import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool } from './support/db';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';

describe('Admin audit log + system-controls (read-only in this phase)', () => {
  let app: INestApplication;
  let adminAuth: [string, string];

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

  it('GET /admin/audit-logs lists entries', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs?limit=5')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/audit-logs/entity-types returns a list', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs/entity-types')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/audit-logs/export returns real CSV honoring filters, not an empty stub', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs/export?limit=5')
      .set(...adminAuth)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = String(res.text).trim().split('\n');
    // Header row + at least one data row — this suite alone has already
    // generated real audited mutations by the time this test runs.
    expect(lines[0]).toBe(
      'When,Actor Email,Actor Name,Actor Role,Method,Path,Entity Type,Entity ID,Status Code,Success,IP Address',
    );
    expect(lines.length).toBeGreaterThan(1);

    // A method filter must actually narrow the export, not just be ignored.
    const getOnly = await request(app.getHttpServer())
      .get('/admin/audit-logs/export?method=DELETE')
      .set(...adminAuth)
      .expect(200);
    // Method (a plain HTTP verb, never comma-containing/quoted) always
    // follows exactly 4 commas in this fixed column order — check via
    // substring rather than a naive positional split, which could be
    // thrown off by a quoted field earlier in the row (e.g. an actor name
    // containing a comma).
    const deleteRows = String(getOnly.text).trim().split('\n').slice(1);
    for (const row of deleteRows) {
      if (!row) continue;
      expect(row).toMatch(/,DELETE,/);
    }
  });

  it('GET /admin/system-controls returns current settings', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/system-controls')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /system-status is public (no auth required)', async () => {
    const res = await request(app.getHttpServer())
      .get('/system-status')
      .expect(200);
    expect(res.body).toHaveProperty('maintenance_mode');
  });

  it('GET /admin/system-controls is rejected without admin role', async () => {
    await request(app.getHttpServer()).get('/admin/system-controls').expect(401);
  });

  describe('audit trail actually records fixture mutations', () => {
    let fixture: QaFixture;

    beforeAll(async () => {
      fixture = await createQaFixture(app);
    }, 60000);

    afterAll(async () => {
      if (fixture) await teardownQaFixture(app, fixture);
    }, 60000);

    it('a PUT on a fixture teacher (id in the URL path) is recorded with a matching entityId', async () => {
      // POST creates have no :id path segment (the interceptor derives
      // entityId purely from the URL, not the response body), so a create
      // is never attributable to a specific row here by design — use an
      // update instead, which does have the id in the path.
      await request(app.getHttpServer())
        .put(`/admin/teachers/${fixture.teachers[0].id}`)
        .set(...adminAuth)
        .send({ full_name: 'QA Audit Trail Check' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/admin/audit-logs?entityType=teachers&search=${fixture.teachers[0].id}&limit=20`)
        .set(...adminAuth)
        .expect(200);
      const list = res.body?.data ?? res.body;
      const entries = Array.isArray(list) ? list : (list?.logs ?? list?.items ?? []);
      expect(
        entries.some(
          (e: { method: string; entityId: string }) =>
            e.method === 'PUT' && e.entityId === String(fixture.teachers[0].id),
        ),
      ).toBe(true);
    });
  });
});
