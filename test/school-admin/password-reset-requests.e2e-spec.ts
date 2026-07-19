import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin password-reset-requests', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('approve flow: student submits a reset request, school-admin approves it with a temp password', async () => {
    await request(app.getHttpServer())
      .post('/auth/password-reset-request')
      .send({ email: fixture.students[0].email })
      .expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'pending' })
      .expect(200);
    const found = listRes.body.requests.find(
      (r: any) => r.email === fixture.students[0].email,
    );
    expect(found).toBeTruthy();

    const patchRes = await request(app.getHttpServer())
      .patch('/school-admin/password-reset-requests')
      .set(...auth)
      .send({ id: found.id, status: 'approved', temp_password: 'QaTemp123!' })
      .expect(200);
    expect(patchRes.body.success).toBe(true);

    const afterRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'approved' })
      .expect(200);
    expect(afterRes.body.requests.some((r: any) => r.id === found.id)).toBe(
      true,
    );
  });

  it('reject then delete flow: teacher submits a request, school-admin rejects then deletes it', async () => {
    await request(app.getHttpServer())
      .post('/auth/password-reset-request')
      .send({ email: fixture.teachers[1].email })
      .expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'pending' })
      .expect(200);
    const found = listRes.body.requests.find(
      (r: any) => r.email === fixture.teachers[1].email,
    );
    expect(found).toBeTruthy();

    await request(app.getHttpServer())
      .patch('/school-admin/password-reset-requests')
      .set(...auth)
      .send({ id: found.id, status: 'rejected', notes: 'QA rejection' })
      .expect(200);

    await request(app.getHttpServer())
      .delete('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ id: found.id })
      .expect(200);

    const afterRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'all', limit: 200 })
      .expect(200);
    expect(afterRes.body.requests.some((r: any) => r.id === found.id)).toBe(
      false,
    );
  });

  it('rejects deleting without an id', async () => {
    await request(app.getHttpServer())
      .delete('/school-admin/password-reset-requests')
      .set(...auth)
      .expect(400);
  });
});
