import './env';
import jwt from 'jsonwebtoken';

export interface TokenSubject {
  id: number;
  email: string;
  role: 'admin' | 'school_admin' | 'teacher' | 'student';
  isSuperAdmin: boolean;
  tenantId?: string | null;
  tokenVersion: number;
}

/**
 * Mints a valid access token locally with JWT_ACCESS_SECRET, matching the
 * exact payload shape AuthService.generateTokens signs (sub/email/role/
 * isSuperAdmin/tenantId/tokenVersion). Avoids a real POST /auth/login call
 * so tests don't write AuthActivity/audit rows for a login that never
 * happened from the user's perspective.
 */
export function mintAccessToken(subject: TokenSubject): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET not set');
  return jwt.sign(
    {
      sub: subject.id,
      email: subject.email,
      role: subject.role,
      isSuperAdmin: subject.isSuperAdmin,
      tenantId: subject.tenantId ?? undefined,
      tokenVersion: subject.tokenVersion,
    },
    secret,
    { expiresIn: '15m' },
  );
}

export function authHeader(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}
