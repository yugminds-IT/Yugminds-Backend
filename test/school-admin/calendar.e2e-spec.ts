import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin calendar CRUD', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app, { withScheduling: true });
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('the fixture-provisioned calendar entry is visible via GET', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/calendar')
      .set(...auth)
      .expect(200);
    const found = res.body.calendar.find(
      (c: any) => c.id === fixture.calendarId,
    );
    expect(found).toBeTruthy();
    expect(found.type).toBe('Holiday');
  });

  it('year/month filters narrow results', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/calendar')
      .set(...auth)
      .query({ year: '2026', month: '8' })
      .expect(200);
    expect(res.body.calendar.some((c: any) => c.id === fixture.calendarId)).toBe(
      true,
    );
    const resOtherMonth = await request(app.getHttpServer())
      .get('/school-admin/calendar')
      .set(...auth)
      .query({ year: '2026', month: '1' })
      .expect(200);
    expect(
      resOtherMonth.body.calendar.some((c: any) => c.id === fixture.calendarId),
    ).toBe(false);
  });

  let createdId: string;

  it('creates a new calendar entry', async () => {
    const res = await request(app.getHttpServer())
      .post('/school-admin/calendar')
      .set(...auth)
      .send({
        date: '2026-09-01',
        end_date: '2026-09-03',
        name: 'QA Autumn Break',
        type: 'Break',
        academic_year: '2026-27',
        description: 'QA test entry',
      })
      .expect(201);
    createdId = res.body.entry.id;
    expect(createdId).toBeTruthy();
    expect(res.body.entry.type).toBe('Break');
    expect(res.body.entry.end_date).toBe('2026-09-03');
  });

  it('rejects an invalid type', async () => {
    await request(app.getHttpServer())
      .post('/school-admin/calendar')
      .set(...auth)
      .send({ date: '2026-09-05', name: 'Bad Type', type: 'NotARealType' })
      .expect(400);
  });

  it('rejects end_date before date', async () => {
    await request(app.getHttpServer())
      .post('/school-admin/calendar')
      .set(...auth)
      .send({
        date: '2026-09-10',
        end_date: '2026-09-01',
        name: 'Bad Range',
        type: 'Holiday',
      })
      .expect(400);
  });

  it('updates the entry', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/school-admin/calendar/${createdId}`)
      .set(...auth)
      .send({ name: 'QA Autumn Break Renamed' })
      .expect(200);
    expect(res.body.entry.name).toBe('QA Autumn Break Renamed');
  });

  it('deletes (soft) the entry, no longer listed', async () => {
    await request(app.getHttpServer())
      .delete(`/school-admin/calendar/${createdId}`)
      .set(...auth)
      .expect(200);
    const res = await request(app.getHttpServer())
      .get('/school-admin/calendar')
      .set(...auth)
      .expect(200);
    expect(res.body.calendar.some((c: any) => c.id === createdId)).toBe(false);
  });
});
