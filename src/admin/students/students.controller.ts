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
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AdminStudentsService } from './students.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller('admin/students')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminStudentsController {
  constructor(private readonly service: AdminStudentsService) {}

  @Get()
  list(@Query('school_id') schoolId?: string, @Query('limit') limit?: string) {
    return this.service.list(schoolId, limit);
  }

  @Get(':studentId')
  get(
    @Param('studentId') studentId: string,
    @CurrentUser() currentUser: { id: number; role: Role; schoolId?: string },
  ) {
    return this.service.get(studentId, currentUser);
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.service.create(body);
  }

  @Patch(':studentId')
  update(
    @Param('studentId') studentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.update(studentId, body);
  }

  @Delete(':studentId')
  delete(@Param('studentId') studentId: string) {
    return this.service.delete(studentId);
  }
}
