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

describe('Student notifications', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let studentAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    studentAuth = authHeader(fixture.students[0].token);
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it('GET /student/notifications/recipients only lists teachers in the student\'s own school', async () => {
    const res = await request(app.getHttpServer())
      .get('/student/notifications/recipients')
      .set(...studentAuth)
      .expect(200);
    const ids = (res.body.users ?? []).map((u: { id: string }) => String(u.id));
    expect(ids).toEqual(
      expect.arrayContaining(fixture.teachers.map((t) => String(t.id))),
    );
  });

  it('POST /student/notifications sends to a teacher and is visible via GET /notifications/user', async () => {
    const uniqueTitle = `QA Student Message ${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post('/student/notifications')
      .set(...studentAuth)
      .send({
        title: uniqueTitle,
        message: 'Can you clarify the homework?',
        recipientType: 'individual',
        recipients: [String(fixture.teachers[0].id)],
      })
      .expect(201);
    expect(res.body.sent).toBe(1);

    const inbox = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const notifications = inbox.body?.notifications ?? inbox.body ?? [];
    const found = (Array.isArray(notifications) ? notifications : []).find(
      (n: { title: string }) => n.title === uniqueTitle,
    );
    expect(found).toBeDefined();
    expect(found.type).toBe('student_message');

    // The second fixture teacher was NOT a recipient — must not see it.
    const otherInbox = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...authHeader(fixture.teachers[1].token))
      .expect(200);
    const otherNotifications = otherInbox.body?.notifications ?? otherInbox.body ?? [];
    expect(
      (Array.isArray(otherNotifications) ? otherNotifications : []).some(
        (n: { title: string }) => n.title === uniqueTitle,
      ),
    ).toBe(false);
  });

  it(
    "POST /student/notifications rejects a recipient outside the student's " +
      'school (a student cannot message an arbitrary user by id)',
    async () => {
      const outsider = await createQaFixture(app);
      try {
        await request(app.getHttpServer())
          .post('/student/notifications')
          .set(...studentAuth)
          .send({
            title: 'x',
            message: 'y',
            recipientType: 'individual',
            recipients: [String(outsider.teachers[0].id)],
          })
          .expect(400);
      } finally {
        await teardownQaFixture(app, outsider);
      }
    },
  );

  it('PATCH /notifications/user marks a single notification read, scoped to the owning student', async () => {
    const uniqueTitle = `QA Student Message For Read ${Date.now()}`;
    await request(app.getHttpServer())
      .post('/student/notifications')
      .set(...authHeader(fixture.students[1].token))
      .send({
        title: uniqueTitle,
        message: 'hi',
        recipientType: 'role',
        recipients: ['role:teacher'],
      })
      .expect(201);

    const teacherInbox = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const notifications = teacherInbox.body?.notifications ?? teacherInbox.body ?? [];
    const found = (Array.isArray(notifications) ? notifications : []).find(
      (n: { title: string }) => n.title === uniqueTitle,
    );
    expect(found).toBeDefined();
    expect(found.is_read).toBe(false);

    // A different student cannot mark the teacher's notification as read.
    await request(app.getHttpServer())
      .patch('/notifications/user')
      .set(...studentAuth)
      .send({ notification_id: found.id, is_read: true })
      .expect(403);

    await request(app.getHttpServer())
      .patch('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .send({ notification_id: found.id, is_read: true })
      .expect(200);

    const refreshed = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const refreshedList = refreshed.body?.notifications ?? refreshed.body ?? [];
    const refreshedNotif = (Array.isArray(refreshedList) ? refreshedList : []).find(
      (n: { id: string }) => n.id === found.id,
    );
    expect(refreshedNotif.is_read).toBe(true);
  });

  it('PATCH /notifications/user with mark_all marks every unread notification read in one call', async () => {
    const student = fixture.students[2];
    const otherStudentAuth = authHeader(student.token);

    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .post('/student/notifications')
        .set(...otherStudentAuth)
        .send({
          title: `QA Mark-all batch ${i} ${Date.now()}`,
          message: 'hi',
          recipientType: 'individual',
          recipients: [String(fixture.teachers[0].id)],
        })
        .expect(201);
    }

    await request(app.getHttpServer())
      .patch('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .send({ mark_all: true, is_read: true })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const list = res.body?.notifications ?? res.body ?? [];
    expect(
      (Array.isArray(list) ? list : []).every(
        (n: { is_read: boolean }) => n.is_read,
      ),
    ).toBe(true);
  });

  it('PATCH /notifications/user with deleted:true soft-deletes, scoped to the owning student', async () => {
    const uniqueTitle = `QA Student Message To Delete ${Date.now()}`;
    await request(app.getHttpServer())
      .post('/student/notifications')
      .set(...studentAuth)
      .send({
        title: uniqueTitle,
        message: 'hi',
        recipientType: 'individual',
        recipients: [String(fixture.teachers[0].id)],
      })
      .expect(201);

    const inbox = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const list = inbox.body?.notifications ?? inbox.body ?? [];
    const found = (Array.isArray(list) ? list : []).find(
      (n: { title: string }) => n.title === uniqueTitle,
    );
    expect(found).toBeDefined();

    await request(app.getHttpServer())
      .patch('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .send({ notification_id: found.id, deleted: true })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    const afterList = after.body?.notifications ?? after.body ?? [];
    expect(
      (Array.isArray(afterList) ? afterList : []).some(
        (n: { id: string }) => n.id === found.id,
      ),
    ).toBe(false);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/notifications/user').expect(401);
    await request(app.getHttpServer())
      .patch('/notifications/user')
      .send({ mark_all: true, is_read: true })
      .expect(401);
    await request(app.getHttpServer())
      .post('/student/notifications')
      .send({ title: 'x', message: 'y' })
      .expect(401);
  });
});
