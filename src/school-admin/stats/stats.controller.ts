import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { SchoolAdminStatsService } from './stats.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@SkipThrottle()
@Controller('school-admin')
@UseGuards(RolesGuard)
@Roles(Role.school_admin)
export class SchoolAdminStatsController {
  constructor(private readonly service: SchoolAdminStatsService) {}

  @Get('stats')
  get(@CurrentUser() user: { id: number; tenantId?: string }) {
    return this.service.get(user).then((stats) => ({ stats }));
  }

  @Get('assignment-analytics')
  getAssignmentAnalytics(
    @CurrentUser() user: { id: number; tenantId?: string },
  ) {
    return this.service
      .getAssignmentAnalytics(user)
      .then((analytics) => ({ analytics }));
  }

  @Get('leaderboard')
  getLeaderboard(@CurrentUser() user: { id: number }) {
    return this.service.getLeaderboard(user);
  }
}
