import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool, pool } from './support/db';

describe('Admin leave approval -> teacher attendance mutation (cross-role side effect)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let leaveId: string;
  const startDate = '2026-08-10';
  const endDate = '2026-08-11';

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('teacher creates a leave request', async () => {
    const res = await request(app.getHttpServer())
      .post('/teacher/leaves')
      .set(...authHeader(fixture.teachers[0].token))
      .send({
        school_id: fixture.schoolId,
        start_date: startDate,
        end_date: endDate,
        reason: 'QA test leave',
      })
      .expect(201);
    leaveId = res.body?.id ?? res.body?.leave?.id ?? res.body?.data?.id;
    expect(leaveId).toBeDefined();
  });

  it('GET /admin/leaves lists the pending request', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/leaves?school_id=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const leaves = Array.isArray(list) ? list : (list?.leaves ?? []);
    expect(leaves.some((l: { id: string }) => l.id === leaveId)).toBe(true);
  });

  it('admin approves the leave -> teacher Attendance rows flip to Leave-Approved', async () => {
    await request(app.getHttpServer())
      .put('/admin/leaves')
      .set(...authHeader(fixture.admin.token))
      .send({ id: leaveId, status: 'Approved' })
      .expect(200);

    const { rows } = await pool.query(
      `SELECT date, status FROM "Attendance"
         WHERE "teacherId" = $1 AND "schoolId" = $2
           AND date >= $3::date AND date <= $4::date`,
      [fixture.teachers[0].id, fixture.schoolId, startDate, endDate],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'Leave-Approved')).toBe(true);
  });

  it(
    'GET /admin/leaves returns real approved_at + a resolved reviewer identity for the just-approved leave ' +
      '(regression: approved_at/rejected_at were declared on the frontend but never sent by this endpoint)',
    async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/leaves?school_id=${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      const list = res.body?.data ?? res.body;
      const leaves = Array.isArray(list) ? list : (list?.leaves ?? []);
      const leave = leaves.find((l: { id: string }) => l.id === leaveId);
      expect(leave).toBeDefined();
      expect(leave.status).toBe('Approved');
      expect(leave.approved_at).toBeTruthy();
      expect(leave.reviewer?.id).toBe(String(fixture.admin.id));
    },
  );

  it(
    "the school admin dashboard resolves the SAME admin-approved leave's reviewer name correctly " +
      '(regression: admin used to store approvedBy as an email; school-admin\'s reviewer lookup does ' +
      "parseInt(approvedBy, 10) to find the user, so an admin-approved leave always showed " +
      '"Reviewed by: N/A" on the School Admin dashboard even though the school-admin frontend tries to ' +
      'render approver.full_name)',
    async () => {
      const schoolAdminAuth = authHeader(fixture.schoolAdmin.token);
      const res = await request(app.getHttpServer())
        .get('/school-admin/leaves')
        .set(...schoolAdminAuth)
        .expect(200);
      const leave = res.body.leaves.find((l: { id: string }) => l.id === leaveId);
      expect(leave).toBeDefined();
      expect(leave.status).toBe('Approved');
      expect(leave.approver).not.toBeNull();
      expect(leave.approver?.id).toBe(String(fixture.admin.id));
      expect(leave.approver?.full_name).toBeTruthy();
    },
  );
});
