import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin RoboCoders licenses CRUD', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let licenseId: string;
  let activationKey: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('POST /admin/licenses generates a signed activation key', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/licenses')
      .set(...authHeader(fixture.admin.token))
      .send({
        schoolId: fixture.schoolId,
        systemLabel: 'QA-Lab-PC-1',
        durationDays: 30,
        machineId: 'ABCD1234EF567890',
      })
      .expect(201);
    const license = res.body?.license;
    licenseId = license?.id;
    activationKey = license?.activation_key;
    expect(licenseId).toBeDefined();
    expect(activationKey).toBeDefined();
  });

  it('GET /admin/licenses?schoolId=... lists the new license', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/licenses?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const licenses = res.body?.licenses ?? [];
    expect(licenses.some((l: { id: string }) => l.id === licenseId)).toBe(true);
  });

  it('POST /admin/licenses/decode round-trips the activation key', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/licenses/decode')
      .set(...authHeader(fixture.admin.token))
      .send({ activationKey })
      .expect(201);
    expect(res.body?.valid).toBe(true);
    expect(res.body?.machine_id).toBe('ABCD1234EF567890'.slice(0, 6));
  });

  it('PATCH /admin/licenses/:id updates notes', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/licenses/${licenseId}`)
      .set(...authHeader(fixture.admin.token))
      .send({ notes: 'QA note' })
      .expect(200);
  });

  it('DELETE /admin/licenses/:id removes it', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/licenses/${licenseId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
  });
});
