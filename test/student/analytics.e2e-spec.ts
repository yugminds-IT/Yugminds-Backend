import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { authHeader } from '../admin/support/auth';
import { closePool, pool } from '../admin/support/db';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';

describe('Student analytics (GET /student/analytics)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let studentAuth: [string, string];
  let teacherAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    studentAuth = authHeader(fixture.students[0].token);
    teacherAuth = authHeader(fixture.teachers[0].token);
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  async function createDailyAssignment(body: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/teacher/assignments')
      .set(...teacherAuth)
      .send({
        schoolId: fixture.schoolId,
        assignmentType: 'DAILY',
        isPublished: true,
        totalMarks: 10,
        ...body,
      })
      .expect(201);
    return res.body.assignment.id as string;
  }

  async function fetchQuestions(assignmentId: string) {
    const res = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}`)
      .set(...teacherAuth)
      .expect(200);
    return res.body.assignment.questions as Array<{ id: string }>;
  }

  it(
    "on a 'highest'-rule assignment, the Analytics summary/leaderboard reflect the same " +
      "best-scoring attempt as the Assignments detail endpoint (regression: this used to be " +
      'a second hand-rolled copy of the retake-rule selection logic, risking silent divergence)',
    async () => {
      const assignmentId = await createDailyAssignment({
        title: 'QA Analytics Retake Scoring',
        maxRetakeAttempts: 3,
        questions: [
          {
            question_type: 'MCQ',
            question_text: '6 + 6 = ?',
            options: ['11', '12', '13'],
            correct_answer: '1',
            marks: 10,
          },
        ],
      });
      const qId = (await fetchQuestions(assignmentId))[0].id;

      // Attempt 1: correct → 10/10.
      await request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set(...studentAuth)
        .send({ answers: { [qId]: '1' } })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/teacher/assignments/${assignmentId}/retake-settings`)
        .set(...teacherAuth)
        .send({
          retakeEnabled: true,
          retakeWindowOpen: true,
          retakeScoringRule: 'highest',
        })
        .expect(200);

      // Attempt 2 (retake): wrong → 0/10. Most recent, but not official
      // under a 'highest' rule.
      await request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set(...studentAuth)
        .send({ answers: { [qId]: '0' } })
        .expect(201);

      const detail = await request(app.getHttpServer())
        .get(`/student/assignments/${assignmentId}`)
        .set(...studentAuth)
        .expect(200);
      expect(detail.body.submission.score).toBe(10);

      const analytics = await request(app.getHttpServer())
        .get('/student/analytics')
        .set(...studentAuth)
        .expect(200);
      const historyRow = analytics.body.score_history.find(
        (h: { assignment_id: string }) => h.assignment_id === assignmentId,
      );
      expect(historyRow).toBeDefined();
      expect(historyRow.score).toBe(10);

      const selfRow = analytics.body.school_leaderboard.find(
        (r: { is_self: boolean }) => r.is_self,
      );
      expect(selfRow).toBeDefined();
      expect(selfRow.daily_score).toBe(100);
    },
  );

  it(
    "pending_grading counts 'late' submissions alongside 'submitted' ones " +
      "(regression: 'late' is a distinct-but-still-ungraded status that used to be excluded, " +
      'understating how much work was awaiting a teacher)',
    async () => {
      const assignmentId = await createDailyAssignment({
        title: 'QA Pending Grading Late Status',
        questions: [],
      });

      const before = await request(app.getHttpServer())
        .get('/student/analytics')
        .set(...studentAuth)
        .expect(200);
      const beforePending = before.body.summary.pending_grading;

      await request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set(...studentAuth)
        .send({ textContent: 'Answer' })
        .expect(201);

      await pool.query(
        'UPDATE "AssignmentSubmission" SET status = $1 WHERE "assignmentId" = $2 AND "studentId" = $3',
        ['late', assignmentId, fixture.students[0].id],
      );

      const after = await request(app.getHttpServer())
        .get('/student/analytics')
        .set(...studentAuth)
        .expect(200);
      expect(after.body.summary.pending_grading).toBe(beforePending + 1);
    },
  );
});
