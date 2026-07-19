import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed rate-limit counters so limits are shared across every backend
 * instance instead of being tracked per-process (see app.module.ts note on
 * ThrottlerModule). Mirrors the semantics of the in-memory default storage.
 */
@Injectable()
export class ThrottlerStorageRedisService implements ThrottlerStorage {
  private readonly logger = new Logger(ThrottlerStorageRedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttler:${throttlerName}:${key}`;
    const blockKey = `throttler:${throttlerName}:${key}:blocked`;

    try {
      const blockPttl = await this.redis.pttl(blockKey);
      if (blockPttl > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: 0,
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockPttl / 1000),
        };
      }

      const totalHits = await this.redis.incr(hitsKey);
      if (totalHits === 1) {
        await this.redis.pexpire(hitsKey, ttl);
      }
      const hitsPttl = await this.redis.pttl(hitsKey);
      const timeToExpire = Math.ceil(Math.max(hitsPttl, 0) / 1000);

      let isBlocked = false;
      let timeToBlockExpire = timeToExpire;
      if (totalHits > limit) {
        isBlocked = true;
        if (blockDuration > 0) {
          await this.redis.set(blockKey, '1', 'PX', blockDuration);
          timeToBlockExpire = Math.ceil(blockDuration / 1000);
        }
      }

      return { totalHits, timeToExpire, isBlocked, timeToBlockExpire };
    } catch (err) {
      // Rate limiting is a protective layer, not a correctness requirement —
      // a Redis outage failing open (allow the request through) is far
      // preferable to it silently hanging every request in the app, since
      // this storage backs the global rate-limit guard applied everywhere.
      this.logger.warn(
        `Redis rate-limit check failed, allowing request through: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { totalHits: 1, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
