import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { StudentDashboardService } from './dashboard.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller('student')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.student)
export class StudentDashboardController {
  constructor(private readonly service: StudentDashboardService) {}

  @Get('dashboard')
  get(@CurrentUser() user: { id: number }) {
    return this.service.get(user);
  }
}
