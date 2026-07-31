import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool, pool } from '../admin/support/db';

/**
 * Covers /auth/verify-password and /auth/update-password — the two endpoints
 * backing the Settings page's "verify current password, then unlock New
 * Password" flow on both the school-admin and admin dashboards. Previously
 * untested anywhere in the repo despite guarding every password change on
 * either dashboard, and previously unthrottled (an authenticated user could
 * brute-force their own current password at the global 1200 req/min/user
 * default).
 */
describe('school-admin settings — /auth/verify-password + /auth/update-password', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
    // Force a deterministic "not a first-login temp password" state so
    // current_password verification is actually exercised rather than
    // silently skipped by the mustChangePassword carve-out.
    await pool.query(
      'UPDATE "User" SET "mustChangePassword" = false WHERE id = $1',
      [fixture.schoolAdmin.id],
    );
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('POST /auth/verify-password returns valid:true for the correct current password', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/verify-password')
      .set(...auth)
      .send({ current_password: fixture.schoolAdmin.password })
      .expect(201);
    expect(res.body.valid).toBe(true);
  });

  it('POST /auth/verify-password returns valid:false for a wrong password (does not leak via a 4xx)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/verify-password')
      .set(...auth)
      .send({ current_password: 'DefinitelyWrong123' })
      .expect(201);
    expect(res.body.valid).toBe(false);
  });

  it('POST /auth/update-password rejects a wrong current_password with 401', async () => {
    await request(app.getHttpServer())
      .post('/auth/update-password')
      .set(...auth)
      .send({ current_password: 'DefinitelyWrong123', new_password: 'NewPassword123' })
      .expect(401);
  });

  it('POST /auth/update-password rejects a new_password that fails complexity rules', async () => {
    await request(app.getHttpServer())
      .post('/auth/update-password')
      .set(...auth)
      .send({ current_password: fixture.schoolAdmin.password, new_password: 'weak' })
      .expect(400);
  });

  it('POST /auth/update-password succeeds with the correct current_password and a strong new_password, and the new password then verifies', async () => {
    const newPassword = 'NewStrongPass1';
    await request(app.getHttpServer())
      .post('/auth/update-password')
      .set(...auth)
      .send({ current_password: fixture.schoolAdmin.password, new_password: newPassword })
      .expect(201);

    const verifyOld = await request(app.getHttpServer())
      .post('/auth/verify-password')
      .set(...auth)
      .send({ current_password: fixture.schoolAdmin.password })
      .expect(201);
    expect(verifyOld.body.valid).toBe(false);

    const verifyNew = await request(app.getHttpServer())
      .post('/auth/verify-password')
      .set(...auth)
      .send({ current_password: newPassword })
      .expect(201);
    expect(verifyNew.body.valid).toBe(true);

    // Restore the original password so teardownQaFixture's own cleanup
    // (which may re-authenticate) isn't affected by this test's side effect.
    await request(app.getHttpServer())
      .post('/auth/update-password')
      .set(...auth)
      .send({ current_password: newPassword, new_password: fixture.schoolAdmin.password })
      .expect(201);
  });

  it('rejects unauthenticated requests to both endpoints', async () => {
    await request(app.getHttpServer())
      .post('/auth/verify-password')
      .send({ current_password: 'x' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/update-password')
      .send({ current_password: 'x', new_password: 'NewPassword123' })
      .expect(401);
  });

  it(
    'throttles a burst of verify-password attempts past the 10/min limit ' +
      '(regression: previously unthrottled — a leaked access token could brute-force ' +
      "the account's own current password at the global 1200 req/min/user default)",
    async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth/verify-password')
          .set(...auth)
          .send({ current_password: 'DefinitelyWrong123' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    },
    30000,
  );
});
