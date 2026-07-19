import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin joining-codes CRUD', () => {
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

  it('GET /admin/joining-codes?schoolId=... lists the auto-generated codes', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const codes = Array.isArray(list) ? list : (list?.codes ?? list?.joinCodes ?? []);
    expect(codes.length).toBeGreaterThan(0);
  });

  it('GET /admin/joining-codes with schoolId=undefined string does not 500', async () => {
    // Regression check for the frontend bug where JoiningCodesDialog sends
    // `schoolId || "undefined"` as a literal string when nothing is
    // selected — the backend must not blow up on that value.
    const res = await request(app.getHttpServer())
      .get('/admin/joining-codes?schoolId=undefined')
      .set(...authHeader(fixture.admin.token));
    expect(res.status).toBeLessThan(500);
  });

  it('POST /admin/joining-codes creates a new code for a grade', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ schoolId: fixture.schoolId, grades: [fixture.grade] })
      .expect(201);
    expect(res.body).toBeDefined();
  });

  it('PATCH /admin/joining-codes deactivates a code', async () => {
    const list = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const codesBody = list.body?.data ?? list.body;
    const codes = Array.isArray(codesBody) ? codesBody : (codesBody?.codes ?? codesBody?.joinCodes ?? []);
    const target = codes[0];
    expect(target).toBeDefined();

    await request(app.getHttpServer())
      .patch('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ codeId: target.id, isActive: false })
      .expect(200);
  });
});
