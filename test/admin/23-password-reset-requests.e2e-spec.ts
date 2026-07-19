import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool, pool } from './support/db';

describe('Admin password-reset-requests approve -> teacher can log in with new password', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let requestId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('teacher submits a password reset request (public endpoint)', async () => {
    await request(app.getHttpServer())
      .post('/auth/password-reset-request')
      .send({ email: fixture.teachers[0].email })
      .expect(201);

    const { rows } = await pool.query(
      `SELECT id FROM "PasswordResetRequest" WHERE "userId" = $1 AND status = 'pending' ORDER BY "createdAt" DESC LIMIT 1`,
      [fixture.teachers[0].id],
    );
    expect(rows.length).toBe(1);
    requestId = rows[0].id;
  });

  it('GET /admin/password-reset-requests lists it as pending', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/password-reset-requests?status=pending')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const items = Array.isArray(list) ? list : (list?.requests ?? list?.items ?? []);
    expect(items.some((r: { id: string }) => r.id === requestId)).toBe(true);
  });

  it('admin approves with a temp password -> teacher can log in with it', async () => {
    const newPassword = 'QaReset123!';
    await request(app.getHttpServer())
      .patch('/admin/password-reset-requests')
      .set(...authHeader(fixture.admin.token))
      .send({ id: requestId, status: 'approved', temp_password: newPassword })
      .expect(200);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.teachers[0].email, password: newPassword });
    expect(login.status).toBe(201);
  });
});
