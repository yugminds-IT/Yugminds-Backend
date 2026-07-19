import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin notifications', () => {
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
    await closePool();
  }, 60000);

  it('GET /school-admin/notifications/recipients lists role groups + individuals', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/notifications/recipients')
      .set(...auth)
      .expect(200);
    expect(res.body.roles.some((r: any) => r.id === 'role:teacher')).toBe(true);
    expect(res.body.roles.some((r: any) => r.id === 'role:student')).toBe(true);
    const userIds = res.body.users.map((u: any) => u.id);
    expect(userIds).toEqual(
      expect.arrayContaining([String(fixture.teachers[0].id)]),
    );
  });

  it('POST /school-admin/notifications targeted at one teacher reaches them via /notifications/user', async () => {
    const uniqueTitle = `QA Notice ${Date.now()}`;
    const createRes = await request(app.getHttpServer())
      .post('/school-admin/notifications')
      .set(...auth)
      .send({
        title: uniqueTitle,
        message: 'Please review the QA test message.',
        recipientType: 'individual',
        recipients: [String(fixture.teachers[0].id)],
      })
      .expect(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.sent).toBe(1);

    const teacherAuth: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[0].token}`,
    ];
    const notifRes = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...teacherAuth)
      .expect(200);
    const found = notifRes.body.notifications.find(
      (n: any) => n.title === uniqueTitle,
    );
    expect(found).toBeTruthy();

    // The other fixture teacher must NOT have received it.
    const otherTeacherAuth: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[1].token}`,
    ];
    const otherRes = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...otherTeacherAuth)
      .expect(200);
    expect(
      otherRes.body.notifications.some((n: any) => n.title === uniqueTitle),
    ).toBe(false);
  });

  it('POST /school-admin/notifications targeted at one student reaches them via /notifications/user', async () => {
    const uniqueTitle = `QA Student Notice ${Date.now()}`;
    await request(app.getHttpServer())
      .post('/school-admin/notifications')
      .set(...auth)
      .send({
        title: uniqueTitle,
        message: 'Please review the QA test message for students.',
        recipientType: 'individual',
        recipients: [String(fixture.students[0].id)],
      })
      .expect(201);

    const studentAuth: [string, string] = [
      'Authorization',
      `Bearer ${fixture.students[0].token}`,
    ];
    const notifRes = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...studentAuth)
      .expect(200);
    const found = notifRes.body.notifications.find(
      (n: any) => n.title === uniqueTitle,
    );
    expect(found).toBeTruthy();
  });

  it('POST /school-admin/notifications with recipientType=role broadcasts to all teachers', async () => {
    const uniqueTitle = `QA Broadcast ${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post('/school-admin/notifications')
      .set(...auth)
      .send({
        title: uniqueTitle,
        message: 'Broadcast to all teachers.',
        recipientType: 'role',
        recipients: ['role:teacher'],
      })
      .expect(201);
    expect(res.body.sent).toBeGreaterThanOrEqual(2);

    for (const t of fixture.teachers) {
      const teacherAuth: [string, string] = [
        'Authorization',
        `Bearer ${t.token}`,
      ];
      const notifRes = await request(app.getHttpServer())
        .get('/notifications/user')
        .set(...teacherAuth)
        .expect(200);
      expect(
        notifRes.body.notifications.some((n: any) => n.title === uniqueTitle),
      ).toBe(true);
    }
  });

  it('GET /school-admin/notifications (mode=sent) shows the sent notifications', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/notifications')
      .set(...auth)
      .query({ mode: 'sent' })
      .expect(200);
    expect(Array.isArray(res.body.notifications)).toBe(true);
  });

  it('rejects a notification without title or message', async () => {
    await request(app.getHttpServer())
      .post('/school-admin/notifications')
      .set(...auth)
      .send({ title: '', message: '', recipients: [] })
      .expect(400);
  });
});
