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

/**
 * Regression coverage: the student-facing assignment endpoints
 * (GET /student/assignments, GET /student/assignments/:id) used to always
 * show whichever attempt was most recent, ignoring the assignment's own
 * retakeScoringRule. On a 'highest'-rule assignment, a student who retook
 * and scored worse would see the worse score — directly contradicting the
 * "Your highest score across all attempts is used for grading" copy shown
 * on the assignment detail page. StudentRankingService (the canonical
 * scoring source used for leaderboards) already honored the rule; these
 * endpoints now use the same graded-attempt selection.
 */
describe('Student assignments — retake scoring rule consistency', () => {
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
    "on a 'highest'-rule assignment, the detail endpoint's submission and grade " +
      'reflect the best-scoring attempt, not just the most recent one',
    async () => {
      const assignmentId = await createDailyAssignment({
        title: 'QA Retake Scoring — highest',
        maxRetakeAttempts: 3,
        questions: [
          {
            question_type: 'MCQ',
            question_text: '2 + 2 = ?',
            options: ['3', '4', '5'],
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

      // Attempt 2 (retake): wrong → 0/10. Most recent attempt, but NOT the
      // official score under a 'highest' rule.
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
      expect(detail.body.submission.grade).toBe(100);
      expect(detail.body.submission.attempt_number).toBe(1);
      // Full attempt history must still show both attempts untouched.
      expect(detail.body.attempts).toHaveLength(2);
      expect(detail.body.attempts[0].score).toBe(10);
      expect(detail.body.attempts[1].score).toBe(0);

      const list = await request(app.getHttpServer())
        .get('/student/assignments?type=DAILY')
        .set(...studentAuth)
        .expect(200);
      const row = list.body.assignments.find(
        (a: { id: string }) => a.id === assignmentId,
      );
      expect(row.submission.grade).toBe(100);
    },
  );

  it(
    "on the default 'latest'-rule assignment, the most recent graded attempt's " +
      'score is shown (no regression from the highest-rule fix)',
    async () => {
      const assignmentId = await createDailyAssignment({
        title: 'QA Retake Scoring — latest',
        maxRetakeAttempts: 3,
        questions: [
          {
            question_type: 'MCQ',
            question_text: '3 + 3 = ?',
            options: ['5', '6', '7'],
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
        .send({ retakeEnabled: true, retakeWindowOpen: true })
        .expect(200);

      // Attempt 2: wrong → 0/10. Under the default 'latest' rule this IS the
      // official score, even though it's worse than attempt 1.
      await request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set(...studentAuth)
        .send({ answers: { [qId]: '0' } })
        .expect(201);

      const detail = await request(app.getHttpServer())
        .get(`/student/assignments/${assignmentId}`)
        .set(...studentAuth)
        .expect(200);
      expect(detail.body.submission.score).toBe(0);
      expect(detail.body.submission.attempt_number).toBe(2);
    },
  );

  it(
    "on a COURSE-type assignment with a 'highest' rule, GET /student/assignments " +
      '(the non-DAILY branch) also shows the best-scoring attempt',
    async () => {
      const adminAuth = authHeader(fixture.admin.token);
      await request(app.getHttpServer())
        .patch(`/admin/courses/${fixture.courseId}`)
        .set(...adminAuth)
        .send({ chapters: [{ name: 'QA Assignment Chapter', order_number: 1 }] })
        .expect(200);
      const courseRes = await request(app.getHttpServer())
        .get(`/admin/courses/${fixture.courseId}`)
        .set(...adminAuth)
        .expect(200);
      const course = courseRes.body?.data ?? courseRes.body;
      const chapterId = course.chapters.find(
        (c: { name: string }) => c.name === 'QA Assignment Chapter',
      ).id;

      const assignmentId = await createDailyAssignment({
        title: 'QA Course Assignment Retake Scoring',
        assignmentType: 'COURSE',
        chapterId,
        schoolId: undefined,
        maxRetakeAttempts: 3,
        questions: [
          {
            question_type: 'MCQ',
            question_text: '5 + 5 = ?',
            options: ['9', '10', '11'],
            correct_answer: '1',
            marks: 10,
          },
        ],
      });
      const qId = (await fetchQuestions(assignmentId))[0].id;

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

      await request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set(...studentAuth)
        .send({ answers: { [qId]: '0' } })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get(`/student/assignments?course_id=${fixture.courseId}`)
        .set(...studentAuth)
        .expect(200);
      const row = list.body.assignments.find(
        (a: { id: string }) => a.id === assignmentId,
      );
      expect(row).toBeDefined();
      expect(row.submission.grade).toBe(100);
    },
  );
});
