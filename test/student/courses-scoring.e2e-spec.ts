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
 * Regression coverage for GET /student/courses' per-course average_grade and
 * completed_assignments fields: they used to average/count every raw
 * AssignmentSubmission row for a course, including every superseded retake
 * attempt, instead of deduping to the one officially-recognized attempt per
 * assignment (the same selection StudentRankingService and the student
 * Analytics endpoint use). A student who retook an assignment and did worse
 * saw their course average dragged down by the discarded attempt, and each
 * retake inflated completed_assignments as if it were a separate assignment.
 */
describe('Student courses — average_grade / completed_assignments dedup retakes', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let studentAuth: [string, string];
  let teacherAuth: [string, string];
  let adminAuth: [string, string];
  let chapterId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    studentAuth = authHeader(fixture.students[0].token);
    teacherAuth = authHeader(fixture.teachers[0].token);
    adminAuth = authHeader(fixture.admin.token);

    await request(app.getHttpServer())
      .patch(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .send({ chapters: [{ name: 'QA Scoring Chapter', order_number: 1 }] })
      .expect(200);
    const courseRes = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .expect(200);
    const course = courseRes.body?.data ?? courseRes.body;
    chapterId = course.chapters.find(
      (c: { name: string }) => c.name === 'QA Scoring Chapter',
    ).id;
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it(
    "average_grade reflects only the officially-recognized attempt under a 'highest' " +
      'retake rule, and completed_assignments counts the assignment once, not per attempt',
    async () => {
      const createRes = await request(app.getHttpServer())
        .post('/teacher/assignments')
        .set(...teacherAuth)
        .send({
          assignmentType: 'COURSE',
          chapterId,
          isPublished: true,
          totalMarks: 10,
          title: 'QA Course Assignment Scoring',
          maxRetakeAttempts: 3,
          questions: [
            {
              question_type: 'MCQ',
              question_text: '7 + 7 = ?',
              options: ['13', '14', '15'],
              correct_answer: '1',
              marks: 10,
            },
          ],
        })
        .expect(201);
      const assignmentId = createRes.body.assignment.id as string;

      const qRes = await request(app.getHttpServer())
        .get(`/teacher/assignments/${assignmentId}`)
        .set(...teacherAuth)
        .expect(200);
      const qId = qRes.body.assignment.questions[0].id;

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

      // Attempt 2 (retake): wrong → 0/10. Superseded under 'highest', but a
      // naive average of both raw rows would show 50%, not 100%.
      await request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set(...studentAuth)
        .send({ answers: { [qId]: '0' } })
        .expect(201);

      const coursesRes = await request(app.getHttpServer())
        .get('/student/courses')
        .set(...studentAuth)
        .expect(200);
      const courses = coursesRes.body?.courses ?? coursesRes.body;
      const row = courses.find(
        (c: { id: string }) => c.id === fixture.courseId,
      );
      expect(row).toBeDefined();
      expect(row.average_grade).toBe(100);
      expect(row.completed_assignments).toBe(1);
    },
  );
});
