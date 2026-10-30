import { describeClient, SessionsService } from './sessions.service';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

describe('describeClient', () => {
  it('parses browser, OS and desktop device', () => {
    const d = describeClient({ ip: '8.8.8.8', userAgent: CHROME_MAC });
    expect(d.browser).toMatch(/^Chrome 126/);
    expect(d.os).toMatch(/mac/i);
    expect(d.deviceType).toBe('desktop');
    expect(d.location).not.toBe('Unknown location'); // 8.8.8.8 resolves to US
  });

  it('detects mobile', () => {
    expect(describeClient({ userAgent: SAFARI_IPHONE }).deviceType).toBe(
      'mobile',
    );
  });

  it('falls back safely for private IPs and missing user agent', () => {
    const d = describeClient({ ip: '::ffff:127.0.0.1' });
    expect(d.ip).toBe('127.0.0.1');
    expect(d.location).toBe('Unknown location');
    expect(d.browser).toBe('Unknown browser');
    expect(d.os).toBe('Unknown OS');
  });
});

describe('SessionsService', () => {
  const rows = new Map<string, any>();
  const table = {
    create: jest.fn(async ({ data }) => {
      const r = {
        id: `s${rows.size + 1}`,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        revokedAt: null,
        ...data,
      };
      rows.set(r.id, r);
      return r;
    }),
    findUnique: jest.fn(async ({ where }) => rows.get(where.id) ?? null),
    findMany: jest.fn(async ({ where }) =>
      [...rows.values()].filter(
        (r) =>
          r.subjectType === where.subjectType &&
          (where.subjectId?.in
            ? where.subjectId.in.includes(r.subjectId)
            : r.subjectId === where.subjectId) &&
          !r.revokedAt &&
          (!where.id?.not || r.id !== where.id.not),
      ),
    ),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      for (const r of rows.values()) {
        const hit = where.id?.in
          ? where.id.in.includes(r.id)
          : r.id === where.id &&
            r.subjectType === where.subjectType &&
            r.subjectId === where.subjectId &&
            !r.revokedAt;
        if (hit) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    }),
    update: jest.fn(),
    deleteMany: jest.fn(),
  };
  const cache = new Map<string, string>();
  const redis = {
    set: jest.fn(async (k: string, v: string) => void cache.set(k, v)),
    get: jest.fn(async (k: string) => cache.get(k) ?? null),
  };
  let svc: SessionsService;
  beforeEach(() => {
    rows.clear();
    cache.clear();
    jest.clearAllMocks();
    svc = new SessionsService({ loginSession: table } as never, redis as never);
  });

  it('create → alive; revoke → dead for that session only', async () => {
    const a = await svc.create('lms', 1, {}, 3600);
    const b = await svc.create('lms', 1, {}, 3600);
    expect(await svc.isAlive(a, 'lms', 1)).toBe(true);
    expect(await svc.revoke('lms', 1, a)).toBe(true);
    expect(await svc.isAlive(a, 'lms', 1)).toBe(false);
    expect(await svc.isAlive(b, 'lms', 1)).toBe(true);
  });

  it("cannot revoke or validate another user's session", async () => {
    const a = await svc.create('lms', 1, {}, 3600);
    expect(await svc.revoke('lms', 2, a)).toBe(false);
    expect(await svc.isAlive(a, 'lms', 2)).toBe(false);
    expect(await svc.isAlive(a, 'academy', 1)).toBe(false);
  });

  it('falls back to the DB when Redis is empty or down', async () => {
    const a = await svc.create('lms', 1, {}, 3600);
    cache.clear();
    expect(await svc.isAlive(a, 'lms', 1)).toBe(true);
    redis.get.mockRejectedValueOnce(new Error('down'));
    expect(await svc.isAlive(a, 'lms', 1)).toBe(true);
    rows.get(a).expiresAt = new Date(Date.now() - 1000);
    cache.clear();
    expect(await svc.isAlive(a, 'lms', 1)).toBe(false);
  });

  it('revokeMany spares the current session when asked', async () => {
    const a = await svc.create('lms', 1, {}, 3600);
    const b = await svc.create('lms', 1, {}, 3600);
    const c = await svc.create('lms', 1, {}, 3600);
    expect(await svc.revokeMany('lms', 1, a)).toBe(2);
    expect(await svc.isAlive(a, 'lms', 1)).toBe(true);
    expect(await svc.isAlive(b, 'lms', 1)).toBe(false);
    expect(await svc.isAlive(c, 'lms', 1)).toBe(false);
    expect(await svc.revokeMany('lms', 1)).toBe(1);
    expect(await svc.isAlive(a, 'lms', 1)).toBe(false);
  });

  it('revokeMany accepts several subjects at once (admin bulk deactivate)', async () => {
    const a = await svc.create('lms', 1, {}, 3600);
    const b = await svc.create('lms', 2, {}, 3600);
    const c = await svc.create('lms', 3, {}, 3600);
    expect(await svc.revokeMany('lms', [1, 2])).toBe(2);
    expect(await svc.isAlive(a, 'lms', 1)).toBe(false);
    expect(await svc.isAlive(b, 'lms', 2)).toBe(false);
    expect(await svc.isAlive(c, 'lms', 3)).toBe(true);
    expect(await svc.revokeMany('lms', [])).toBe(0);
  });

  it('notifies listeners (realtime gateway) with the revoked session ids', async () => {
    const a = await svc.create('lms', 1, {}, 3600);
    const b = await svc.create('lms', 1, {}, 3600);
    const seen: string[][] = [];
    svc.onRevoked((sids) => seen.push(sids));
    await svc.revoke('lms', 1, a);
    await svc.revokeMany('lms', 1);
    expect(seen).toEqual([[a], [b]]);
  });
});
