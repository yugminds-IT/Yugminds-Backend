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

/**
 * Next Monday on/after `from` (UTC date-only), formatted YYYY-MM-DD. The
 * fixture's teacher-working-days history only starts "today" (set up fresh
 * by createQaFixture at test-run time) and its ClassSchedule is pinned to
 * Monday — a report date must be BOTH on/after today AND a Monday, or the
 * "today" status reads back as "Not-Scheduled" instead of "Present". A
 * hardcoded past date breaks this the moment it's no longer within the
 * fixture's (freshly-created) working-days window.
 */
function nextMonday(from: Date): string {
  const d = new Date(from);
  const day = d.getUTCDay();
  const daysUntilMonday = (8 - day) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + (day === 1 ? 0 : daysUntilMonday));
  return d.toISOString().split('T')[0];
}

describe('Teacher attendance', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let teacherAuth: [string, string];
  const reportDate = nextMonday(new Date());
  const reportDateYearMonth = reportDate.slice(0, 7);

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

  it('GET /teacher/attendance/today returns a shape with no data marked yet', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/attendance/today?school_id=${fixture.schoolId}&date=${reportDate}`)
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.date).toBe(reportDate);
    expect(res.body.attendance).toBeDefined();
  });

  it('submitting a teaching report marks attendance Present for that date', async () => {
    await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        date: reportDate,
        period_id: fixture.periodId,
        topics_taught: 'Intro to fractions',
      })
      .expect(201);

    const todayRes = await request(app.getHttpServer())
      .get(`/teacher/attendance/today?school_id=${fixture.schoolId}&date=${reportDate}`)
      .set(...teacherAuth)
      .expect(200);
    expect(todayRes.body.attendance.status).toBe('Present');

    const listRes = await request(app.getHttpServer())
      .get(
        `/teacher/attendance?school_id=${fixture.schoolId}&from=${reportDate}&to=${reportDate}`,
      )
      .set(...teacherAuth)
      .expect(200);
    expect(listRes.body.attendance).toHaveLength(1);
    expect(listRes.body.attendance[0].status).toBe('Present');
    expect(listRes.body.attendance[0].date).toBe(reportDate);
  });

  it('GET /teacher/attendance/monthly includes the reported month with present_days >= 1', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/teacher/attendance/monthly?school_id=${fixture.schoolId}&yearMonth=${reportDateYearMonth}`,
      )
      .set(...teacherAuth)
      .expect(200);
    const monthEntry = res.body.monthlyData.find(
      (m: any) => m.month === reportDateYearMonth,
    );
    expect(monthEntry).toBeDefined();
    expect(monthEntry.present_days).toBeGreaterThanOrEqual(1);
  });

  it('a teacher with no report that day sees no Present attendance from teacher[0]', async () => {
    const otherAuth = authHeader(fixture.teachers[1].token);
    const res = await request(app.getHttpServer())
      .get(`/teacher/attendance/today?school_id=${fixture.schoolId}&date=${reportDate}`)
      .set(...otherAuth)
      .expect(200);
    expect(res.body.attendance.status).not.toBe('Present');
  });

  it('rejects unauthenticated requests and unassigned school_id (tenant interceptor)', async () => {
    await request(app.getHttpServer()).get('/teacher/attendance/today').expect(401);
    await request(app.getHttpServer())
      .get('/teacher/attendance?school_id=some-other-school')
      .set(...teacherAuth)
      .expect(403);
  });
});
