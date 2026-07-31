import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';
import { authHeader } from '../admin/support/auth';

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

  describe('assertTeacherSchedulable — assigned-school/working-day/date-range enforcement', () => {
    let adminAuth: [string, string];
    let extraPeriodId: string;

    beforeAll(async () => {
      adminAuth = authHeader(fixture.admin.token);
      const res = await request(app.getHttpServer())
        .post('/school-admin/periods')
        .set(...auth)
        .send({ period_number: 3, start_time: '12:00', end_time: '13:00' })
        .expect(201);
      extraPeriodId = res.body.period.id;
    });

    afterAll(async () => {
      await request(app.getHttpServer())
        .delete(`/school-admin/periods/${extraPeriodId}`)
        .set(...auth)
        .catch(() => undefined);
    });

    it('rejects a teacher who has no TeacherSchool row at this school at all', async () => {
      const res = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: extraPeriodId,
          teacher_id: 999999999,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Wednesday',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not assigned to your school/i);
    });

    it("rejects scheduling on a day outside the teacher's working days (fixture default is Mon-Fri, no weekend)", async () => {
      const res = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: extraPeriodId,
          teacher_id: fixture.teachers[1].id,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Saturday',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/doesn't work at your school on Saturdays/i);
    });

    it("rejects scheduling before the teacher's assignedFrom date, and allows it again once cleared", async () => {
      const detail = await request(app.getHttpServer())
        .get(`/admin/teachers/${fixture.teachers[1].id}`)
        .set(...adminAuth)
        .expect(200);
      const school = detail.body.assignedSchools.find(
        (s: any) => s.schoolId === fixture.schoolId,
      );
      expect(school).toBeTruthy();

      const baseAssignment = {
        school_id: fixture.schoolId,
        grade_sections_assigned: school.gradesAssigned.map((g: any) => ({
          grade: g.gradeName,
          sections: g.sectionsAssigned,
        })),
        subjects: school.subjects,
        working_days: school.workingDays,
      };

      // A future assignedFrom — the teacher isn't "there yet" per the admin's
      // own assignment dates.
      await request(app.getHttpServer())
        .put(`/admin/teachers/${fixture.teachers[1].id}`)
        .set(...adminAuth)
        .send({
          school_assignments: [{ ...baseAssignment, assigned_from: '2099-01-01' }],
        })
        .expect(200);

      const blocked = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: extraPeriodId,
          teacher_id: fixture.teachers[1].id,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Wednesday',
        });
      expect(blocked.status).toBe(400);
      expect(blocked.body.message).toMatch(/assignment to your school starts on 2099-01-01/i);

      // Clear the restriction (both null = no restriction) and confirm
      // scheduling now succeeds.
      await request(app.getHttpServer())
        .put(`/admin/teachers/${fixture.teachers[1].id}`)
        .set(...adminAuth)
        .send({ school_assignments: [{ ...baseAssignment }] })
        .expect(200);

      const allowed = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: extraPeriodId,
          teacher_id: fixture.teachers[1].id,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Wednesday',
        });
      expect(allowed.status).toBe(201);

      // Cleanup: remove the schedule this test just created.
      await request(app.getHttpServer())
        .delete(`/school-admin/schedules/${allowed.body.schedule.id}`)
        .set(...auth)
        .catch(() => undefined);
    });
  });

  describe('assertSchoolOperatesOnDay — school-wide constraint, independent of teacher', () => {
    let adminAuth: [string, string];
    let extraPeriodId: string;

    beforeAll(async () => {
      adminAuth = authHeader(fixture.admin.token);
      const res = await request(app.getHttpServer())
        .post('/school-admin/periods')
        .set(...auth)
        .send({ period_number: 4, start_time: '14:00', end_time: '15:00' })
        .expect(201);
      extraPeriodId = res.body.period.id;
    });

    afterAll(async () => {
      // Restore the fixture school's default Mon-Sat operating days so
      // other describe blocks in this file aren't affected by ordering.
      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...adminAuth)
        .send({ id: fixture.schoolId, operating_days: [1, 2, 3, 4, 5, 6] })
        .catch(() => undefined);
      await request(app.getHttpServer())
        .delete(`/school-admin/periods/${extraPeriodId}`)
        .set(...auth)
        .catch(() => undefined);
    });

    it('rejects a schedule on a day the school does not operate, even with no teacher assigned', async () => {
      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...adminAuth)
        .send({ id: fixture.schoolId, operating_days: [1, 2, 3, 4, 5] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: extraPeriodId,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Saturday',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/doesn't operate on Saturdays/i);
    });

    it('rejects the same request even when a valid teacher is assigned (school-level check runs unconditionally)', async () => {
      const res = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: extraPeriodId,
          teacher_id: fixture.teachers[1].id,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Saturday',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/doesn't operate on Saturdays/i);
    });

    it('allows scheduling again once the school operating days are widened back to include Saturday', async () => {
      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...adminAuth)
        .send({ id: fixture.schoolId, operating_days: [1, 2, 3, 4, 5, 6] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/school-admin/schedules')
        .set(...auth)
        .send({
          period_id: extraPeriodId,
          grade: fixture.grade,
          subject: 'Science',
          day_of_week: 'Saturday',
        });
      expect(res.status).toBe(201);

      await request(app.getHttpServer())
        .delete(`/school-admin/schedules/${res.body.schedule.id}`)
        .set(...auth)
        .catch(() => undefined);
    });
  });
});
