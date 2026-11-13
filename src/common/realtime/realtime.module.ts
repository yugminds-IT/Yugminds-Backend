import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';
import { AdminTeacherAttendanceService } from '../../admin/teacher-attendance/teacher-attendance.service';
import { AdminCalendarService } from '../../admin/calendar/calendar.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [forwardRef(() => AuthModule), DatabaseModule],
  providers: [
    RealtimeGateway,
    AdminTeacherAttendanceService,
    AdminCalendarService,
  ],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
