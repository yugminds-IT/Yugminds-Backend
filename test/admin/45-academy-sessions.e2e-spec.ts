import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { closePool, pool } from './support/db';

/** Academy device sessions: own account table + cookies, same revoke semantics as the LMS. */
describe('Academy device sessions', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const email = `__qa_academy_${Date.now()}@example.test`;
  const password = 'QaAcademy123!';
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';

  beforeAll(async () => {
    app = await bootstrapApp();
    http = app.getHttpServer();
    await request(http)
      .post('/academy/auth/signup')
      .send({ fullName: 'QA Learner', email, password, phone: '9999999999' })
      .expect(201);
  }, 60000);

  afterAll(async () => {
    const r = await pool.query('SELECT id FROM "AcademyAccount" WHERE email = $1', [email]);
    if (r.rows[0]) {
      await pool.query(`DELETE FROM "LoginSession" WHERE "subjectType"='academy' AND "subjectId"=$1`, [r.rows[0].id]);
      await pool.query('DELETE FROM "AcademyAccount" WHERE id = $1', [r.rows[0].id]);
    }
    if (app) await app.close();
    await closePool();
  }, 30000);

  const cookieOf = (res: request.Response, name: string) =>
    (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${name}=`))!.split(';')[0];

  const login = async (ua: string) => {
    const res = await request(http).post('/academy/auth/login').set('User-Agent', ua).send({ email, password }).expect(200);
    return { at: cookieOf(res, 'ac_at'), rt: cookieOf(res, 'ac_rt') };
  };
  const list = async (c: { at: string }) =>
    (await request(http).get('/academy/auth/sessions').set('Cookie', c.at).expect(200)).body.sessions as Array<{
      id: string;
      current: boolean;
      deviceType: string;
    }>;
  const me = (c: { at: string }) => request(http).get('/academy/auth/me').set('Cookie', c.at);
  const refresh = (c: { rt: string }) => request(http).post('/academy/auth/refresh').set('Cookie', c.rt);

  it('lists devices, flags the current one', async () => {
    const a = await login(CHROME);
    const b = await login(IPHONE);
    const seen = await list(a);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.filter((s) => s.current)).toHaveLength(1);
    expect((await list(b)).find((s) => s.current)!.deviceType).toBe('mobile');
  });

  it("revoking one device kills its access + refresh, not the other's", async () => {
    const a = await login(CHROME);
    const b = await login(IPHONE);
    const bId = (await list(b)).find((s) => s.current)!.id;
    await request(http).delete(`/academy/auth/sessions/${bId}`).set('Cookie', a.at).expect(200);
    await me(b).expect(401);
    await refresh(b).expect(401);
    await me(a).expect(200);
  });

  it('logout ends only the calling device', async () => {
    const a = await login(CHROME);
    const b = await login(IPHONE);
    await request(http).post('/academy/auth/logout').set('Cookie', `${a.at}; ${a.rt}`).expect(200);
    await me(a).expect(401);
    await refresh(a).expect(401);
    await me(b).expect(200);
  });

  it('revoke-others spares this device; revoke-all ends everything', async () => {
    const a = await login(CHROME);
    const b = await login(IPHONE);
    await request(http).post('/academy/auth/sessions/revoke-others').set('Cookie', a.at).expect(200);
    await me(a).expect(200);
    await me(b).expect(401);
    await request(http).post('/academy/auth/sessions/revoke-all').set('Cookie', a.at).expect(200);
    await me(a).expect(401);
    await refresh(a).expect(401);
  });

  it('refresh keeps the same device session', async () => {
    const a = await login(CHROME);
    const before = (await list(a)).find((s) => s.current)!.id;
    const res = await refresh(a).expect(200);
    const next = { at: cookieOf(res, 'ac_at') };
    expect((await list(next)).find((s) => s.current)!.id).toBe(before);
  });

  it('password change signs out other devices but keeps the caller', async () => {
    const a = await login(CHROME);
    const b = await login(IPHONE);
    const res = await request(http)
      .post('/academy/auth/change-password')
      .set('Cookie', a.at)
      .send({ currentPassword: password, newPassword: 'QaAcademy456!' })
      .expect(200);
    await me(b).expect(401);
    await me({ at: cookieOf(res, 'ac_at') }).expect(200);
  });

  it('rejects tokens with no sid and unauthenticated calls', async () => {
    await request(http).get('/academy/auth/sessions').expect(401);
    await request(http).post('/academy/auth/sessions/revoke-all').expect(401);
  });
});
