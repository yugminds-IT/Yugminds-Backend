import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
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

  /** Emergency leave filed on behalf of a teacher (admin = approval stage 2). */
  @Post()
  createEmergency(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.createEmergency(
      {
        teacher_id: body.teacher_id as number | string | undefined,
        school_id: body.school_id as string | undefined,
        start_date: body.start_date as string | undefined,
        end_date: body.end_date as string | undefined,
        reason: body.reason as string | undefined,
      },
      user.id,
    );
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
      // Numeric user id (as a string), matching the format the school-admin
      // side stores — see AdminLeavesService.update for why this must not
      // be an email.
      actor_user_id: String(user.id),
    });
  }
}
