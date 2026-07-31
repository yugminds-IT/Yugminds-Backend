import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { AuthService, AuthResponse } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { SignupDto } from './dto/signup.dto';
import type { CreateUserOptions } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import type { Request, Response } from 'express';

const REFRESH_TOKEN_COOKIE_NAME = 'refresh_token';

function parseExpiryToMs(expiry: string, envName: string): number {
  const v = String(expiry ?? '').trim();
  const match = v.match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new Error(
      `Invalid ${envName} value: "${expiry}". Expected format like 15m, 7d, 30d.`,
    );
  }
  const amount = Number(match[1]);
  const unit = String(match[2]).toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[unit];
}

function getCookieOptions(refreshExpiry: string) {
  return {
    httpOnly: true,
    // Browsers will ignore `Secure` cookies over plain `http://localhost` in dev.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: parseExpiryToMs(refreshExpiry, 'REFRESH_TOKEN_EXPIRY'),
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  // Per-IP (pre-auth). Raised for shared school IPs while keeping signup-spam protection.
  @Throttle({ default: { limit: 50, ttl: 60000 } })
  @Post('signup')
  async signup(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    // Map the public DTO (restricted roles, no isSuperAdmin) to the internal options type.
    const opts: CreateUserOptions = {
      email: dto.email,
      password: dto.password,
      role: dto.role,
      tenantId: dto.tenantId,
    };
    const result = await this.authService.signup(opts);
    const refreshToken = result.tokens.refreshToken;
    if (!refreshToken) throw new UnauthorizedException('Refresh token missing');

    // Set refresh token as httpOnly cookie; do not expose refresh token in JS.
    const refreshExpiry =
      this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';
    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      refreshToken,
      getCookieOptions(refreshExpiry),
    );

    return {
      ...result,
      tokens: { accessToken: result.tokens.accessToken },
    };
  }

  @Public()
  // Per-IP (pre-auth). Raised so a whole computer lab logging in at once isn't
  // blocked, while still capping brute-force attempts from a single IP.
  @Throttle({ default: { limit: 100, ttl: 60000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.authService.login(dto);
    const refreshToken = result.tokens.refreshToken;
    if (!refreshToken) throw new UnauthorizedException('Refresh token missing');

    const refreshExpiry =
      this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';
    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      refreshToken,
      getCookieOptions(refreshExpiry),
    );

    return {
      ...result,
      tokens: { accessToken: result.tokens.accessToken },
    };
  }

  @Public()
  // Per-IP (the refresh cookie carries no access token, so there's no req.user
  // to key on). Token refresh fires automatically for every active session, so
  // many students on one school IP need plenty of headroom.
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const refreshExpiry =
      this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';
    const cookieOptions = getCookieOptions(refreshExpiry);
    const refreshToken = (req as any).cookies?.[REFRESH_TOKEN_COOKIE_NAME] as
      | string
      | undefined;

    if (!refreshToken) {
      // Ensure stale cookie is removed.
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, cookieOptions);
      throw new UnauthorizedException('Refresh token missing');
    }

    try {
      const result = await this.authService.refresh(refreshToken);
      const newRefreshToken = result.tokens.refreshToken;
      if (!newRefreshToken)
        throw new UnauthorizedException('Refresh token missing');

      res.cookie(REFRESH_TOKEN_COOKIE_NAME, newRefreshToken, cookieOptions);

      return {
        ...result,
        tokens: { accessToken: result.tokens.accessToken },
      };
    } catch (err) {
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, cookieOptions);
      throw err;
    }
  }

  @Public()
  @Throttle({ default: { limit: 50, ttl: 60000 } })
  @Post('password-reset-request')
  async passwordResetRequest(
    @Body()
    body: {
      email?: string;
    },
  ): Promise<{ message: string }> {
    // SECURITY: Always return same message to prevent account enumeration
    return this.authService.submitPasswordResetRequest(body?.email ?? '');
  }

  // Keyed per-user (UserOrIpThrottlerGuard), not IP — the global default of
  // 1200 req/min/user is far too generous for a password-guessing endpoint;
  // a leaked/stolen access token would otherwise let an attacker brute-force
  // the account's own current password effectively unthrottled.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('verify-password')
  async verifyPassword(
    @CurrentUser() user: { id: number },
    @Body() body: { current_password: string },
  ): Promise<{ valid: boolean }> {
    return this.authService.verifyPassword(
      user.id,
      body?.current_password ?? '',
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('update-password')
  async updatePassword(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      current_password?: string;
      password?: string;
      new_password?: string;
    },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean; tokens: { accessToken: string } }> {
    const currentPassword = String(body?.current_password ?? '').trim();
    const nextPassword = String(
      body?.new_password ?? body?.password ?? '',
    ).trim();
    const tokens = await this.authService.updatePassword(
      user.id,
      currentPassword,
      nextPassword,
    );

    // The change bumps tokenVersion, invalidating the access token this very
    // request was authenticated with — re-issue a matching refresh cookie +
    // access token so the caller's own session keeps working seamlessly
    // (every OTHER session/device is still force-logged-out).
    const refreshToken = tokens.refreshToken;
    if (!refreshToken) throw new UnauthorizedException('Refresh token missing');
    const refreshExpiry =
      this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';
    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      refreshToken,
      getCookieOptions(refreshExpiry),
    );

    return { success: true, tokens: { accessToken: tokens.accessToken } };
  }

  @Post('logout')
  async logout(
    @CurrentUser() user: { id: number },
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    await this.authService.logout(user.id, dto?.refreshToken);

    const refreshExpiry =
      this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, getCookieOptions(refreshExpiry));
    return { success: true };
  }
}
