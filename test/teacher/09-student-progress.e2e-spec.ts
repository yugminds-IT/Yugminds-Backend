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

describe('Teacher student-progress', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let otherSchoolFixture: QaFixture;
  let teacherAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    otherSchoolFixture = await createQaFixture(app);
    teacherAuth = authHeader(fixture.teachers[0].token);
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app && otherSchoolFixture)
      await teardownQaFixture(app, otherSchoolFixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it('lists all 3 fixture students, auto-enrolled in the fixture course, with zero progress initially', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/student-progress?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.students).toHaveLength(3);
    const s0 = res.body.students.find(
      (s: any) => s.student_id === String(fixture.students[0].id),
    );
    expect(s0).toBeDefined();
    expect(s0.total_courses).toBe(1);
    expect(s0.average_progress).toBe(0);
    expect(res.body.summary.total_students).toBe(3);
  });

  it(
    'reflects a course-level progress marker in average_progress, but does NOT report the ' +
      'course as "completed" when it has no chapters (matches /school-admin/student-progress ' +
      'and /admin/student-progress, which use the same shared computeCourseProgress util and ' +
      'require completedChapters >= totalChapters — a chapterless course can never satisfy that, ' +
      'by design, regardless of a stray whole-course progress row)',
    async () => {
      await request(app.getHttpServer())
        .post('/student/simple-progress')
        .set(...authHeader(fixture.students[0].token))
        .send({ courseId: fixture.courseId, isCompleted: true })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(
          `/teacher/student-progress?school_id=${fixture.schoolId}&student_id=${fixture.students[0].id}`,
        )
        .set(...teacherAuth)
        .expect(200);
      expect(res.body.students).toHaveLength(1);
      expect(res.body.students[0].average_progress).toBe(100);
      expect(res.body.students[0].completed_courses).toBe(0);

      const other = await request(app.getHttpServer())
        .get(
          `/teacher/student-progress?school_id=${fixture.schoolId}&student_id=${fixture.students[1].id}`,
        )
        .set(...teacherAuth)
        .expect(200);
      expect(other.body.students[0].average_progress).toBe(0);
    },
  );

  it(
    'summary.average_school_progress mirrors average_system_progress (regression: the ' +
      "frontend's Class Average card reads average_school_progress specifically — the " +
      'school-admin endpoint sends both keys, but this endpoint used to send only ' +
      'average_system_progress, so Class Average always showed 0%)',
    async () => {
      const res = await request(app.getHttpServer())
        .get(`/teacher/student-progress?school_id=${fixture.schoolId}`)
        .set(...teacherAuth)
        .expect(200);
      expect(res.body.summary.average_school_progress).toBe(
        res.body.summary.average_system_progress,
      );
      expect(res.body.summary.average_school_progress).toBeGreaterThan(0);
    },
  );

  it('excludes a deactivated student from the population/summary (matches /school-admin/student-progress)', async () => {
    const target = fixture.students[2];
    const schoolAdminAuth = authHeader(fixture.schoolAdmin.token);

    await request(app.getHttpServer())
      .delete(`/school-admin/students/${target.id}?hard=false`)
      .set(...schoolAdminAuth)
      .expect(200);

    try {
      const res = await request(app.getHttpServer())
        .get(`/teacher/student-progress?school_id=${fixture.schoolId}`)
        .set(...teacherAuth)
        .expect(200);
      const ids = res.body.students.map((s: any) => Number(s.student_id));
      expect(ids).not.toContain(target.id);
    } finally {
      await pool.query('UPDATE "User" SET "isActive" = true WHERE id = $1', [
        target.id,
      ]);
      await pool.query(
        'UPDATE "StudentSchool" SET "isActive" = true WHERE "studentId" = $1',
        [target.id],
      );
    }
  });

  it("summary.total_courses excludes a soft-deleted course, and it disappears from every student's per-course breakdown", async () => {
    const adminAuth: [string, string] = [
      'Authorization',
      `Bearer ${fixture.admin.token}`,
    ];
    const createRes = await request(app.getHttpServer())
      .post('/admin/courses')
      .set(...adminAuth)
      .send({
        name: '__qa_test_teacher_extra_progress_course',
        description: 'QA extra course for teacher total_courses regression test',
        school_ids: [fixture.schoolId],
        grades: [fixture.grade],
        is_published: true,
        status: 'Published',
      })
      .expect(201);
    const extraCourseId: string = createRes.body?.data?.id ?? createRes.body?.id;
    expect(extraCourseId).toBeDefined();

    const before = await request(app.getHttpServer())
      .get(`/teacher/student-progress?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    const beforeTotal = before.body.summary.total_courses;

    await request(app.getHttpServer())
      .delete(`/admin/courses/${extraCourseId}`)
      .set(...adminAuth)
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`/teacher/student-progress?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(after.body.summary.total_courses).toBe(beforeTotal - 1);
    for (const s of after.body.students) {
      expect(
        s.courses.some((c: any) => c.course_id === extraCourseId),
      ).toBe(false);
    }

    await request(app.getHttpServer())
      .delete(`/admin/trash?entity_type=courses&id=${extraCourseId}`)
      .set(...adminAuth)
      .expect(200);
  });

  it('filters by section, returning nothing for a section the teacher has no student in', async () => {
    const matching = await request(app.getHttpServer())
      .get(
        `/teacher/student-progress?school_id=${fixture.schoolId}&section=${fixture.section}`,
      )
      .set(...teacherAuth)
      .expect(200);
    expect(matching.body.students.length).toBe(3);

    const empty = await request(app.getHttpServer())
      .get(
        `/teacher/student-progress?school_id=${fixture.schoolId}&section=NoSuchSection`,
      )
      .set(...teacherAuth)
      .expect(200);
    expect(empty.body.students).toHaveLength(0);
  });

  it("cannot query another school's student progress (tenant interceptor blocks it)", async () => {
    await request(app.getHttpServer())
      .get(`/teacher/student-progress?school_id=${otherSchoolFixture.schoolId}`)
      .set(...teacherAuth)
      .expect(403);
  });

  it('rejects unauthenticated and non-teacher access', async () => {
    await request(app.getHttpServer())
      .get('/teacher/student-progress')
      .expect(401);
    const res = await request(app.getHttpServer())
      .get('/teacher/student-progress')
      .set(...authHeader(fixture.students[0].token));
    expect([401, 403]).toContain(res.status);
  });
});
