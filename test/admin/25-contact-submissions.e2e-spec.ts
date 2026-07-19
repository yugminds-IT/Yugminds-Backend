import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool } from './support/db';

describe('Contact submissions (public form -> admin review)', () => {
  let app: INestApplication;
  let adminAuth: [string, string];
  const email = `__qa_test_contact_${Date.now()}@example.test`;
  let submissionId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    const admin = await getBootstrapAdmin();
    adminAuth = authHeader(
      mintAccessToken({
        id: admin.id,
        email: admin.email,
        role: 'admin',
        isSuperAdmin: admin.isSuperAdmin,
        tenantId: admin.tenantId,
        tokenVersion: admin.tokenVersion,
      }),
    );
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    await closePool();
  }, 30000);

  it('POST /contact (public, no auth) creates a submission', async () => {
    await request(app.getHttpServer())
      .post('/contact')
      .send({
        firstName: 'QA',
        lastName: 'Tester',
        email,
        purpose: 'Testing',
        message: 'QA contact submission test',
      })
      .expect(201);
  });

  it('GET /admin/contact-submissions lists it', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/contact-submissions?search=${email}`)
      .set(...adminAuth)
      .expect(200);
    const list = res.body?.data ?? res.body;
    const items = Array.isArray(list) ? list : (list?.submissions ?? list?.items ?? []);
    const found = items.find((s: { email: string }) => s.email === email);
    expect(found).toBeDefined();
    submissionId = found.id;
  });

  it('PATCH /admin/contact-submissions/:id updates status and notes', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/contact-submissions/${submissionId}`)
      .set(...adminAuth)
      .send({ status: 'read', admin_notes: 'QA reviewed' })
      .expect(200);
  });

  it('DELETE /admin/contact-submissions/:id removes it', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/contact-submissions/${submissionId}`)
      .set(...adminAuth)
      .expect(200);
  });
});
