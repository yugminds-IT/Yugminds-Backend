import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ProfileService } from './profile.service';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly service: ProfileService) {}

  // Always the caller's own profile. A client-supplied ?userId used to be honoured,
  // which let any logged-in user read any other user's row; the param is accepted
  // (old clients still send their own id) but ignored.
  @Get()
  get(@CurrentUser() user: { id: number }) {
    return this.service.get(user.id);
  }

  @Patch()
  update(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: { id: number },
  ) {
    return this.service.update(user.id, body);
  }
}
