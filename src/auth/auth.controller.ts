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
import { PasswordResetRequestService } from '../common/password-reset-request/password-reset-request.service';
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
    private readonly passwordResetService: PasswordResetRequestService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
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
  @Throttle({ default: { limit: 5, ttl: 60000 } })
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
  @Throttle({ default: { limit: 10, ttl: 60000 } })
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
  @Throttle({ default: { limit: 5, ttl: 60000 } })
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

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('verify-reset-token')
  async verifyResetToken(
    @Body() body: { requestId?: string; token?: string },
  ): Promise<{ valid: boolean }> {
    // This endpoint allows the frontend to verify a token before showing the password reset form
    const requestId = String(body?.requestId ?? '').trim();
    const token = String(body?.token ?? '').trim();

    if (!requestId || !token) {
      return { valid: false };
    }

    const result = await this.passwordResetService.verifyResetToken(
      requestId,
      token,
    );
    return { valid: result.valid };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('complete-password-reset')
  async completePasswordReset(
    @Body() body: { requestId?: string; token?: string; newPassword?: string },
  ): Promise<{ success: boolean; message: string }> {
    const requestId = String(body?.requestId ?? '').trim();
    const token = String(body?.token ?? '').trim();
    const newPassword = String(body?.newPassword ?? '').trim();

    if (!requestId || !token || !newPassword) {
      throw new UnauthorizedException('Missing required fields');
    }

    await this.passwordResetService.completePasswordReset(
      requestId,
      token,
      newPassword,
    );
    return {
      success: true,
      message:
        'Password reset successfully. You can now log in with your new password.',
    };
  }

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

  @Post('update-password')
  async updatePassword(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      current_password?: string;
      password?: string;
      new_password?: string;
    },
  ): Promise<{ success: boolean }> {
    const currentPassword = String(body?.current_password ?? '').trim();
    const nextPassword = String(
      body?.new_password ?? body?.password ?? '',
    ).trim();
    await this.authService.updatePassword(
      user.id,
      currentPassword,
      nextPassword,
    );
    return { success: true };
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
