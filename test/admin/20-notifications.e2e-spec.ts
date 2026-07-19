import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool } from './support/db';

describe('Admin notifications -> teacher sees it (cross-role propagation)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let notificationId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('POST /admin/notifications (individual) reaches only the fixture teacher, not real users', async () => {
    const uniqueTitle = `QA Notification ${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post('/admin/notifications')
      .set(...authHeader(fixture.admin.token))
      .send({
        title: uniqueTitle,
        message: 'QA cross-role propagation check',
        recipientType: 'individual',
        recipients: [String(fixture.teachers[0].id)],
      })
      .expect(201);
    expect(res.body?.recipients ?? res.body?.data?.recipients).toBe(1);

    const inbox = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=received')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const notifications = inbox.body?.notifications ?? [];
    const found = notifications.find(
      (n: { title: string; id: string }) => n.title === uniqueTitle,
    );
    expect(found).toBeDefined();
    notificationId = found.id;

    // The second fixture teacher was NOT a recipient — must not see it.
    const otherInbox = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=received')
      .set(...authHeader(fixture.teachers[1].token))
      .expect(200);
    const otherNotifications = otherInbox.body?.notifications ?? [];
    expect(
      otherNotifications.some((n: { title: string }) => n.title === uniqueTitle),
    ).toBe(false);
  });

  it('teacher can mark the notification read', async () => {
    await request(app.getHttpServer())
      .patch(`/teacher/notifications/${notificationId}`)
      .set(...authHeader(fixture.teachers[0].token))
      .send({ is_read: true })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/teacher/notifications/${notificationId}`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(res.body?.notification?.is_read).toBe(true);
  });
});
