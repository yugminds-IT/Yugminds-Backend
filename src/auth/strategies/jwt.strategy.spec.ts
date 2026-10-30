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
  const build = (alive: boolean) => {
    const sessions = { isAlive: jest.fn().mockResolvedValue(alive) };
    const strat = new JwtStrategy(
      { get: () => 'secret' } as never,
      { user: { findUnique: jest.fn().mockResolvedValue(user) } } as never,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn() } as never,
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
});
