import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { PasswordResetRequestModule } from '../common/password-reset-request/password-reset-request.module';
import { SchoolAdminSchoolController } from './school/school.controller';
import { SchoolAdminStatsController } from './stats/stats.controller';
import { SchoolAdminSchoolService } from './school/school.service';
import { SchoolAdminStatsService } from './stats/stats.service';
import { SchoolAdminExtraController } from './extra/school-admin-extra.controller';
import { SchoolAdminLeavesController } from './leaves/leaves.controller';
import { SchoolAdminLeavesService } from './leaves/leaves.service';
import { SchoolCalendarController } from './calendar/school-calendar.controller';
import { SchoolCalendarService } from './calendar/school-calendar.service';
import { RealtimeModule } from '../common/realtime/realtime.module';
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
    SchoolAdminLeavesController,
    SchoolCalendarController,
  ],
  providers: [
    SchoolAdminSchoolService,
    SchoolAdminStatsService,
    SchoolAdminLeavesService,
    SchoolCalendarService,
  ],
  exports: [SchoolCalendarService],
})
export class SchoolAdminModule {}
