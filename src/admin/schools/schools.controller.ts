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
import { Role } from '@prisma/client';
import { AdminSchoolsService } from './schools.service';

@Controller('admin/schools')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminSchoolsController {
  constructor(private readonly service: AdminSchoolsService) {}

  @Get()
  list(
    @Query('school_id') schoolId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '50', 10) || 50, 200);
    const skip = parseInt(offset ?? '0', 10) || 0;
    return this.service.list(schoolId, take, skip);
  }

  @Get(':id/teacher-assignments')
  getTeacherAssignments(@Param('id') id: string) {
    return this.service.getTeacherAssignments(id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() body: { name: string; domain: string }) {
    return this.service.create(body);
  }

  // Support frontend client that sends PUT /admin/schools with { id, ...data }
  @Put()
  updateByBody(@Body() body: { id: string; name?: string; domain?: string }) {
    return this.service.update(body);
  }

  @Post(':id/init-academic-structure')
  initAcademicStructure(@Param('id') id: string) {
    return this.service.initAcademicStructure(id);
  }

  @Delete(':id')
  deleteById(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
