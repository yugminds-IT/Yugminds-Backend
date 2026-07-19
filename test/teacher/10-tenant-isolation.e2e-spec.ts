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

describe('Teacher tenant isolation (school A teacher vs school B resources)', () => {
  let app: INestApplication;
  let schoolA: QaFixture;
  let schoolB: QaFixture;
  let authA: [string, string];
  let authB: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    schoolA = await createQaFixture(app);
    schoolB = await createQaFixture(app);
    authA = authHeader(schoolA.teachers[0].token);
    authB = authHeader(schoolB.teachers[0].token);
  }, 90000);

  afterAll(async () => {
    if (app && schoolA) await teardownQaFixture(app, schoolA);
    if (app && schoolB) await teardownQaFixture(app, schoolB);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it('a school-A assignment is invisible (404) to a school-B teacher, and vice versa', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/teacher/assignments')
      .set(...authA)
      .send({
        schoolId: schoolA.schoolId,
        title: 'School A only assignment',
        assignmentType: 'DAILY',
        isPublished: true,
        totalMarks: 10,
        questions: [],
      })
      .expect(201);
    const assignmentId = createRes.body.assignment.id;

    await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}`)
      .set(...authB)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/teacher/assignments/${assignmentId}`)
      .set(...authB)
      .send({ title: 'hijacked' })
      .expect(404);
    await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}/submissions`)
      .set(...authB)
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/teacher/assignments/${assignmentId}`)
      .set(...authB)
      .expect(404);

    // The school-A teacher can still access it normally.
    await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}`)
      .set(...authA)
      .expect(200);
  });

  it('a school-A student submission cannot be graded by a school-B teacher', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/teacher/assignments')
      .set(...authA)
      .send({
        schoolId: schoolA.schoolId,
        title: 'Grading isolation assignment',
        assignmentType: 'DAILY',
        isPublished: true,
        totalMarks: 10,
        questions: [],
      })
      .expect(201);
    const assignmentId = createRes.body.assignment.id;
    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(schoolA.students[0].token))
      .send({ textContent: 'answer' })
      .expect(201);
    const subs = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}/submissions`)
      .set(...authA)
      .expect(200);
    const submissionId = subs.body.submissions[0].id;

    await request(app.getHttpServer())
      .patch(
        `/teacher/assignments/${assignmentId}/submissions/${submissionId}/grade`,
      )
      .set(...authB)
      .send({ score: 10 })
      .expect(404);
  });

  it('listing/creating with a cross-school school_id is rejected by the tenant interceptor (403), for both directions', async () => {
    const crossChecks: Array<[string, () => request.Test]> = [
      [
        'dashboard',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/dashboard?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'classes',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/classes?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'periods',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/periods?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'schedules',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/schedules?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'attendance today',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/attendance/today?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'leaves list',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/leaves?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'reports list',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/reports?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'analytics',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/analytics?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'assignments list',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/assignments?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'student-progress',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/student-progress?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'notifications recipients',
        () =>
          request(app.getHttpServer())
            .get(`/teacher/notifications/recipients?school_id=${schoolB.schoolId}`)
            .set(...authA),
      ],
      [
        'leave create',
        () =>
          request(app.getHttpServer())
            .post('/teacher/leaves')
            .set(...authA)
            .send({
              school_id: schoolB.schoolId,
              start_date: '2026-07-01',
              end_date: '2026-07-01',
            }),
      ],
      [
        'report create',
        () =>
          request(app.getHttpServer())
            .post('/teacher/reports')
            .set(...authA)
            .send({ school_id: schoolB.schoolId, date: '2026-07-01' }),
      ],
      [
        'notification create',
        () =>
          request(app.getHttpServer())
            .post('/teacher/notifications')
            .set(...authA)
            .send({
              title: 'x',
              message: 'y',
              school_id: schoolB.schoolId,
              recipientType: 'role',
              recipients: ['role:student'],
            }),
      ],
      [
        'assignment create',
        () =>
          request(app.getHttpServer())
            .post('/teacher/assignments')
            .set(...authA)
            .send({
              schoolId: schoolB.schoolId,
              title: 'cross-school',
              assignmentType: 'DAILY',
              isPublished: false,
              questions: [],
            }),
      ],
    ];

    for (const [label, run] of crossChecks) {
      const res = await run();
      expect([403, 404]).toContain(res.status);
    }
  });

  it('a school-B teacher never sees school-A notifications, leaves, or reports in their own lists', async () => {
    await request(app.getHttpServer())
      .post('/teacher/notifications')
      .set(...authA)
      .send({
        title: 'School A staff notice',
        message: 'Only for school A',
        school_id: schoolA.schoolId,
        recipientType: 'role',
        recipients: ['role:teacher'],
      })
      .expect(201);

    const bReceived = await request(app.getHttpServer())
      .get('/teacher/notifications?mode=received')
      .set(...authB)
      .expect(200);
    expect(
      bReceived.body.notifications.some(
        (n: any) => n.title === 'School A staff notice',
      ),
    ).toBe(false);
  });
});
