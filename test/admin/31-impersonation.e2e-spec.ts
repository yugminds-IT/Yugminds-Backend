import request from 'supertest';
import jwt from 'jsonwebtoken';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin impersonation', () => {
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

  it('mints a 15-minute token with impersonator claims that can call a teacher-scoped route', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/impersonate')
      .set(...authHeader(fixture.admin.token))
      .send({ user_id: fixture.teachers[0].id })
      .expect(201);

    const token = res.body?.accessToken ?? res.body?.data?.accessToken;
    expect(token).toBeDefined();
    expect(res.body?.expiresIn ?? res.body?.data?.expiresIn).toBe(15 * 60);

    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.sub).toBe(fixture.teachers[0].id);
    expect(decoded.role).toBe('teacher');
    expect(decoded.tenantId).toBe(fixture.schoolId);
    expect(decoded.impersonatorId).toBe(fixture.admin.id);
    expect(decoded.exp - decoded.iat).toBe(15 * 60);

    await request(app.getHttpServer())
      .get('/teacher/dashboard')
      .set('Authorization', `Bearer ${token}`)
      .then((r) => expect([200, 404]).toContain(r.status));
  });

  it('the admin\'s own token still works after impersonating (session untouched)', async () => {
    await request(app.getHttpServer())
      .get('/admin/stats')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
  });

  it('rejects impersonating another admin', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/impersonate')
      .set(...authHeader(fixture.admin.token))
      .send({ user_id: fixture.admin.id });
    expect(res.status).toBe(403);
  });

  it('rejects impersonating an inactive/deleted user', async () => {
    // Soft-delete a throwaway student then try to impersonate them.
    await request(app.getHttpServer())
      .delete(`/admin/students/${fixture.students[2].id}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/admin/impersonate')
      .set(...authHeader(fixture.admin.token))
      .send({ user_id: fixture.students[2].id });
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin caller', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/impersonate')
      .set(...authHeader(fixture.teachers[1].token))
      .send({ user_id: fixture.students[0].id });
    expect(res.status).toBe(403);
  });
});
