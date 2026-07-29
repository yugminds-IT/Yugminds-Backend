import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin school-admins CRUD', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/school-admins lists the fixture school-admin', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/school-admins?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const admins = Array.isArray(list) ? list : (list?.items ?? []);
    expect(
      admins.some((a: { id: string }) => Number(a.id) === fixture.schoolAdmin.id),
    ).toBe(true);
  });

  it('PUT /admin/school-admins changes the password, verified via login AND immediate session invalidation', async () => {
    // Warm the 120s auth cache for this user first (jwt.strategy.ts's
    // cached branch would otherwise keep validating the pre-change
    // tokenVersion until the entry expires on its own).
    await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...authHeader(fixture.schoolAdmin.token))
      .expect(200);

    const newPassword = 'NewQaTest123!';
    await request(app.getHttpServer())
      .put('/admin/school-admins')
      .set(...authHeader(fixture.admin.token))
      .send({
        id: String(fixture.schoolAdmin.id),
        change_password: true,
        temp_password: newPassword,
      })
      .expect(200);

    const oldLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.schoolAdmin.email, password: fixture.schoolAdmin.password });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.schoolAdmin.email, password: newPassword });
    expect(newLogin.status).toBe(201);

    // The pre-change access token must be rejected immediately (tokenVersion
    // bump + auth-cache invalidation), not remain valid until its own
    // ~15min natural expiry.
    await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...authHeader(fixture.schoolAdmin.token))
      .expect(401);
  });

  it('PUT /admin/school-admins deactivation immediately kills an already-issued access token', async () => {
    // Re-login with the (now-changed, from the previous test) password to
    // get a fresh token and re-warm the auth cache.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.schoolAdmin.email, password: 'NewQaTest123!' })
      .expect(201);
    const liveToken: string = login.body?.tokens?.accessToken;
    expect(liveToken).toBeDefined();

    await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...authHeader(liveToken))
      .expect(200);

    await request(app.getHttpServer())
      .put('/admin/school-admins')
      .set(...authHeader(fixture.admin.token))
      .send({ id: String(fixture.schoolAdmin.id), is_active: false })
      .expect(200);

    // jwt.strategy.ts never checks isActive directly — only tokenVersion —
    // so this is the actual mechanism that must fire on deactivation.
    await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...authHeader(liveToken))
      .expect(401);

    // New login attempts are also rejected while deactivated.
    const loginWhileInactive = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.schoolAdmin.email, password: 'NewQaTest123!' });
    expect(loginWhileInactive.status).toBe(401);

    // Reactivate so later tests / fixture teardown aren't affected.
    await request(app.getHttpServer())
      .put('/admin/school-admins')
      .set(...authHeader(fixture.admin.token))
      .send({ id: String(fixture.schoolAdmin.id), is_active: true })
      .expect(200);
  });

  it('creates and deletes a second school-admin (hard delete, no trash entry, live session killed immediately)', async () => {
    const email = `__qa_test_extra_school_admin_${Date.now()}@example.test`;
    const password = 'QaTest123!';
    const createRes = await request(app.getHttpServer())
      .post('/admin/school-admins')
      .set(...authHeader(fixture.admin.token))
      .send({
        email,
        temp_password: password,
        school_id: fixture.schoolId,
        full_name: 'QA Extra School Admin',
      })
      .expect(201);
    const newId: number = createRes.body?.data?.user?.id ?? createRes.body?.user?.id;
    expect(newId).toBeDefined();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const liveToken: string = login.body?.tokens?.accessToken;
    expect(liveToken).toBeDefined();
    // Warm the auth cache before deleting.
    await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...authHeader(liveToken))
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/admin/school-admins?id=${newId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    // A hard-deleted user's already-issued token must stop working right
    // away, not linger for up to the auth cache's 120s TTL.
    await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...authHeader(liveToken))
      .expect(401);

    const trash = await request(app.getHttpServer())
      .get('/admin/trash')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const trashList = trash.body?.data ?? trash.body;
    const students = trashList?.students ?? [];
    const teachers = trashList?.teachers ?? [];
    expect([...students, ...teachers].some((u: { id: number }) => u.id === newId)).toBe(false);
  });
});
