import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { SchoolAdminLeavesService } from './leaves.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@SkipThrottle()
@Controller('school-admin')
@UseGuards(RolesGuard)
@Roles(Role.school_admin)
export class SchoolAdminLeavesController {
  constructor(private readonly service: SchoolAdminLeavesService) {}

  @Get('leaves')
  list(@CurrentUser() user: { id: number }, @Query('status') status?: string) {
    return this.service.list(user.id, { status });
  }

  @Get('leaves/:id')
  get(@CurrentUser() user: { id: number }, @Param('id') id: string) {
    return this.service.get(user.id, id);
  }

  @Patch('leaves/:id')
  update(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body() body: { action?: string; status?: string; admin_remarks?: string },
  ) {
    return this.service.update(user.id, id, body);
  }
}
