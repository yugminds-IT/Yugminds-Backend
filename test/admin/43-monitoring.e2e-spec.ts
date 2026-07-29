import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool } from './support/db';

describe('Admin monitoring / cache', () => {
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

  it('GET /admin/monitoring-dashboard returns metrics + recent-request shape, and reflects a request made just before it', async () => {
    // Warm the endpoint stats with a known call, then verify the snapshot picked it up.
    await request(app.getHttpServer())
      .get('/admin/materialized-view-stats')
      .set(...adminAuth)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/admin/monitoring-dashboard')
      .set(...adminAuth)
      .expect(200);

    expect(res.body.metrics).toBeDefined();
    expect(typeof res.body.metrics.totalRequests).toBe('number');
    expect(res.body.metrics.totalRequests).toBeGreaterThan(0);
    expect(typeof res.body.metrics.averageResponseTime).toBe('number');
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it('GET /admin/cache-monitor returns a stable shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/cache-monitor')
      .set(...adminAuth)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.cacheHitRate).toBe('number');
    expect(typeof res.body.checked_at).toBe('string');
    expect(new Date(res.body.checked_at).toString()).not.toBe('Invalid Date');
  });

  it('POST /admin/warm-cache reports success', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/warm-cache')
      .set(...adminAuth)
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.warmed_at).toBe('string');
    expect(new Date(res.body.warmed_at).toString()).not.toBe('Invalid Date');
  });

  it('GET /admin/materialized-view-stats returns views + checked_at', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/materialized-view-stats')
      .set(...adminAuth)
      .expect(200);
    expect(Array.isArray(res.body.views)).toBe(true);
    expect(typeof res.body.checked_at).toBe('string');
  });

  it('rejects unauthenticated requests on every monitoring route', async () => {
    await request(app.getHttpServer()).get('/admin/monitoring-dashboard').expect(401);
    await request(app.getHttpServer()).get('/admin/cache-monitor').expect(401);
    await request(app.getHttpServer()).post('/admin/warm-cache').expect(401);
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
      .get('/admin/monitoring-dashboard')
      .set('Authorization', `Bearer ${fakeStudentToken}`);
    expect([401, 403]).toContain(res.status);
  });
});
