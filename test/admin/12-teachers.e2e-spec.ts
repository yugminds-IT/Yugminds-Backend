import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin teachers CRUD + role matrix + cross-school isolation', () => {
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

  it('GET /admin/teachers (admin) lists fixture teachers', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/teachers?school_id=${fixtureA.schoolId}`)
      .set(...authHeader(fixtureA.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const teachers = Array.isArray(list) ? list : (list?.teachers ?? []);
    const ids = teachers.map((t: { id: number }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(fixtureA.teachers.map((t) => t.id)));
  });

  it('GET /admin/teachers/:id (admin) returns detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/teachers/${fixtureA.teachers[0].id}`)
      .set(...authHeader(fixtureA.admin.token))
      .expect(200);
    const teacher = res.body?.data ?? res.body;
    expect(teacher.id ?? teacher.teacher?.id).toBe(fixtureA.teachers[0].id);
  });

  it('PUT /admin/teachers/:id (admin) updates full_name', async () => {
    const newName = 'QA Teacher Renamed';
    await request(app.getHttpServer())
      .put(`/admin/teachers/${fixtureA.teachers[0].id}`)
      .set(...authHeader(fixtureA.admin.token))
      .send({ full_name: newName })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/admin/teachers/${fixtureA.teachers[0].id}`)
      .set(...authHeader(fixtureA.admin.token))
      .expect(200);
    const teacher = res.body?.data ?? res.body;
    expect(teacher.name).toBe(newName);
  });

  describe('role matrix: school_admin token', () => {
    it('GET (list) succeeds for school_admin', async () => {
      await request(app.getHttpServer())
        .get(`/admin/teachers?school_id=${fixtureA.schoolId}`)
        .set(...authHeader(fixtureA.schoolAdmin.token))
        .expect(200);
    });

    it('GET :id succeeds for school_admin within own school', async () => {
      await request(app.getHttpServer())
        .get(`/admin/teachers/${fixtureA.teachers[0].id}`)
        .set(...authHeader(fixtureA.schoolAdmin.token))
        .expect(200);
    });

    it('PUT :id succeeds for school_admin', async () => {
      await request(app.getHttpServer())
        .put(`/admin/teachers/${fixtureA.teachers[0].id}`)
        .set(...authHeader(fixtureA.schoolAdmin.token))
        .send({ full_name: 'QA Teacher Via School Admin' })
        .expect(200);
    });

    it('POST (create) is rejected for school_admin (admin-only)', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/teachers')
        .set(...authHeader(fixtureA.schoolAdmin.token))
        .send({ email: 'x@example.test', password: 'QaTest123!', school_assignments: [] });
      expect(res.status).toBe(403);
    });

    it('POST bulk is rejected for school_admin (admin-only)', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/teachers/bulk')
        .set(...authHeader(fixtureA.schoolAdmin.token))
        .send({ action: 'deactivate', teacher_ids: [fixtureA.teachers[0].id] });
      expect(res.status).toBe(403);
    });

    it('DELETE :id is rejected for school_admin (admin-only)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/admin/teachers/${fixtureA.teachers[1].id}`)
        .set(...authHeader(fixtureA.schoolAdmin.token));
      expect(res.status).toBe(403);
    });
  });

  describe('cross-school isolation (HIGH-02 regression)', () => {
    it('school_admin of school A cannot see a teacher in school B', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/teachers/${fixtureB.teachers[0].id}`)
        .set(...authHeader(fixtureA.schoolAdmin.token));
      expect([403, 404]).toContain(res.status);
    });
  });

  it('admin bulk-deactivates a teacher (updates exactly one row)', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/teachers/bulk')
      .set(...authHeader(fixtureA.admin.token))
      .send({ action: 'deactivate', teacher_ids: [fixtureA.teachers[1].id] })
      .expect(201);
    expect(res.body?.updated ?? res.body?.data?.updated).toBe(1);
  });
});
