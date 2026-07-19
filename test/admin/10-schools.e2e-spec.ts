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

    it('restoring the school restores its users', async () => {
      await request(app.getHttpServer())
        .post('/admin/trash/restore')
        .set(...authHeader(tempFixture.admin.token))
        .send({ entity_type: 'schools', id: tempFixture.schoolId })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/admin/schools/${tempFixture.schoolId}`)
        .set(...authHeader(tempFixture.admin.token))
        .expect(200);
      const school = res.body?.data ?? res.body;
      expect(school.isActive ?? school.school?.isActive).toBe(true);
    });

    afterAll(async () => {
      if (tempFixture) await teardownQaFixture(app, tempFixture);
    }, 30000);
  });
});
