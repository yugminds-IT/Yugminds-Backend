import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool, pool } from './support/db';

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

  it('DELETE /admin/contact-submissions/:id soft-deletes it (moves to Deleted, not gone forever)', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/contact-submissions/${submissionId}`)
      .set(...adminAuth)
      .expect(200);

    // Gone from the default (non-deleted) list...
    const normal = await request(app.getHttpServer())
      .get(`/admin/contact-submissions?search=${email}`)
      .set(...adminAuth)
      .expect(200);
    const normalItems = normal.body?.submissions ?? [];
    expect(normalItems.some((s: { id: string }) => s.id === submissionId)).toBe(false);

    // ...but present under the deleted pseudo-status, with deleted_at set.
    const trashed = await request(app.getHttpServer())
      .get(`/admin/contact-submissions?status=deleted&search=${email}`)
      .set(...adminAuth)
      .expect(200);
    const trashedItems = trashed.body?.submissions ?? [];
    const found = trashedItems.find((s: { id: string }) => s.id === submissionId);
    expect(found).toBeDefined();
    expect(found.deleted_at).toBeTruthy();

    // A soft-deleted submission can't be edited until restored.
    await request(app.getHttpServer())
      .patch(`/admin/contact-submissions/${submissionId}`)
      .set(...adminAuth)
      .send({ status: 'archived' })
      .expect(404);
  });

  it('POST /admin/contact-submissions/:id/restore brings it back with its prior status intact', async () => {
    await request(app.getHttpServer())
      .post(`/admin/contact-submissions/${submissionId}/restore`)
      .set(...adminAuth)
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/admin/contact-submissions?search=${email}`)
      .set(...adminAuth)
      .expect(200);
    const items = res.body?.submissions ?? [];
    const found = items.find((s: { id: string }) => s.id === submissionId);
    expect(found).toBeDefined();
    // Set to 'read' by the PATCH test above — restore must not reset status.
    expect(found.status).toBe('read');
    expect(found.deleted_at).toBeNull();
  });

  it('DELETE /admin/contact-submissions/:id/purge only works on an already-deleted submission, and is permanent', async () => {
    // Purge before delete: nothing to purge yet.
    await request(app.getHttpServer())
      .delete(`/admin/contact-submissions/${submissionId}/purge`)
      .set(...adminAuth)
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/admin/contact-submissions/${submissionId}`)
      .set(...adminAuth)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/admin/contact-submissions/${submissionId}/purge`)
      .set(...adminAuth)
      .expect(200);

    const trashed = await request(app.getHttpServer())
      .get(`/admin/contact-submissions?status=deleted&search=${email}`)
      .set(...adminAuth)
      .expect(200);
    const trashedItems = trashed.body?.submissions ?? [];
    expect(trashedItems.some((s: { id: string }) => s.id === submissionId)).toBe(false);

    // Restore on a purged (truly gone) row must 404, not silently succeed.
    await request(app.getHttpServer())
      .post(`/admin/contact-submissions/${submissionId}/restore`)
      .set(...adminAuth)
      .expect(404);
  });

  describe('POST /contact rate limiting (public, unauthenticated, spam-exposed)', () => {
    const throttleEmailPrefix = `__qa_test_contact_throttle_${Date.now()}`;

    afterAll(async () => {
      await pool.query(
        `DELETE FROM "ContactSubmission" WHERE email LIKE $1`,
        [`${throttleEmailPrefix}%`],
      );
    });

    it('blocks a burst of requests past the per-IP limit (5/min)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await request(app.getHttpServer())
          .post('/contact')
          .send({
            firstName: 'QA',
            lastName: 'Throttle',
            email: `${throttleEmailPrefix}_${i}@example.test`,
            purpose: 'Testing',
            message: 'QA rate-limit burst test',
          });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    }, 30000);
  });
});
