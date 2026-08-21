import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool, pool } from './support/db';

describe('Admin courses CRUD + publish auto-enrollment', () => {
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

  it('GET /admin/courses lists the fixture course', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/courses?limit=300')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const courses = res.body?.data?.courses ?? res.body?.courses ?? [];
    expect(courses.some((c: { id: string }) => c.id === fixture.courseId)).toBe(true);
  });

  it('GET /admin/courses/:id returns full detail with chapters array', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const course = res.body?.data ?? res.body;
    expect(Array.isArray(course.chapters)).toBe(true);
  });

  it('POST /admin/courses/:id/chapters adds a chapter', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/courses/${fixture.courseId}/chapters`)
      .set(...authHeader(fixture.admin.token))
      .send({ name: 'QA Chapter 1', title: 'QA Chapter 1' })
      .expect(201);
    expect(res.body).toBeDefined();
  });

  it('PATCH /admin/courses/:id updates the description', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/courses/${fixture.courseId}`)
      .set(...authHeader(fixture.admin.token))
      .send({ description: 'QA updated description' })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const course = res.body?.data ?? res.body;
    expect(course.description).toBe('QA updated description');
  });

  it('POST /admin/courses/:id/access rewrites CourseAccess for the fixture school', async () => {
    await request(app.getHttpServer())
      .post(`/admin/courses/${fixture.courseId}/access`)
      .set(...authHeader(fixture.admin.token))
      .send({ school_ids: [fixture.schoolId], grades: [fixture.grade] })
      .expect(201);
  });

  it('POST /admin/courses/:id/publish rejects a course with zero chapters', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/courses')
      .set(...authHeader(fixture.admin.token))
      .send({ name: `QA Empty Course ${Date.now()}` })
      .expect(201);
    const emptyCourseId: string = createRes.body?.data?.id ?? createRes.body?.id;
    expect(emptyCourseId).toBeDefined();

    const res = await request(app.getHttpServer())
      .post(`/admin/courses/${emptyCourseId}/publish`)
      .set(...authHeader(fixture.admin.token))
      .send({ publish: true })
      .expect(400);
    expect(res.body?.message).toMatch(/chapter/i);

    await request(app.getHttpServer())
      .delete(`/admin/courses/${emptyCourseId}`)
      .set(...authHeader(fixture.admin.token))
      .catch(() => undefined);
    await request(app.getHttpServer())
      .delete(`/admin/trash?entity_type=courses&id=${emptyCourseId}`)
      .set(...authHeader(fixture.admin.token))
      .catch(() => undefined);
  });

  it('POST /admin/courses/:id/publish auto-enrolls fixture students', async () => {
    await request(app.getHttpServer())
      .post(`/admin/courses/${fixture.courseId}/publish`)
      .set(...authHeader(fixture.admin.token))
      .send({ publish: true })
      .expect(201);

    const { rows } = await pool.query(
      `SELECT "studentId" FROM "StudentCourse" WHERE "courseId" = $1`,
      [fixture.courseId],
    );
    const enrolledIds = rows.map((r) => r.studentId);
    expect(enrolledIds).toEqual(
      expect.arrayContaining(fixture.students.map((s) => s.id)),
    );
  });

  it('POST /admin/courses/:id/duplicate creates a copy', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/courses/${fixture.courseId}/duplicate`)
      .set(...authHeader(fixture.admin.token))
      .expect(201);
    const dupId: string = res.body?.data?.id ?? res.body?.id;
    expect(dupId).toBeDefined();
    expect(dupId).not.toBe(fixture.courseId);

    // Clean up the duplicate immediately (own throwaway, not part of the
    // shared fixture's teardown flow).
    await request(app.getHttpServer())
      .delete(`/admin/courses/${dupId}`)
      .set(...authHeader(fixture.admin.token))
      .catch(() => undefined);
    await request(app.getHttpServer())
      .delete(`/admin/trash?entity_type=courses&id=${dupId}`)
      .set(...authHeader(fixture.admin.token))
      .catch(() => undefined);
  });
});
