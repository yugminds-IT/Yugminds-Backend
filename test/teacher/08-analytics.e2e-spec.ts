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

describe('Teacher analytics', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let teacherAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app, { withScheduling: true });
    teacherAuth = authHeader(fixture.teachers[0].token);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /teacher/analytics works with no date range', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/analytics')
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.analytics).toBeDefined();
  });

  it('reports_total/leaves_total reflect exactly what this teacher created in-range', async () => {
    await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-06-01',
        period_id: fixture.periodId,
        topics_taught: 'Analytics test report',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/teacher/leaves')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        start_date: '2026-06-05',
        end_date: '2026-06-05',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(
        `/teacher/analytics?school_id=${fixture.schoolId}&from=2026-06-01&to=2026-06-30`,
      )
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.analytics.summary.reports_total).toBe(1);
    expect(res.body.analytics.summary.reports_pending).toBe(1);
    expect(res.body.analytics.summary.leaves_total).toBe(1);
    expect(res.body.analytics.summary.leaves_pending).toBe(1);
  });

  it('GET /teacher/assignment-analytics cross-checks against a known graded submission', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/teacher/assignments')
      .set(...teacherAuth)
      .send({
        schoolId: fixture.schoolId,
        title: 'Analytics Assignment',
        assignmentType: 'DAILY',
        isPublished: true,
        totalMarks: 10,
        subject: 'Math',
        questions: [
          {
            question_type: 'MCQ',
            question_text: '10 - 4 = ?',
            options: ['5', '6', '7'],
            correct_answer: '1',
            marks: 10,
          },
        ],
      })
      .expect(201);
    const assignmentId = createRes.body.assignment.id;

    const getRes = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}`)
      .set(...teacherAuth)
      .expect(200);
    const qId = getRes.body.assignment.questions[0].id;

    // Correct answer -> full marks (10/10 = 100%)
    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(fixture.students[0].token))
      .send({ answers: { [qId]: '1' } })
      .expect(201);

    const analyticsRes = await request(app.getHttpServer())
      .get(`/teacher/assignment-analytics?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    const row = analyticsRes.body.analytics.assignments.find(
      (a: any) => a.assignment_id === assignmentId,
    );
    expect(row).toBeDefined();
    expect(row.total_submissions).toBe(1);
    expect(row.graded_count).toBe(1);
    expect(row.avg_score_percentage).toBe(100);
    expect(row.highest_score).toBe(10);
  });

  it('403s when school_id is not assigned to the teacher', async () => {
    await request(app.getHttpServer())
      .get('/teacher/analytics?school_id=nonexistent-school-id')
      .set(...teacherAuth)
      .expect(403);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/teacher/analytics').expect(401);
    await request(app.getHttpServer())
      .get('/teacher/assignment-analytics')
      .expect(401);
  });
});
