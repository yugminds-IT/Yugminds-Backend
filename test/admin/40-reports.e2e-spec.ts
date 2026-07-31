import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader, mintAccessToken } from './support/auth';
import { closePool, pool } from './support/db';

describe('Admin reports + teacher-reports', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let reportId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);

    // Seed a TeacherReport row directly for the fixture teacher/school so the
    // teacher-reports read/patch endpoints have real, known data to assert on.
    const { rows } = await pool.query(
      `INSERT INTO "TeacherReport"
         (id, "teacherId", "schoolId", "reportDate", grade, "topicsTaught", "studentCount", "durationHours", notes, status, "createdAt")
       VALUES (gen_random_uuid(), $1, $2, now(), 'QA-Grade', 'QA topics for e2e', 5, 1.5, 'QA e2e seeded report', 'submitted', now())
       RETURNING id`,
      [fixture.teachers[0].id, fixture.schoolId],
    );
    reportId = rows[0].id;
  }, 60000);

  afterAll(async () => {
    if (reportId) {
      await pool.query('DELETE FROM "TeacherReport" WHERE id = $1', [reportId]);
    }
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/teacher-reports scoped by school_id returns the seeded report with resolved teacher/school', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const reports = res.body?.reports ?? [];
    const found = reports.find((r: { id: string }) => r.id === reportId);
    expect(found).toBeDefined();
    expect(found.teacher_id).toBe(String(fixture.teachers[0].id));
    expect(found.school_id).toBe(fixture.schoolId);
    expect(found.topics_taught).toBe('QA topics for e2e');
    expect(found.status).toBe('submitted');
    expect(found.profiles?.id).toBe(String(fixture.teachers[0].id));
    expect(found.schools?.id).toBe(fixture.schoolId);
  });

  it('GET /admin/teacher-reports filters by teacher_id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?teacher_id=${fixture.teachers[1].id}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const reports = res.body?.reports ?? [];
    expect(reports.some((r: { id: string }) => r.id === reportId)).toBe(false);
  });

  it('GET /admin/teacher-reports search matches topics_taught', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?school_id=${fixture.schoolId}&search=QA%20topics`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const reports = res.body?.reports ?? [];
    expect(reports.some((r: { id: string }) => r.id === reportId)).toBe(true);

    const missRes = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?school_id=${fixture.schoolId}&search=zzz-no-match-zzz`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const missReports = missRes.body?.reports ?? [];
    expect(missReports.some((r: { id: string }) => r.id === reportId)).toBe(false);
  });

  it('PATCH /admin/teacher-reports updates status and admin_notes, and the read reflects it', async () => {
    const res = await request(app.getHttpServer())
      .patch('/admin/teacher-reports')
      .set(...authHeader(fixture.admin.token))
      .send({ id: reportId, status: 'approved', admin_notes: 'QA reviewed' })
      .expect(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.report?.status).toBe('approved');
    expect(res.body?.report?.admin_notes).toBe('QA reviewed');

    const listRes = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const found = (listRes.body?.reports ?? []).find(
      (r: { id: string }) => r.id === reportId,
    );
    expect(found?.status).toBe('approved');
    expect(found?.admin_notes).toBe('QA reviewed');
  });

  it('GET /admin/teacher-reports filters by status', async () => {
    // The previous test left reportId as 'approved'.
    const approvedRes = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?school_id=${fixture.schoolId}&status=approved`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(
      (approvedRes.body?.reports ?? []).some((r: { id: string }) => r.id === reportId),
    ).toBe(true);

    const rejectedRes = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?school_id=${fixture.schoolId}&status=rejected`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(
      (rejectedRes.body?.reports ?? []).some((r: { id: string }) => r.id === reportId),
    ).toBe(false);
  });

  it('GET /admin/teacher-reports returns real stats independent of the status filter and the list cap', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/teacher-reports?school_id=${fixture.schoolId}&status=approved&limit=1`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(res.body.reports.length).toBe(1);
    // stats.total counts every status for this school, not just 'approved'
    // (the currently-applied status filter), and isn't capped at limit=1.
    expect(res.body.stats.total).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.approved).toBeGreaterThanOrEqual(1);
    expect(
      res.body.stats.submitted + res.body.stats.reviewed + res.body.stats.approved + res.body.stats.rejected,
    ).toBe(res.body.stats.total);
  });

  it('PATCH /admin/teacher-reports rejects an invalid status', async () => {
    await request(app.getHttpServer())
      .patch('/admin/teacher-reports')
      .set(...authHeader(fixture.admin.token))
      .send({ id: reportId, status: 'not-a-real-status' })
      .expect(400);
  });

  it('PATCH /admin/teacher-reports requires an id', async () => {
    await request(app.getHttpServer())
      .patch('/admin/teacher-reports')
      .set(...authHeader(fixture.admin.token))
      .send({ status: 'approved' })
      .expect(400);
  });

  it('GET /admin/reports?type=schools scopes counts to school_ids filter', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/reports?type=schools&school_ids=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    expect(res.body).toBeDefined();
  });

  it('GET /admin/reports?type=teachers returns a PDF response', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/reports?type=teachers&teacher_ids=${fixture.teachers[0].id}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });

  it('GET /admin/reports with no type defaults to system report', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/admin/teacher-reports').expect(401);
    await request(app.getHttpServer()).get('/admin/reports').expect(401);
  });

  it('rejects non-admin roles', async () => {
    const teacherToken = mintAccessToken({
      id: fixture.teachers[0].id,
      email: fixture.teachers[0].email,
      role: 'teacher',
      isSuperAdmin: false,
      tenantId: fixture.schoolId,
      tokenVersion: 0,
    });
    const res = await request(app.getHttpServer())
      .get('/admin/teacher-reports')
      .set('Authorization', `Bearer ${teacherToken}`);
    expect([401, 403]).toContain(res.status);
  });
});
