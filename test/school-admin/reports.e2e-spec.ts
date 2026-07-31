import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin reports (single + bulk, route-ordering regression guard)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];
  let reportIdA: string;
  let reportIdB: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app, { withScheduling: true });
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];

    const teacherAuthA: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[0].token}`,
    ];
    const teacherAuthB: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[1].token}`,
    ];
    const resA = await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuthA)
      .send({
        school_id: fixture.schoolId,
        grade: fixture.grade,
        date: '2026-07-01',
        period_id: fixture.periodId,
        topics_taught: 'QA Topic A',
      })
      .expect(201);
    reportIdA = resA.body?.id ?? resA.body?.report?.id ?? resA.body?.data?.id;

    const resB = await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuthB)
      .send({
        school_id: fixture.schoolId,
        grade: fixture.grade,
        date: '2026-07-02',
        period_id: fixture.periodId,
        topics_taught: 'QA Topic B',
      })
      .expect(201);
    reportIdB = resB.body?.id ?? resB.body?.report?.id ?? resB.body?.data?.id;

    expect(reportIdA).toBeTruthy();
    expect(reportIdB).toBeTruthy();
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /school-admin/reports lists both reports as Pending', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/reports')
      .set(...auth)
      .query({ limit: 500 })
      .expect(200);
    const ids = res.body.reports.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([reportIdA, reportIdB]));
    const a = res.body.reports.find((r: any) => r.id === reportIdA);
    expect(a.status).toBe('Pending');
  });

  it('GET /school-admin/reports/:id returns a single report', async () => {
    const res = await request(app.getHttpServer())
      .get(`/school-admin/reports/${reportIdA}`)
      .set(...auth)
      .expect(200);
    expect(res.body.report.id).toBe(reportIdA);
    expect(res.body.report.topics_taught).toBe('QA Topic A');
  });

  it(
    'PATCH /school-admin/reports/bulk is NOT shadowed by the :id route ' +
      '(regression guard — previously "bulk" was parsed as an :id and 400\'d)',
    async () => {
      const res = await request(app.getHttpServer())
        .patch('/school-admin/reports/bulk')
        .set(...auth)
        .send({ report_ids: [reportIdA, reportIdB], action: 'approve' })
        .expect(200);
      expect(res.body.approved).toBe(2);
    },
  );

  it('bulk update took effect on both reports', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/reports')
      .set(...auth)
      .query({ limit: 500 })
      .expect(200);
    const a = res.body.reports.find((r: any) => r.id === reportIdA);
    const b = res.body.reports.find((r: any) => r.id === reportIdB);
    expect(a.status).toBe('Approved');
    expect(b.status).toBe('Approved');
  });

  it('PATCH /school-admin/reports/:id (single) can reject one report', async () => {
    await request(app.getHttpServer())
      .patch(`/school-admin/reports/${reportIdB}`)
      .set(...auth)
      .send({ action: 'reject' })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/school-admin/reports/${reportIdB}`)
      .set(...auth)
      .expect(200);
    // GET /reports/:id now maps through the same toReportUiStatus as the
    // list endpoint (previously returned the raw DB enum 'rejected',
    // inconsistent with the list's 'Rejected' — a real cross-endpoint bug).
    expect(res.body.report.status).toBe('Rejected');
  });

  describe('bulk action validation (regression: missing/invalid action silently no-op\'d as "submitted")', () => {
    let pendingId: string;

    beforeAll(async () => {
      const teacherAuth: [string, string] = [
        'Authorization',
        `Bearer ${fixture.teachers[0].token}`,
      ];
      const res = await request(app.getHttpServer())
        .post('/teacher/reports')
        .set(...teacherAuth)
        .send({
          school_id: fixture.schoolId,
          grade: fixture.grade,
          date: '2026-07-03',
          period_id: fixture.periodId,
          topics_taught: 'QA Topic C (bulk validation)',
        })
        .expect(201);
      pendingId = res.body?.id ?? res.body?.report?.id ?? res.body?.data?.id;
      expect(pendingId).toBeTruthy();
    });

    it('rejects a bulk request with no action at all (previously defaulted to a silent no-op)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/school-admin/reports/bulk')
        .set(...auth)
        .send({ report_ids: [pendingId] })
        .expect(400);
      expect(res.body.message).toMatch(/action must be/i);

      // Confirm the report is untouched — still Pending, not silently
      // resubmitted.
      const check = await request(app.getHttpServer())
        .get(`/school-admin/reports/${pendingId}`)
        .set(...auth)
        .expect(200);
      expect(check.body.report.status).toBe('Pending');
    });

    it('rejects a bulk request with an invalid action string', async () => {
      await request(app.getHttpServer())
        .patch('/school-admin/reports/bulk')
        .set(...auth)
        .send({ report_ids: [pendingId], action: 'not-a-real-action' })
        .expect(400);
    });

    it('bulk-rejects real reports when action="reject" is sent explicitly (mirrors the real frontend payload)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/school-admin/reports/bulk')
        .set(...auth)
        .send({ report_ids: [pendingId], action: 'reject' })
        .expect(200);
      expect(res.body.approved).toBe(1);

      const check = await request(app.getHttpServer())
        .get(`/school-admin/reports/${pendingId}`)
        .set(...auth)
        .expect(200);
      expect(check.body.report.status).toBe('Rejected');
    });
  });

  describe('GET /school-admin/reports stats — real DB counts, independent of the list `limit`', () => {
    it('stats reflect the true total even when `limit` caps the returned `reports` array', async () => {
      const capped = await request(app.getHttpServer())
        .get('/school-admin/reports')
        .set(...auth)
        .query({ limit: 1 })
        .expect(200);
      expect(capped.body.reports.length).toBe(1);
      expect(capped.body.stats.total).toBeGreaterThanOrEqual(3);

      const full = await request(app.getHttpServer())
        .get('/school-admin/reports')
        .set(...auth)
        .query({ limit: 500 })
        .expect(200);
      // Same stats regardless of the page size requested.
      expect(full.body.stats).toEqual(capped.body.stats);
      expect(full.body.stats.approved + full.body.stats.rejected + full.body.stats.pending).toBe(
        full.body.stats.total,
      );
    });
  });

  describe('status sync: a platform admin marking a report "reviewed" is visible as such to the school admin', () => {
    let reviewId: string;

    beforeAll(async () => {
      const teacherAuth: [string, string] = [
        'Authorization',
        `Bearer ${fixture.teachers[0].token}`,
      ];
      const res = await request(app.getHttpServer())
        .post('/teacher/reports')
        .set(...teacherAuth)
        .send({
          school_id: fixture.schoolId,
          grade: fixture.grade,
          date: '2026-07-04',
          period_id: fixture.periodId,
          topics_taught: 'QA Topic D (reviewed-status sync)',
        })
        .expect(201);
      reviewId = res.body?.id ?? res.body?.report?.id ?? res.body?.data?.id;
      expect(reviewId).toBeTruthy();
    });

    it('school admin sees the platform-admin-set "reviewed" status distinctly, not silently as Pending', async () => {
      const adminAuth: [string, string] = [
        'Authorization',
        `Bearer ${fixture.admin.token}`,
      ];
      await request(app.getHttpServer())
        .patch('/admin/teacher-reports')
        .set(...adminAuth)
        .send({ id: reviewId, status: 'reviewed' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/school-admin/reports/${reviewId}`)
        .set(...auth)
        .expect(200);
      expect(res.body.report.status).toBe('Reviewed');

      const list = await request(app.getHttpServer())
        .get('/school-admin/reports')
        .set(...auth)
        .query({ limit: 500 })
        .expect(200);
      const found = list.body.reports.find((r: any) => r.id === reviewId);
      expect(found.status).toBe('Reviewed');
    });
  });
});
