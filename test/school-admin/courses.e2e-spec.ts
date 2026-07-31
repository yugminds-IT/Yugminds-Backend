import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool, pool } from '../admin/support/db';
import { authHeader } from '../admin/support/auth';

describe('school-admin courses + progress', () => {
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

  it('GET /school-admin/courses lists the fixture course', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/courses')
      .set(...auth)
      .expect(200);
    expect(Array.isArray(res.body.courses)).toBe(true);
    const found = res.body.courses.find((c: any) => c.id === fixture.courseId);
    expect(found).toBeTruthy();
    expect(found.school_id).toBe(fixture.schoolId);
  });

  it('GET /school-admin/courses/progress returns the fixture course row', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/courses/progress')
      .set(...auth)
      .expect(200);
    expect(Array.isArray(res.body.progress)).toBe(true);
    const found = res.body.progress.find(
      (p: any) => p.course_id === fixture.courseId,
    );
    expect(found).toBeTruthy();
    expect(found).toEqual(
      expect.objectContaining({
        total_students: expect.any(Number),
        completed_students: expect.any(Number),
        average_progress: expect.any(Number),
      }),
    );
  });

  it('GET /school-admin/courses/progress/students returns fixture students', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/courses/progress/students')
      .set(...auth)
      .query({ courseId: fixture.courseId })
      .expect(200);
    expect(Array.isArray(res.body.students)).toBe(true);
    const ids = res.body.students.map((s: any) => Number(s.student_id));
    expect(ids).toEqual(
      expect.arrayContaining(fixture.students.map((s) => s.id)),
    );
  });

  it('GET /school-admin/courses/progress/students/detail requires courseId', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/courses/progress/students/detail')
      .set(...auth)
      .expect(200);
    expect(res.body).toEqual({ students: [], chapters: [] });
  });

  it('GET /school-admin/courses/progress/students/detail scoped to a student returns shape', async () => {
    const target = fixture.students[0];
    const res = await request(app.getHttpServer())
      .get('/school-admin/courses/progress/students/detail')
      .set(...auth)
      .query({ courseId: fixture.courseId, studentId: String(target.id) })
      .expect(200);
    expect(res.body).toHaveProperty('students');
    expect(res.body).toHaveProperty('chapters');
  });

  it('status filter narrows results (Published/Draft)', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/courses')
      .set(...auth)
      .query({ status: 'Draft' })
      .expect(200);
    for (const c of res.body.courses) {
      expect(c.status).toBe('Draft');
    }
  });

  it('soft-deleting a course removes it from both /courses and /courses/progress', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/courses')
      .set(...authHeader(fixture.admin.token))
      .send({
        name: '__qa_test_school_admin_extra_course',
        description: 'QA extra course for soft-delete exclusion test',
        school_ids: [fixture.schoolId],
        grades: [fixture.grade],
        is_published: true,
        status: 'Published',
      })
      .expect(201);
    const extraCourseId: string =
      createRes.body?.data?.id ?? createRes.body?.id;
    expect(extraCourseId).toBeDefined();

    const before = await request(app.getHttpServer())
      .get('/school-admin/courses')
      .set(...auth)
      .expect(200);
    expect(
      before.body.courses.some((c: { id: string }) => c.id === extraCourseId),
    ).toBe(true);

    await request(app.getHttpServer())
      .delete(`/admin/courses/${extraCourseId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const afterList = await request(app.getHttpServer())
      .get('/school-admin/courses')
      .set(...auth)
      .expect(200);
    expect(
      afterList.body.courses.some((c: { id: string }) => c.id === extraCourseId),
    ).toBe(false);

    const afterProgress = await request(app.getHttpServer())
      .get('/school-admin/courses/progress')
      .set(...auth)
      .expect(200);
    expect(
      afterProgress.body.progress.some(
        (p: { course_id: string }) => p.course_id === extraCourseId,
      ),
    ).toBe(false);

    // Cleanup: purge so it doesn't linger as debris across other test files.
    await request(app.getHttpServer())
      .delete(`/admin/trash?entity_type=courses&id=${extraCourseId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
  });

  it('total_students excludes an orphaned StudentCourse row (no backing User)', async () => {
    const before = await request(app.getHttpServer())
      .get('/school-admin/courses/progress')
      .set(...auth)
      .expect(200);
    const beforeCount = before.body.progress.find(
      (p: { course_id: string }) => p.course_id === fixture.courseId,
    )?.total_students;

    // A ghost enrollment: StudentCourse.studentId has no enforced FK to
    // User, so a hard-deleted (or never-real) student id can linger here
    // forever and inflate the count — exactly what was found live on
    // Dawn Buds' "Sctarch" course (studentId 3365, no matching User row).
    await pool.query(
      `INSERT INTO "StudentCourse" (id, "studentId", "courseId", "enrolledAt")
       VALUES (gen_random_uuid(), 999999998, $1, now())`,
      [fixture.courseId],
    );

    try {
      const after = await request(app.getHttpServer())
        .get('/school-admin/courses/progress')
        .set(...auth)
        .expect(200);
      const afterCount = after.body.progress.find(
        (p: { course_id: string }) => p.course_id === fixture.courseId,
      )?.total_students;
      expect(afterCount).toBe(beforeCount);
    } finally {
      await pool.query(
        'DELETE FROM "StudentCourse" WHERE "studentId" = 999999998 AND "courseId" = $1',
        [fixture.courseId],
      );
    }
  });

  it('average_progress counts an enrolled-but-untouched student as 0%, not excluded from the average', async () => {
    // Add a real chapter to the fixture course so there's something to mark
    // "complete" against.
    const chapterRes = await request(app.getHttpServer())
      .post(`/admin/courses/${fixture.courseId}/chapters`)
      .set(...authHeader(fixture.admin.token))
      .send({ name: 'QA Progress-Averaging Chapter' })
      .expect(201);
    const chapterId: string = chapterRes.body?.data?.id ?? chapterRes.body?.id;
    expect(chapterId).toBeDefined();

    // Only the FIRST of the 3 fixture students (all auto-enrolled in the
    // published fixture course) gets a completed progress row — the other
    // two remain enrolled but have touched nothing.
    const touchedStudentId = fixture.students[0].id;
    await pool.query(
      `INSERT INTO "CourseProgress" (id, "studentId", "courseId", "chapterId", progress, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 100, now())`,
      [touchedStudentId, fixture.courseId, chapterId],
    );

    try {
      const res = await request(app.getHttpServer())
        .get('/school-admin/courses/progress')
        .set(...auth)
        .expect(200);
      const row = res.body.progress.find(
        (p: { course_id: string }) => p.course_id === fixture.courseId,
      );
      expect(row).toBeDefined();
      // 1 of 3 enrolled students at 100%, 2 at 0% (untouched, still counted)
      // -> average must be ~33%, not 100% (which is what the old code gave
      // by excluding the two untouched students from the denominator).
      expect(row.total_students).toBeGreaterThanOrEqual(3);
      expect(row.average_progress).toBeGreaterThan(0);
      expect(row.average_progress).toBeLessThan(50);
    } finally {
      await pool.query(
        'DELETE FROM "CourseProgress" WHERE "chapterId" = $1',
        [chapterId],
      );
      await pool.query('DELETE FROM "Chapter" WHERE id = $1', [chapterId]);
    }
  });
});
