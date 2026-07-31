import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { authHeader } from '../admin/support/auth';
import { closePool } from '../admin/support/db';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';

describe('Teacher profile / settings', () => {
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

  it('GET /profile returns the real teacher with notification-preference defaults', async () => {
    const res = await request(app.getHttpServer())
      .get('/profile')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const profile = res.body?.profile ?? res.body;
    expect(profile.email).toBe(fixture.teachers[0].email);
    expect(profile.email_notifications).toBe(true);
    expect(profile.assignment_reminders).toBe(true);
    expect(profile.grade_notifications).toBe(true);
    expect(profile.course_updates).toBe(true);
  });

  it('PATCH /profile updates full_name and notification preferences, reflected on GET', async () => {
    await request(app.getHttpServer())
      .patch('/profile')
      .set(...authHeader(fixture.teachers[0].token))
      .send({
        full_name: 'QA Updated Teacher Name',
        email_notifications: false,
        course_updates: false,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/profile')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const profile = res.body?.profile ?? res.body;
    expect(profile.full_name).toBe('QA Updated Teacher Name');
    expect(profile.email_notifications).toBe(false);
    expect(profile.course_updates).toBe(false);
    // Untouched preferences must stay at their previous value, not reset.
    expect(profile.assignment_reminders).toBe(true);
    expect(profile.grade_notifications).toBe(true);
  });

  it(
    'PATCH /profile silently ignores an email change — the "Email is fixed ' +
      'and cannot be changed" UI claim is actually enforced server-side, not ' +
      'just a disabled input a direct API call could bypass',
    async () => {
      const originalEmail = fixture.teachers[0].email;
      await request(app.getHttpServer())
        .patch('/profile')
        .set(...authHeader(fixture.teachers[0].token))
        .send({ email: `__qa_test_should_not_apply_${Date.now()}@example.test` })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/profile')
        .set(...authHeader(fixture.teachers[0].token))
        .expect(200);
      const profile = res.body?.profile ?? res.body;
      expect(profile.email).toBe(originalEmail);
    },
  );

  it(
    'POST /auth/update-password immediately invalidates the pre-change access ' +
      'token (tokenVersion bump), while the newly-issued one keeps working — ' +
      'previously only refresh tokens were revoked, so an already-issued access ' +
      'token stayed valid until its own ~15min natural expiry',
    async () => {
      const oldToken = fixture.teachers[1].token;
      const oldEmail = fixture.teachers[1].email;
      const oldPassword = fixture.teachers[1].password;
      const newPassword = 'QaNewPass123!';

      // Confirm the old token works before the change.
      await request(app.getHttpServer())
        .get('/profile')
        .set(...authHeader(oldToken))
        .expect(200);

      const updateRes = await request(app.getHttpServer())
        .post('/auth/update-password')
        .set(...authHeader(oldToken))
        .send({ current_password: oldPassword, new_password: newPassword })
        .expect(201);
      expect(updateRes.body.success).toBe(true);
      const newAccessToken: string = updateRes.body?.tokens?.accessToken;
      expect(newAccessToken).toBeDefined();

      // The pre-change token must now be rejected...
      await request(app.getHttpServer())
        .get('/profile')
        .set(...authHeader(oldToken))
        .expect(401);

      // ...but the freshly-issued one (matching the new tokenVersion) works,
      // so the settings page's own save flow doesn't 401 right after success.
      await request(app.getHttpServer())
        .get('/profile')
        .set(...authHeader(newAccessToken))
        .expect(200);

      // And login now requires the new password.
      const oldLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: oldEmail, password: oldPassword });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: oldEmail, password: newPassword })
        .expect(201);
      expect(newLogin.body?.tokens?.accessToken).toBeDefined();
    },
  );
});
