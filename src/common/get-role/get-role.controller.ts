import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { GetRoleService } from './get-role.service';

@SkipThrottle()
@Controller()
@UseGuards(JwtAuthGuard)
export class GetRoleController {
  constructor(private readonly getRoleService: GetRoleService) {}

  // Role lookup is for the caller only; the userId query param is ignored (it
  // used to expose email / role / super-admin status of any user id).
  @Get('get-role')
  async getRole(@CurrentUser() user: { id: number }) {
    return this.getRoleService.getRole(String(user.id));
  }
}
