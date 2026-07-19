import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

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

  describe('leave request lifecycle + duplicate-route empirical check', () => {
    let leaveId: string;

    it('teacher creates a leave request', async () => {
      const teacherAuth: [string, string] = [
        'Authorization',
        `Bearer ${fixture.teachers[0].token}`,
      ];
      const res = await request(app.getHttpServer())
        .post('/teacher/leaves')
        .set(...teacherAuth)
        .send({
          school_id: fixture.schoolId,
          start_date: '2026-08-03',
          end_date: '2026-08-04',
          reason: 'QA test leave',
          substitute_required: true,
        })
        .expect(201);
      leaveId =
        res.body?.id ?? res.body?.leave?.id ?? res.body?.data?.id;
      expect(leaveId).toBeTruthy();
    });

    it('school-admin sees the pending leave via GET /school-admin/leaves', async () => {
      const res = await request(app.getHttpServer())
        .get('/school-admin/leaves')
        .set(...auth)
        .expect(200);
      const found = res.body.leaves.find((l: any) => l.id === leaveId);
      expect(found).toBeTruthy();
      expect(found.status).toBe('Pending');
    });

    it(
      'PATCH /school-admin/leaves/:id approve — empirically reports which ' +
        'of the two duplicate-route controllers (SchoolAdminExtraController ' +
        'vs SchoolAdminLeavesController) actually handles the request',
      async () => {
        const res = await request(app.getHttpServer())
          .patch(`/school-admin/leaves/${leaveId}`)
          .set(...auth)
          .send({ action: 'approve' })
          .expect(200);

        // SchoolAdminExtraController.updateLeave returns `{ success: true }`
        // (no `leave` object). SchoolAdminLeavesService.update returns
        // `{ leave: { id, status, admin_remarks } }`. Whichever shape shows up
        // here is empirically the one Nest's router dispatched to — both
        // controllers register `@Patch('leaves/:id')` on `@Controller
        // ('school-admin')`, so this is a real duplicate-route situation
        // (see src/school-admin/school-admin.module.ts controllers order and
        // memory: project_school_admin_dashboard_bugs.md).
        // eslint-disable-next-line no-console
        console.log(
          '[duplicate-route check] PATCH /school-admin/leaves/:id response:',
          JSON.stringify(res.body),
        );
        if (res.body.leave) {
          // eslint-disable-next-line no-console
          console.log(
            '[duplicate-route check] WINNER: SchoolAdminLeavesController (leaves.controller.ts)',
          );
        } else if (res.body.success === true) {
          // eslint-disable-next-line no-console
          console.log(
            '[duplicate-route check] WINNER: SchoolAdminExtraController (school-admin-extra.controller.ts)',
          );
        }
        expect(res.body).toBeTruthy();
      },
    );

    it('the update took effect — GET shows Approved', async () => {
      const res = await request(app.getHttpServer())
        .get(`/school-admin/leaves/${leaveId}`)
        .set(...auth)
        .expect(200);
      const status = res.body.leave.status;
      expect(['Approved', 'approved']).toContain(status);
    });

    it(
      'GET /school-admin/leaves list item shape reveals which controller ' +
        'implementation answers GET too (extra controller includes ' +
        '`substitute_required` + `approver`; leaves.controller.ts does not)',
      async () => {
        const res = await request(app.getHttpServer())
          .get('/school-admin/leaves')
          .set(...auth)
          .expect(200);
        const found = res.body.leaves.find((l: any) => l.id === leaveId);
        expect(found).toBeTruthy();
        const isExtraControllerShape = 'substitute_required' in found;
        // eslint-disable-next-line no-console
        console.log(
          '[duplicate-route check] GET /school-admin/leaves winner:',
          isExtraControllerShape
            ? 'SchoolAdminExtraController'
            : 'SchoolAdminLeavesController',
        );
        expect(typeof isExtraControllerShape).toBe('boolean');
      },
    );
  });
});
