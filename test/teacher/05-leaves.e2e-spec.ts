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

describe('Teacher leaves', () => {
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

  it('creates and lists a leave request', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/teacher/leaves')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        start_date: '2026-03-02',
        end_date: '2026-03-03',
        reason: 'Personal',
        substitute_required: true,
      })
      .expect(201);
    expect(createRes.body.leave.status).toBe('pending');
    expect(createRes.body.leave.substitute_required).toBe(true);

    const listRes = await request(app.getHttpServer())
      .get(`/teacher/leaves?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(
      listRes.body.leaves.some((l: any) => l.id === createRes.body.leave.id),
    ).toBe(true);
  });

  it('rejects a leave request missing required fields', async () => {
    await request(app.getHttpServer())
      .post('/teacher/leaves')
      .set(...teacherAuth)
      .send({ school_id: fixture.schoolId, start_date: '2026-03-05' })
      .expect(400);
  });

  it('rejects an overlapping leave request for the same teacher+school', async () => {
    await request(app.getHttpServer())
      .post('/teacher/leaves')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        start_date: '2026-04-10',
        end_date: '2026-04-12',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/teacher/leaves')
      .set(...teacherAuth)
      .send({
        school_id: fixture.schoolId,
        start_date: '2026-04-11',
        end_date: '2026-04-13',
      })
      .expect(400);
  });

  it("a second teacher's leaves are not visible in the first teacher's list", async () => {
    const otherAuth = authHeader(fixture.teachers[1].token);
    const otherLeave = await request(app.getHttpServer())
      .post('/teacher/leaves')
      .set(...otherAuth)
      .send({
        school_id: fixture.schoolId,
        start_date: '2026-05-01',
        end_date: '2026-05-01',
      })
      .expect(201);

    const teacher0List = await request(app.getHttpServer())
      .get(`/teacher/leaves?school_id=${fixture.schoolId}`)
      .set(...teacherAuth)
      .expect(200);
    expect(
      teacher0List.body.leaves.some(
        (l: any) => l.id === otherLeave.body.leave.id,
      ),
    ).toBe(false);
  });

  it('rejects unauthenticated and non-teacher access', async () => {
    await request(app.getHttpServer()).get('/teacher/leaves').expect(401);
    const res = await request(app.getHttpServer())
      .get('/teacher/leaves')
      .set(...authHeader(fixture.students[0].token));
    expect([401, 403]).toContain(res.status);
  });
});
