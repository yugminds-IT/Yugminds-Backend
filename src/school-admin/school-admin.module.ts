import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { PasswordResetRequestModule } from '../common/password-reset-request/password-reset-request.module';
import { SchoolAdminSchoolController } from './school/school.controller';
import { SchoolAdminStatsController } from './stats/stats.controller';
import { SchoolAdminSchoolService } from './school/school.service';
import { SchoolPerformanceService } from './stats/performance.service';
import { SchoolAdminStatsService } from './stats/stats.service';
import { SchoolAdminExtraController } from './extra/school-admin-extra.controller';
import { RealtimeModule } from '../common/realtime/realtime.module';
import { AdminTeacherAttendanceService } from '../admin/teacher-attendance/teacher-attendance.service';
import { AdminCalendarService } from '../admin/calendar/calendar.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    PasswordResetRequestModule,
    RealtimeModule,
    CommonModule,
  ],
  controllers: [
    SchoolAdminSchoolController,
    SchoolAdminStatsController,
    SchoolAdminExtraController,
  ],
  providers: [
    SchoolAdminSchoolService,
    SchoolAdminStatsService,
    SchoolPerformanceService,
    AdminTeacherAttendanceService,
    AdminCalendarService,
  ],
})
export class SchoolAdminModule {}
