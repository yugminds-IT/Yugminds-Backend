import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { TeacherLeavesService } from './leaves.service';

@Controller('teacher/leaves')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.teacher)
export class TeacherLeavesController {
  constructor(private readonly service: TeacherLeavesService) {}

  @Post()
  create(
    @CurrentUser() user: { id: number },
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.create(user.id, {
      school_id: body.school_id as string,
      start_date: body.start_date as string,
      end_date: body.end_date as string,
      reason: body.reason as string | undefined,
      substitute_required: body.substitute_required as boolean | undefined,
    });
  }

  @Get()
  list(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
  ) {
    return this.service.list(user.id, schoolId);
  }
}
