import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { CommonModule } from '../common/common.module';
import { TeacherDashboardController } from './dashboard/dashboard.controller';
import { TeacherSchoolsController } from './schools/schools.controller';
import { TeacherReportsController } from './reports/reports.controller';
import { TeacherAttendanceController } from './attendance/attendance.controller';
import { TeacherLeavesController } from './leaves/leaves.controller';
import { TeacherDashboardService } from './dashboard/dashboard.service';
import { TeacherSchoolsService } from './schools/schools.service';
import { TeacherReportsService } from './reports/reports.service';
import { TeacherAttendanceService } from './attendance/attendance.service';
import { TeacherLeavesService } from './leaves/leaves.service';
import { TeacherExtraController } from './extra/teacher-extra.controller';
import { RealtimeModule } from '../common/realtime/realtime.module';

@Module({
  imports: [DatabaseModule, AuthModule, CommonModule, RealtimeModule],
  controllers: [
    TeacherDashboardController,
    TeacherSchoolsController,
    TeacherReportsController,
    TeacherAttendanceController,
    TeacherLeavesController,
    TeacherExtraController,
  ],
  providers: [
    TeacherDashboardService,
    TeacherSchoolsService,
    TeacherReportsService,
    TeacherAttendanceService,
    TeacherLeavesService,
  ],
})
export class TeacherModule {}
