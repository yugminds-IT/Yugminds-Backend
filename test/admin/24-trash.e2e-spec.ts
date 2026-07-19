import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin trash: course soft-delete -> vanishes from student view -> restore (not auto-republished)', () => {
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

  it('fixture student sees the published course before trashing', async () => {
    const res = await request(app.getHttpServer())
      .get('/student/courses')
      .set(...authHeader(fixture.students[0].token))
      .expect(200);
    const courses = res.body?.courses ?? [];
    expect(courses.some((c: { id: string }) => c.id === fixture.courseId)).toBe(true);
  });

  it('GET /admin/trash lists nothing for the fixture course yet', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/trash')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const trash = res.body?.data ?? res.body;
    const courses = trash?.courses ?? [];
    expect(courses.some((c: { id: string }) => c.id === fixture.courseId)).toBe(false);
  });

  it('soft-deleting the course removes it from the trash list source AND from the student view', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/courses/${fixture.courseId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const trash = await request(app.getHttpServer())
      .get('/admin/trash')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const trashBody = trash.body?.data ?? trash.body;
    const trashedCourses = trashBody?.courses ?? [];
    expect(trashedCourses.some((c: { id: string }) => c.id === fixture.courseId)).toBe(true);

    const studentView = await request(app.getHttpServer())
      .get('/student/courses')
      .set(...authHeader(fixture.students[0].token))
      .expect(200);
    const courses = studentView.body?.courses ?? [];
    expect(courses.some((c: { id: string }) => c.id === fixture.courseId)).toBe(false);
  });

  it('restoring brings it back but NOT re-published', async () => {
    await request(app.getHttpServer())
      .post('/admin/trash/restore')
      .set(...authHeader(fixture.admin.token))
      .send({ entity_type: 'courses', id: fixture.courseId })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const course = res.body?.data ?? res.body;
    expect(course.is_published ?? course.isPublished).toBe(false);
  });
});
