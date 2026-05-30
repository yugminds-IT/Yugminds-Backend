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
import { SchoolCalendarService } from './school-calendar.service';

@SkipThrottle()
@Controller('school-admin/calendar')
@UseGuards(RolesGuard)
@Roles(Role.school_admin)
export class SchoolCalendarController {
  constructor(private readonly service: SchoolCalendarService) {}

  @Get()
  list(
    @CurrentUser() user: { id: number },
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('academic_year') academicYear?: string,
  ) {
    return this.service.list(user.id, { year, month, academicYear });
  }

  @Post()
  create(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
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

  @Patch(':id')
  update(
    @CurrentUser() user: { id: number },
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
    return this.service.update(user.id, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: { id: number }, @Param('id') id: string) {
    return this.service.remove(user.id, id);
  }
}
