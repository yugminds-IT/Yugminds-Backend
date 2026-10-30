import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  AcademyAuthGuard,
  ACCESS_COOKIE,
  issueTokens,
  REFRESH_COOKIE,
  verifyToken,
} from './academy-auth';

describe('Academy auth tokens', () => {
  const jwt = new JwtService({});
  const account = { id: 'acc-1', role: 'LEARNER' as const, tokenVersion: 3 };
  beforeAll(() => {
    process.env.ACADEMY_JWT_SECRET = 'x'.repeat(40);
  });

  const issue = async () => {
    const cookies: Record<
      string,
      { value: string; opts: Record<string, unknown> }
    > = {};
    const res = {
      cookie: (n: string, value: string, opts: Record<string, unknown>) =>
        (cookies[n] = { value, opts }),
    };
    await issueTokens(jwt, res as never, account, 'sid-1');
    return cookies;
  };

  it('sets httpOnly lax cookies; refresh cookie only on the auth path', async () => {
    const c = await issue();
    expect(c[ACCESS_COOKIE].opts).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(c[REFRESH_COOKIE].opts).toMatchObject({
      httpOnly: true,
      path: '/api/academy/auth',
    });
  });

  it('access and refresh tokens are not interchangeable', async () => {
    const c = await issue();
    expect(
      await verifyToken(jwt, c[ACCESS_COOKIE].value, 'access'),
    ).toMatchObject({ sub: 'acc-1', v: 3 });
    expect(
      await verifyToken(jwt, c[ACCESS_COOKIE].value, 'refresh'),
    ).toBeNull();
    expect(
      await verifyToken(jwt, c[REFRESH_COOKIE].value, 'access'),
    ).toBeNull();
  });

  it('rejects tokens signed with another secret (e.g. the LMS one)', async () => {
    const foreign = await jwt.signAsync(
      { sub: 'acc-1', role: 'ADMIN', v: 0, typ: 'access' },
      { secret: 'y'.repeat(40) },
    );
    expect(await verifyToken(jwt, foreign, 'access')).toBeNull();
  });

  describe('AcademyAuthGuard', () => {
    let alive = true;
    beforeEach(() => (alive = true));
    const ctx = (cookie: string | undefined, roles?: string[]) => {
      const req: Record<string, unknown> = {
        headers: {},
        cookies: cookie ? { [ACCESS_COOKIE]: cookie } : {},
      };
      const reflector = {
        getAllAndOverride: () => roles,
      } as unknown as Reflector;
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => null,
        getClass: () => null,
      } as unknown as ExecutionContext;
      const sessions = { isAlive: async () => alive } as never;
      return {
        guard: new AcademyAuthGuard(jwt, reflector, sessions),
        context,
        req,
      };
    };

    it('admits a valid account and never sets req.user (keeps LMS tenant logic out)', async () => {
      const token = (await issue())[ACCESS_COOKIE].value;
      const { guard, context, req } = ctx(token, ['LEARNER']);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.academy).toEqual({
        id: 'acc-1',
        role: 'LEARNER',
        sid: 'sid-1',
      });
      expect(req.user).toBeUndefined();
    });

    it('401 once the session is revoked, even with a valid token', async () => {
      const token = (await issue())[ACCESS_COOKIE].value;
      alive = false;
      const { guard, context } = ctx(token);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('401 for a token with no sid (issued before device sessions)', async () => {
      const old = await jwt.signAsync(
        { sub: 'acc-1', role: 'LEARNER', v: 3, typ: 'access' },
        { secret: process.env.ACADEMY_JWT_SECRET },
      );
      const { guard, context } = ctx(old);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('401 without a token, 403 for the wrong role', async () => {
      await expect(
        ctx(undefined).guard.canActivate(ctx(undefined).context),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      const token = (await issue())[ACCESS_COOKIE].value;
      const { guard, context } = ctx(token, ['ADMIN']);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
