import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { GetRoleService } from './get-role.service';

@SkipThrottle()
@Controller()
@UseGuards(JwtAuthGuard)
export class GetRoleController {
  constructor(private readonly getRoleService: GetRoleService) {}

  @Get('get-role')
  async getRole(@Query('userId') userId: string) {
    return this.getRoleService.getRole(userId);
  }
}
