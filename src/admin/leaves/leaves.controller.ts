import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { AdminLeavesService } from './leaves.service';

@Controller('admin/leaves')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class AdminLeavesController {
  constructor(private readonly service: AdminLeavesService) {}

  @Get()
  list(@Query('school_id') schoolId?: string) {
    return this.service.list(schoolId);
  }

  @Put()
  update(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.update({
      id: body.id as string,
      status: body.status as string,
      admin_remarks: body.admin_remarks as string | undefined,
      approved_by: body.approved_by as string | undefined,
      actor_email: user.email,
    });
  }
}
