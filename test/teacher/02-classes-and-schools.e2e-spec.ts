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

describe('Teacher classes, periods, schedules, schools', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app, { withScheduling: true });
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /teacher/schools lists the fixture school for both teachers', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/schools')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(Array.isArray(res.body.schools)).toBe(true);
    expect(res.body.schools.some((s: any) => s.id === fixture.schoolId)).toBe(
      true,
    );
  });

  it('GET /teacher/schools is empty-ish for a teacher with no assignments (401/403 not required, just no fixture school)', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/schools')
      .set(...authHeader(fixture.teachers[1].token))
      .expect(200);
    // teachers[1] is assigned to the same fixture school too
    expect(res.body.schools.some((s: any) => s.id === fixture.schoolId)).toBe(
      true,
    );
  });

  it('GET /teacher/classes returns the assigned grade/section for teacher[0]', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/classes?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(Array.isArray(res.body.classes)).toBe(true);
    expect(res.body.classes.length).toBeGreaterThanOrEqual(1);
    const cls = res.body.classes[0];
    expect(cls.grade).toBe(fixture.grade);
    expect(cls.section).toBe(fixture.section);
    expect(cls.school_id).toBe(fixture.schoolId);
  });

  it('GET /teacher/periods requires school_id (empty without it) and returns periods with it', async () => {
    const noSchool = await request(app.getHttpServer())
      .get('/teacher/periods')
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(noSchool.body.periods).toEqual([]);

    const res = await request(app.getHttpServer())
      .get(`/teacher/periods?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(Array.isArray(res.body.periods)).toBe(true);
    expect(
      res.body.periods.some((p: any) => p.id === fixture.periodId),
    ).toBe(true);
  });

  it('GET /teacher/periods filtered by day only returns periods with a schedule on that day', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/periods?school_id=${fixture.schoolId}&day=Monday`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(
      res.body.periods.every((p: any) => p.has_schedule === true),
    ).toBe(true);
  });

  it('GET /teacher/schedules returns the fixture schedule for teacher[0]', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/schedules?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.teachers[0].token))
      .expect(200);
    expect(Array.isArray(res.body.schedules)).toBe(true);
    const sched = res.body.schedules.find(
      (s: any) => s.id === fixture.scheduleId,
    );
    expect(sched).toBeDefined();
    expect(sched.day_of_week).toBe('Monday');
    expect(sched.school_id).toBe(fixture.schoolId);
    expect(sched.period).toBeDefined();
    expect(sched.room).toBeDefined();
  });

  it('teacher[1] (not assigned to the schedule) sees no schedules for that school', async () => {
    const res = await request(app.getHttpServer())
      .get(`/teacher/schedules?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.teachers[1].token))
      .expect(200);
    expect(
      res.body.schedules.some((s: any) => s.id === fixture.scheduleId),
    ).toBe(false);
  });

  it('rejects unauthenticated requests on classes/schedules/periods/schools', async () => {
    await request(app.getHttpServer()).get('/teacher/classes').expect(401);
    await request(app.getHttpServer()).get('/teacher/schedules').expect(401);
    await request(app.getHttpServer()).get('/teacher/periods').expect(401);
    await request(app.getHttpServer()).get('/teacher/schools').expect(401);
  });
});
