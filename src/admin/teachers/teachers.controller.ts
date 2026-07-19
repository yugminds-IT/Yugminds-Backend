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
  list(
    @Query('school_id') schoolId?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    const parsed = limit ? parseInt(limit, 10) : undefined;
    return this.service.list(
      schoolId,
      parsed && parsed > 0 ? parsed : undefined,
      { page, search, sort, order },
    );
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentUser() user: { id: number; role: Role; tenantId?: string },
  ) {
    return this.service.get(id, user);
  }

  @Post()
  @Roles(Role.admin) // Only admins can create teachers
  create(@Body() body: Record<string, unknown>) {
    return this.service.create(body);
  }

  @Post('bulk')
  @Roles(Role.admin)
  bulk(@Body() body: { action?: string; teacher_ids?: Array<number | string> }) {
    return this.service.bulk(body);
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
