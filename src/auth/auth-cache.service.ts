import { Inject, Injectable } from '@nestjs/common';
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

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(userId: number): string {
    return `authuser:${userId}`;
  }

  async get(userId: number): Promise<CachedAuthUser | null> {
    const cached = await this.redis.get(this.key(userId));
    return cached ? (JSON.parse(cached) as CachedAuthUser) : null;
  }

  async set(userId: number, data: CachedAuthUser): Promise<void> {
    await this.redis.set(
      this.key(userId),
      JSON.stringify(data),
      'EX',
      this.TTL_SECONDS,
    );
  }

  async invalidate(userId: number | number[]): Promise<void> {
    const ids = Array.isArray(userId) ? userId : [userId];
    if (!ids.length) return;
    await this.redis.del(...ids.map((id) => this.key(id)));
  }
}
