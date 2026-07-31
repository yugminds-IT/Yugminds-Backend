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
 * Regression coverage for the Student dashboard Overview tab:
 * - GET /student/dashboard stat cards must agree with the "Active Courses"
 *   list (GET /student/courses), instead of each deriving completion with
 *   its own slightly different rules (the courses-with-zero-chapters and
 *   0%-progress edge cases used to be silently excluded from both the
 *   "Active Courses" and "Courses Completed" counts, while the same
 *   courses appeared in the Active Courses list).
 * - GET /student/last-viewed ("Jump back in") must not surface a course
 *   that's already 100% complete as "Resume".
 */
describe('Student dashboard overview', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let studentAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    studentAuth = authHeader(fixture.students[0].token);
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it(
    "a freshly-enrolled course with zero chapters counts as 'active' in " +
      'the stat card, matching the Active Courses list ' +
      '(regression guard for the zero-chapter skip bug)',
    async () => {
      const dashRes = await request(app.getHttpServer())
        .get('/student/dashboard')
        .set(...studentAuth)
        .expect(200);
      expect(dashRes.body.stats.activeCourses).toBe(1);
      expect(dashRes.body.stats.completedCourses).toBe(0);

      const coursesRes = await request(app.getHttpServer())
        .get('/student/courses')
        .set(...studentAuth)
        .expect(200);
      const fixtureCourse = coursesRes.body.courses.find(
        (c: { id: string }) => c.id === fixture.courseId,
      );
      expect(fixtureCourse).toBeDefined();
      expect(fixtureCourse.progress_percentage).toBeLessThan(100);
    },
  );

  it(
    'completing every chapter in the course flips both the stat cards and ' +
      'the Active Courses list to "completed" in agreement, and the ' +
      "course stops appearing as \"Jump back in / Resume\" " +
      '(regression guard for the completed-course-still-resumable bug)',
    async () => {
      const chapterRes = await request(app.getHttpServer())
        .post(`/admin/courses/${fixture.courseId}/chapters`)
        .set(...authHeader(fixture.admin.token))
        .send({ name: 'Only Chapter' })
        .expect(201);
      const chapterId: string = chapterRes.body.id;

      await request(app.getHttpServer())
        .post('/student/simple-progress')
        .set(...studentAuth)
        .send({ courseId: fixture.courseId, chapterId, isCompleted: true })
        .expect(201);

      const dashRes = await request(app.getHttpServer())
        .get('/student/dashboard')
        .set(...studentAuth)
        .expect(200);
      expect(dashRes.body.stats.activeCourses).toBe(0);
      expect(dashRes.body.stats.completedCourses).toBe(1);

      const coursesRes = await request(app.getHttpServer())
        .get('/student/courses')
        .set(...studentAuth)
        .expect(200);
      const fixtureCourse = coursesRes.body.courses.find(
        (c: { id: string }) => c.id === fixture.courseId,
      );
      expect(fixtureCourse.progress_percentage).toBe(100);

      const lastViewedRes = await request(app.getHttpServer())
        .get('/student/last-viewed')
        .set(...studentAuth)
        .expect(200);
      if (lastViewedRes.body.lastViewed) {
        expect(lastViewedRes.body.lastViewed.courseId).not.toBe(
          fixture.courseId,
        );
      }
    },
  );

  it(
    'GET /profile includes the school/grade/section the greeting subtitle ' +
      'reads (regression guard for the always-empty "profile.students" bug ' +
      'that rendered a lone bullet under the dashboard greeting)',
    async () => {
      const res = await request(app.getHttpServer())
        .get('/profile')
        .set(...studentAuth)
        .expect(200);
      const info = res.body.profile.students?.[0];
      expect(info).toBeDefined();
      expect(info.grade).toBe(fixture.grade);
      expect(info.section).toBe(fixture.section);
      expect(info.schools?.[0]?.name).toEqual(expect.any(String));
    },
  );

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/student/dashboard').expect(401);
    await request(app.getHttpServer()).get('/student/last-viewed').expect(401);
  });
});
