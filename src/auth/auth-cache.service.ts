import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.constants';

export interface CachedAuthUser {
  tokenVersion: number;
  tenantId: string | null;
  role: string;
  isSuperAdmin: boolean;
}

/**
 * Short-lived Redis cache of the per-request user lookup JwtStrategy would
 * otherwise do against Postgres on every authenticated request. TTL is kept
 * short (2 min) so a missed invalidation call self-heals quickly; every
 * tokenVersion-bumping mutation should also call invalidate() so the change
 * takes effect immediately instead of waiting out the TTL.
 */
@Injectable()
export class AuthCacheService {
  private readonly TTL_SECONDS = 120;
  private readonly logger = new Logger(AuthCacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(userId: number): string {
    return `authuser:${userId}`;
  }

  // This is purely a performance cache — JwtStrategy always falls back to a
  // direct Postgres lookup on a miss. So a Redis error here should degrade
  // to "cache miss" (slower, still correct) rather than fail the request.

  async get(userId: number): Promise<CachedAuthUser | null> {
    try {
      const cached = await this.redis.get(this.key(userId));
      return cached ? (JSON.parse(cached) as CachedAuthUser) : null;
    } catch (err) {
      this.logger.warn(`Redis GET failed, falling back to DB: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async set(userId: number, data: CachedAuthUser): Promise<void> {
    try {
      await this.redis.set(
        this.key(userId),
        JSON.stringify(data),
        'EX',
        this.TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`Redis SET failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async invalidate(userId: number | number[]): Promise<void> {
    const ids = Array.isArray(userId) ? userId : [userId];
    if (!ids.length) return;
    try {
      await this.redis.del(...ids.map((id) => this.key(id)));
    } catch (err) {
      this.logger.warn(`Redis DEL failed (non-fatal, entry will expire via TTL): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
