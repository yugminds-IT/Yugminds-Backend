import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AdminDashboardService } from './dashboard.service';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Controller('admin')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminDashboardController {
  constructor(private readonly service: AdminDashboardService) {}

  @Get('stats')
  getStats() {
    return this.service.getStats();
  }

  @Get('analytics')
  getAnalytics() {
    return this.service.getAnalytics();
  }

  @Get('assignment-analytics')
  getAssignmentAnalytics() {
    return this.service.getAssignmentAnalytics();
  }

  @Post('refresh-dashboard-views')
  refreshViews() {
    return this.service.refreshViews();
  }

  @Get('monitoring-dashboard')
  getMonitoring() {
    return this.service.getMonitoring();
  }

  @Get('materialized-view-stats')
  getMaterializedViewStats() {
    return this.service.getMaterializedViewStats();
  }
}
