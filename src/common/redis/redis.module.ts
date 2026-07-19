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
      useFactory: (config: ConfigService) =>
        new Redis(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
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
        }),
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
