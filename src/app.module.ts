import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserOrIpThrottlerGuard } from './common/throttler/user-or-ip-throttler.guard';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { JwtAuthGuard } from './auth/jwt-auth/jwt-auth.guard';
import { AdminModule } from './admin/admin.module';
import { TeacherModule } from './teacher/teacher.module';
import { SchoolAdminModule } from './school-admin/school-admin.module';
import { StudentModule } from './student/student.module';
import { MonitoringModule } from './common/monitoring/monitoring.module';
import { MonitoringInterceptor } from './common/monitoring/monitoring.interceptor';
import { InternalModule } from './modules/internal/internal.module';
import { TenantContextInterceptor } from './tenants/tenant-context.interceptor';
import { SeedModule } from './common/seed/seed.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // SECURITY: Rate limiting to prevent brute force / abuse.
    //
    // Requests are tracked PER AUTHENTICATED USER (see UserOrIpThrottlerGuard),
    // not per IP — schools put many students behind one NAT'd IP, so an IP-keyed
    // budget would be shared across a whole class. Each user gets their own
    // budget below; unauthenticated auth endpoints fall back to per-IP limits.
    //
    // Only the `default` throttler is registered globally — every named
    // throttler in this array applies to every request, so adding an extra
    // `auth` tracker with limit 5 here would 429 every authenticated route
    // after 5 hits/min. Auth endpoints instead override the default tracker
    // to a stricter limit via `@Throttle({ default: { limit: N, ttl: 60000 } })`.
    //
    // NOTE: storage is in-memory, so with multiple backend instances each keeps
    // its own counters (limits are effectively per-instance). If/when this scales
    // horizontally, wire a shared Redis ThrottlerStorage here for exact limits.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000, // 1 minute
        limit: 1200, // per user/min — generous for data-heavy dashboards firing many parallel calls
      },
    ]),
    AuthModule,
    DatabaseModule,
    AdminModule,
    TeacherModule,
    SchoolAdminModule,
    StudentModule,
    UsersModule,
    TenantsModule,
    CommonModule,
    MonitoringModule,
    InternalModule,
    SeedModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserOrIpThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MonitoringInterceptor },
  ],
})
export class AppModule {}
