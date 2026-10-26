import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { AcademyAuthService } from './academy-auth.service';
import {
  AcademyAuthGuard,
  type AcademyPrincipal,
  clearTokens,
  CurrentAccount,
  issueTokens,
  REFRESH_COOKIE,
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
  ) {}

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('signup')
  async signup(
    @Body() dto: AcademySignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const account = await this.auth.signup(dto);
    await issueTokens(this.jwt, res, account);
    return this.auth.me(account.id);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() dto: AcademyLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const account = await this.auth.login(dto.email, dto.password);
    await issueTokens(this.jwt, res, account);
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
    if (!payload) {
      clearTokens(res);
      throw new UnauthorizedException('Please log in');
    }
    const account = await this.auth.forRefresh(payload.sub, payload.v);
    await issueTokens(this.jwt, res, account);
    return this.auth.me(account.id);
  }

  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as { cookies?: Record<string, string> }).cookies?.[
      REFRESH_COOKIE
    ];
    const payload = await verifyToken(this.jwt, token, 'refresh');
    if (payload) await this.auth.revokeAll(payload.sub).catch(() => undefined);
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
    @Res({ passthrough: true }) res: Response,
  ) {
    const account = await this.auth.changePassword(
      a.id,
      dto.currentPassword,
      dto.newPassword,
    );
    await issueTokens(this.jwt, res, account); // keep this device signed in, revoke the rest
    return { ok: true };
  }
}
