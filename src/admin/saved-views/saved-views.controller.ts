import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role, Prisma } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DatabaseService } from '../../database/database.service';

/**
 * Per-admin named filter/sort presets for admin data tables. The `state`
 * payload is owned by the frontend; the backend only stores and scopes it.
 */
@Controller('admin/saved-views')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class SavedViewsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('table_key') tableKey?: string,
  ) {
    if (!tableKey) throw new BadRequestException('table_key is required');
    return this.db.adminSavedView.findMany({
      where: { userId: user.id, tableKey },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  @Post()
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      table_key?: string;
      name?: string;
      state?: Record<string, unknown>;
      is_default?: boolean;
    },
  ) {
    const tableKey = String(body.table_key ?? '').trim();
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!tableKey || !name) {
      throw new BadRequestException('table_key and name are required');
    }
    if (!body.state || typeof body.state !== 'object') {
      throw new BadRequestException('state must be an object');
    }
    if (body.is_default) {
      await this.db.adminSavedView.updateMany({
        where: { userId: user.id, tableKey },
        data: { isDefault: false },
      });
    }
    return this.db.adminSavedView.upsert({
      where: {
        userId_tableKey_name: { userId: user.id, tableKey, name },
      },
      create: {
        userId: user.id,
        tableKey,
        name,
        state: body.state as Prisma.InputJsonValue,
        isDefault: !!body.is_default,
      },
      update: {
        state: body.state as Prisma.InputJsonValue,
        isDefault: !!body.is_default,
      },
    });
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ) {
    // Scope delete to the owner so one admin can't remove another's views.
    await this.db.adminSavedView.deleteMany({
      where: { id, userId: user.id },
    });
    return { success: true };
  }
}
