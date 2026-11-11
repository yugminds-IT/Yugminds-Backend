import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy session check', () => {
  const user = {
    id: 1,
    email: 'a@b.c',
    role: 'teacher',
    isSuperAdmin: false,
    tenantId: 't1',
    tokenVersion: 0,
  };
  const build = (
    alive: boolean,
    o: {
      user?: Record<string, unknown>;
      school?: { isActive: boolean } | null;
      cached?: Record<string, unknown> | null;
    } = {},
  ) => {
    const sessions = { isAlive: jest.fn().mockResolvedValue(alive) };
    const strat = new JwtStrategy(
      { get: () => 'secret' } as never,
      {
        user: {
          findUnique: jest.fn().mockResolvedValue({ ...user, ...o.user }),
        },
        school: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              o.school === undefined ? { isActive: true } : o.school,
            ),
        },
      } as never,
      {
        get: jest.fn().mockResolvedValue(o.cached ?? null),
        set: jest.fn(),
      } as never,
      sessions as never,
    );
    return { strat, sessions };
  };
  const payload = {
    sub: 1,
    email: 'a@b.c',
    role: 'teacher' as const,
    isSuperAdmin: false,
    tokenVersion: 0,
  };

  it('accepts a live session and exposes sid', async () => {
    const { strat } = build(true);
    await expect(
      strat.validate({ ...payload, sid: 's1' }),
    ).resolves.toMatchObject({ id: 1, sid: 's1' });
  });

  it('rejects a revoked session', async () => {
    const { strat } = build(false);
    await expect(strat.validate({ ...payload, sid: 's1' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects tokens without sid (pre-feature logins)', async () => {
    const { strat, sessions } = build(true);
    await expect(strat.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(sessions.isAlive).not.toHaveBeenCalled();
  });

  it('lets impersonation tokens through without a session', async () => {
    const { strat, sessions } = build(false);
    await expect(
      strat.validate({ ...payload, impersonatorId: 9 }),
    ).resolves.toMatchObject({ id: 1 });
    expect(sessions.isAlive).not.toHaveBeenCalled();
  });

  it('keeps the impersonator on the user, so what an admin does as someone else can be traced to the admin', async () => {
    const { strat } = build(false);
    await expect(
      strat.validate({ ...payload, impersonatorId: 9 }),
    ).resolves.toMatchObject({ id: 1, impersonatorId: 9 });
    const normal = build(true);
    expect(
      (await normal.strat.validate({ ...payload, sid: 's1' })).impersonatorId,
    ).toBeUndefined();
  });

  describe('deactivated accounts are rejected per request, not only at login', () => {
    const live = { ...payload, sid: 's1' };

    it('rejects a deactivated user', async () => {
      const { strat } = build(true, { user: { isActive: false } });
      await expect(strat.validate(live)).rejects.toThrow(/inactive/);
    });

    it('rejects a user of a deactivated school', async () => {
      const { strat } = build(true, { school: { isActive: false } });
      await expect(strat.validate(live)).rejects.toThrow(/inactive/);
    });

    it('still lets a global admin through even if no school is active', async () => {
      const { strat } = build(true, {
        user: { role: 'admin', tenantId: null },
        school: { isActive: false },
      });
      await expect(
        strat.validate({ ...live, role: 'admin' }),
      ).resolves.toMatchObject({
        id: 1,
      });
    });

    it('rejects from the cache when the cached entry says inactive', async () => {
      const { strat } = build(true, {
        cached: {
          tokenVersion: 0,
          tenantId: 't1',
          role: 'teacher',
          isSuperAdmin: false,
          active: false,
        },
      });
      await expect(strat.validate(live)).rejects.toThrow(/inactive/);
    });
  });
});
