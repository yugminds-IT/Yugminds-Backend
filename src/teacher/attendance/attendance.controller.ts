import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { TeacherAttendanceService } from './attendance.service';

@Controller('teacher/attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.teacher)
export class TeacherAttendanceController {
  constructor(private readonly service: TeacherAttendanceService) {}

  @Get('today')
  getToday(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('date') date?: string,
  ) {
    return this.service.getToday(user.id, schoolId, date);
  }

  @Get('monthly')
  getMonthly(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('limit') limit?: string,
    @Query('yearMonth') yearMonth?: string,
  ) {
    return this.service.getMonthly(
      user.id,
      schoolId,
      limit ? parseInt(limit, 10) : 6,
      yearMonth,
    );
  }

  @Get()
  list(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.list(user.id, schoolId, from, to);
  }
}
