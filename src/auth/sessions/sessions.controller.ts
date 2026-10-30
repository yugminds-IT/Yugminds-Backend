import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth.service';
import { CurrentUser } from '../decorators/current-user.decorator';

type Me = { id: number; sid?: string };

@Controller('auth/sessions')
export class SessionsController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  async list(@CurrentUser() me: Me) {
    return { sessions: await this.auth.listSessions(me.id, me.sid) };
  }

  @HttpCode(200)
  @Post('revoke-others')
  async revokeOthers(@CurrentUser() me: Me) {
    return { revoked: await this.auth.revokeOtherSessions(me.id, me.sid) };
  }

  @HttpCode(200)
  @Post('revoke-all')
  async revokeAll(
    @CurrentUser() me: Me,
    @Res({ passthrough: true }) res: Response,
  ) {
    const revoked = await this.auth.revokeAllSessions(me.id);
    res.clearCookie('refresh_token', { path: '/' });
    return { revoked };
  }

  @Delete(':id')
  async revoke(
    @CurrentUser() me: Me,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.auth.revokeSession(me.id, id);
    return { success: true };
  }
}
