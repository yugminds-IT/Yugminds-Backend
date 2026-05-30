import { Controller, Get, Patch, Body, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { AdminProfileService } from './profile.service';

@Controller('admin/profile')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminProfileController {
  constructor(private readonly service: AdminProfileService) {}

  @Get()
  get(
    @Query('user_id') userId: string | undefined,
    @CurrentUser() user: { id: number },
  ) {
    return this.service.get(userId ? parseInt(userId, 10) : user.id);
  }

  @Patch()
  update(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: { id: number },
  ) {
    return this.service.update(user.id, body);
  }
}
