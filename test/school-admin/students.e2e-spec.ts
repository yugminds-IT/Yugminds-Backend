import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin students CRUD + tenant scoping', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let otherFixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    otherFixture = await createQaFixture(app);
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
  }, 120000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app && otherFixture) await teardownQaFixture(app, otherFixture);
    if (app) await app.close();
    await closePool();
  }, 120000);

  it('lists the 3 fixture students', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/students')
      .set(...auth)
      .query({ limit: 200 })
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    const ids = res.body.students.map((s: any) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(fixture.students.map((s) => s.id)),
    );
  });

  it('tenant scoping: a different school-admin does NOT see this fixture\'s students', async () => {
    const otherAuth: [string, string] = [
      'Authorization',
      `Bearer ${otherFixture.schoolAdmin.token}`,
    ];
    const res = await request(app.getHttpServer())
      .get('/school-admin/students')
      .set(...otherAuth)
      .query({ limit: 200 })
      .expect(200);
    const ids = res.body.students.map((s: any) => s.id);
    for (const s of fixture.students) {
      expect(ids).not.toContain(s.id);
    }
  });

  let createdStudentId: number;

  it('creates a student', async () => {
    const res = await request(app.getHttpServer())
      .post('/school-admin/students')
      .set(...auth)
      .send({
        email: `qa_new_student_${Date.now()}@example.test`,
        password: 'QaTest123!',
        full_name: 'QA New Student',
        grade: fixture.grade,
        section: fixture.section,
      })
      .expect(201);
    expect(res.body.success).toBe(true);
    createdStudentId = res.body.student.id;
    expect(createdStudentId).toBeTruthy();
    expect(res.body.student.profile.full_name).toBe('QA New Student');
  });

  it('rejects creating a student with a duplicate email', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/students')
      .set(...auth)
      .query({ limit: 200 })
      .expect(200);
    const existing = res.body.students[0];
    await request(app.getHttpServer())
      .post('/school-admin/students')
      .set(...auth)
      .send({
        email: existing.profile.email,
        password: 'QaTest123!',
        full_name: 'Dup',
        grade: fixture.grade,
        section: fixture.section,
      })
      .expect(400);
  });

  it('updates the created student', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/school-admin/students/${createdStudentId}`)
      .set(...auth)
      .send({ full_name: 'QA Renamed Student', section: 'Section B' })
      .expect(200);
    expect(res.body.student.profile.full_name).toBe('QA Renamed Student');
    expect(res.body.student.section).toBe('Section B');
  });

  it('resets the student password', async () => {
    await request(app.getHttpServer())
      .patch(`/school-admin/students/${createdStudentId}/password`)
      .set(...auth)
      .send({ password: 'NewQaPass123!' })
      .expect(200);
  });

  it('rejects password reset with empty password', async () => {
    await request(app.getHttpServer())
      .patch(`/school-admin/students/${createdStudentId}/password`)
      .set(...auth)
      .send({ password: '' })
      .expect(400);
  });

  it('bulk-imports 2 new students (dry_run then real)', async () => {
    const email1 = `qa_bulk1_${Date.now()}@example.test`;
    const email2 = `qa_bulk2_${Date.now()}@example.test`;
    const dryRes = await request(app.getHttpServer())
      .post('/school-admin/students/bulk-import')
      .set(...auth)
      .send({
        dry_run: true,
        students: [
          { email: email1, full_name: 'Bulk One', grade: fixture.grade },
          { email: email2, full_name: 'Bulk Two', grade: fixture.grade },
        ],
      })
      .expect(201);
    expect(dryRes.body.summary.success).toBe(2);

    const realRes = await request(app.getHttpServer())
      .post('/school-admin/students/bulk-import')
      .set(...auth)
      .send({
        dry_run: false,
        students: [
          { email: email1, full_name: 'Bulk One', grade: fixture.grade },
          { email: email2, full_name: 'Bulk Two', grade: fixture.grade },
        ],
      })
      .expect(201);
    expect(realRes.body.summary.success).toBe(2);
    expect(realRes.body.results.every((r: any) => r.success)).toBe(true);

    // Cleanup the bulk-imported students (hard-delete) so they don't leak.
    for (const r of realRes.body.results) {
      if (r.student_id) {
        await request(app.getHttpServer())
          .delete(`/school-admin/students/${r.student_id}?hard=true`)
          .set(...auth)
          .catch(() => undefined);
      }
    }
  });

  it('soft-deletes (deactivates) the created student by default query semantics, hard-deletes on hard=true', async () => {
    const softRes = await request(app.getHttpServer())
      .delete(`/school-admin/students/${createdStudentId}`)
      .set(...auth)
      .query({ hard: 'false' })
      .expect(200);
    expect(softRes.body.deactivated).toBe(true);

    // Confirm still present but inactive.
    const listRes = await request(app.getHttpServer())
      .get('/school-admin/students')
      .set(...auth)
      .query({ limit: 200, status: 'inactive' })
      .expect(200);
    expect(
      listRes.body.students.some((s: any) => s.id === createdStudentId),
    ).toBe(true);

    // Now hard-delete to actually clean it up.
    const hardRes = await request(app.getHttpServer())
      .delete(`/school-admin/students/${createdStudentId}`)
      .set(...auth)
      .query({ hard: 'true' })
      .expect(200);
    expect(hardRes.body.deleted).toBe(true);
  });
});
