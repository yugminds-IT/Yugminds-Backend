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

/**
 * Regression coverage for GET /student/courses/:courseId/chapters/:chapterId/contents:
 * it used to only honor a per-content-item CourseProgress row when deciding
 * is_completed, ignoring the chapter-level "mark whole chapter done" row that
 * GET /student/courses/:courseId/chapters already treats as completing every
 * item in the chapter. That divergence let the chapter sidebar show a green
 * checkmark (100%) while the item viewer still showed "Mark as Complete" on
 * every item inside it.
 */
describe('Student course content — chapter-level completion propagation', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let studentAuth: [string, string];
  let adminAuth: [string, string];
  let chapterId: string;
  let contentId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    studentAuth = authHeader(fixture.students[0].token);
    adminAuth = authHeader(fixture.admin.token);

    await request(app.getHttpServer())
      .patch(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .send({
        chapters: [{ name: 'QA Chapter', order_number: 1 }],
      })
      .expect(200);

    const courseRes = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .expect(200);
    const course = courseRes.body?.data ?? courseRes.body;
    chapterId = course.chapters[0].id;

    await request(app.getHttpServer())
      .patch(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .send({
        chapters: [{ id: chapterId, name: 'QA Chapter', order_number: 1 }],
        chapter_contents: [
          {
            chapter_id: chapterId,
            content_type: 'text',
            title: 'QA Lesson',
            content_text: 'Some content',
            order_index: 1,
          },
        ],
      })
      .expect(200);

    const withContentRes = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .expect(200);
    const withContent = withContentRes.body?.data ?? withContentRes.body;
    contentId = withContent.chapter_contents.find(
      (c: { chapter_id: string }) => c.chapter_id === chapterId,
    ).id;
  }, 90000);

  afterAll(async () => {
    // closePool() runs once, in this file's LAST describe block's afterAll —
    // the shared `pool` singleton can't be closed twice, and a second
    // describe block in this same file still needs it after this one ends.
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
  }, 90000);

  it('before completion: both endpoints agree the chapter/item are not done', async () => {
    const chapters = await request(app.getHttpServer())
      .get(`/student/courses/${fixture.courseId}/chapters`)
      .set(...studentAuth)
      .expect(200);
    expect(chapters.body.chapters[0].is_completed).toBe(false);

    const contents = await request(app.getHttpServer())
      .get(
        `/student/courses/${fixture.courseId}/chapters/${chapterId}/contents`,
      )
      .set(...studentAuth)
      .expect(200);
    expect(contents.body.contents[0].is_completed).toBe(false);
  });

  it(
    'marking the whole chapter complete (no contentId) is reflected as ' +
      'is_completed on both the chapter listing AND every item inside it',
    async () => {
      await request(app.getHttpServer())
        .post('/student/save-chapter-progress')
        .set(...studentAuth)
        .send({
          courseId: fixture.courseId,
          chapterId,
          completed: true,
        })
        .expect(201);

      const chapters = await request(app.getHttpServer())
        .get(`/student/courses/${fixture.courseId}/chapters`)
        .set(...studentAuth)
        .expect(200);
      expect(chapters.body.chapters[0].is_completed).toBe(true);

      const contents = await request(app.getHttpServer())
        .get(
          `/student/courses/${fixture.courseId}/chapters/${chapterId}/contents`,
        )
        .set(...studentAuth)
        .expect(200);
      expect(contents.body.contents[0].id).toBe(contentId);
      expect(contents.body.contents[0].is_completed).toBe(true);
    },
  );
});

/**
 * Regression coverage for the chapter drip-unlock schedule
 * (Course.chapterUnlockIntervalDays): a chapter must be BOTH past its
 * scheduled unlock date (enrolledAt + index*interval days) AND have its
 * predecessor completed — either condition alone is not enough. Covers the
 * shared computeChapterUnlockStates() and its three call sites
 * (listCourseChapters, getChapterContents, submitAssignment).
 */
describe('Student course chapters — drip-unlock schedule', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let adminAuth: [string, string];
  let chapterAId: string;
  let chapterBId: string;
  let assignmentId: string;
  let questionId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    adminAuth = authHeader(fixture.admin.token);

    // 7-day cadence, two chapters.
    await request(app.getHttpServer())
      .patch(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .send({
        chapter_unlock_interval_days: 7,
        chapters: [
          { name: 'QA Drip Chapter A', order_number: 1 },
          { name: 'QA Drip Chapter B', order_number: 2 },
        ],
      })
      .expect(200);

    const courseRes = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .expect(200);
    const course = courseRes.body?.data ?? courseRes.body;
    chapterAId = course.chapters.find(
      (c: { name: string }) => c.name === 'QA Drip Chapter A',
    ).id;
    chapterBId = course.chapters.find(
      (c: { name: string }) => c.name === 'QA Drip Chapter B',
    ).id;

    // Content in chapter A (for the completion gate), content + an
    // MCQ assignment in chapter B (for the submit-gating test).
    await request(app.getHttpServer())
      .patch(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .send({
        chapters: [
          { id: chapterAId, name: 'QA Drip Chapter A', order_number: 1 },
          { id: chapterBId, name: 'QA Drip Chapter B', order_number: 2 },
        ],
        chapter_contents: [
          {
            chapter_id: chapterAId,
            content_type: 'text',
            title: 'QA Drip Lesson A',
            content_text: 'Chapter A content',
            order_index: 1,
          },
        ],
        assignments: [
          {
            chapter_id: chapterBId,
            title: 'QA Drip Assignment B',
            questions: [
              {
                question_type: 'MCQ',
                question_text: '2 + 2 = ?',
                options: ['3', '4', '5'],
                correct_answer: '1',
                marks: 10,
              },
            ],
          },
        ],
      })
      .expect(200);

    const withContentRes = await request(app.getHttpServer())
      .get(`/admin/courses/${fixture.courseId}`)
      .set(...adminAuth)
      .expect(200);
    const withContent = withContentRes.body?.data ?? withContentRes.body;
    const assignment = withContent.assignments.find(
      (a: { chapter_id: string }) => a.chapter_id === chapterBId,
    );
    assignmentId = assignment.id;
    questionId = assignment.questions[0].id;
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it(
    'at enrollment, chapter A is unlocked and chapter B is locked with ' +
      "unlocks_in_days: 7, lock_reason: 'time'",
    async () => {
      const studentAuth = authHeader(fixture.students[0].token);
      const res = await request(app.getHttpServer())
        .get(`/student/courses/${fixture.courseId}/chapters`)
        .set(...studentAuth)
        .expect(200);
      const chapterA = res.body.chapters.find(
        (c: { id: string }) => c.id === chapterAId,
      );
      const chapterB = res.body.chapters.find(
        (c: { id: string }) => c.id === chapterBId,
      );
      expect(chapterA.is_unlocked).toBe(true);
      expect(chapterA.lock_reason).toBeNull();
      expect(chapterB.is_unlocked).toBe(false);
      expect(chapterB.unlocks_in_days).toBe(7);
      expect(chapterB.lock_reason).toBe('time');
    },
  );

  it(
    "completing chapter A within the 7-day window does NOT unlock chapter B " +
      "— still lock_reason: 'time' (proves AND, not OR)",
    async () => {
      const studentAuth = authHeader(fixture.students[0].token);
      await request(app.getHttpServer())
        .post('/student/save-chapter-progress')
        .set(...studentAuth)
        .send({ courseId: fixture.courseId, chapterId: chapterAId, completed: true })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/student/courses/${fixture.courseId}/chapters`)
        .set(...studentAuth)
        .expect(200);
      const chapterB = res.body.chapters.find(
        (c: { id: string }) => c.id === chapterBId,
      );
      expect(chapterB.is_unlocked).toBe(false);
      expect(chapterB.lock_reason).toBe('time');
    },
  );

  it('GET .../chapters/:chapterId/contents on a locked chapter returns 403', async () => {
    const studentAuth = authHeader(fixture.students[0].token);
    await request(app.getHttpServer())
      .get(`/student/courses/${fixture.courseId}/chapters/${chapterBId}/contents`)
      .set(...studentAuth)
      .expect(403);
  });

  it('submitting the locked chapter\'s assignment is rejected', async () => {
    const studentAuth = authHeader(fixture.students[0].token);
    const res = await request(app.getHttpServer())
      .post(`/student/assignments/${assignmentId}/submit`)
      .set(...studentAuth)
      .send({ answers: { [questionId]: '1' } });
    expect(res.status).toBe(400);
    const noAttempts = await pool.query(
      'SELECT COUNT(*)::int AS count FROM "AssignmentSubmission" WHERE "assignmentId" = $1 AND "studentId" = $2',
      [assignmentId, fixture.students[0].id],
    );
    expect(noAttempts.rows[0].count).toBe(0);
  });

  it(
    'once 7 days have elapsed AND chapter A is complete, chapter B unlocks ' +
      'and its assignment can be submitted',
    async () => {
      const studentAuth = authHeader(fixture.students[0].token);
      await pool.query(
        `UPDATE "StudentCourse" SET "enrolledAt" = "enrolledAt" - INTERVAL '8 days' WHERE "studentId" = $1 AND "courseId" = $2`,
        [fixture.students[0].id, fixture.courseId],
      );

      const res = await request(app.getHttpServer())
        .get(`/student/courses/${fixture.courseId}/chapters`)
        .set(...studentAuth)
        .expect(200);
      const chapterB = res.body.chapters.find(
        (c: { id: string }) => c.id === chapterBId,
      );
      expect(chapterB.is_unlocked).toBe(true);
      expect(chapterB.lock_reason).toBeNull();

      await request(app.getHttpServer())
        .get(`/student/courses/${fixture.courseId}/chapters/${chapterBId}/contents`)
        .set(...studentAuth)
        .expect(200);

      const submitRes = await request(app.getHttpServer())
        .post(`/student/assignments/${assignmentId}/submit`)
        .set(...studentAuth)
        .send({ answers: { [questionId]: '1' } })
        .expect(201);
      expect(submitRes.body.score).toBe(10);
    },
  );

  it(
    "for a DIFFERENT student, elapsed time alone does not unlock chapter B " +
      "if chapter A was never completed — lock_reason becomes 'sequential'",
    async () => {
      const studentAuth = authHeader(fixture.students[1].token);
      await pool.query(
        `UPDATE "StudentCourse" SET "enrolledAt" = "enrolledAt" - INTERVAL '8 days' WHERE "studentId" = $1 AND "courseId" = $2`,
        [fixture.students[1].id, fixture.courseId],
      );

      const res = await request(app.getHttpServer())
        .get(`/student/courses/${fixture.courseId}/chapters`)
        .set(...studentAuth)
        .expect(200);
      const chapterB = res.body.chapters.find(
        (c: { id: string }) => c.id === chapterBId,
      );
      expect(chapterB.is_unlocked).toBe(false);
      expect(chapterB.lock_reason).toBe('sequential');
    },
  );
});
