import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { TeacherDashboardService } from './dashboard.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller('teacher')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.teacher)
export class TeacherDashboardController {
  constructor(private readonly service: TeacherDashboardService) {}

  @Get('dashboard')
  get(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('date') date?: string,
  ) {
    return this.service.get(user.id, { school_id: schoolId, date });
  }
}
