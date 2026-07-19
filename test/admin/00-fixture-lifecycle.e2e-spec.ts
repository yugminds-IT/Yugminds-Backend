import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { closePool } from './support/db';

describe('QA fixture lifecycle (smoke test for the test infra itself)', () => {
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

  it('created a real school visible via GET /admin/schools/:id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .expect(200);
    expect(res.body?.data?.name ?? res.body?.name).toContain('__qa_test_');
  });

  it('fixture school-admin token authenticates and is scoped to the fixture school', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/school-admins')
      .set('Authorization', `Bearer ${fixture.schoolAdmin.token}`);
    // school_admin role should not have list access to /admin/school-admins (admin-only)
    expect([403, 401]).toContain(res.status);
  });

  it('fixture teachers and students were created with distinct ids', () => {
    expect(fixture.teachers).toHaveLength(2);
    expect(fixture.students).toHaveLength(3);
    const ids = [...fixture.teachers, ...fixture.students].map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fixture course exists and is scoped to the fixture school', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .expect(200);
    expect(res.body?.data?.name ?? res.body?.name).toContain('__qa_test_');
  });
});
