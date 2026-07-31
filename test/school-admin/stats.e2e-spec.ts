import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin stats / assignment-analytics / leaderboard', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /school-admin/stats reflects fixture counts (2 active teachers, 3 students)', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...auth)
      .expect(200);
    expect(res.body.stats.totalTeachers).toBe(2);
    expect(res.body.stats.totalStudents).toBe(3);
    expect(res.body.stats).toEqual(
      expect.objectContaining({
        activeCourses: expect.any(Number),
        pendingReports: expect.any(Number),
        pendingLeaves: expect.any(Number),
        averageAttendance: expect.any(Number),
      }),
    );
  });

  it('GET /school-admin/assignment-analytics no longer exists (removed dead/duplicate endpoint — the real UI only ever used /school-admin/leaderboard)', async () => {
    await request(app.getHttpServer())
      .get('/school-admin/assignment-analytics')
      .set(...auth)
      .expect(404);
  });

  it('GET /school-admin/leaderboard returns expected shape and school name matches fixture', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/leaderboard')
      .set(...auth)
      .expect(200);
    expect(res.body.summary.school_name).toContain('__qa_test_');
    expect(res.body.summary.total_students).toBe(3);
    expect(Array.isArray(res.body.leaderboard)).toBe(true);
    expect(Array.isArray(res.body.grade_breakdown)).toBe(true);
    expect(Array.isArray(res.body.subject_breakdown)).toBe(true);
    expect(Array.isArray(res.body.assignment_table)).toBe(true);
  });

  it('unauthenticated requests are rejected', async () => {
    await request(app.getHttpServer()).get('/school-admin/stats').expect(401);
  });
});
