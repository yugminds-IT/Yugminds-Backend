import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#000"/></svg>',
);

describe('Admin logos CRUD (fixture school, soft + hard delete)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let logoId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('POST /admin/logos uploads a logo for the fixture school', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/logos')
      .set(...authHeader(fixture.admin.token))
      .field('school_id', fixture.schoolId)
      .attach('file', SVG, { filename: 'logo.svg', contentType: 'image/svg+xml' })
      .expect(201);
    logoId = res.body?.id ?? res.body?.data?.id;
    expect(logoId).toBeDefined();
  });

  it('GET /admin/logos lists it', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/logos?limit=100')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const logos = res.body?.data ?? [];
    expect(logos.some((l: { id: string }) => l.id === logoId)).toBe(true);
  });

  it('PUT /admin/logos/:id updates description', async () => {
    await request(app.getHttpServer())
      .put(`/admin/logos/${logoId}`)
      .set(...authHeader(fixture.admin.token))
      .send({ description: 'QA description' })
      .expect(200);
  });

  it('DELETE /admin/logos/:id (soft) then hard-delete removes it', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/logos/${logoId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/admin/logos/${logoId}?hard=true`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
  });
});
