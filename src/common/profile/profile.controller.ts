import { Controller, Get, Patch, Body, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ProfileService } from './profile.service';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly service: ProfileService) {}

  @Get()
  get(
    @Query('userId') userId: string | undefined,
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
