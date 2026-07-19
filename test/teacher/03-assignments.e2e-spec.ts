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

describe('Teacher assignments (CRUD, grading, retakes, analytics-adjacent)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let teacherAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    teacherAuth = authHeader(fixture.teachers[0].token);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  async function createAssignment(body: Record<string, unknown>) {
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

  // ---- CRUD ----

  it('creates, reads, lists, updates, and deletes an assignment', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/teacher/assignments')
      .set(...teacherAuth)
      .send({
        schoolId: fixture.schoolId,
        title: 'Assignment CRUD',
        assignmentType: 'DAILY',
        isPublished: false,
        totalMarks: 10,
        questions: [
          {
            question_type: 'MCQ',
            question_text: '2 + 2 = ?',
            options: ['3', '4', '5'],
            correct_answer: '1',
            marks: 10,
          },
        ],
      })
      .expect(201);
    const assignmentId = createRes.body.assignment.id;
    expect(assignmentId).toBeDefined();

    const getRes = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(getRes.body.assignment.title).toBe('Assignment CRUD');
    expect(getRes.body.assignment.questions).toHaveLength(1);

    const listRes = await request(app.getHttpServer())
      .get(`/teacher/assignments?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(
      listRes.body.assignments.some((a: any) => a.id === assignmentId),
    ).toBe(true);

    const patchRes = await request(app.getHttpServer())
      .patch(`/teacher/assignments/${assignmentId}`)
      .set(...teacherAuth)
      .send({ title: 'Assignment CRUD (updated)', isPublished: true })
      .expect(200);
    expect(patchRes.body.assignment.title).toBe('Assignment CRUD (updated)');
    expect(patchRes.body.assignment.isPublished).toBe(true);

    await request(app.getHttpServer())
      .delete(`/teacher/assignments/${assignmentId}`)
      .set(...teacherAuth)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}`)
      .set(...teacherAuth)
      .expect(404);
  });

  it('404s for a nonexistent assignment on get/patch/delete', async () => {
    await request(app.getHttpServer())
      .get('/teacher/assignments/nonexistent-id')
      .set(...teacherAuth)
      .expect(404);
    await request(app.getHttpServer())
      .patch('/teacher/assignments/nonexistent-id')
      .set(...teacherAuth)
      .send({ title: 'x' })
      .expect(404);
    await request(app.getHttpServer())
      .delete('/teacher/assignments/nonexistent-id')
      .set(...teacherAuth)
      .expect(404);
  });

  // ---- Grading: manual (no auto-gradable questions) ----

  it('a manually graded submission becomes visible with score/feedback to the student who submitted it', async () => {
    const assignmentId = await createAssignment({
      title: 'Assignment Grading',
      questions: [],
    });
    const student = fixture.students[0];

    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ textContent: 'My essay answer.' })
      .expect(201);

    const subsRes = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}/submissions`)
      .set(...teacherAuth)
      .expect(200);
    expect(subsRes.body.submissions).toHaveLength(1);
    const submissionId = subsRes.body.submissions[0].id;
    expect(subsRes.body.submissions[0].status).toBe('submitted');

    const gradeRes = await request(app.getHttpServer())
      .patch(
        `/teacher/assignments/${assignmentId}/submissions/${submissionId}/grade`,
      )
      .set(...teacherAuth)
      .send({ score: 8, feedback: 'Nice work' })
      .expect(200);
    expect(gradeRes.body.submission.score).toBe(8);
    expect(gradeRes.body.submission.status).toBe('graded');

    const studentView = await request(app.getHttpServer())
      .get(`/student/assignments/${assignmentId}`)
      .set(...authHeader(student.token))
      .expect(200);
    expect(studentView.body.submission.score).toBe(8);
    expect(studentView.body.submission.feedback).toBe('Nice work');
    expect(studentView.body.submission.status).toBe('graded');
  });

  // ---- Batch grading ----

  it('batch-grade grades multiple submissions across students in one call', async () => {
    const assignmentId = await createAssignment({
      title: 'Assignment Batch',
      questions: [],
    });
    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(fixture.students[1].token))
      .send({ textContent: 'Student 1 answer' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(fixture.students[2].token))
      .send({ textContent: 'Student 2 answer' })
      .expect(201);

    const subsRes = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}/submissions`)
      .set(...teacherAuth)
      .expect(200);
    expect(subsRes.body.submissions).toHaveLength(2);

    const grades = subsRes.body.submissions.map((s: any, i: number) => ({
      submissionId: s.id,
      assignmentId,
      score: 5 + i,
      feedback: `Feedback ${i}`,
    }));

    const batchRes = await request(app.getHttpServer())
      .post('/teacher/assignments/batch-grade')
      .set(...teacherAuth)
      .send({ grades })
      .expect(201);
    expect(batchRes.body.graded_count).toBe(2);

    const afterRes = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}/submissions`)
      .set(...teacherAuth)
      .expect(200);
    expect(afterRes.body.submissions.every((s: any) => s.status === 'graded')).toBe(
      true,
    );

    const dashRes = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}/progress-dashboard`)
      .set(...teacherAuth)
      .expect(200);
    expect(dashRes.body.dashboard.students_count).toBe(2);
    expect(dashRes.body.dashboard.submission_completion_rate).toBe(100);
  });

  // ---- Retakes: settings + open/close window ----

  it('retake settings gate resubmission; enabling retake allows a second attempt', async () => {
    const assignmentId = await createAssignment({
      title: 'Assignment Retake Settings',
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
    const questions = await fetchQuestions(assignmentId);
    const qId = questions[0].id;
    const student = fixture.students[1];

    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '0' } })
      .expect(201);

    // retakeEnabled defaults to false — a second attempt must be rejected.
    const blocked = await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '1' } });
    expect(blocked.status).toBe(400);

    await request(app.getHttpServer())
      .patch(`/teacher/assignments/${assignmentId}/retake-settings`)
      .set(...teacherAuth)
      .send({
        retakeEnabled: true,
        retakeWindowOpen: true,
        retakeScoringRule: 'highest',
      })
      .expect(200);

    const retakeSubmit = await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '1' } })
      .expect(201);
    expect(retakeSubmit.body.attempt_number).toBe(2);
    expect(retakeSubmit.body.score).toBe(10);

    const history = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}/attempt-history/${student.id}`)
      .set(...teacherAuth)
      .expect(200);
    expect(history.body.attempts).toHaveLength(2);
    expect(history.body.attempts[1].score).toBe(10);
  });

  // ---- Retake grants (per-student override) ----

  it('a retake grant lets one selected student resubmit while the window is closed', async () => {
    const assignmentId = await createAssignment({
      title: 'Assignment Retake Grant',
      retakeEnabled: true,
      maxRetakeAttempts: 2,
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
    await request(app.getHttpServer())
      .patch(`/teacher/assignments/${assignmentId}/retake-settings`)
      .set(...teacherAuth)
      .send({ retakeAccessScope: 'selected', retakeWindowOpen: false })
      .expect(200);

    const questions = await fetchQuestions(assignmentId);
    const qId = questions[0].id;
    const student = fixture.students[2];

    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '1' } })
      .expect(201);

    const blocked = await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '0' } });
    expect(blocked.status).toBe(400);

    const grantRes = await request(app.getHttpServer())
      .post(`/teacher/assignments/${assignmentId}/retake-grants`)
      .set(...teacherAuth)
      .send({ studentIds: [student.id] })
      .expect(201);
    expect(grantRes.body.granted_count).toBe(1);

    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '0' } })
      .expect(201);

    // a different, non-granted student is still blocked
    const other = fixture.students[0];
    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(other.token))
      .send({ answers: { [qId]: '1' } })
      .expect(201); // first attempt for `other`, always allowed
    const otherBlocked = await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(other.token))
      .send({ answers: { [qId]: '0' } });
    expect(otherBlocked.status).toBe(400);
  });

  // ---- Retake open-all / close ----

  it('retake-open-all grants retakes to every submitted student; retake-close revokes them', async () => {
    const assignmentId = await createAssignment({
      title: 'Assignment Open All',
      maxRetakeAttempts: 5,
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
    const questions = await fetchQuestions(assignmentId);
    const qId = questions[0].id;
    const student = fixture.students[0];

    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '1' } })
      .expect(201);

    const openRes = await request(app.getHttpServer())
      .post(`/teacher/assignments/${assignmentId}/retake-open-all`)
      .set(...teacherAuth)
      .send({})
      .expect(201);
    expect(openRes.body.retake_granted_count).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '0' } })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/teacher/assignments/${assignmentId}/retake-close`)
      .set(...teacherAuth)
      .send({})
      .expect(201);

    const blocked = await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...authHeader(student.token))
      .send({ answers: { [qId]: '1' } });
    expect(blocked.status).toBe(400);
  });

  // ---- AuthZ ----

  it('rejects unauthenticated and non-teacher access', async () => {
    await request(app.getHttpServer())
      .get(`/teacher/assignments?school_id=${fixture.schoolId}`)
      .expect(401);
    const res = await request(app.getHttpServer())
      .get(`/teacher/assignments?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.students[0].token));
    expect([401, 403]).toContain(res.status);
  });
});
