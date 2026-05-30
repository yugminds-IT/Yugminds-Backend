import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { SchoolAdminSchoolService } from './school.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@SkipThrottle()
@Controller('school-admin')
@UseGuards(RolesGuard)
@Roles(Role.school_admin)
export class SchoolAdminSchoolController {
  constructor(private readonly service: SchoolAdminSchoolService) {}

  @Get('school')
  get(@CurrentUser() user: { id: number; tenantId?: string }) {
    return this.service.get(user);
  }
}
