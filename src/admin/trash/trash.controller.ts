import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { TrashService, TrashEntityType } from './trash.service';

const VALID_TYPES: TrashEntityType[] = ['students', 'teachers', 'schools', 'courses'];

function assertType(value: unknown): TrashEntityType {
  if (!VALID_TYPES.includes(value as TrashEntityType)) {
    throw new BadRequestException(
      `entity_type must be one of: ${VALID_TYPES.join(', ')}`,
    );
  }
  return value as TrashEntityType;
}

@Controller('admin/trash')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  @Get()
  list() {
    return this.trash.list();
  }

  @Post('restore')
  restore(@Body() body: { entity_type?: string; id?: string }) {
    if (!body?.id) throw new BadRequestException('id is required');
    return this.trash.restore(assertType(body.entity_type), String(body.id));
  }

  @Delete()
  purge(@Query('entity_type') entityType?: string, @Query('id') id?: string) {
    if (!id) throw new BadRequestException('id is required');
    return this.trash.purge(assertType(entityType), id);
  }
}
