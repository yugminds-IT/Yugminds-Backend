import { Body, Controller, Post, UseGuards, BadRequestException } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AuthService } from '../../auth/auth.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';

@Controller('admin/impersonate')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class ImpersonationController {
  constructor(private readonly auth: AuthService) {}

  @Post()
  impersonate(
    @CurrentUser() admin: CurrentUserPayload,
    @Body() body: { user_id?: number | string },
  ) {
    const targetId = parseInt(String(body?.user_id ?? ''), 10);
    if (!targetId) throw new BadRequestException('user_id is required');
    return this.auth.impersonate({ id: admin.id, email: admin.email }, targetId);
  }
}
