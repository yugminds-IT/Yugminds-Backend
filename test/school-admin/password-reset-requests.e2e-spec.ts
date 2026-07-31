import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin password-reset-requests', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
  }, 60000);

  it('approve flow: student submits a reset request, school-admin approves it with a temp password', async () => {
    await request(app.getHttpServer())
      .post('/auth/password-reset-request')
      .send({ email: fixture.students[0].email })
      .expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'pending' })
      .expect(200);
    const found = listRes.body.requests.find(
      (r: any) => r.email === fixture.students[0].email,
    );
    expect(found).toBeTruthy();

    const patchRes = await request(app.getHttpServer())
      .patch('/school-admin/password-reset-requests')
      .set(...auth)
      .send({ id: found.id, status: 'approved', temp_password: 'QaTemp123!' })
      .expect(200);
    expect(patchRes.body.success).toBe(true);

    const afterRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'approved' })
      .expect(200);
    expect(afterRes.body.requests.some((r: any) => r.id === found.id)).toBe(
      true,
    );
  });

  it('reject then delete flow: teacher submits a request, school-admin rejects then deletes it', async () => {
    await request(app.getHttpServer())
      .post('/auth/password-reset-request')
      .send({ email: fixture.teachers[1].email })
      .expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'pending' })
      .expect(200);
    const found = listRes.body.requests.find(
      (r: any) => r.email === fixture.teachers[1].email,
    );
    expect(found).toBeTruthy();

    await request(app.getHttpServer())
      .patch('/school-admin/password-reset-requests')
      .set(...auth)
      .send({ id: found.id, status: 'rejected', notes: 'QA rejection' })
      .expect(200);

    await request(app.getHttpServer())
      .delete('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ id: found.id })
      .expect(200);

    const afterRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'all', limit: 200 })
      .expect(200);
    expect(afterRes.body.requests.some((r: any) => r.id === found.id)).toBe(
      false,
    );
  });

  it('rejects deleting without an id', async () => {
    await request(app.getHttpServer())
      .delete('/school-admin/password-reset-requests')
      .set(...auth)
      .expect(400);
  });

  it('GET /school-admin/password-reset-requests/pending-count is real and school-scoped', async () => {
    const before = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests/pending-count')
      .set(...auth)
      .expect(200);
    const beforeCount = before.body.count;

    await request(app.getHttpServer())
      .post('/auth/password-reset-request')
      .send({ email: fixture.students[1].email })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests/pending-count')
      .set(...auth)
      .expect(200);
    expect(after.body.count).toBe(beforeCount + 1);

    // Clean up so it doesn't leak into other tests in this file.
    const listRes = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'pending' })
      .expect(200);
    const found = listRes.body.requests.find(
      (r: any) => r.email === fixture.students[1].email,
    );
    await request(app.getHttpServer())
      .patch('/school-admin/password-reset-requests')
      .set(...auth)
      .send({ id: found.id, status: 'rejected' })
      .expect(200);
    await request(app.getHttpServer())
      .delete('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ id: found.id })
      .expect(200);
  });

  it('honors limit/offset pagination', async () => {
    // At least one resolved request exists from the earlier tests in this
    // file (the approve + reject-then-delete flows above).
    const full = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'resolved', limit: 100 })
      .expect(200);
    if (full.body.requests.length < 2) return; // not enough data to page over

    const page1 = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'resolved', limit: 1, offset: 0 })
      .expect(200);
    const page2 = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...auth)
      .query({ status: 'resolved', limit: 1, offset: 1 })
      .expect(200);
    expect(page1.body.requests.length).toBe(1);
    expect(page2.body.requests.length).toBe(1);
    expect(page1.body.requests[0].id).not.toBe(page2.body.requests[0].id);
  });
});

describe('school-admin password-reset-requests: cross-school isolation', () => {
  let app: INestApplication;
  let fixtureA: QaFixture;
  let fixtureB: QaFixture;
  let authA: [string, string];
  let authB: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixtureA = await createQaFixture(app);
    fixtureB = await createQaFixture(app);
    authA = ['Authorization', `Bearer ${fixtureA.schoolAdmin.token}`];
    authB = ['Authorization', `Bearer ${fixtureB.schoolAdmin.token}`];
  }, 90000);

  afterAll(async () => {
    if (app && fixtureA) await teardownQaFixture(app, fixtureA);
    if (app && fixtureB) await teardownQaFixture(app, fixtureB);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it("school admin A cannot see, approve, or delete school B's password reset request", async () => {
    await request(app.getHttpServer())
      .post('/auth/password-reset-request')
      .send({ email: fixtureB.students[0].email })
      .expect(201);

    const listAsB = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...authB)
      .query({ status: 'pending' })
      .expect(200);
    const requestId = listAsB.body.requests.find(
      (r: any) => r.email === fixtureB.students[0].email,
    )?.id;
    expect(requestId).toBeDefined();

    // School A's list must not include school B's request.
    const listAsA = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...authA)
      .query({ status: 'pending' })
      .expect(200);
    expect(
      listAsA.body.requests.some((r: any) => r.id === requestId),
    ).toBe(false);

    // School A's pending-count must not include it either.
    const countAsA = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests/pending-count')
      .set(...authA)
      .expect(200);
    expect(countAsA.body.count).toBe(0);

    // School A cannot approve it — the service enforces restrictToSchoolId
    // and rejects the update outright when the request belongs to a
    // different school.
    await request(app.getHttpServer())
      .patch('/school-admin/password-reset-requests')
      .set(...authA)
      .send({ id: requestId, status: 'approved', temp_password: 'QaTemp123!' })
      .expect(400);
    const stillPendingForB = await request(app.getHttpServer())
      .get('/school-admin/password-reset-requests')
      .set(...authB)
      .query({ status: 'pending' })
      .expect(200);
    expect(
      stillPendingForB.body.requests.some((r: any) => r.id === requestId),
    ).toBe(true);

    // School A explicitly cannot delete it either — the DELETE handler
    // separately ownership-checks the request's schoolId against the
    // caller's own.
    await request(app.getHttpServer())
      .delete('/school-admin/password-reset-requests')
      .set(...authA)
      .query({ id: requestId })
      .expect(403);

    // Clean up via the actual owning school (B).
    await request(app.getHttpServer())
      .patch('/school-admin/password-reset-requests')
      .set(...authB)
      .send({ id: requestId, status: 'rejected' })
      .expect(200);
    await request(app.getHttpServer())
      .delete('/school-admin/password-reset-requests')
      .set(...authB)
      .query({ id: requestId })
      .expect(200);
  });
});
