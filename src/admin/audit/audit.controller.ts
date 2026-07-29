import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

  @Get('export')
  async exportCsv(@Query() query: AuditQuery, @Res() res: Response) {
    const csv = await this.audit.exportCsv(query);
    const filename = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(csv);
  }
}
