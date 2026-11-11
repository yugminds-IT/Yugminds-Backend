import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IMPERSONATED_BY } from './audit.constants';
import { DatabaseService } from '../../database/database.service';
import { Prisma } from '@prisma/client';

export interface AuditEntry {
  actorId?: number | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  schoolId?: string | null;
  method: string;
  path: string;
  entityType?: string | null;
  entityId?: string | null;
  payload?: Prisma.InputJsonValue | null;
  statusCode?: number | null;
  success?: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditQuery {
  page?: string;
  limit?: string;
  actorEmail?: string;
  actorId?: string;
  /** admin | school_admin | teacher | student */
  actorRole?: string;
  schoolId?: string;
  /** "false" shows only failed attempts */
  success?: string;
  /** "true" shows only what may need a look: failed attempts and deletions */
  attention?: string;
  entityType?: string;
  method?: string;
  search?: string;
  from?: string;
  to?: string;
}

const SENSITIVE_KEYS = /pass(word)?|token|secret|authorization|otp/i;

/** Recursively strip password/token-like fields from a request body before persisting. */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizePayload(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k)
        ? '[redacted]'
        : sanitizePayload(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) {
    return value.slice(0, 2000) + '…[truncated]';
  }
  return value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Fire-and-forget write: audit logging must never break the request it observes. */
  record(entry: AuditEntry): void {
    this.db.auditLog
      .create({
        data: {
          actorId: entry.actorId ?? null,
          actorEmail: entry.actorEmail ?? null,
          actorRole: entry.actorRole ?? null,
          schoolId: entry.schoolId ?? null,
          method: entry.method,
          path: entry.path,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          payload: (entry.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          statusCode: entry.statusCode ?? null,
          success: entry.success ?? true,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to write audit log: ${(err as Error)?.message}`,
        );
      });
  }

  private buildWhere(query: AuditQuery): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.actorEmail) {
      where.actorEmail = { contains: query.actorEmail, mode: 'insensitive' };
    }
    if (query.actorRole) where.actorRole = query.actorRole;
    if (query.actorId && /^\d+$/.test(query.actorId))
      where.actorId = Number(query.actorId);
    if (query.schoolId) where.schoolId = query.schoolId;
    if (query.success === 'false') where.success = false;
    else if (query.success === 'true') where.success = true;
    if (query.attention === 'true') {
      where.AND = [{ OR: [{ success: false }, { method: 'DELETE' }] }];
    }
    if (query.entityType) where.entityType = query.entityType;
    if (query.method) where.method = query.method.toUpperCase();
    if (query.search) {
      where.OR = [
        { path: { contains: query.search, mode: 'insensitive' } },
        { actorEmail: { contains: query.search, mode: 'insensitive' } },
        { entityId: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }
    return where;
  }

  async list(query: AuditQuery) {
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(
      200,
      Math.max(1, parseInt(query.limit ?? '50', 10) || 50),
    );

    const where = this.buildWhere(query);

    const [total, logs] = await Promise.all([
      this.db.auditLog.count({ where }),
      this.db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          actor: {
            select: { email: true, profile: { select: { fullName: true } } },
          },
        },
      }),
    ]);

    const names = await this.schoolNames(logs.map((l) => l.schoolId));
    const adminIds = [
      ...new Set(
        logs
          .map(
            (l) =>
              (l.payload as Record<string, unknown> | null)?.[IMPERSONATED_BY],
          )
          .filter((x): x is number => typeof x === 'number'),
      ),
    ];
    const admins = adminIds.length
      ? await this.db.user.findMany({
          where: { id: { in: adminIds } },
          select: {
            id: true,
            email: true,
            profile: { select: { fullName: true } },
          },
        })
      : [];
    const adminName = new Map(
      admins.map((a) => [a.id, a.profile?.fullName ?? a.email]),
    );

    return {
      logs: logs.map((l) => ({
        id: l.id,
        actorId: l.actorId,
        actorEmail: l.actorEmail ?? l.actor?.email ?? null,
        actorName: l.actor?.profile?.fullName ?? null,
        actorRole: l.actorRole,
        schoolId: l.schoolId,
        schoolName: l.schoolId ? (names.get(l.schoolId) ?? null) : null,
        impersonatedBy: ((id) =>
          typeof id === 'number'
            ? { id, name: adminName.get(id) ?? 'An admin' }
            : null)(
          (l.payload as Record<string, unknown> | null)?.[IMPERSONATED_BY],
        ),
        method: l.method,
        path: l.path,
        entityType: l.entityType,
        entityId: l.entityId,
        payload: l.payload,
        statusCode: l.statusCode,
        success: l.success,
        ipAddress: l.ipAddress,
        createdAt: l.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private async schoolNames(
    ids: Array<string | null>,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const rows = await this.db.school.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * Who is behind the failed attempts and deletions: totals per role, and the people with the most
   * failed attempts and deletions, under the same filters as the list (except which role or person).
   */
  async summary(query: AuditQuery) {
    const { actorRole: _role, actorId: _actor, ...rest } = query;
    void _role;
    void _actor;
    const where = this.buildWhere(rest);
    const count = (extra: Prisma.AuditLogWhereInput) =>
      this.db.auditLog.groupBy({
        by: ['actorId', 'actorEmail', 'actorRole'],
        where: { AND: [where, extra] },
        _count: { _all: true },
      });
    const [all, failed, deleted] = await Promise.all([
      count({}),
      count({ success: false }),
      count({ method: 'DELETE' }),
    ]);

    type Row = {
      actorId: number | null;
      email: string | null;
      role: string | null;
      total: number;
      failed: number;
      deleted: number;
    };
    const people = new Map<string, Row>();
    const key = (r: { actorId: number | null; actorEmail: string | null }) =>
      `${r.actorId ?? ''}|${r.actorEmail ?? ''}`;
    const add = (rows: typeof all, field: 'total' | 'failed' | 'deleted') => {
      for (const r of rows) {
        const cur = people.get(key(r)) ?? {
          actorId: r.actorId,
          email: r.actorEmail,
          role: r.actorRole,
          total: 0,
          failed: 0,
          deleted: 0,
        };
        cur[field] += r._count._all;
        people.set(key(r), cur);
      }
    };
    add(all, 'total');
    add(failed, 'failed');
    add(deleted, 'deleted');

    const byRole = new Map<
      string,
      { role: string; total: number; failed: number; deleted: number }
    >();
    for (const p of people.values()) {
      const role = p.role ?? 'unknown';
      const cur = byRole.get(role) ?? { role, total: 0, failed: 0, deleted: 0 };
      cur.total += p.total;
      cur.failed += p.failed;
      cur.deleted += p.deleted;
      byRole.set(role, cur);
    }

    const top = [...people.values()]
      .filter((p) => p.failed + p.deleted > 0)
      .sort(
        (a, b) =>
          b.failed + b.deleted - (a.failed + a.deleted) || b.total - a.total,
      )
      .slice(0, 10);
    const ids = top.map((p) => p.actorId).filter((x): x is number => x != null);
    const profiles = ids.length
      ? await this.db.profile.findMany({
          where: { userId: { in: ids } },
          select: { userId: true, fullName: true },
        })
      : [];
    const nameOf = new Map(profiles.map((p) => [p.userId, p.fullName]));

    return {
      by_role: [...byRole.values()].sort((a, b) => b.total - a.total),
      top_people: top.map((p) => ({
        actor_id: p.actorId,
        name:
          (p.actorId != null ? nameOf.get(p.actorId) : null) ??
          p.email ??
          'Unknown',
        email: p.email,
        role: p.role,
        total: p.total,
        failed: p.failed,
        deleted: p.deleted,
      })),
    };
  }

  /**
   * How long entries by school admins, teachers and students are kept (90 days by default, set with
   * AUDIT_RETENTION_DAYS). Entries for admin-area actions are never deleted, whoever made them.
   */
  get retentionDays(): number {
    return Math.min(
      3650,
      Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS) || 90),
    );
  }

  @Cron('30 3 * * *')
  async purgeOld(): Promise<number> {
    try {
      const cutoff = new Date(
        Date.now() - this.retentionDays * 24 * 3600 * 1000,
      );
      const res = await this.db.auditLog.deleteMany({
        where: {
          actorRole: { in: ['school_admin', 'teacher', 'student'] },
          NOT: { path: { startsWith: '/admin' } },
          createdAt: { lt: cutoff },
        },
      });
      return res.count;
    } catch (err) {
      this.logger.warn(
        `Could not purge old audit entries: ${(err as Error)?.message}`,
      );
      return 0;
    }
  }

  /**
   * CSV export honoring the same filters as `list()` — a compliance-style
   * audit trail with no way to get the data out is a real gap. Capped at
   * 5000 rows (matching the newest-first order `list()` already uses) so a
   * broad/unfiltered export can't load an unbounded table into memory;
   * admins narrowing by date range can pull more via multiple exports.
   */
  async exportCsv(query: AuditQuery): Promise<string> {
    const where = this.buildWhere(query);
    const logs = await this.db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 5000,
      include: {
        actor: {
          select: { email: true, profile: { select: { fullName: true } } },
        },
      },
    });

    const names = await this.schoolNames(logs.map((l) => l.schoolId));
    const header = [
      'When',
      'Actor Email',
      'Actor Name',
      'Actor Role',
      'School',
      'Method',
      'Path',
      'Entity Type',
      'Entity ID',
      'Status Code',
      'Success',
      'IP Address',
    ];
    const escapeCsv = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = logs.map((l) =>
      [
        l.createdAt.toISOString(),
        l.actorEmail ?? l.actor?.email ?? '',
        l.actor?.profile?.fullName ?? '',
        l.actorRole ?? '',
        l.schoolId ? (names.get(l.schoolId) ?? '') : '',
        l.method,
        l.path,
        l.entityType ?? '',
        l.entityId ?? '',
        l.statusCode ?? '',
        l.success ? 'true' : 'false',
        l.ipAddress ?? '',
      ]
        .map(escapeCsv)
        .join(','),
    );
    return [header.join(','), ...rows].join('\n');
  }

  /** Distinct entity types seen so the UI filter dropdown reflects real data. */
  async entityTypes(): Promise<string[]> {
    const rows = await this.db.auditLog.findMany({
      where: { entityType: { not: null } },
      distinct: ['entityType'],
      select: { entityType: true },
      orderBy: { entityType: 'asc' },
    });
    return rows.map((r) => r.entityType!).filter(Boolean);
  }
}
