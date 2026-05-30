import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AdminSchoolAdminsService } from './school-admins.service';

@Controller('admin')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminSchoolAdminsController {
  constructor(private readonly service: AdminSchoolAdminsService) {}

  @Get('school-admins')
  list(
    @Query('search') _search?: string,
    @Query('status') status?: string,
    @Query('schoolId') schoolId?: string,
  ) {
    return this.service.list({ search: _search, status, schoolId });
  }

  @Post('school-admins')
  create(@Body() body: Record<string, unknown>) {
    return this.service.create(body);
  }

  @Put('school-admins')
  update(@Body() body: Record<string, unknown>) {
    return this.service.update(body);
  }

  @Delete('school-admins')
  async delete(
    @Body() body: { id?: string | number },
    @Query('id') idQuery?: string,
  ) {
    const id = body?.id != null ? String(body.id) : idQuery;
    if (!id || id.trim() === '') {
      return { success: false, message: 'id required' };
    }
    await this.service.delete(id.trim());
    return { success: true };
  }
}
