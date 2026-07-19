import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin profile', () => {
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

  it('GET /school-admin/profile returns the school admin user', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/profile')
      .set('Authorization', `Bearer ${fixture.schoolAdmin.token}`)
      .expect(200);
    expect(res.body.id).toBe(fixture.schoolAdmin.id);
    expect(res.body.email).toBe(fixture.schoolAdmin.email);
    expect(res.body.password).toBeUndefined();
    expect(res.body.profile).toBeUndefined();
  });

  it('PATCH /school-admin/profile updates full_name and phone, reflected on GET', async () => {
    const patchRes = await request(app.getHttpServer())
      .patch('/school-admin/profile')
      .set('Authorization', `Bearer ${fixture.schoolAdmin.token}`)
      .send({ full_name: 'QA Updated Name', phone: '9998887777' })
      .expect(200);
    expect(patchRes.body.success).toBe(true);

    const getRes = await request(app.getHttpServer())
      .get('/school-admin/profile')
      .set('Authorization', `Bearer ${fixture.schoolAdmin.token}`)
      .expect(200);
    expect(getRes.body.full_name).toBe('QA Updated Name');
    expect(getRes.body.phone).toBe('9998887777');
  });

  it('rejects unauthenticated access', async () => {
    await request(app.getHttpServer()).get('/school-admin/profile').expect(401);
  });

  it('rejects non-school-admin roles', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/profile')
      .set('Authorization', `Bearer ${fixture.teachers[0].token}`);
    expect([403, 401]).toContain(res.status);
  });
});
