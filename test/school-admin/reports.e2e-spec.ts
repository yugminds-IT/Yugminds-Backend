import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin reports (single + bulk, route-ordering regression guard)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];
  let reportIdA: string;
  let reportIdB: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app, { withScheduling: true });
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];

    const teacherAuthA: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[0].token}`,
    ];
    const teacherAuthB: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[1].token}`,
    ];
    const resA = await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuthA)
      .send({
        school_id: fixture.schoolId,
        grade: fixture.grade,
        date: '2026-07-01',
        period_id: fixture.periodId,
        topics_taught: 'QA Topic A',
      })
      .expect(201);
    reportIdA = resA.body?.id ?? resA.body?.report?.id ?? resA.body?.data?.id;

    const resB = await request(app.getHttpServer())
      .post('/teacher/reports')
      .set(...teacherAuthB)
      .send({
        school_id: fixture.schoolId,
        grade: fixture.grade,
        date: '2026-07-02',
        period_id: fixture.periodId,
        topics_taught: 'QA Topic B',
      })
      .expect(201);
    reportIdB = resB.body?.id ?? resB.body?.report?.id ?? resB.body?.data?.id;

    expect(reportIdA).toBeTruthy();
    expect(reportIdB).toBeTruthy();
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /school-admin/reports lists both reports as Pending', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/reports')
      .set(...auth)
      .query({ limit: 500 })
      .expect(200);
    const ids = res.body.reports.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([reportIdA, reportIdB]));
    const a = res.body.reports.find((r: any) => r.id === reportIdA);
    expect(a.status).toBe('Pending');
  });

  it('GET /school-admin/reports/:id returns a single report', async () => {
    const res = await request(app.getHttpServer())
      .get(`/school-admin/reports/${reportIdA}`)
      .set(...auth)
      .expect(200);
    expect(res.body.report.id).toBe(reportIdA);
    expect(res.body.report.topics_taught).toBe('QA Topic A');
  });

  it(
    'PATCH /school-admin/reports/bulk is NOT shadowed by the :id route ' +
      '(regression guard — previously "bulk" was parsed as an :id and 400\'d)',
    async () => {
      const res = await request(app.getHttpServer())
        .patch('/school-admin/reports/bulk')
        .set(...auth)
        .send({ report_ids: [reportIdA, reportIdB], action: 'approve' })
        .expect(200);
      expect(res.body.approved).toBe(2);
    },
  );

  it('bulk update took effect on both reports', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/reports')
      .set(...auth)
      .query({ limit: 500 })
      .expect(200);
    const a = res.body.reports.find((r: any) => r.id === reportIdA);
    const b = res.body.reports.find((r: any) => r.id === reportIdB);
    expect(a.status).toBe('Approved');
    expect(b.status).toBe('Approved');
  });

  it('PATCH /school-admin/reports/:id (single) can reject one report', async () => {
    await request(app.getHttpServer())
      .patch(`/school-admin/reports/${reportIdB}`)
      .set(...auth)
      .send({ action: 'reject' })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/school-admin/reports/${reportIdB}`)
      .set(...auth)
      .expect(200);
    expect(res.body.report.status).toBe('rejected');
  });
});
