import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { TeacherReportsService } from './reports.service';

@Controller('teacher/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.teacher)
export class TeacherReportsController {
  constructor(private readonly service: TeacherReportsService) {}

  @Post()
  create(
    @CurrentUser() user: { id: number },
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.create(user.id, {
      school_id: body.school_id as string,
      grade: body.grade as string | undefined,
      date: body.date as string,
      period_id: body.period_id as string | undefined,
      start_time: body.start_time as string | undefined,
      end_time: body.end_time as string | undefined,
      topics_taught: body.topics_taught as string | undefined,
      activities: body.activities as string | undefined,
      notes: body.notes as string | undefined,
    });
  }

  @Get()
  list(
    @CurrentUser() user: { id: number },
    @Query() query: Record<string, string>,
  ) {
    return this.service.list(user.id, {
      school_id: query.school_id,
      date: query.date,
      from: query.from,
      to: query.to,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });
  }
}
