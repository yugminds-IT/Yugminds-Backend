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
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
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
