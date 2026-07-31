import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool, pool } from '../admin/support/db';

describe('school-admin student-progress', () => {
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

  it('returns the fixture students with the expected summary shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .expect(200);
    expect(Array.isArray(res.body.students)).toBe(true);
    expect(res.body.summary).toEqual(
      expect.objectContaining({
        total_students: expect.any(Number),
        students_with_progress: expect.any(Number),
        students_completed: expect.any(Number),
        average_system_progress: expect.any(Number),
        total_courses: expect.any(Number),
      }),
    );
    expect(res.body.summary.total_students).toBe(3);
    const ids = res.body.students.map((s: any) => Number(s.student_id));
    expect(ids).toEqual(
      expect.arrayContaining(fixture.students.map((s) => s.id)),
    );
  });

  it('filters by grade/section', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .query({ grade: fixture.grade, section: fixture.section })
      .expect(200);
    expect(res.body.summary.total_students).toBe(3);
  });

  it('filters by an unmatched grade -> zero students', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .query({ grade: 'Nonexistent Grade XYZ' })
      .expect(200);
    expect(res.body.summary.total_students).toBe(0);
    expect(res.body.students).toEqual([]);
  });

  it('filters by student_id', async () => {
    const target = fixture.students[0];
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .query({ student_id: String(target.id) })
      .expect(200);
    expect(res.body.students).toHaveLength(1);
    expect(Number(res.body.students[0].student_id)).toBe(target.id);
  });

  it('excludes a deactivated student from the population/summary (matches /admin/student-progress)', async () => {
    const target = fixture.students[1];

    // Soft-deactivate via the same endpoint the school-admin UI's
    // "Deactivate student" action uses — sets both User.isActive and the
    // StudentSchool enrollment's isActive to false.
    await request(app.getHttpServer())
      .delete(`/school-admin/students/${target.id}?hard=false`)
      .set(...auth)
      .expect(200);

    try {
      const res = await request(app.getHttpServer())
        .get('/school-admin/student-progress')
        .set(...auth)
        .expect(200);
      const ids = res.body.students.map((s: any) => Number(s.student_id));
      expect(ids).not.toContain(target.id);
      expect(res.body.summary.total_students).toBe(2);
    } finally {
      // Reactivate so this test doesn't bleed into the others in this file.
      await pool.query('UPDATE "User" SET "isActive" = true WHERE id = $1', [target.id]);
      await pool.query(
        'UPDATE "StudentSchool" SET "isActive" = true WHERE "studentId" = $1',
        [target.id],
      );
    }
  });

  it('total_students matches a real COUNT(*), independent of the in-memory student list', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .expect(200);
    expect(res.body.summary.total_students).toBe(res.body.students.length);
  });

  it(
    'summary.total_courses excludes a soft-deleted course, and it disappears from the ' +
      'courses list and every student\'s per-course breakdown',
    async () => {
      const adminAuth: [string, string] = ['Authorization', `Bearer ${fixture.admin.token}`];
      const createRes = await request(app.getHttpServer())
        .post('/admin/courses')
        .set(...adminAuth)
        .send({
          name: '__qa_test_school_admin_extra_progress_course',
          description: 'QA extra course for school-admin total_courses regression test',
          school_ids: [fixture.schoolId],
          grades: [fixture.grade],
          is_published: true,
          status: 'Published',
        })
        .expect(201);
      const extraCourseId: string = createRes.body?.data?.id ?? createRes.body?.id;
      expect(extraCourseId).toBeDefined();

      const before = await request(app.getHttpServer())
        .get('/school-admin/student-progress')
        .set(...auth)
        .expect(200);
      const beforeTotal = before.body.summary.total_courses;
      expect(
        before.body.courses.some((c: any) => c.course_id === extraCourseId),
      ).toBe(true);

      await request(app.getHttpServer())
        .delete(`/admin/courses/${extraCourseId}`)
        .set(...adminAuth)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get('/school-admin/student-progress')
        .set(...auth)
        .expect(200);
      expect(after.body.summary.total_courses).toBe(beforeTotal - 1);
      expect(
        after.body.courses.some((c: any) => c.course_id === extraCourseId),
      ).toBe(false);
      for (const s of after.body.students) {
        expect(
          s.courses.some((c: any) => c.course_id === extraCourseId),
        ).toBe(false);
      }

      await request(app.getHttpServer())
        .delete(`/admin/trash?entity_type=courses&id=${extraCourseId}`)
        .set(...adminAuth)
        .expect(200);
    },
  );

  it(
    'a chapterless course with a stray high-progress row is NOT reported as "completed" ' +
      '(regression: this endpoint used to hand-roll its own status rule that only checked ' +
      'progressPercentage >= 100, unlike the shared computeCourseProgress util used by ' +
      '/admin/student-progress, which additionally requires completedChapters >= totalChapters)',
    async () => {
      const target = fixture.students[0];
      // fixture.courseId is published but was never given any chapters/content
      // — exactly the "chapterless" edge case. A stray CourseProgress row with
      // progress >= 99 and no chapterId/contentId used to be enough to flip
      // this endpoint's own status rule to 'completed'.
      await pool.query(
        `INSERT INTO "CourseProgress" (id, "studentId", "courseId", "chapterId", "contentId", progress, "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, NULL, NULL, 99, now())
         ON CONFLICT ("studentId", "courseId", "chapterId", "contentId") DO UPDATE SET progress = 99`,
        [target.id, fixture.courseId],
      );

      const res = await request(app.getHttpServer())
        .get('/school-admin/student-progress')
        .set(...auth)
        .query({ student_id: String(target.id) })
        .expect(200);
      const student = res.body.students[0];
      const courseEntry = student.courses.find(
        (c: any) => c.course_id === fixture.courseId,
      );
      expect(courseEntry).toBeDefined();
      expect(courseEntry.total_chapters).toBe(0);
      // progress_percentage can still read 100 (the util's documented
      // fallback for a chapterless course), but status must not be
      // 'completed' without any chapters to actually complete.
      expect(courseEntry.status).not.toBe('completed');
      expect(student.completed_courses).toBe(0);
    },
  );
});
