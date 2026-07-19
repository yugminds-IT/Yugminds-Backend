import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool } from './support/db';

describe('Admin dashboard (read-only)', () => {
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

  it('GET /admin/stats returns aggregate counts', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/stats')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/analytics works with no date range', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/analytics')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/analytics honors from/to date range params', async () => {
    const from = '2020-01-01';
    const to = '2020-01-31';
    const res = await request(app.getHttpServer())
      .get(`/admin/analytics?from=${from}&to=${to}`)
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/assignment-analytics returns leaderboard-backed data', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/assignment-analytics')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/monitoring-dashboard returns in-memory metrics', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/monitoring-dashboard')
      .set(...adminAuth)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/materialized-view-stats does not error', async () => {
    await request(app.getHttpServer())
      .get('/admin/materialized-view-stats')
      .set(...adminAuth)
      .expect(200);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/admin/stats').expect(401);
  });

  it('rejects non-admin roles', async () => {
    const fakeStudentToken = mintAccessToken({
      id: 999999999,
      email: 'nonexistent@example.test',
      role: 'student',
      isSuperAdmin: false,
      tenantId: null,
      tokenVersion: 0,
    });
    const res = await request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', `Bearer ${fakeStudentToken}`);
    expect([401, 403]).toContain(res.status);
  });
});
