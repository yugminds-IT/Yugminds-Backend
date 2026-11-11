import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { MonitoringHistoryService } from './monitoring-history.service';
import { MonitoringMiddleware } from './monitoring.middleware';

@Global()
@Module({
  providers: [MonitoringService, MonitoringHistoryService],
  exports: [MonitoringService, MonitoringHistoryService],
})
export class MonitoringModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, so requests the guards reject and pages that do not exist are counted too.
    consumer.apply(MonitoringMiddleware).forRoutes('{*path}');
  }
}
