import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { closePool, pool } from './support/db';

/**
 * Devices & sessions: every login is a LoginSession; revoking one ends that
 * device's access AND refresh tokens, and only that device's.
 */
describe('Device sessions (login tracking + revoke)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let http: ReturnType<INestApplication['getHttpServer']>;

  const CHROME_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const SAFARI_IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  beforeAll(async () => {
    app = await bootstrapApp();
    http = app.getHttpServer();
    fixture = await createQaFixture(app);
  }, 120000);

  afterAll(async () => {
    if (fixture) {
      await pool.query(
        `DELETE FROM "LoginSession" WHERE "subjectType"='lms' AND "subjectId" = ANY($1)`,
        [[fixture.teachers[0].id, fixture.teachers[1].id].map(String)],
      );
    }
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  const login = async (ua: string, who = fixture.teachers[0]) => {
    const res = await request(http)
      .post('/auth/login')
      .set('User-Agent', ua)
      .send({ email: who.email, password: who.password })
      .expect(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;
    return {
      access: res.body.tokens.accessToken as string,
      refresh: cookie.split(';')[0].slice('refresh_token='.length),
    };
  };
  const bearer = (t: string): [string, string] => ['Authorization', `Bearer ${t}`];
  const list = async (t: string) =>
    (await request(http).get('/auth/sessions').set(...bearer(t)).expect(200)).body
      .sessions as Array<{ id: string; current: boolean; browser: string; os: string; deviceType: string }>;
  const refresh = (rt: string) =>
    request(http).post('/auth/refresh').send({ refreshToken: rt });
  const me = (t: string) => request(http).get('/auth/sessions').set(...bearer(t));

  it('lists each login as its own device, flags the current one, and parses the user agent', async () => {
    const laptop = await login(CHROME_MAC);
    const phone = await login(SAFARI_IPHONE);
    const seenFromLaptop = await list(laptop.access);
    expect(seenFromLaptop.length).toBeGreaterThanOrEqual(2);
    const current = seenFromLaptop.filter((s) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0].browser).toMatch(/Chrome/);
    expect(seenFromLaptop.some((s) => s.deviceType === 'mobile')).toBe(true);
    const seenFromPhone = await list(phone.access);
    expect(seenFromPhone.find((s) => s.current)!.deviceType).toBe('mobile');
  });

  it("revoking one device kills that device's access + refresh tokens, not the other's", async () => {
    const a = await login(CHROME_MAC);
    const b = await login(SAFARI_IPHONE);
    const bId = (await list(b.access)).find((s) => s.current)!.id;

    await request(http).delete(`/auth/sessions/${bId}`).set(...bearer(a.access)).expect(200);

    await me(b.access).expect(401); // access token dies immediately
    await refresh(b.refresh).expect(401); // and can't be refreshed back to life
    await me(a.access).expect(200); // other device untouched
  });

  it("cannot revoke someone else's session (404) or a malformed id (400)", async () => {
    const mine = await login(CHROME_MAC, fixture.teachers[0]);
    const theirs = await login(CHROME_MAC, fixture.teachers[1]);
    const theirId = (await list(theirs.access)).find((s) => s.current)!.id;
    await request(http).delete(`/auth/sessions/${theirId}`).set(...bearer(mine.access)).expect(404);
    await me(theirs.access).expect(200);
    await request(http).delete('/auth/sessions/not-a-uuid').set(...bearer(mine.access)).expect(400);
  });

  it('revoke-others keeps this device only', async () => {
    const a = await login(CHROME_MAC);
    const b = await login(SAFARI_IPHONE);
    const c = await login(CHROME_MAC);
    await request(http).post('/auth/sessions/revoke-others').set(...bearer(a.access)).expect(200);
    await me(a.access).expect(200);
    await me(b.access).expect(401);
    await me(c.access).expect(401);
    expect(await list(a.access)).toHaveLength(1);
  });

  it('revoke-all ends every device including the caller', async () => {
    const a = await login(CHROME_MAC);
    const b = await login(SAFARI_IPHONE);
    await request(http).post('/auth/sessions/revoke-all').set(...bearer(a.access)).expect(200);
    await me(a.access).expect(401);
    await me(b.access).expect(401);
    await refresh(a.refresh).expect(401);
    await refresh(b.refresh).expect(401);
  });

  it('logout ends only the calling device (other devices stay signed in)', async () => {
    const a = await login(CHROME_MAC);
    const b = await login(SAFARI_IPHONE);
    await request(http).post('/auth/logout').set(...bearer(a.access)).expect(201);
    await me(a.access).expect(401);
    await refresh(a.refresh).expect(401);
    await me(b.access).expect(200);
  });

  it('refresh rotates the token but keeps the same device session', async () => {
    const a = await login(CHROME_MAC);
    const before = (await list(a.access)).find((s) => s.current)!.id;
    const res = await refresh(a.refresh).expect(201);
    const after = (await list(res.body.tokens.accessToken)).find((s) => s.current)!.id;
    expect(after).toBe(before);
  });

  it('changing the password signs out other devices but keeps the caller signed in', async () => {
    const user = fixture.teachers[1];
    await pool.query('UPDATE "User" SET "mustChangePassword" = false WHERE id = $1', [user.id]);
    const a = await login(CHROME_MAC, user);
    const b = await login(SAFARI_IPHONE, user);
    const res = await request(http)
      .post('/auth/update-password')
      .set(...bearer(a.access))
      .send({ current_password: user.password, new_password: 'NewQaPass123!' })
      .expect(201);
    await me(b.access).expect(401);
    await me(res.body.tokens.accessToken).expect(200);
    user.password = 'NewQaPass123!';
  });

  it('rejects tokens with no sid (logins from before this feature)', async () => {
    const u = fixture.teachers[0];
    const old = jwt.sign(
      { sub: u.id, email: u.email, role: 'teacher', isSuperAdmin: false, tenantId: fixture.schoolId, tokenVersion: 0 },
      process.env.JWT_ACCESS_SECRET!,
      { expiresIn: '15m' },
    );
    await me(old).expect(401);
  });

  it('requires auth on every sessions endpoint', async () => {
    await request(http).get('/auth/sessions').expect(401);
    await request(http).post('/auth/sessions/revoke-all').expect(401);
  });
});
