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

  it('PUT /admin/school-admins changes the password (verified via login)', async () => {
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

    // Note: this endpoint only revokes refresh tokens (RefreshTokenStore),
    // it does NOT bump the user's tokenVersion the way student/teacher
    // deletes do — so an already-issued access token stays valid until its
    // own ~15min expiry rather than being force-invalidated immediately.
    // Verify the change actually took effect via login instead.
    const oldLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.schoolAdmin.email, password: fixture.schoolAdmin.password });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.schoolAdmin.email, password: newPassword });
    expect(newLogin.status).toBe(201);
  });

  it('creates and deletes a second school-admin (hard delete, no trash entry)', async () => {
    const email = `__qa_test_extra_school_admin_${Date.now()}@example.test`;
    const createRes = await request(app.getHttpServer())
      .post('/admin/school-admins')
      .set(...authHeader(fixture.admin.token))
      .send({
        email,
        temp_password: 'QaTest123!',
        school_id: fixture.schoolId,
        full_name: 'QA Extra School Admin',
      })
      .expect(201);
    const newId: number = createRes.body?.data?.user?.id ?? createRes.body?.user?.id;
    expect(newId).toBeDefined();

    await request(app.getHttpServer())
      .delete(`/admin/school-admins?id=${newId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

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
