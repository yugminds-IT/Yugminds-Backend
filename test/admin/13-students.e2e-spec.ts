import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool, pool } from './support/db';

describe('Admin students CRUD + bulk + cross-school isolation', () => {
  let app: INestApplication;
  let fixtureA: QaFixture;
  let fixtureB: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixtureA = await createQaFixture(app);
    fixtureB = await createQaFixture(app);
  }, 90000);

  afterAll(async () => {
    if (app && fixtureA) await teardownQaFixture(app, fixtureA);
    if (app && fixtureB) await teardownQaFixture(app, fixtureB);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/students lists fixture students', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/students?school_id=${fixtureA.schoolId}&limit=100`)
      .set(...authHeader(fixtureA.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const students = Array.isArray(list) ? list : (list?.students ?? []);
    const ids = students.map((s: { id: number }) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(fixtureA.students.map((s) => s.id)),
    );
  });

  it('GET /admin/students/:id returns detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/students/${fixtureA.students[0].id}`)
      .set(...authHeader(fixtureA.admin.token))
      .expect(200);
    const student = res.body?.data ?? res.body;
    expect(student.id ?? student.student?.id).toBe(fixtureA.students[0].id);
  });

  it('PATCH /admin/students/:id updates full_name', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/students/${fixtureA.students[0].id}`)
      .set(...authHeader(fixtureA.admin.token))
      .send({ full_name: 'QA Student Renamed' })
      .expect(200);
  });

  it('POST /admin/students/bulk moves students to a new section', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/students/bulk')
      .set(...authHeader(fixtureA.admin.token))
      .send({
        action: 'move',
        student_ids: [fixtureA.students[0].id],
        school_id: fixtureA.schoolId,
        grade: fixtureA.grade,
        section: fixtureA.section,
      })
      .expect(201);
    expect(res.body?.success ?? res.body?.data?.success).toBeTruthy();
  });

  it('POST /admin/students/sync-enrollments does not error', async () => {
    await request(app.getHttpServer())
      .post('/admin/students/sync-enrollments')
      .set(...authHeader(fixtureA.admin.token))
      .send({ school_id: fixtureA.schoolId })
      .expect(201);
  });

  describe('cross-school isolation (HIGH-02 regression)', () => {
    it('school_admin of school A cannot see a student in school B', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/students/${fixtureB.students[0].id}`)
        .set(...authHeader(fixtureA.schoolAdmin.token));
      expect([403, 404]).toContain(res.status);
    });
  });

  it('POST /admin/students/delete-by-class previews, then deletes a section (multi-school students only unenrolled)', async () => {
    const server = app.getHttpServer();
    const [moved, shared, ...rest] = fixtureB.students;
    await request(server)
      .post('/admin/students/bulk')
      .set(...authHeader(fixtureB.admin.token))
      .send({
        action: 'move',
        student_ids: [moved.id],
        school_id: fixtureB.schoolId,
        grade: fixtureB.grade,
        section: 'Section B',
      })
      .expect(201);
    await pool.query(
      `INSERT INTO "StudentSchool" (id, "studentId", "schoolId", grade, section, "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
      [shared.id, fixtureA.schoolId, fixtureA.grade, fixtureA.section],
    );
    const sectionA = [{ grade: fixtureB.grade, section: fixtureB.section }];

    const preview = await request(server)
      .post('/admin/students/delete-by-class')
      .set(...authHeader(fixtureB.admin.token))
      .send({ school_id: fixtureB.schoolId, classes: sectionA, dry_run: true })
      .expect(201);
    expect(preview.body.selected_students).toBe(rest.length + 1);
    expect(preview.body.will_unenroll).toBe(1);
    expect(preview.body.classes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: 'Section B', count: 1 }),
      ]),
    );

    await request(server)
      .post('/admin/students/delete-by-class')
      .set(...authHeader(fixtureB.admin.token))
      .send({ school_id: fixtureB.schoolId })
      .expect(400);

    const res = await request(server)
      .post('/admin/students/delete-by-class')
      .set(...authHeader(fixtureB.admin.token))
      .send({ school_id: fixtureB.schoolId, classes: sectionA })
      .expect(201);
    expect(res.body).toMatchObject({ deleted: rest.length, unenrolled: 1 });

    await request(server)
      .get(`/admin/students/${moved.id}`)
      .set(...authHeader(fixtureB.admin.token))
      .expect(200);
    await request(server)
      .get(`/admin/students/${shared.id}`)
      .set(...authHeader(fixtureB.admin.token))
      .expect(200);
    const { rows } = await pool.query(
      `SELECT "schoolId" FROM "StudentSchool" WHERE "studentId" = $1`,
      [shared.id],
    );
    expect(rows.map((r: { schoolId: string }) => r.schoolId)).toEqual([
      fixtureA.schoolId,
    ]);
    for (const s of rest) {
      const gone = await request(server)
        .get('/student/dashboard')
        .set(...authHeader(s.token));
      expect(gone.status).toBe(401);
    }
  });

  it('DELETE /admin/students/:id soft-deletes and force-logs-out', async () => {
    const token = fixtureA.students[2].token;
    const before = await request(app.getHttpServer())
      .get('/student/dashboard')
      .set(...authHeader(token));
    expect([200, 404]).toContain(before.status);

    await request(app.getHttpServer())
      .delete(`/admin/students/${fixtureA.students[2].id}`)
      .set(...authHeader(fixtureA.admin.token))
      .expect(200);

    const after = await request(app.getHttpServer())
      .get('/student/dashboard')
      .set(...authHeader(token));
    expect(after.status).toBe(401);
  });
});
