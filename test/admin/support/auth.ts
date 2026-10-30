import './env';
import jwt from 'jsonwebtoken';
import { execFileSync } from 'child_process';

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
 * isSuperAdmin/tenantId/tokenVersion/sid). Avoids a real POST /auth/login call
 * so tests don't write AuthActivity/audit rows for a login that never
 * happened from the user's perspective.
 */
/**
 * Tokens now need a live LoginSession (the `sid` claim). mintAccessToken is
 * called synchronously all over the suites, so create the row with a
 * synchronous psql call instead of making every caller async.
 */
function createSessionRow(subject: TokenSubject): string {
  const out = execFileSync(
    'psql',
    [
      process.env.DATABASE_URL!,
      '-tAqX',
      '-c',
      `INSERT INTO "LoginSession" (id, "subjectType", "subjectId", "expiresAt")
       VALUES (gen_random_uuid()::text, 'lms', '${Number(subject.id)}', NOW() + interval '1 day')
       RETURNING id`,
    ],
    { encoding: 'utf8' },
  );
  return out.split('\n')[0].trim();
}

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
      sid: createSessionRow(subject),
    },
    secret,
    { expiresIn: '15m' },
  );
}

export function authHeader(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}
