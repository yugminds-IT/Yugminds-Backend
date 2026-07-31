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

describe('Student profile / settings', () => {
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

  it('GET /profile returns the real student with school/grade/section and notification-preference defaults', async () => {
    const res = await request(app.getHttpServer())
      .get('/profile')
      .set(...authHeader(fixture.students[0].token))
      .expect(200);
    const profile = res.body?.profile ?? res.body;
    expect(profile.email).toBe(fixture.students[0].email);
    expect(profile.email_notifications).toBe(true);
    expect(profile.assignment_reminders).toBe(true);
    expect(profile.grade_notifications).toBe(true);
    expect(profile.course_updates).toBe(true);
    const info = profile.students?.[0];
    expect(info).toBeDefined();
    expect(info.grade).toBe(fixture.grade);
    expect(info.section).toBe(fixture.section);
    expect(info.schools?.[0]?.name).toEqual(expect.any(String));
  });

  it('PATCH /profile updates full_name and notification preferences, reflected on GET', async () => {
    await request(app.getHttpServer())
      .patch('/profile')
      .set(...authHeader(fixture.students[0].token))
      .send({
        full_name: 'QA Updated Student Name',
        email_notifications: false,
        course_updates: false,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/profile')
      .set(...authHeader(fixture.students[0].token))
      .expect(200);
    const profile = res.body?.profile ?? res.body;
    expect(profile.full_name).toBe('QA Updated Student Name');
    expect(profile.email_notifications).toBe(false);
    expect(profile.course_updates).toBe(false);
    // Untouched preferences must stay at their previous value, not reset.
    expect(profile.assignment_reminders).toBe(true);
    expect(profile.grade_notifications).toBe(true);
  });

  it(
    'PATCH /profile silently ignores email/grade/section/school changes — ' +
      'the settings page shows these as locked, and that must be enforced ' +
      'server-side too, not just a disabled input a direct API call could bypass',
    async () => {
      const originalEmail = fixture.students[0].email;
      await request(app.getHttpServer())
        .patch('/profile')
        .set(...authHeader(fixture.students[0].token))
        .send({
          email: `__qa_test_should_not_apply_${Date.now()}@example.test`,
          grade: 'Grade 12',
          section: 'Z',
        })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/profile')
        .set(...authHeader(fixture.students[0].token))
        .expect(200);
      const profile = res.body?.profile ?? res.body;
      expect(profile.email).toBe(originalEmail);
      expect(profile.students?.[0]?.grade).toBe(fixture.grade);
      expect(profile.students?.[0]?.section).toBe(fixture.section);
    },
  );

  it(
    'POST /auth/update-password immediately invalidates the pre-change ' +
      'access token (tokenVersion bump), while the newly-issued one keeps working',
    async () => {
      const oldToken = fixture.students[1].token;
      const oldEmail = fixture.students[1].email;
      const oldPassword = fixture.students[1].password;
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

  it('POST /auth/verify-password confirms the real current password and rejects a wrong one', async () => {
    const student = fixture.students[2];
    const ok = await request(app.getHttpServer())
      .post('/auth/verify-password')
      .set(...authHeader(student.token))
      .send({ current_password: student.password })
      .expect(201);
    expect(ok.body.valid).toBe(true);

    const bad = await request(app.getHttpServer())
      .post('/auth/verify-password')
      .set(...authHeader(student.token))
      .send({ current_password: 'definitely-wrong' })
      .expect(201);
    expect(bad.body.valid).toBe(false);
  });

  it(
    'POST /auth/update-password rejects the wrong current password without ' +
      'changing anything (a student cannot bypass current-password ' +
      'verification by calling the endpoint directly)',
    async () => {
      const student = fixture.students[2];

      // Fixture students are created with mustChangePassword: true, which
      // intentionally skips current-password verification on the very
      // first change (temp-password flow). Do that legitimate first
      // change so this test exercises the real "wrong current password on
      // an already-set password" rejection path, not the first-login one.
      const firstChange = await request(app.getHttpServer())
        .post('/auth/update-password')
        .set(...authHeader(student.token))
        .send({ current_password: student.password, new_password: 'QaFirstChange123!' })
        .expect(201);
      const tokenAfterFirstChange: string = firstChange.body.tokens.accessToken;

      await request(app.getHttpServer())
        .post('/auth/update-password')
        .set(...authHeader(tokenAfterFirstChange))
        .send({ current_password: 'definitely-wrong', new_password: 'QaNewPass123!' })
        .expect(401);

      // The password from the legitimate first change still works.
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: student.email, password: 'QaFirstChange123!' })
        .expect(201);
    },
  );

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/profile').expect(401);
    await request(app.getHttpServer())
      .patch('/profile')
      .send({ full_name: 'x' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/verify-password')
      .send({ current_password: 'x' })
      .expect(401);
  });
});
