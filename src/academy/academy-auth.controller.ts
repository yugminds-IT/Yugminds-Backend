import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  HttpCode,
  NotFoundException,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { AcademyRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import {
  SessionsService,
  type SessionMeta,
} from '../auth/sessions/sessions.service';
import { AcademyAuthService } from './academy-auth.service';
import {
  AcademyAuthGuard,
  type AcademyPrincipal,
  clearTokens,
  CurrentAccount,
  issueTokens,
  REFRESH_COOKIE,
  REFRESH_TTL_S,
  verifyToken,
} from './academy-auth';
import {
  AcademyLoginDto,
  AcademySignupDto,
  ChangePasswordDto,
  UpdateProfileDto,
} from './academy.dto';

@Public()
@Controller('academy/auth')
export class AcademyAuthController {
  constructor(
    private readonly auth: AcademyAuthService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
  ) {}

  private meta(req: Request): SessionMeta {
    // req.ip honours `trust proxy`; never parse x-forwarded-for by hand.
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  /** New device session + cookies. */
  private async start(
    req: Request,
    res: Response,
    account: { id: string; role: AcademyRole; tokenVersion: number },
  ) {
    const sid = await this.sessions.create(
      'academy',
      account.id,
      this.meta(req),
      REFRESH_TTL_S,
    );
    await issueTokens(this.jwt, res, account, sid);
  }

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('signup')
  async signup(
    @Body() dto: AcademySignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const account = await this.auth.signup(dto);
    await this.start(req, res, account);
    return this.auth.me(account.id);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() dto: AcademyLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const account = await this.auth.login(dto.email, dto.password);
    await this.start(req, res, account);
    return this.auth.me(account.id);
  }

  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = (req as { cookies?: Record<string, string> }).cookies?.[
      REFRESH_COOKIE
    ];
    const payload = await verifyToken(this.jwt, token, 'refresh');
    // No sid = token from before device sessions existed: force re-login.
    if (
      !payload?.sid ||
      !(await this.sessions.isAlive(payload.sid, 'academy', payload.sub))
    ) {
      clearTokens(res);
      throw new UnauthorizedException('Please log in');
    }
    const account = await this.auth.forRefresh(payload.sub, payload.v);
    await issueTokens(this.jwt, res, account, payload.sid);
    await this.sessions
      .touch(payload.sid, this.meta(req), REFRESH_TTL_S)
      .catch(() => undefined);
    return this.auth.me(account.id);
  }

  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as { cookies?: Record<string, string> }).cookies?.[
      REFRESH_COOKIE
    ];
    const payload = await verifyToken(this.jwt, token, 'refresh');
    // Only this device: other sessions stay signed in.
    if (payload?.sid) {
      await this.sessions
        .revoke('academy', payload.sub, payload.sid)
        .catch(() => undefined);
    }
    clearTokens(res);
    return { ok: true };
  }

  @UseGuards(AcademyAuthGuard)
  @Get('me')
  me(@CurrentAccount() a: AcademyPrincipal) {
    return this.auth.me(a.id);
  }

  @UseGuards(AcademyAuthGuard)
  @Patch('me')
  updateMe(
    @CurrentAccount() a: AcademyPrincipal,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.auth.updateProfile(a.id, dto);
  }

  @UseGuards(AcademyAuthGuard)
  @HttpCode(200)
  @Post('change-password')
  async changePassword(
    @CurrentAccount() a: AcademyPrincipal,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const account = await this.auth.changePassword(
      a.id,
      dto.currentPassword,
      dto.newPassword,
    );
    await this.sessions.revokeMany('academy', account.id);
    await this.start(req, res, account); // keep this device signed in, revoke the rest
    return { ok: true };
  }

  @UseGuards(AcademyAuthGuard)
  @Get('sessions')
  async listSessions(@CurrentAccount() a: AcademyPrincipal) {
    return { sessions: await this.sessions.list('academy', a.id, a.sid) };
  }

  @UseGuards(AcademyAuthGuard)
  @HttpCode(200)
  @Post('sessions/revoke-others')
  async revokeOthers(@CurrentAccount() a: AcademyPrincipal) {
    return { revoked: await this.sessions.revokeMany('academy', a.id, a.sid) };
  }

  @UseGuards(AcademyAuthGuard)
  @HttpCode(200)
  @Post('sessions/revoke-all')
  async revokeAll(
    @CurrentAccount() a: AcademyPrincipal,
    @Res({ passthrough: true }) res: Response,
  ) {
    const revoked = await this.sessions.revokeMany('academy', a.id);
    clearTokens(res);
    return { revoked };
  }

  @UseGuards(AcademyAuthGuard)
  @Delete('sessions/:id')
  async revokeSession(
    @CurrentAccount() a: AcademyPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    if (!(await this.sessions.revoke('academy', a.id, id))) {
      throw new NotFoundException('Session not found');
    }
    return { success: true };
  }
}
