import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

const KEY_MAINTENANCE = 'maintenance_mode';
const KEY_MAINTENANCE_MESSAGE = 'maintenance_message';
const KEY_ANNOUNCEMENT = 'announcement';
const KEY_FEATURE_FLAGS = 'feature_flags';

export interface Announcement {
  enabled: boolean;
  text: string;
  level: 'info' | 'warning' | 'critical';
}

export interface SystemControls {
  maintenance_mode: boolean;
  maintenance_message: string;
  announcement: Announcement;
  feature_flags: Record<string, boolean>;
}

const MAX_TEXT = 500;
const LEVELS: Announcement['level'][] = ['info', 'warning', 'critical'];
const FLAG_NAME = /^[\w.-]{1,64}$/;

/** A usable announcement from whatever was stored or sent: real booleans and text only, a known level. */
function cleanAnnouncement(raw: unknown, base: Announcement): Announcement {
  const a =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    enabled: typeof a.enabled === 'boolean' ? a.enabled : base.enabled,
    text: typeof a.text === 'string' ? a.text.slice(0, MAX_TEXT) : base.text,
    level: LEVELS.includes(a.level as Announcement['level'])
      ? (a.level as Announcement['level'])
      : base.level,
  };
}

/** Only well-formed names with a real on/off value, at most 100. */
function cleanFlags(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(
    0,
    100,
  )) {
    if (FLAG_NAME.test(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const DEFAULT_CONTROLS: SystemControls = {
  maintenance_mode: false,
  maintenance_message:
    'Yugminds is undergoing scheduled maintenance. Please check back shortly.',
  announcement: { enabled: false, text: '', level: 'info' },
  feature_flags: {},
};

/**
 * Platform-wide switches stored in the SystemSetting key-value table:
 * maintenance mode (blocks non-admin logins), a broadcast announcement
 * banner, and free-form feature flags.
 */
@Injectable()
export class SystemControlsService {
  // Login path reads maintenance state on every attempt — cache briefly.
  private cache: { data: SystemControls; expiresAt: number } | null = null;
  private readonly TTL_MS = 15_000;

  constructor(private readonly db: DatabaseService) {}

  private async readAll(): Promise<SystemControls> {
    if (this.cache && Date.now() < this.cache.expiresAt) return this.cache.data;
    const rows = await this.db.systemSetting.findMany({
      where: {
        key: {
          in: [
            KEY_MAINTENANCE,
            KEY_MAINTENANCE_MESSAGE,
            KEY_ANNOUNCEMENT,
            KEY_FEATURE_FLAGS,
          ],
        },
      },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const parseJson = <T>(raw: string | undefined, fallback: T): T => {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };
    const data: SystemControls = {
      maintenance_mode: byKey.get(KEY_MAINTENANCE) === 'true',
      // a blank message must never reach people: they would read nothing at sign-in
      maintenance_message:
        (byKey.get(KEY_MAINTENANCE_MESSAGE) ?? '').trim() ||
        DEFAULT_CONTROLS.maintenance_message,
      announcement: cleanAnnouncement(
        parseJson<unknown>(byKey.get(KEY_ANNOUNCEMENT), null),
        DEFAULT_CONTROLS.announcement,
      ),
      feature_flags: cleanFlags(
        parseJson<unknown>(byKey.get(KEY_FEATURE_FLAGS), {}),
      ),
    };
    this.cache = { data, expiresAt: Date.now() + this.TTL_MS };
    return data;
  }

  private async writeKey(key: string, value: string): Promise<void> {
    await this.db.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async get(): Promise<SystemControls> {
    return this.readAll();
  }

  async update(body: Partial<SystemControls>): Promise<SystemControls> {
    if (typeof body.maintenance_mode === 'boolean') {
      await this.writeKey(KEY_MAINTENANCE, String(body.maintenance_mode));
    }
    if (typeof body.maintenance_message === 'string') {
      await this.writeKey(
        KEY_MAINTENANCE_MESSAGE,
        body.maintenance_message.trim().slice(0, MAX_TEXT),
      );
    }
    if (body.announcement && typeof body.announcement === 'object') {
      // Parts that are not sent keep their current value, so sending only { enabled: false } does not wipe the text.
      const current = (await this.readAll()).announcement;
      await this.writeKey(
        KEY_ANNOUNCEMENT,
        JSON.stringify(cleanAnnouncement(body.announcement, current)),
      );
    }
    if (body.feature_flags && typeof body.feature_flags === 'object') {
      // The flags sent are the complete list: anything left out is removed.
      const clean: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(body.feature_flags).slice(0, 100)) {
        if (FLAG_NAME.test(k)) clean[k] = !!v;
      }
      await this.writeKey(KEY_FEATURE_FLAGS, JSON.stringify(clean));
    }
    this.cache = null;
    return this.readAll();
  }

  /** Public system status: what any client may know before/after login. */
  async publicStatus(): Promise<{
    maintenance_mode: boolean;
    maintenance_message: string;
    announcement: Announcement;
    feature_flags: Record<string, boolean>;
  }> {
    const {
      maintenance_mode,
      maintenance_message,
      announcement,
      feature_flags,
    } = await this.readAll();
    return {
      maintenance_mode,
      maintenance_message,
      announcement,
      feature_flags,
    };
  }

  /** Used by the login flow to block non-admin sign-ins during maintenance. */
  async isMaintenanceActive(): Promise<{ active: boolean; message: string }> {
    const c = await this.readAll();
    return { active: c.maintenance_mode, message: c.maintenance_message };
  }
}
