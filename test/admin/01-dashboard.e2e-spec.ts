import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool, pool } from './support/db';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';

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

  it('GET /admin/schools wraps its payload in a { data: {...} } envelope', async () => {
    // Regression guard for the "Recent Schools: No recent data" bug — the
    // admin dashboard's quick-previews hook only works because it unwraps
    // this exact shape. If this endpoint's response shape ever changes
    // (e.g. someone "simplifies" it to match the other list endpoints),
    // the frontend unwrap logic must change with it.
    const res = await request(app.getHttpServer())
      .get('/admin/schools?limit=1')
      .set(...adminAuth)
      .expect(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.schools).toBeDefined();
    expect(Array.isArray(res.body.data.schools)).toBe(true);
    expect(res.body.schools).toBeUndefined();
  });

  describe('pendingLeaves excludes orphaned TeacherLeave rows', () => {
    let fixture: QaFixture;
    let orphanId: string;

    beforeAll(async () => {
      fixture = await createQaFixture(app);
    }, 60000);

    afterAll(async () => {
      if (orphanId) {
        await pool.query('DELETE FROM "TeacherLeave" WHERE id = $1', [orphanId]);
      }
      if (fixture) await teardownQaFixture(app, fixture);
    }, 60000);

    it('a TeacherLeave row referencing a nonexistent teacher/school is not counted as pending', async () => {
      const before = await request(app.getHttpServer())
        .get('/admin/stats')
        .set(...adminAuth)
        .expect(200);
      const beforeCount = before.body?.stats?.pendingLeaves ?? 0;

      // Directly insert a row with a teacherId/schoolId that can never
      // resolve — simulates the exact debris a hard-deleted teacher/school
      // leaves behind, since TeacherLeave has no enforced DB-level FK.
      const insertRes = await pool.query(
        `INSERT INTO "TeacherLeave" (id, "teacherId", "schoolId", "startDate", "endDate", status, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), 999999999, 'nonexistent-school-id', now(), now(), 'pending', now(), now())
         RETURNING id`,
      );
      orphanId = insertRes.rows[0].id;

      const after = await request(app.getHttpServer())
        .get('/admin/stats')
        .set(...adminAuth)
        .expect(200);
      const afterCount = after.body?.stats?.pendingLeaves ?? 0;
      expect(afterCount).toBe(beforeCount);
    });

    it('a real pending leave for the fixture teacher IS counted', async () => {
      const before = await request(app.getHttpServer())
        .get('/admin/stats')
        .set(...adminAuth)
        .expect(200);
      const beforeCount = before.body?.stats?.pendingLeaves ?? 0;

      const start = new Date();
      start.setDate(start.getDate() + 1);
      const end = new Date();
      end.setDate(end.getDate() + 2);
      await request(app.getHttpServer())
        .post('/teacher/leaves')
        .set(...authHeader(fixture.teachers[0].token))
        .send({
          school_id: fixture.schoolId,
          start_date: start.toISOString().split('T')[0],
          end_date: end.toISOString().split('T')[0],
          reason: 'QA test leave',
        })
        .expect(201);

      const after = await request(app.getHttpServer())
        .get('/admin/stats')
        .set(...adminAuth)
        .expect(200);
      const afterCount = after.body?.stats?.pendingLeaves ?? 0;
      expect(afterCount).toBe(beforeCount + 1);
    });
  });

  describe('purging a teacher also cleans up their TeacherLeave rows (no orphan left behind)', () => {
    let fixture: QaFixture;

    beforeAll(async () => {
      fixture = await createQaFixture(app);
    }, 60000);

    afterAll(async () => {
      if (fixture) await teardownQaFixture(app, fixture);
    }, 60000);

    it('purging a soft-deleted teacher removes their TeacherLeave rows too', async () => {
      const teacherId = fixture.teachers[0].id;
      const start = new Date();
      start.setDate(start.getDate() + 1);
      const end = new Date();
      end.setDate(end.getDate() + 2);
      await request(app.getHttpServer())
        .post('/teacher/leaves')
        .set(...authHeader(fixture.teachers[0].token))
        .send({
          school_id: fixture.schoolId,
          start_date: start.toISOString().split('T')[0],
          end_date: end.toISOString().split('T')[0],
          reason: 'QA test leave for purge',
        })
        .expect(201);

      const before = await pool.query(
        'SELECT count(*)::int AS c FROM "TeacherLeave" WHERE "teacherId" = $1',
        [teacherId],
      );
      expect(before.rows[0].c).toBeGreaterThan(0);

      await request(app.getHttpServer())
        .delete(`/admin/teachers/${teacherId}`)
        .set(...adminAuth)
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/admin/trash?entity_type=teachers&id=${teacherId}`)
        .set(...adminAuth)
        .expect(200);

      const after = await pool.query(
        'SELECT count(*)::int AS c FROM "TeacherLeave" WHERE "teacherId" = $1',
        [teacherId],
      );
      expect(after.rows[0].c).toBe(0);
    });
  });
});
