import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { UAParser } from 'ua-parser-js';
import * as geoip from 'geoip-lite';
import { DatabaseService } from '../../database/database.service';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';

export type SubjectType = 'lms' | 'academy';

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface SessionView {
  id: string;
  browser: string;
  os: string;
  deviceType: string;
  ip: string | null;
  location: string;
  createdAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

const ALIVE_TTL_S = 300;
// ponytail: lastSeenAt is only written on login/refresh (every ~15 min of use), not per request.
const TOUCH_MIN_GAP_MS = 5 * 60 * 1000;

export function describeClient(meta: SessionMeta) {
  const ua = new UAParser(meta.userAgent ?? '').getResult();
  const ip = (meta.ip ?? '').replace(/^::ffff:/, '') || null;
  const geo = ip ? geoip.lookup(ip) : null;
  const location = geo
    ? [geo.city, geo.region, geo.country].filter(Boolean).join(', ')
    : 'Unknown location';
  return {
    browser: ua.browser.name
      ? `${ua.browser.name}${ua.browser.major ? ' ' + ua.browser.major : ''}`
      : 'Unknown browser',
    os: ua.os.name ?? 'Unknown OS',
    deviceType:
      ua.device.type === 'mobile' || ua.device.type === 'tablet'
        ? ua.device.type
        : 'desktop',
    ip,
    location,
    userAgent: (meta.userAgent ?? '').slice(0, 512) || null,
  };
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // Keyed by owner too, so a cached 'alive' can never be read for someone else's sid.
  private key(type: SubjectType, subjectId: string | number, sid: string) {
    return `sess:${type}:${subjectId}:${sid}`;
  }

  private get table() {
    return (this.db as any).loginSession;
  }

  async create(
    type: SubjectType,
    subjectId: string | number,
    meta: SessionMeta,
    ttlSeconds: number,
  ): Promise<string> {
    const row = await this.table.create({
      data: {
        subjectType: type,
        subjectId: String(subjectId),
        ...describeClient(meta),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    await this.cache(
      type,
      subjectId,
      row.id,
      true,
      Math.min(ALIVE_TTL_S, ttlSeconds),
    );
    return row.id;
  }

  private async cache(
    type: SubjectType,
    subjectId: string | number,
    sid: string,
    alive: boolean,
    ttl = ALIVE_TTL_S,
  ) {
    try {
      await this.redis.set(
        this.key(type, subjectId, sid),
        alive ? '1' : '0',
        'EX',
        ttl,
      );
    } catch (err) {
      this.logger.warn(`session cache write failed: ${String(err)}`);
    }
  }

  /** True if the session exists, isn't revoked and hasn't expired. Redis first, DB on miss/failure. */
  async isAlive(
    sid: string,
    type: SubjectType,
    subjectId: string | number,
  ): Promise<boolean> {
    try {
      const hit = await this.redis.get(this.key(type, subjectId, sid));
      if (hit === '0') return false;
      if (hit === '1') return true;
    } catch {
      /* fall through to DB */
    }
    const row = await this.table.findUnique({ where: { id: sid } });
    const alive =
      !!row &&
      row.subjectType === type &&
      row.subjectId === String(subjectId) &&
      !row.revokedAt &&
      row.expiresAt > new Date();
    await this.cache(type, subjectId, sid, alive);
    return alive;
  }

  /** Called on refresh: keep the row's IP/last-seen fresh and extend its expiry. */
  async touch(
    sid: string,
    meta: SessionMeta,
    ttlSeconds: number,
  ): Promise<void> {
    const row = await this.table.findUnique({ where: { id: sid } });
    if (!row || Date.now() - row.lastSeenAt.getTime() < TOUCH_MIN_GAP_MS)
      return;
    const { ip, location } = describeClient(meta);
    await this.table.update({
      where: { id: sid },
      data: {
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        ...(ip ? { ip, location } : {}),
      },
    });
  }

  async list(
    type: SubjectType,
    subjectId: string | number,
    currentSid?: string,
  ): Promise<SessionView[]> {
    const rows = await this.table.findMany({
      where: {
        subjectType: type,
        subjectId: String(subjectId),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((r: any) => ({
      id: r.id,
      browser: r.browser ?? 'Unknown browser',
      os: r.os ?? 'Unknown OS',
      deviceType: r.deviceType ?? 'desktop',
      ip: r.ip,
      location: r.location ?? 'Unknown location',
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      current: r.id === currentSid,
    }));
  }

  /** Revoke one session owned by the subject. Returns false if it isn't theirs / already gone. */
  async revoke(
    type: SubjectType,
    subjectId: string | number,
    sid: string,
  ): Promise<boolean> {
    const res = await this.table.updateMany({
      where: {
        id: sid,
        subjectType: type,
        subjectId: String(subjectId),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (res.count) {
      await this.cache(type, subjectId, sid, false);
      this.notifyRevoked([sid]);
    }
    return res.count > 0;
  }

  /** Revoke every live session of the subject(s), except `exceptSid` when given. */
  async revokeMany(
    type: SubjectType,
    subjectId: string | number | Array<string | number>,
    exceptSid?: string,
  ): Promise<number> {
    const ids = (Array.isArray(subjectId) ? subjectId : [subjectId]).map(
      String,
    );
    if (!ids.length) return 0;
    const where = {
      subjectType: type,
      subjectId: ids.length === 1 ? ids[0] : { in: ids },
      revokedAt: null,
      ...(exceptSid ? { id: { not: exceptSid } } : {}),
    };
    const rows: { id: string; subjectId: string }[] = await this.table.findMany(
      { where, select: { id: true, subjectId: true } },
    );
    if (!rows.length) return 0;
    await this.table.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { revokedAt: new Date() },
    });
    await Promise.all(
      rows.map((r) => this.cache(type, r.subjectId, r.id, false)),
    );
    this.notifyRevoked(rows.map((r) => r.id));
    return rows.length;
  }

  // Lets the realtime gateway drop live sockets of a revoked session.
  // ponytail: in-process only; with several backend instances add a Redis pub/sub.
  private readonly revokeListeners: Array<(sids: string[]) => void> = [];

  onRevoked(fn: (sids: string[]) => void) {
    this.revokeListeners.push(fn);
  }

  private notifyRevoked(sids: string[]) {
    for (const fn of this.revokeListeners) {
      try {
        fn(sids);
      } catch (err) {
        this.logger.warn(`revoke listener failed: ${String(err)}`);
      }
    }
  }

  @Cron('0 3 * * *')
  async purgeOld(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await this.table.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });
  }
}
