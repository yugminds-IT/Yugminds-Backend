import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool, pool } from '../admin/support/db';

describe('school-admin teachers list + leaves', () => {
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

  it('GET /school-admin/teachers lists the 2 fixture teachers', async () => {
    const res = await request(app.getHttpServer())
      .get('/school-admin/teachers')
      .set(...auth)
      .expect(200);
    expect(Array.isArray(res.body.teachers)).toBe(true);
    const ids = res.body.teachers.map((t: any) => Number(t.id));
    expect(ids).toEqual(
      expect.arrayContaining(fixture.teachers.map((t) => t.id)),
    );
    const fixtureTeacherRows = res.body.teachers.filter((t: any) =>
      fixture.teachers.some((f) => f.id === Number(t.id)),
    );
    expect(fixtureTeacherRows).toHaveLength(2);
    for (const row of fixtureTeacherRows) {
      expect(row.status).toBe('Active');
    }
  });

  describe('leave request lifecycle', () => {
    // Only SchoolAdminExtraController handles /school-admin/leaves* now — a
    // second controller (SchoolAdminLeavesController) used to register the
    // exact same routes on the same @Controller('school-admin') prefix, so
    // Nest/Express silently dispatched every request to whichever was
    // registered first and the other's service (with its own, different
    // approve/reject logic) never ran in production. It's been deleted.
    let approveLeaveId: string;
    let rejectLeaveId: string;

    // Distinct, non-overlapping date ranges — the teacher-side leave
    // creation endpoint rejects a new request that overlaps an
    // already-pending/approved one for the same teacher+school.
    const APPROVE_RANGE = { start: '2026-08-03', end: '2026-08-04' };
    const REJECT_RANGE = { start: '2026-08-10', end: '2026-08-11' };

    async function createLeave(range: {
      start: string;
      end: string;
    }): Promise<string> {
      const teacherAuth: [string, string] = [
        'Authorization',
        `Bearer ${fixture.teachers[0].token}`,
      ];
      const res = await request(app.getHttpServer())
        .post('/teacher/leaves')
        .set(...teacherAuth)
        .send({
          school_id: fixture.schoolId,
          start_date: range.start,
          end_date: range.end,
          reason: 'QA test leave',
          substitute_required: true,
        })
        .expect(201);
      const id = res.body?.id ?? res.body?.leave?.id ?? res.body?.data?.id;
      expect(id).toBeTruthy();
      return id;
    }

    it('teacher creates a leave request, school-admin sees it pending', async () => {
      approveLeaveId = await createLeave(APPROVE_RANGE);
      const res = await request(app.getHttpServer())
        .get('/school-admin/leaves')
        .set(...auth)
        .expect(200);
      const found = res.body.leaves.find((l: any) => l.id === approveLeaveId);
      expect(found).toBeTruthy();
      expect(found.status).toBe('Pending');
    });

    it('approving records the approver identity and marks Attendance Leave-Approved', async () => {
      await request(app.getHttpServer())
        .patch(`/school-admin/leaves/${approveLeaveId}`)
        .set(...auth)
        .send({ action: 'approve' })
        .expect(200);

      const getRes = await request(app.getHttpServer())
        .get(`/school-admin/leaves/${approveLeaveId}`)
        .set(...auth)
        .expect(200);
      expect(['Approved', 'approved']).toContain(getRes.body.leave.status);

      const listRes = await request(app.getHttpServer())
        .get('/school-admin/leaves')
        .set(...auth)
        .expect(200);
      const found = listRes.body.leaves.find(
        (l: any) => l.id === approveLeaveId,
      );
      expect(found.approver?.full_name).toBeTruthy();

      const { rows } = await pool.query(
        `SELECT status FROM "Attendance" WHERE "teacherId" = $1 AND "schoolId" = $2 AND date BETWEEN $3 AND $4`,
        [fixture.teachers[0].id, fixture.schoolId, APPROVE_RANGE.start, APPROVE_RANGE.end],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { status: string }) => r.status === 'Leave-Approved')).toBe(true);
    });

    it('rejecting records the rejecter identity (not discarded) and reverts Leave-Approved days back to Unreported', async () => {
      rejectLeaveId = await createLeave(REJECT_RANGE);
      // Approve first so there are real Leave-Approved Attendance rows to revert.
      await request(app.getHttpServer())
        .patch(`/school-admin/leaves/${rejectLeaveId}`)
        .set(...auth)
        .send({ action: 'approve' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/school-admin/leaves/${rejectLeaveId}`)
        .set(...auth)
        .send({ action: 'reject', admin_remarks: 'QA reject test' })
        .expect(200);

      const listRes = await request(app.getHttpServer())
        .get('/school-admin/leaves')
        .set(...auth)
        .expect(200);
      const found = listRes.body.leaves.find(
        (l: any) => l.id === rejectLeaveId,
      );
      expect(found.status).toBe('Rejected');
      // Previously nulled out on reject — "Reviewed by" always showed N/A.
      expect(found.reviewer?.full_name).toBeTruthy();
      expect(found.approved_by).toBeTruthy();

      const { rows } = await pool.query(
        `SELECT status FROM "Attendance" WHERE "teacherId" = $1 AND "schoolId" = $2 AND date BETWEEN $3 AND $4`,
        [fixture.teachers[0].id, fixture.schoolId, REJECT_RANGE.start, REJECT_RANGE.end],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { status: string }) => r.status === 'Unreported')).toBe(true);
    });

    it(
      'rejects a PATCH with a missing/invalid action instead of silently no-op\'ing ' +
        '(regression: this used to fall back to the leave\'s current status and return 200 ' +
        'OK with no actual change, unlike the equivalent admin endpoint which already threw)',
      async () => {
        const thirdLeaveId = await createLeave({ start: '2026-08-17', end: '2026-08-18' });

        const missingBody = await request(app.getHttpServer())
          .patch(`/school-admin/leaves/${thirdLeaveId}`)
          .set(...auth)
          .send({})
          .expect(400);
        expect(missingBody.body.message).toBeTruthy();

        const invalidAction = await request(app.getHttpServer())
          .patch(`/school-admin/leaves/${thirdLeaveId}`)
          .set(...auth)
          .send({ action: 'not-a-real-action' })
          .expect(400);
        expect(invalidAction.body.message).toBeTruthy();

        // Confirm it's genuinely untouched — still Pending, not silently
        // re-written to itself.
        const getRes = await request(app.getHttpServer())
          .get(`/school-admin/leaves/${thirdLeaveId}`)
          .set(...auth)
          .expect(200);
        expect(['Pending', 'pending']).toContain(getRes.body.leave.status);
      },
    );
  });
});
