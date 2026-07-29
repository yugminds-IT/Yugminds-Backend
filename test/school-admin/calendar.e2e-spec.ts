import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

/**
 * School-admin calendar write access was moved out entirely — only the
 * platform admin can declare a holiday/break now (see
 * AdminCalendarService's class doc, "project history 2026-07-25"). This
 * file used to exercise `/school-admin/calendar` CRUD directly, which no
 * longer exists at all (every case 404s). Rewritten to: (a) confirm that
 * old route family is genuinely gone for a school admin, and (b) exercise
 * the equivalent CRUD that now actually lives at `/admin/calendar`, so this
 * functionality keeps real test coverage instead of silently losing it.
 */
describe('calendar CRUD (moved to admin-only)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let schoolAdminAuth: [string, string];
  let adminAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app, { withScheduling: true });
    schoolAdminAuth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
    adminAuth = ['Authorization', `Bearer ${fixture.admin.token}`];
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('school admins no longer have any /school-admin/calendar route', async () => {
    await request(app.getHttpServer())
      .get('/school-admin/calendar')
      .set(...schoolAdminAuth)
      .expect(404);
    await request(app.getHttpServer())
      .post('/school-admin/calendar')
      .set(...schoolAdminAuth)
      .send({ date: '2026-09-01', name: 'x', type: 'Holiday' })
      .expect(404);
  });

  it('the fixture-provisioned calendar entry is visible via GET /admin/calendar', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/calendar')
      .set(...adminAuth)
      .query({ school_id: fixture.schoolId })
      .expect(200);
    const found = res.body.calendar.find(
      (c: any) => c.id === fixture.calendarId,
    );
    expect(found).toBeTruthy();
    expect(found.type).toBe('Holiday');
  });

  it('year/month filters narrow results', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/calendar')
      .set(...adminAuth)
      .query({ school_id: fixture.schoolId, year: '2026', month: '8' })
      .expect(200);
    expect(res.body.calendar.some((c: any) => c.id === fixture.calendarId)).toBe(
      true,
    );
    const resOtherMonth = await request(app.getHttpServer())
      .get('/admin/calendar')
      .set(...adminAuth)
      .query({ school_id: fixture.schoolId, year: '2026', month: '1' })
      .expect(200);
    expect(
      resOtherMonth.body.calendar.some((c: any) => c.id === fixture.calendarId),
    ).toBe(false);
  });

  let createdId: string;

  it('creates a new calendar entry', async () => {
    // 2026-09-01..03 is Tue-Thu — within the fixture teachers' default
    // Mon-Fri working days, so the "is anyone actually scheduled" guard
    // in AdminCalendarService.create() doesn't reject it.
    const res = await request(app.getHttpServer())
      .post('/admin/calendar')
      .set(...adminAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-09-01',
        end_date: '2026-09-03',
        name: 'QA Autumn Break',
        type: 'Break',
        academic_year: '2026-27',
        description: 'QA test entry',
      })
      .expect(201);
    createdId = res.body.calendar?.[0]?.id;
    expect(createdId).toBeTruthy();
    expect(res.body.calendar[0].type).toBe('Break');
    expect(res.body.calendar[0].end_date).toBe('2026-09-03');
  });

  it('rejects an invalid type', async () => {
    await request(app.getHttpServer())
      .post('/admin/calendar')
      .set(...adminAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-09-05',
        name: 'Bad Type',
        type: 'NotARealType',
      })
      .expect(400);
  });

  it('rejects end_date before date', async () => {
    await request(app.getHttpServer())
      .post('/admin/calendar')
      .set(...adminAuth)
      .send({
        school_id: fixture.schoolId,
        date: '2026-09-10',
        end_date: '2026-09-01',
        name: 'Bad Range',
        type: 'Holiday',
      })
      .expect(400);
  });

  it('updates the entry', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/calendar/${createdId}`)
      .set(...adminAuth)
      .send({ name: 'QA Autumn Break Renamed' })
      .expect(200);
    const updated = res.body.entry ?? res.body;
    expect(updated.name).toBe('QA Autumn Break Renamed');
  });

  it('deletes the entry, no longer listed', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/calendar/${createdId}`)
      .set(...adminAuth)
      .expect(200);
    const res = await request(app.getHttpServer())
      .get('/admin/calendar')
      .set(...adminAuth)
      .query({ school_id: fixture.schoolId })
      .expect(200);
    expect(res.body.calendar.some((c: any) => c.id === createdId)).toBe(false);
  });
});
