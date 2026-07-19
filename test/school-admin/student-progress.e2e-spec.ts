import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin student-progress', () => {
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

  it('returns the fixture students with the expected summary shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .expect(200);
    expect(Array.isArray(res.body.students)).toBe(true);
    expect(res.body.summary).toEqual(
      expect.objectContaining({
        total_students: expect.any(Number),
        students_with_progress: expect.any(Number),
        students_completed: expect.any(Number),
        average_system_progress: expect.any(Number),
        total_courses: expect.any(Number),
      }),
    );
    expect(res.body.summary.total_students).toBe(3);
    const ids = res.body.students.map((s: any) => Number(s.student_id));
    expect(ids).toEqual(
      expect.arrayContaining(fixture.students.map((s) => s.id)),
    );
  });

  it('filters by grade/section', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .query({ grade: fixture.grade, section: fixture.section })
      .expect(200);
    expect(res.body.summary.total_students).toBe(3);
  });

  it('filters by an unmatched grade -> zero students', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .query({ grade: 'Nonexistent Grade XYZ' })
      .expect(200);
    expect(res.body.summary.total_students).toBe(0);
    expect(res.body.students).toEqual([]);
  });

  it('filters by student_id', async () => {
    const target = fixture.students[0];
    const res = await request(app.getHttpServer())
      .get('/school-admin/student-progress')
      .set(...auth)
      .query({ student_id: String(target.id) })
      .expect(200);
    expect(res.body.students).toHaveLength(1);
    expect(Number(res.body.students[0].student_id)).toBe(target.id);
  });
});
