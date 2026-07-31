import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool, pool } from './support/db';

describe('Admin alerts / search / saved-views / profile (self-scoped, safe)', () => {
  let app: INestApplication;
  let adminAuth: [string, string];
  let adminId: number;

  beforeAll(async () => {
    app = await bootstrapApp();
    const admin = await getBootstrapAdmin();
    adminId = admin.id;
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

  it('GET /admin/alerts returns threshold-check results', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/alerts')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/search returns results across entity types', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/search?q=a')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/search with empty q does not error', async () => {
    await request(app.getHttpServer())
      .get('/admin/search?q=')
      .set(...adminAuth)
      .expect(200);
  });

  describe('saved views (own, self-cleaning)', () => {
    const tableKey = `__qa_test__table_${Date.now()}`;
    const viewName = 'QA View';
    let createdId: string;

    it('requires table_key on list', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/saved-views')
        .set(...adminAuth);
      expect(res.status).toBe(400);
    });

    it('creates a saved view scoped to the current admin', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/saved-views')
        .set(...adminAuth)
        .send({ table_key: tableKey, name: viewName, state: { foo: 'bar' } })
        .expect(201);
      expect(res.body.userId).toBe(adminId);
      expect(res.body.tableKey).toBe(tableKey);
      createdId = res.body.id;
    });

    it('lists the created view back', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/saved-views?table_key=${tableKey}`)
        .set(...adminAuth)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((v: { id: string }) => v.id === createdId)).toBe(true);
    });

    it('deletes the view', async () => {
      await request(app.getHttpServer())
        .delete(`/admin/saved-views/${createdId}`)
        .set(...adminAuth)
        .expect(200);
      const res = await request(app.getHttpServer())
        .get(`/admin/saved-views?table_key=${tableKey}`)
        .set(...adminAuth)
        .expect(200);
      expect(res.body.some((v: { id: string }) => v.id === createdId)).toBe(false);
    });
  });

  describe('profile (self, update-and-revert)', () => {
    let originalFullName: string | undefined;

    it('gets own profile', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/profile')
        .set(...adminAuth)
        .expect(200);
      originalFullName = res.body?.data?.full_name ?? res.body?.full_name;
    });

    it('updates and reverts full_name without leaking state', async () => {
      const tempName = `QA Temp Name ${Date.now()}`;
      await request(app.getHttpServer())
        .patch('/admin/profile')
        .set(...adminAuth)
        .send({ full_name: tempName })
        .expect(200);

      const check = await request(app.getHttpServer())
        .get('/admin/profile')
        .set(...adminAuth)
        .expect(200);
      expect(check.body?.data?.full_name ?? check.body?.full_name).toBe(tempName);

      if (originalFullName) {
        await request(app.getHttpServer())
          .patch('/admin/profile')
          .set(...adminAuth)
          .send({ full_name: originalFullName })
          .expect(200);
      } else {
        // AdminProfileService.update() treats a blank full_name as "no
        // change" (silently ignored, not cleared) — so when the admin had
        // NO profile row before this test, a PATCH with `full_name: ''`
        // can never actually revert it. Delete the row this test itself
        // created directly instead, restoring the exact pre-test state on
        // this shared, real bootstrap admin account.
        await pool.query('DELETE FROM "Profile" WHERE "userId" = $1', [
          adminId,
        ]);
      }

      const reverted = await request(app.getHttpServer())
        .get('/admin/profile')
        .set(...adminAuth)
        .expect(200);
      expect(reverted.body?.data?.full_name ?? reverted.body?.full_name).toBe(
        originalFullName ?? undefined,
      );
    });

    it(
      'PATCH /admin/profile silently ignores an email change — the "Email is ' +
        'fixed and cannot be changed" UI claim is actually enforced server-side, ' +
        'not just a disabled input a direct API call could bypass',
      async () => {
        const before = await request(app.getHttpServer())
          .get('/admin/profile')
          .set(...adminAuth)
          .expect(200);
        const realEmail = before.body?.data?.email ?? before.body?.email;
        expect(realEmail).toBeTruthy();

        await request(app.getHttpServer())
          .patch('/admin/profile')
          .set(...adminAuth)
          .send({ email: `__qa_test_should_not_apply_${Date.now()}@example.test` })
          .expect(200);

        const after = await request(app.getHttpServer())
          .get('/admin/profile')
          .set(...adminAuth)
          .expect(200);
        expect(after.body?.data?.email ?? after.body?.email).toBe(realEmail);
      },
    );
  });
});
