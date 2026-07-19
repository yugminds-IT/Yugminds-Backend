import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AlertsService } from './alerts.service';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Controller('admin/alerts')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list() {
    return this.alerts.evaluate();
  }
}
