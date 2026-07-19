import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AuditService } from './audit.service';
import type { AuditQuery } from './audit.service';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Controller('admin/audit-logs')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: AuditQuery) {
    return this.audit.list(query);
  }

  @Get('entity-types')
  entityTypes() {
    return this.audit.entityTypes();
  }
}
