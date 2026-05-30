import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AdminCoursesService } from './courses.service';

@Controller('admin/courses')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminCoursesController {
  constructor(private readonly service: AdminCoursesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':courseId/versions')
  getVersions(@Param('courseId') courseId: string) {
    return this.service.getVersions(courseId);
  }

  @Get(':courseId/chapters')
  getChapters(@Param('courseId') courseId: string) {
    return this.service.getChapters(courseId);
  }

  @Get(':courseId')
  get(@Param('courseId') courseId: string) {
    return this.service.get(courseId);
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.service.create(body);
  }

  @Post(':courseId/publish')
  publish(
    @Param('courseId') courseId: string,
    @Body() body: { publish?: boolean; changes_summary?: string },
  ) {
    return this.service.publish(courseId, body);
  }

  @Post(':courseId/duplicate')
  duplicate(@Param('courseId') courseId: string) {
    return this.service.duplicate(courseId);
  }

  @Patch(':courseId')
  update(
    @Param('courseId') courseId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.update(courseId, body);
  }

  @Delete(':courseId')
  delete(@Param('courseId') courseId: string) {
    return this.service.delete(courseId);
  }

  @Patch(':courseId/versions')
  revertVersion(
    @Param('courseId') courseId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.revertVersion(
      courseId,
      body as { version_id?: string; version_number?: number },
    );
  }

  @Post(':courseId/chapters')
  addChapter(
    @Param('courseId') courseId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.addChapter(courseId, body);
  }
}
