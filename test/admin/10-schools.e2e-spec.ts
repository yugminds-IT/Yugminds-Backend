import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin schools CRUD + soft-delete/restore blast radius', () => {
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

  it('GET /admin/schools lists the fixture school', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/schools?limit=200')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const schools = res.body?.data?.schools ?? res.body?.schools ?? [];
    expect(schools.some((s: { id: string }) => s.id === fixture.schoolId)).toBe(true);
  });

  it('GET /admin/schools/:id returns full detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const school = res.body?.data ?? res.body;
    expect(school.id ?? school.school?.id).toBe(fixture.schoolId);
  });

  it('GET /admin/schools/:id/teacher-assignments works', async () => {
    await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}/teacher-assignments`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
  });

  it('PUT /admin/schools updates the school name', async () => {
    const newName = `${fixture.schoolId}-renamed`;
    await request(app.getHttpServer())
      .put('/admin/schools')
      .set(...authHeader(fixture.admin.token))
      .send({ id: fixture.schoolId, name: newName })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const school = res.body?.data ?? res.body;
    expect(school.name ?? school.school?.name).toBe(newName);
  });

  describe('deactivating a school blocks sign-in for its teachers/students (own throwaway school)', () => {
    let deactivateFixture: QaFixture;

    beforeAll(async () => {
      deactivateFixture = await createQaFixture(app);
    }, 60000);

    afterAll(async () => {
      if (app && deactivateFixture) await teardownQaFixture(app, deactivateFixture);
    }, 60000);

    it('login is blocked while the school is inactive, and works again once reactivated', async () => {
      const teacher = deactivateFixture.teachers[0];

      // Sanity check: login works while the school is active.
      const before = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: teacher.email, password: teacher.password });
      expect([200, 201]).toContain(before.status);

      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(deactivateFixture.admin.token))
        .send({ id: deactivateFixture.schoolId, is_active: false })
        .expect(200);

      try {
        const blocked = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: teacher.email, password: teacher.password });
        expect(blocked.status).toBe(401);
        expect(blocked.body?.message).toMatch(/deactivated/i);

        // The platform admin is exempt — deactivating a school must not lock
        // the admin who deactivated it out of the platform.
        const adminLogin = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'admin@yugminds.com', password: process.env.ADMIN_SEED_PASSWORD });
        expect([200, 201]).toContain(adminLogin.status);
      } finally {
        await request(app.getHttpServer())
          .put('/admin/schools')
          .set(...authHeader(deactivateFixture.admin.token))
          .send({ id: deactivateFixture.schoolId, is_active: true })
          .expect(200);
      }

      const after = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: teacher.email, password: teacher.password });
      expect([200, 201]).toContain(after.status);
    });
  });

  describe('soft-delete blast radius (own throwaway school, not the shared fixture)', () => {
    let tempFixture: QaFixture;

    beforeAll(async () => {
      tempFixture = await createQaFixture(app);
    }, 60000);

    it('deleting the school force-logs-out every user at that school', async () => {
      const teacherToken = tempFixture.teachers[0].token;
      // Sanity check: the token works before delete.
      await request(app.getHttpServer())
        .get('/teacher/dashboard')
        .set(...authHeader(teacherToken))
        .then((res) => expect([200, 404]).toContain(res.status));

      await request(app.getHttpServer())
        .delete(`/admin/schools/${tempFixture.schoolId}`)
        .set(...authHeader(tempFixture.admin.token))
        .expect(200);

      const after = await request(app.getHttpServer())
        .get('/teacher/dashboard')
        .set(...authHeader(teacherToken));
      expect(after.status).toBe(401);
    });

    // AdminSchoolsService.delete() is a deliberate PERMANENT delete (see its
    // doc comment) — the school, its users, and cascaded data are gone
    // immediately, not soft-deleted into the Trash page's restore flow.
    // "Restoring" a school that was deleted via this endpoint should fail:
    // there's nothing left to restore.
    it('the school cannot be restored after a permanent delete', async () => {
      await request(app.getHttpServer())
        .get(`/admin/schools/${tempFixture.schoolId}`)
        .set(...authHeader(tempFixture.admin.token))
        .expect(404);

      await request(app.getHttpServer())
        .post('/admin/trash/restore')
        .set(...authHeader(tempFixture.admin.token))
        .send({ entity_type: 'schools', id: tempFixture.schoolId })
        .expect(404);
    });

    afterAll(async () => {
      // The school (and its fixture users) were already permanently deleted
      // by the test above — nothing left to tear down via the normal flow.
    }, 30000);
  });
});
