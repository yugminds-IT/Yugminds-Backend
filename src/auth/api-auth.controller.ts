import { Body, Controller, Post, Res } from '@nestjs/common';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { LogoutDto } from './dto/logout.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

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

@Controller('api/auth')
export class ApiAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

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

  @Post('reset-password')
  async resetPassword(
    @CurrentUser() user: { id: number },
    @Body() dto: ResetPasswordDto,
  ): Promise<{ success: boolean }> {
    await this.authService.resetPassword(user.id, dto.password);
    return { success: true };
  }
}
