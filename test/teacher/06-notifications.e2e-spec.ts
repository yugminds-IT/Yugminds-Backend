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
});
