import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { mintAccessToken, authHeader } from '../admin/support/auth';
import { closePool } from '../admin/support/db';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';

describe('Teacher dashboard', () => {
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

  it('GET /teacher/dashboard returns stats shape for the fixture teacher', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/dashboard')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(res.body?.stats).toBeDefined();
    expect(typeof res.body.stats.todaysClasses).toBe('number');
    expect(typeof res.body.stats.pendingReports).toBe('number');
    expect(typeof res.body.stats.totalClasses).toBe('number');
    expect(typeof res.body.stats.monthlyAttendance).toBe('number');
    expect(typeof res.body.stats.pendingLeaves).toBe('number');
    expect(typeof res.body.stats.totalStudents).toBe('number');
    expect(res.body?.meta?.school_ids).toContain(fixture.schoolId);
  });

  it('reflects real fixture data: totalClasses >= 1 and totalStudents >= 1 for the assigned section', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/dashboard?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(res.body.stats.totalClasses).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.totalStudents).toBeGreaterThanOrEqual(1);
  });

  it('honors an explicit date param', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/dashboard?date=2026-01-15`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(res.body.meta.date).toBe('2026-01-15');
  });

  it('403s when school_id is not one the teacher is assigned to', async () => {
    await request(app.getHttpServer())
      .get(`/teacher/dashboard?school_id=nonexistent-school-id`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(403);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/teacher/dashboard').expect(401);
  });

  it('rejects non-teacher roles', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/dashboard')
      .set(...authHeader(fixture.students[0].token));
    expect([401, 403]).toContain(res.status);
  });
});
