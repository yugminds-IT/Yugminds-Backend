import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { ThrottlerStorageRedisService } from '../throttler/throttler-storage-redis.service';
import { AuthCacheService } from '../../auth/auth-cache.service';
import { RefreshTokenStoreService } from '../../auth/refresh-token-store.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService) => {
        const client = new Redis(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          {
            // SECURITY/RELIABILITY: `maxRetriesPerRequest: null` (the old value)
            // makes ioredis queue commands and retry the connection forever —
            // if Redis is unreachable (wrong URL, network issue, credentials
            // rotated), every request touching it hangs indefinitely with no
            // error, which is indistinguishable from a frontend stuck loading
            // forever. Bound retries + a per-command timeout so a Redis outage
            // fails fast and loud instead.
            maxRetriesPerRequest: 3,
            commandTimeout: 5000,
            connectTimeout: 5000,
            lazyConnect: false,
            // Remote Redis drops idle sockets: keep them alive and reconnect
            // with capped backoff instead of surfacing ECONNRESET as unhandled.
            keepAlive: 10000,
            retryStrategy: (times) => Math.min(times * 200, 3000),
          },
        );
        // Without a listener ioredis prints "Unhandled error event" per reset.
        client.on('error', (err) =>
          console.warn(`[Redis] ${err.message} (auto-reconnecting)`),
        );
        return client;
      },
      inject: [ConfigService],
    },
    ThrottlerStorageRedisService,
    AuthCacheService,
    RefreshTokenStoreService,
  ],
  exports: [
    REDIS_CLIENT,
    ThrottlerStorageRedisService,
    AuthCacheService,
    RefreshTokenStoreService,
  ],
})
export class RedisModule {}
