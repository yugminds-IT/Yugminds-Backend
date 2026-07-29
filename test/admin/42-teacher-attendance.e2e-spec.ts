import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader, mintAccessToken } from './support/auth';
import { closePool } from './support/db';

describe('Admin teacher-attendance', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/teacher-attendance returns both a today snapshot (attendanceRate) and a real average (averageAttendanceRate)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/teacher-attendance?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const summary = res.body.summary;
    expect(summary).toBeDefined();
    expect(typeof summary.attendanceRate).toBe('number');
    expect(typeof summary.averageAttendanceRate).toBe('number');
    expect(summary.averageAttendanceRate).toBeGreaterThanOrEqual(0);
    expect(summary.averageAttendanceRate).toBeLessThanOrEqual(100);
  });

  it('averageAttendanceRate is the mean of the same per-teacher percentages the Attendance tab (monthly) shows — not tied to whether today has been marked yet', async () => {
    const [listRes, monthlyRes] = await Promise.all([
      request(app.getHttpServer())
        .get(`/admin/teacher-attendance?school_id=${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200),
      request(app.getHttpServer())
        .get(`/admin/teacher-attendance/monthly?school_id=${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200),
    ]);

    const monthlyData = monthlyRes.body.monthlyData as Array<{
      total_working_days: number;
      attendance_percentage: number;
    }>;
    const rated = monthlyData.filter((m) => m.total_working_days > 0);
    const expectedAverage =
      rated.length > 0
        ? Math.round(
            rated.reduce((sum, m) => sum + m.attendance_percentage, 0) / rated.length,
          )
        : 0;

    expect(listRes.body.summary.averageAttendanceRate).toBe(expectedAverage);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/admin/teacher-attendance').expect(401);
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
      .get('/admin/teacher-attendance')
      .set('Authorization', `Bearer ${teacherToken}`);
    expect([401, 403]).toContain(res.status);
  });
});
