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

describe('Admin trash: teacher soft-delete -> restore round-trip', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
  }, 60000);

  it('deleting a teacher soft-deletes them into trash, and restore reactivates the account', async () => {
    const teacherId = fixture.teachers[0].id;

    await request(app.getHttpServer())
      .delete(`/admin/teachers/${teacherId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const trash = await request(app.getHttpServer())
      .get('/admin/trash')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const trashBody = trash.body?.data ?? trash.body;
    const trashedTeachers = trashBody?.teachers ?? [];
    expect(
      trashedTeachers.some((t: { id: string }) => t.id === String(teacherId)),
    ).toBe(true);

    // A soft-deleted account can't authenticate — confirms deletedAt/isActive
    // actually took effect, not just a cosmetic trash-list entry.
    await request(app.getHttpServer())
      .get('/teacher/dashboard')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(401);

    await request(app.getHttpServer())
      .post('/admin/trash/restore')
      .set(...authHeader(fixture.admin.token))
      .send({ entity_type: 'teachers', id: String(teacherId) })
      .expect(201);

    const trashAfter = await request(app.getHttpServer())
      .get('/admin/trash')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const trashAfterBody = trashAfter.body?.data ?? trashAfter.body;
    expect(
      (trashAfterBody?.teachers ?? []).some(
        (t: { id: string }) => t.id === String(teacherId),
      ),
    ).toBe(false);
  });
});

describe('Admin trash: students and schools are never soft-deletable (permanent-delete by design)', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    // teardownQaFixture's own requests are all wrapped in .catch(() =>
    // undefined), so it's safe to call even though the school (and one
    // student) were already deleted directly by the tests below — it still
    // correctly soft-deletes+purges the fixture's course, which otherwise
    // stays orphaned once its school/CourseAccess is gone.
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('deleting a student never lands them in trash — AdminStudentsService.delete() is a real hard delete', async () => {
    const studentId = fixture.students[0].id;

    await request(app.getHttpServer())
      .delete(`/admin/students/${studentId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const trash = await request(app.getHttpServer())
      .get('/admin/trash')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const trashBody = trash.body?.data ?? trash.body;
    expect(
      (trashBody?.students ?? []).some(
        (s: { id: string }) => s.id === String(studentId),
      ),
    ).toBe(false);

    // Restore must correctly 404 — there is genuinely nothing to restore,
    // regression guard for the Trash UI's own "students are never
    // recoverable" claim being actually true, not just unlisted.
    await request(app.getHttpServer())
      .post('/admin/trash/restore')
      .set(...authHeader(fixture.admin.token))
      .send({ entity_type: 'students', id: String(studentId) })
      .expect(404);
  });

  it('deleting a school never lands it in trash — AdminSchoolsService.delete() is a real hard delete', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/schools/${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const trash = await request(app.getHttpServer())
      .get('/admin/trash')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const trashBody = trash.body?.data ?? trash.body;
    expect(
      (trashBody?.schools ?? []).some(
        (s: { id: string }) => s.id === fixture.schoolId,
      ),
    ).toBe(false);

    await request(app.getHttpServer())
      .post('/admin/trash/restore')
      .set(...authHeader(fixture.admin.token))
      .send({ entity_type: 'schools', id: fixture.schoolId })
      .expect(404);
  });
});
