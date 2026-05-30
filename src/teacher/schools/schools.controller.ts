import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { TeacherSchoolsService } from './schools.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller('teacher/schools')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.teacher)
export class TeacherSchoolsController {
  constructor(private readonly service: TeacherSchoolsService) {}

  @Get()
  list(@CurrentUser() user: { id: number; tenantId?: string }) {
    return this.service.list(user);
  }
}
