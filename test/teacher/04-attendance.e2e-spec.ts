import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { authHeader } from '../admin/support/auth';
import { closePool, pool } from '../admin/support/db';
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

  it("monthly attendance denominator never counts days later this month than today (future-date bug regression)", async () => {
    const teacherId = fixture.teachers[0].id;
    const schoolId = fixture.schoolId;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const todayUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    // Replace whatever working-days history the fixture set up with a
    // single row covering every weekday for the whole month — makes every
    // date from the 1st through today (AND every date later this month) a
    // "working day" per the schedule, so the test can assert precisely how
    // many of them the denominator actually counted.
    await pool.query(
      `DELETE FROM "TeacherWorkingDaysHistory" WHERE "teacherId" = $1 AND "schoolId" = $2`,
      [teacherId, schoolId],
    );
    // One day before month start, not exactly midnight month-start — the
    // "effectiveFrom" column is a Postgres timestamp WITHOUT time zone, and
    // node-pg serializes a JS Date's LOCAL wall-clock fields into it (not
    // UTC), so an exact-UTC-midnight value can silently land a few hours
    // into day 1 once round-tripped through the local test-runner's
    // timezone offset — pushing it safely into the prior day sidesteps that
    // entirely rather than relying on exact-midnight equality.
    const historyEffectiveFrom = new Date(monthStart.getTime() - 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO "TeacherWorkingDaysHistory" (id, "teacherId", "schoolId", "effectiveFrom", "workingDays", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
      [teacherId, schoolId, historyEffectiveFrom, [0, 1, 2, 3, 4, 5, 6]],
    );

    // Mark today Present directly (bypassing the report-submission flow,
    // which requires a period actually scheduled today).
    await pool.query(
      `INSERT INTO "Attendance" (id, "teacherId", "schoolId", date, status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Present')
       ON CONFLICT ("teacherId", "schoolId", date) DO UPDATE SET status = 'Present'`,
      [teacherId, schoolId, todayUTC],
    );

    try {
      const res = await request(app.getHttpServer())
        .get(`/teacher/attendance/monthly?school_id=${schoolId}&yearMonth=${yearMonth}`)
        .set(...teacherAuth)
        .expect(200);
      const monthEntry = res.body.monthlyData.find(
        (m: any) => m.month === yearMonth,
      );
      expect(monthEntry).toBeDefined();
      expect(monthEntry.present_days).toBe(1);

      // Every day from the 1st through today is a working day (7/7 pattern),
      // so total_working_days must equal today's day-of-month — NOT the
      // full month's day count, which would include not-yet-happened days.
      const expectedWorkingDaysSoFar = now.getUTCDate();
      expect(monthEntry.total_working_days).toBe(expectedWorkingDaysSoFar);
      expect(monthEntry.attendance_percentage).toBe(
        Math.round((1 / expectedWorkingDaysSoFar) * 100),
      );
    } finally {
      await pool.query(
        `DELETE FROM "Attendance" WHERE "teacherId" = $1 AND "schoolId" = $2 AND date = $3`,
        [teacherId, schoolId, todayUTC],
      );
    }
  });
});
