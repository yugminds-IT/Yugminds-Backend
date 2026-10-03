import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin stats / assignment-analytics / leaderboard', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /school-admin/stats reflects fixture counts (2 active teachers, 3 students)', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/stats')
      .set(...auth)
      .expect(200);
    expect(res.body.stats.totalTeachers).toBe(2);
    expect(res.body.stats.totalStudents).toBe(3);
    expect(res.body.stats).toEqual(
      expect.objectContaining({
        activeCourses: expect.any(Number),
        pendingReports: expect.any(Number),
        pendingLeaves: expect.any(Number),
        averageAttendance: expect.any(Number),
      }),
    );
  });

  it('GET /school-admin/assignment-analytics no longer exists (removed dead/duplicate endpoint — the real UI only ever used /school-admin/leaderboard)', async () => {
    await request(app.getHttpServer())
      .get('/school-admin/assignment-analytics')
      .set(...auth)
      .expect(404);
  });

  it('GET /school-admin/leaderboard returns expected shape and school name matches fixture', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/leaderboard')
      .set(...auth)
      .expect(200);
    expect(res.body.summary.school_name).toContain('__qa_test_');
    expect(res.body.summary.total_students).toBe(3);
    expect(Array.isArray(res.body.leaderboard)).toBe(true);
    expect(Array.isArray(res.body.grade_breakdown)).toBe(true);
    expect(Array.isArray(res.body.subject_breakdown)).toBe(true);
    expect(Array.isArray(res.body.assignment_table)).toBe(true);
  });

  it('GET /school-admin/leaderboard/assignments/:id/marks lists each student mark; the table average is a percentage', async () => {
    const created = await request(app.getHttpServer())
      .post('/teacher/assignments')
      .set('Authorization', `Bearer ${fixture.teachers[0].token}`)
      .send({
        schoolId: fixture.schoolId,
        title: 'QA School Admin Marks',
        assignmentType: 'DAILY',
        isPublished: true,
        totalMarks: 20,
        questions: [
          {
            question_type: 'MCQ',
            question_text: '4 + 4 = ?',
            options: ['7', '8', '9'],
            correct_answer: '1',
            marks: 20,
          },
        ],
      })
      .expect(201);
    const assignmentId: string = created.body.assignment.id;
    const detail = await request(app.getHttpServer())
      .get(`/teacher/assignments/${assignmentId}`)
      .set('Authorization', `Bearer ${fixture.teachers[0].token}`)
      .expect(200);
    const qId: string = detail.body.assignment.questions[0].id;

    const submit = (token: string, answer: string) =>
      request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ answers: { [qId]: answer } })
        .expect(201);
    await submit(fixture.students[0].token, '1');
    await submit(fixture.students[1].token, '0');

    const res = await request(app.getHttpServer())
      .get(`/school-admin/leaderboard/assignments/${assignmentId}/marks`)
      .set(...auth)
      .expect(200);
    expect(res.body.assignment.title).toBe('QA School Admin Marks');
    expect(res.body.students).toHaveLength(2);
    const byId = new Map<
      number,
      {
        score: number;
        max_score: number;
        percent: number;
        status: string;
        attempts: number;
      }
    >(res.body.students.map((s: { student_id: number }) => [s.student_id, s]));
    expect(byId.get(fixture.students[0].id)).toMatchObject({
      score: 20,
      max_score: 20,
      percent: 100,
      status: 'graded',
      attempts: 1,
    });
    expect(byId.get(fixture.students[1].id)).toMatchObject({
      score: 0,
      percent: 0,
    });

    const board = await request(app.getHttpServer())
      .get('/school-admin/leaderboard')
      .set(...auth)
      .expect(200);
    const row = board.body.assignment_table.find(
      (r: { assignment_id: string }) => r.assignment_id === assignmentId,
    );
    // Not targeted at any grade, so the audience is all 3 fixture students.
    expect(row).toMatchObject({
      total_submissions: 2,
      targeted_students: 3,
      completion_rate: 66.67,
      avg_score: 50,
      avg_marks: 10,
    });

    await request(app.getHttpServer())
      .get(
        '/school-admin/leaderboard/assignments/00000000-0000-0000-0000-000000000000/marks',
      )
      .set(...auth)
      .expect(404);
  });

  it('unauthenticated requests are rejected', async () => {
    await request(app.getHttpServer()).get('/school-admin/stats').expect(401);
  });
});
