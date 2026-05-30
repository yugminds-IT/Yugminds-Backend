import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { AdminTeachersService } from './teachers.service';

@Controller('admin/teachers')
@UseGuards(RolesGuard)
@Roles(Role.admin, Role.school_admin)
export class AdminTeachersController {
  constructor(private readonly service: AdminTeachersService) {}

  @Get()
  list(@Query('school_id') schoolId?: string) {
    return this.service.list(schoolId);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentUser() user: { id: number; role: Role; schoolId?: string },
  ) {
    return this.service.get(id, user);
  }

  @Post()
  @Roles(Role.admin) // Only admins can create teachers
  create(@Body() body: Record<string, unknown>) {
    return this.service.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @Roles(Role.admin) // Only admins can delete teachers
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
