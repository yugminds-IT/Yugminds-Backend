import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AdminSearchService } from './search.service';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Controller('admin/search')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminSearchController {
  constructor(private readonly search: AdminSearchService) {}

  @Get()
  find(@Query('q') q?: string) {
    return this.search.find(q ?? '');
  }
}
