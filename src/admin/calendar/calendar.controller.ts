import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { AdminCalendarService } from './calendar.service';

@SkipThrottle()
@Controller('admin/calendar')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminCalendarController {
  constructor(private readonly service: AdminCalendarService) {}

  @Get()
  list(
    @Query('school_id') schoolId?: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('academic_year') academicYear?: string,
    @Query('type') type?: string,
  ) {
    return this.service.list({
      school_id: schoolId,
      year,
      month,
      academic_year: academicYear,
      type,
    });
  }

  /**
   * Per school: which weekdays (0=Sun..6=Sat) at least one teacher was
   * actually assigned to work there, as of `date` (defaults to today) —
   * resolved from working-days history so this stays correct for a past
   * date even after a teacher's schedule has since changed.
   */
  @Get('active-weekdays')
  activeWeekdays(@Query('date') date?: string) {
    const resolved = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
    return this.service.getActiveWeekdaysBySchool(resolved);
  }

  /**
   * Per school, the exact dates in a given month that were an active
   * working day for at least one teacher — resolved day-by-day, so a
   * mid-month working-days change is reflected precisely instead of one
   * flat pattern approximating the whole month. Used by the calendar grid.
   */
  @Get('active-dates')
  activeDates(@Query('year') year: string, @Query('month') month: string) {
    return this.service.getActiveDatesBySchoolForMonth(
      parseInt(year, 10),
      parseInt(month, 10),
    );
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      school_id?: string;
      apply_to_all_schools?: boolean;
      date: string;
      end_date?: string;
      name: string;
      type: string;
      academic_year?: string;
      description?: string;
    },
  ) {
    return this.service.create(user.id, body);
  }

  @Post('mark-today')
  markToday(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      school_id?: string;
      apply_to_all_schools?: boolean;
      name: string;
      type?: string;
      description?: string;
      academic_year?: string;
    },
  ) {
    return this.service.markToday(user.id, body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      date?: string;
      end_date?: string | null;
      name?: string;
      type?: string;
      academic_year?: string;
      description?: string | null;
    },
  ) {
    return this.service.update(id, body);
  }

  @Delete('batch/:batchId')
  removeBatch(@Param('batchId') batchId: string) {
    return this.service.removeBatch(batchId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
