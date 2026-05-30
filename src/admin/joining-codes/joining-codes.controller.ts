import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AdminJoiningCodesService } from './joining-codes.service';

@Controller('admin/joining-codes')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminJoiningCodesController {
  constructor(private readonly service: AdminJoiningCodesService) {}

  @Get()
  list(@Query('schoolId') schoolId?: string) {
    return this.service.list({ schoolId });
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.service.create(body);
  }

  @Patch()
  update(@Body() body: Record<string, unknown>) {
    return this.service.update(body);
  }
}
