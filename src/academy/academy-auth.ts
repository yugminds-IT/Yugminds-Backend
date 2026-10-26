import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AcademyRole } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * Academy auth is independent of the LMS: own secret, own cookies, own
 * accounts table. Academy routes are @Public() to the LMS JwtAuthGuard and
 * guarded by AcademyAuthGuard instead; it sets `req.academy`, never `req.user`,
 * so LMS tenant/role machinery never runs for Academy requests.
 */

export const ACCESS_COOKIE = 'ac_at';
export const REFRESH_COOKIE = 'ac_rt';
// Browser-visible path of the auth routes (through the Next /api proxy).
export const REFRESH_COOKIE_PATH = '/api/academy/auth';
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;

export type AcademyPrincipal = { id: string; role: AcademyRole };
type TokenPayload = {
  sub: string;
  role: AcademyRole;
  v: number;
  typ: 'access' | 'refresh';
};

export function academySecret(): string {
  const s = process.env.ACADEMY_JWT_SECRET;
  if (!s || s.length < 32)
    throw new UnauthorizedException('Academy auth is not configured');
  return s;
}

export async function issueTokens(
  jwt: JwtService,
  res: Response,
  account: { id: string; role: AcademyRole; tokenVersion: number },
) {
  const base = { sub: account.id, role: account.role, v: account.tokenVersion };
  const secret = academySecret();
  const [access, refresh] = await Promise.all([
    jwt.signAsync(
      { ...base, typ: 'access' },
      { secret, expiresIn: ACCESS_TTL_S },
    ),
    jwt.signAsync(
      { ...base, typ: 'refresh' },
      { secret, expiresIn: REFRESH_TTL_S },
    ),
  ]);
  const common = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax + no state-changing GET routes = cross-site POSTs never carry the cookie.
    sameSite: 'lax' as const,
  };
  res.cookie(ACCESS_COOKIE, access, {
    ...common,
    path: '/',
    maxAge: ACCESS_TTL_S * 1000,
  });
  res.cookie(REFRESH_COOKIE, refresh, {
    ...common,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TTL_S * 1000,
  });
}

export function clearTokens(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

export async function verifyToken(
  jwt: JwtService,
  token: string | undefined,
  typ: TokenPayload['typ'],
): Promise<TokenPayload | null> {
  if (!token) return null;
  try {
    const p = await jwt.verifyAsync<TokenPayload>(token, {
      secret: academySecret(),
    });
    return p.typ === typ ? p : null;
  } catch {
    return null;
  }
}

const ROLES_KEY = 'academyRoles';
/** Roles allowed on an Academy route. No decorator = any signed-in Academy account. */
export const AcademyRoles = (...roles: AcademyRole[]) =>
  SetMetadata(ROLES_KEY, roles);

/** Signed-in Academy account (set by AcademyAuthGuard). */
export const CurrentAccount = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AcademyPrincipal =>
    ctx.switchToHttp().getRequest<{ academy: AcademyPrincipal }>().academy,
);

@Injectable()
export class AcademyAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { academy?: AcademyPrincipal }>();
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const cookies = (req as { cookies?: Record<string, string> }).cookies ?? {};
    // ponytail: access tokens are stateless for 15 min; deactivation/revocation is
    // enforced at refresh. Check tokenVersion per request if instant revoke is needed.
    const payload = await verifyToken(
      this.jwt,
      cookies[ACCESS_COOKIE] ?? bearer,
      'access',
    );
    if (!payload) throw new UnauthorizedException('Please log in');
    req.academy = { id: payload.sub, role: payload.role };

    const roles = this.reflector.getAllAndOverride<AcademyRole[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (roles?.length && !roles.includes(payload.role)) {
      throw new ForbiddenException('Not allowed for this account');
    }
    return true;
  }
}
