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

  it('reflects a real course completion after the student marks progress', async () => {
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
    expect(res.body.students[0].completed_courses).toBe(1);
    expect(res.body.summary.students_completed).toBeGreaterThanOrEqual(1);

    const other = await request(app.getHttpServer())
      .get(
        `/teacher/student-progress?school_id=${fixture.schoolId}&student_id=${fixture.students[1].id}`,
      )
      .set(...teacherAuth)
      .expect(200);
    expect(other.body.students[0].average_progress).toBe(0);
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
