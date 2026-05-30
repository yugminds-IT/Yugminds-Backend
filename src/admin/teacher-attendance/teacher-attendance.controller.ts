import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { AdminTeacherAttendanceService } from './teacher-attendance.service';

@Controller('admin/teacher-attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class AdminTeacherAttendanceController {
  constructor(private readonly service: AdminTeacherAttendanceService) {}

  @Get()
  list(
    @Query('school_id') schoolId?: string,
    @Query('teacherId') teacherId?: string,
  ) {
    return this.service.list(schoolId, teacherId);
  }

  @Get('monthly')
  monthly(@Query('month') month?: string) {
    return this.service.monthly(month);
  }

  @Post('mark-missing')
  markMissing(@Body() body: { start_date?: string; end_date?: string }) {
    const start_date =
      body.start_date ?? new Date().toISOString().split('T')[0];
    const end_date = body.end_date ?? new Date().toISOString().split('T')[0];
    return this.service.markMissing({ start_date, end_date });
  }
}
