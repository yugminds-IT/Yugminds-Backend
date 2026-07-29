import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader, mintAccessToken } from './support/auth';
import { closePool } from './support/db';

describe('Admin student-progress', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);

    await request(app.getHttpServer())
      .post(`/admin/courses/${fixture.courseId}/publish`)
      .set(...authHeader(fixture.admin.token))
      .send({ publish: true })
      .expect(201);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/student-progress?school_id scopes to the fixture school and includes the fixture students', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/student-progress?school_id=${fixture.schoolId}&limit=500`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const body = res.body;
    expect(body.students).toBeDefined();
    expect(body.schools).toBeDefined();
    expect(body.courses).toBeDefined();
    expect(body.summary).toBeDefined();
    expect(body.pagination).toBeDefined();

    const fixtureStudentIds = fixture.students.map((s) => String(s.id));
    const returned = body.students.filter((s: { student_id: string }) =>
      fixtureStudentIds.includes(s.student_id),
    );
    expect(returned.length).toBe(fixture.students.length);
    for (const s of returned) {
      expect(s.school_id).toBe(fixture.schoolId);
      expect(s.grade).toBe(fixture.grade);
    }

    const school = body.schools.find(
      (s: { school_id: string }) => s.school_id === fixture.schoolId,
    );
    expect(school).toBeDefined();
  });

  it('GET /admin/student-progress?course_id restricts to enrollments in that course', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/student-progress?course_id=${fixture.courseId}&limit=500`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const courses = res.body.courses ?? [];
    if (courses.length > 0) {
      expect(courses.every((c: { course_id: string }) => c.course_id === fixture.courseId)).toBe(true);
    }
  });

  it('GET /admin/student-progress?student_id filters to a single student', async () => {
    const target = fixture.students[0];
    const res = await request(app.getHttpServer())
      .get(`/admin/student-progress?student_id=${target.id}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const students = res.body.students ?? [];
    expect(students.length).toBe(1);
    expect(students[0].student_id).toBe(String(target.id));
    expect(res.body.summary.total_students).toBe(1);
  });

  it('GET /admin/student-progress?grade filters by grade, no match for a bogus grade returns empty summary', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/student-progress?school_id=${fixture.schoolId}&grade=ZZ-not-a-real-grade`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(res.body.students).toEqual([]);
    expect(res.body.schools).toEqual([]);
    expect(res.body.courses).toEqual([]);
    expect(res.body.summary.total_students).toBe(0);
    expect(res.body.pagination.total).toBe(0);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  it('GET /admin/student-progress honors limit/offset pagination', async () => {
    const page1 = await request(app.getHttpServer())
      .get(`/admin/student-progress?school_id=${fixture.schoolId}&limit=1&offset=0`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    expect(page1.body.students.length).toBeLessThanOrEqual(1);
    expect(page1.body.pagination.limit).toBe(1);
    expect(page1.body.pagination.offset).toBe(0);

    const page2 = await request(app.getHttpServer())
      .get(`/admin/student-progress?school_id=${fixture.schoolId}&limit=1&offset=1`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    if (page1.body.students[0] && page2.body.students[0]) {
      expect(page1.body.students[0].student_id).not.toBe(
        page2.body.students[0].student_id,
      );
    }
  });

  it('excludes deactivated students from the unfiltered summary/population (no more whole-DB unscoped counting)', async () => {
    const target = fixture.students[1];

    // Deactivate one fixture student who is already enrolled (via the
    // published fixture course) and therefore has a real StudentCourse row.
    await request(app.getHttpServer())
      .patch(`/admin/students/${target.id}`)
      .set(...authHeader(fixture.admin.token))
      .send({ isActive: false })
      .expect(200);

    try {
      // No filters at all — this used to compute the summary from every
      // StudentCourse/CourseProgress row in the entire database (studentScope
      // = {}), so a deactivated student's enrollment could still inflate it.
      const res = await request(app.getHttpServer())
        .get('/admin/student-progress?limit=5000')
        .set(...authHeader(fixture.admin.token))
        .expect(200);

      const ids = (res.body.students as Array<{ student_id: string }>).map(
        (s) => s.student_id,
      );
      expect(ids).not.toContain(String(target.id));
    } finally {
      await request(app.getHttpServer())
        .patch(`/admin/students/${target.id}`)
        .set(...authHeader(fixture.admin.token))
        .send({ isActive: true })
        .expect(200);
    }
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/admin/student-progress').expect(401);
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
      .get('/admin/student-progress')
      .set('Authorization', `Bearer ${teacherToken}`);
    expect([401, 403]).toContain(res.status);
  });
});
