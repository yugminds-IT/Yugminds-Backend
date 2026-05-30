import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { AuditModule } from './common/audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // SECURITY: Rate limiting to prevent brute force attacks.
    // Only the `default` throttler is registered globally — every named
    // throttler in this array applies to every request, so adding an extra
    // `auth` tracker with limit 5 here would 429 every authenticated route
    // after 5 hits/min. Auth endpoints instead override the default tracker
    // to a stricter limit via `@Throttle({ default: { limit: 5, ttl: 60000 } })`.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000, // 1 minute
        limit: 600, // 600 requests per minute for general endpoints
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
    AuditModule,
    InternalModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MonitoringInterceptor },
  ],
})
export class AppModule {}
