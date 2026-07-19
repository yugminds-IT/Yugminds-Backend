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
      maintenance_message:
        byKey.get(KEY_MAINTENANCE_MESSAGE) ?? DEFAULT_CONTROLS.maintenance_message,
      announcement: parseJson(byKey.get(KEY_ANNOUNCEMENT), DEFAULT_CONTROLS.announcement),
      feature_flags: parseJson(byKey.get(KEY_FEATURE_FLAGS), {}),
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
      await this.writeKey(KEY_MAINTENANCE_MESSAGE, body.maintenance_message.slice(0, 500));
    }
    if (body.announcement && typeof body.announcement === 'object') {
      const a = body.announcement;
      const clean: Announcement = {
        enabled: !!a.enabled,
        text: String(a.text ?? '').slice(0, 500),
        level: ['info', 'warning', 'critical'].includes(a.level) ? a.level : 'info',
      };
      await this.writeKey(KEY_ANNOUNCEMENT, JSON.stringify(clean));
    }
    if (body.feature_flags && typeof body.feature_flags === 'object') {
      const clean: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(body.feature_flags).slice(0, 100)) {
        if (/^[\w.-]{1,64}$/.test(k)) clean[k] = !!v;
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
  }> {
    const { maintenance_mode, maintenance_message, announcement } = await this.readAll();
    return { maintenance_mode, maintenance_message, announcement };
  }

  /** Used by the login flow to block non-admin sign-ins during maintenance. */
  async isMaintenanceActive(): Promise<{ active: boolean; message: string }> {
    const c = await this.readAll();
    return { active: c.maintenance_mode, message: c.maintenance_message };
  }
}
