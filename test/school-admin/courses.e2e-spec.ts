import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

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
});
