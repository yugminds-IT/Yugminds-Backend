import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin schedules CRUD + sync-to-teachers', () => {
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

  it('fixture-provisioned schedule is visible via GET /school-admin/schedules', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/schedules')
      .set(...auth)
      .expect(200);
    const found = res.body.schedules.find(
      (s: any) => s.id === fixture.scheduleId,
    );
    expect(found).toBeTruthy();
    expect(found.day_of_week).toBe('Monday');
    expect(Number(found.teacher_id)).toBe(fixture.teachers[0].id);
  });

  describe('full CRUD on a second schedule (different period/day to avoid conflicting with the fixture schedule)', () => {
    let periodId: string;
    let scheduleId: string;

    it('creates a second period for this CRUD test', async () => {
      const res = await request(app.getHttpServer())
        .post('/school-admin/periods')
        .set(...auth)
        .send({ period_number: 2, start_time: '10:00', end_time: '11:00' })
        .expect(201);
      periodId = res.body.period.id;
    });

    it('creates a schedule', async () => {
      const res = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: periodId,
          room_id: fixture.roomId,
          teacher_id: fixture.teachers[1].id,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Tuesday',
        })
        .expect(201);
      scheduleId = res.body.schedule.id;
      expect(scheduleId).toBeTruthy();
      expect(res.body.schedule.subject).toBe('Science');
      expect(res.body.schedule.day_of_week).toBe('Tuesday');
    });

    it('rejects a conflicting schedule (same teacher/day/period)', async () => {
      await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: periodId,
          teacher_id: fixture.teachers[1].id,
          grade: fixture.grade,
          subject: 'Math',
          day_of_week: 'Tuesday',
        })
        .expect(400);
    });

    it('gets the schedule by id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/school-admin/schedules/${scheduleId}`)
        .set(...auth)
        .expect(200);
      expect(res.body.schedule.id).toBe(scheduleId);
    });

    it('updates the schedule', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/school-admin/schedules/${scheduleId}`)
        .set(...auth)
        .send({ subject: 'Advanced Science' })
        .expect(200);
      expect(res.body.schedule.subject).toBe('Advanced Science');
    });

    it('deletes the schedule', async () => {
      await request(app.getHttpServer())
        .delete(`/school-admin/schedules/${scheduleId}`)
        .set(...auth)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/school-admin/schedules/${scheduleId}`)
        .set(...auth)
        .expect(400);
    });

    afterAll(async () => {
      await request(app.getHttpServer())
        .delete(`/school-admin/periods/${periodId}`)
        .set(...auth)
        .catch(() => undefined);
    });
  });

  it('sync-to-teachers: notifies the target teacher, who receives it on their own notifications endpoint', async () => {
    const teacherAuth: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[0].token}`,
    ];

    const syncRes = await request(app.getHttpServer())
      .post('/school-admin/schedules/sync-to-teachers')
      .set(...auth)
      .send({ teacherIds: [String(fixture.teachers[0].id)] })
      .expect(201);
    expect(syncRes.body.success).toBe(true);
    expect(syncRes.body.synced).toBeGreaterThanOrEqual(1);

    const notifRes = await request(app.getHttpServer())
      .get('/notifications/user')
      .set(...teacherAuth)
      .expect(200);
    const found = notifRes.body.notifications.find(
      (n: any) => n.title === 'Your Updated Schedule',
    );
    expect(found).toBeTruthy();
    expect(String(found.message)).toContain('Monday');
  });

  it('cross-user check: the fixture teacher sees the synced schedule via their own GET /teacher/schedules', async () => {
    const teacherAuth: [string, string] = [
      'Authorization',
      `Bearer ${fixture.teachers[0].token}`,
    ];
    const res = await request(app.getHttpServer())
      .get('/teacher/schedules')
      .set(...teacherAuth)
      .query({ school_id: fixture.schoolId })
      .expect(200);
    const found = res.body.schedules.find(
      (s: any) => s.id === fixture.scheduleId,
    );
    expect(found).toBeTruthy();
  });
});
