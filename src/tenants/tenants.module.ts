import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { TenantMiddleware } from './tenant.middleware';

@Module({
  providers: [TenantsService, TenantMiddleware],
  controllers: [TenantsController],
})
export class TenantsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
