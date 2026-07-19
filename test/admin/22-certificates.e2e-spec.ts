import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin certificate batch-generate -> visible on student side (cross-role)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let certId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    // Publish the fixture course so the fixture students get auto-enrolled
    // (StudentCourse rows) — batchGenerate only issues certs for enrolled pairs.
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

  it('POST /admin/certificates/batch-generate issues a cert for the fixture student+course pair', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/certificates/batch-generate')
      .set(...authHeader(fixture.admin.token))
      .send({
        course_ids: [fixture.courseId],
        student_ids: [String(fixture.students[0].id)],
      })
      .expect(201);
    expect(res.body?.generated).toBe(1);
  }, 30000);

  it('the fixture student sees the certificate via their own endpoint', async () => {
    const res = await request(app.getHttpServer())
      .get('/student/certificates')
      .set(...authHeader(fixture.students[0].token))
      .expect(200);
    const certs = res.body?.certificates ?? [];
    const found = certs.find(
      (c: { course_id?: string; courseId?: string }) =>
        (c.course_id ?? c.courseId) === fixture.courseId,
    );
    expect(found).toBeDefined();
  });

  it('admin sees the certificate in the global list', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/certificates?search=${fixture.students[0].email}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const certs = Array.isArray(list) ? list : (list?.certificates ?? []);
    expect(certs.length).toBeGreaterThan(0);
    certId = certs[0].id;
  });

  it('admin revokes the certificate -> it disappears from the student view', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/certificates/${certId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/student/certificates')
      .set(...authHeader(fixture.students[0].token))
      .expect(200);
    const certs = res.body?.certificates ?? [];
    expect(certs.some((c: { id: string }) => c.id === certId)).toBe(false);
  });
});
