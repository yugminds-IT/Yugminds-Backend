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

describe('Teacher notifications', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let otherSchoolFixture: QaFixture;
  let teacherAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    otherSchoolFixture = await createQaFixture(app);
    teacherAuth = authHeader(fixture.teachers[0].token);
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app && otherSchoolFixture)
      await teardownQaFixture(app, otherSchoolFixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it('GET /teacher/notifications/recipients returns role groups and individual users for the school', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/notifications/recipients?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.roles.some((r: any) => r.id === 'role:student')).toBe(
      true,
    );
    expect(
      res.body.users.some((u: any) => u.id === String(fixture.students[0].id)),
    ).toBe(true);
  });

  it('a notification sent to role:student reaches every fixture student and is visible via GET /notifications/user', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/teacher/notifications')
      .set(...teacherAuth)
      .send({
        title: 'Class trip reminder',
        message: 'Bring your permission slip tomorrow.',
        school_id: fixture.schoolId,
        recipientType: 'role',
        recipients: ['role:student'],
      })
      .expect(201);
    expect(createRes.body.sent).toBe(3); // 3 fixture students

    for (const student of fixture.students) {
      const res = await request(app.getHttpServer())
        .get('/notifications/user?filter=all&limit=50')
        .set(...authHeader(student.token))
        .expect(200);
      expect(
        res.body.notifications.some(
          (n: any) => n.title === 'Class trip reminder',
        ),
      ).toBe(true);
    }

    // A student in a completely different QA school must never see it.
    const outsiderRes = await request(app.getHttpServer())
      .get('/notifications/user?filter=all&limit=50')
      .set(...authHeader(otherSchoolFixture.students[0].token))
      .expect(200);
    expect(
      outsiderRes.body.notifications.some(
        (n: any) => n.title === 'Class trip reminder',
      ),
    ).toBe(false);
  });

  it('a notification sent to role:teacher is received by another teacher in the same school and can be marked read', async () => {
    const senderAuth = authHeader(fixture.teachers[1].token);
    const createRes = await request(app.getHttpServer())
      .post('/teacher/notifications')
      .set(...senderAuth)
      .send({
        title: 'Staff meeting',
        message: 'Meeting at 3pm in the staff room.',
        school_id: fixture.schoolId,
        recipientType: 'role',
        recipients: ['role:teacher'],
      })
      .expect(201);
    expect(createRes.body.sent).toBeGreaterThanOrEqual(1);

    const receivedRes = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=received')
      .set(...teacherAuth)
      .expect(200);
    const received = receivedRes.body.notifications.find(
      (n: any) => n.title === 'Staff meeting',
    );
    expect(received).toBeDefined();
    expect(received.is_read).toBe(false);

    await request(app.getHttpServer())
      .patch(`/teacher/notifications/${received.id}`)
      .set(...teacherAuth)
      .send({ is_read: true })
      .expect(200);

    const getOne = await request(app.getHttpServer())
      .get(`/teacher/notifications/${received.id}`)
      .set(...teacherAuth)
      .expect(200);
    expect(getOne.body.notification.is_read).toBe(true);
  });

  it('the sender sees their own sent notification via mode=sent', async () => {
    const sentRes = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=sent')
      .set(...authHeader(fixture.teachers[1].token))
      .expect(200);
    expect(
      sentRes.body.notifications.some(
        (n: any) => n.title === 'Staff meeting',
      ),
    ).toBe(true);
  });

  it('creating a notification without a school_id is rejected', async () => {
    await request(app.getHttpServer())
      .post('/teacher/notifications')
      .set(...teacherAuth)
      .send({
        title: 'x',
        message: 'y',
        recipientType: 'role',
        recipients: ['role:student'],
      })
      .expect(400);
  });

  it('creating a notification for a school the teacher is not assigned to is forbidden', async () => {
    await request(app.getHttpServer())
      .post('/teacher/notifications')
      .set(...teacherAuth)
      .send({
        title: 'x',
        message: 'y',
        school_id: otherSchoolFixture.schoolId,
        recipientType: 'role',
        recipients: ['role:student'],
      })
      .expect(403);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/teacher/notifications').expect(401);
  });

  it('GET /teacher/notifications returns a real total, defaults to mode=received', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/notifications')
      .set(...teacherAuth)
      .expect(200);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.notifications.length);
    // Default mode is 'received' — the sender's own "Staff meeting" send
    // (from an earlier test in this file, teachers[1] -> role:teacher)
    // must NOT appear for teachers[1] under the default mode, since it's
    // a sent row, not a received one.
    const sentAuth = authHeader(fixture.teachers[1].token);
    const defaultRes = await request(app.getHttpServer())
      .get('/teacher/notifications')
      .set(...sentAuth)
      .expect(200);
    expect(
      defaultRes.body.notifications.some((n: any) => n.title === 'Staff meeting'),
    ).toBe(false);
  });

  it('honors limit/offset pagination', async () => {
    const full = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=sent')
      .set(...authHeader(fixture.teachers[1].token))
      .query({ limit: 100 })
      .expect(200);
    if (full.body.notifications.length < 2) return; // not enough data to page over

    const page1 = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=sent')
      .set(...authHeader(fixture.teachers[1].token))
      .query({ limit: 1, offset: 0 })
      .expect(200);
    const page2 = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=sent')
      .set(...authHeader(fixture.teachers[1].token))
      .query({ limit: 1, offset: 1 })
      .expect(200);
    expect(page1.body.notifications.length).toBe(1);
    expect(page2.body.notifications.length).toBe(1);
    expect(page1.body.notifications[0].id).not.toBe(page2.body.notifications[0].id);
  });

  it(
    'marking a SENT notification as read fails — the row belongs to the ' +
      "recipient, not the sender, so the shared ownership check rejects it " +
      '(regression guard for the mark-as-read-in-sent-view bug)',
    async () => {
      const senderAuth = authHeader(fixture.teachers[1].token);
      const sentRes = await request(app.getHttpServer())
        .get('/teacher/notifications?mode=sent')
        .set(...senderAuth)
        .expect(200);
      const sentNotif = sentRes.body.notifications.find(
        (n: any) => n.title === 'Staff meeting',
      );
      expect(sentNotif).toBeDefined();

      await request(app.getHttpServer())
        .patch(`/teacher/notifications/${sentNotif.id}`)
        .set(...senderAuth)
        .send({ is_read: true })
        .expect(400);
    },
  );

  it(
    'GET /teacher/notifications/recipients excludes the requesting teacher ' +
      "from both the role:teacher count and the individual users list " +
      '(regression guard for the "All Teachers (1)" self-count bug that ' +
      "always 400'd on solo-teacher schools)",
    async () => {
      const res = await request(app.getHttpServer())
        .get(`/teacher/notifications/recipients?school_id=${fixture.schoolId}`)
        .set(...teacherAuth)
        .expect(200);
      expect(
        res.body.users.some(
          (u: any) => u.id === String(fixture.teachers[0].id),
        ),
      ).toBe(false);
      expect(
        res.body.users.some(
          (u: any) => u.id === String(fixture.teachers[1].id),
        ),
      ).toBe(true);
      // Fixture has 2 teachers total; excluding the requester, exactly 1
      // "other" teacher remains.
      const teacherRole = res.body.roles.find(
        (r: any) => r.id === 'role:teacher',
      );
      expect(teacherRole).toBeDefined();
      expect(teacherRole.count).toBe(1);
    },
  );
});
