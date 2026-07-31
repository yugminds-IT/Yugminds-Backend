import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { authHeader } from '../admin/support/auth';
import { closePool } from '../admin/support/db';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';

describe('Teacher reports', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let teacherAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app, { withScheduling: true });
    teacherAuth = authHeader(fixture.teachers[0].token);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('creates a report and lists it back', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-02-10',
        period_id: fixture.periodId,
        grade: fixture.grade,
        start_time: '09:00',
        end_time: '10:00',
        topics_taught: 'Fractions',
        activities: 'Worksheet',
        notes: 'Went well',
      })
      .expect(201);
    expect(createRes.body.report.report_status).toBe('Pending');
    expect(createRes.body.report.duration_hours).toBe(1);

    const listRes = await request(app.getHttpServer())
      .get(`/teacher/reports?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(
      listRes.body.reports.some((r: any) => r.id === createRes.body.report.id),
    ).toBe(true);
  });

  it('GET /teacher/reports includes real stats alongside the list', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/reports?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.total).toBeGreaterThanOrEqual(1);
    expect(
      res.body.stats.pending +
        res.body.stats.reviewed +
        res.body.stats.approved +
        res.body.stats.rejected,
    ).toBe(res.body.stats.total);
  });

  it('rejects a report missing period_id', async () => {
    await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuth)
      .send({ school_id: fixture.schoolId, date: '2026-02-11' })
      .expect(400);
  });

  it('rejects a duplicate report for the same teacher+school+date+period', async () => {
    await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-02-12',
        period_id: fixture.periodId,
        topics_taught: 'First',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-02-12',
        period_id: fixture.periodId,
        topics_taught: 'Duplicate',
      })
      .expect(400);
  });

  it('filters reports by date range', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/teacher/reports?school_id=${fixture.schoolId}&from=2026-02-10&to=2026-02-10`,
      )
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].date).toBe('2026-02-10');
  });

  it("another teacher's reports do not appear in this teacher's list", async () => {
    const otherAuth = authHeader(fixture.teachers[1].token);
    const otherReport = await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...otherAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-02-13',
        period_id: fixture.periodId,
        topics_taught: 'Other teacher report',
      })
      .expect(201);
    const listRes = await request(app.getHttpServer())
      .get(`/teacher/reports?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(
      listRes.body.reports.some(
        (r: any) => r.id === otherReport.body.report.id,
      ),
    ).toBe(false);
  });

  it('rejects a report for a future date', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const futureDateStr = tomorrow.toISOString().split('T')[0];
    const res = await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        date: futureDateStr,
        period_id: fixture.periodId,
        topics_taught: 'Should not be allowed',
      });
    expect(res.status).toBe(400);
  });

  it(
    'response includes attendance_marked_present, reflecting whether the day\'s scheduled ' +
      'periods were fully covered by this submission (not just an unconditional "true")',
    async () => {
      const res = await request(app.getHttpServer())
        .post('/teacher/reports')
        .set(...teacherAuth)
        .send({
          school_id: fixture.schoolId,
          date: '2026-02-14',
          period_id: fixture.periodId,
          topics_taught: 'Attendance-marked field check',
        })
        .expect(201);
      expect(typeof res.body.attendance_marked_present).toBe('boolean');
    },
  );

  it('rejects unauthenticated and non-teacher access', async () => {
    await request(app.getHttpServer()).get('/teacher/reports').expect(401);
    const res = await request(app.getHttpServer())
      .get('/teacher/reports')
      .set(...authHeader(fixture.students[0].token));
    expect([401, 403]).toContain(res.status);
  });
});
