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
          maxRetriesPerRequest: null,
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
