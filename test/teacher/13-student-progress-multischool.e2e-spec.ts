import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { authHeader, mintAccessToken } from '../admin/support/auth';
import { getUserById, closePool, pool } from '../admin/support/db';

/**
 * Regression coverage for the "getting automatically logged out" bug: a
 * multi-school teacher (Nandini@yugminds.org) requesting
 * GET /teacher/student-progress?school_id=<their non-primary school> got a
 * spurious 401 "Cross-tenant schoolId access denied", which the frontend's
 * generic 401 handler misread as an expired session and force-logged them
 * out. Root cause was `getStudentProgress` querying every one of the
 * teacher's assigned schools regardless of the `school_id` the
 * TenantContextInterceptor had already locked the request to.
 *
 * Also covers the second, independent bug uncovered while fixing the
 * first: the endpoint always returned zero students because it compared
 * Section.name ("Section A") directly against StudentSchool.section ("A")
 * without normalizing the format on either side.
 *
 * No disposable QA fixture supports a real multi-school teacher with real
 * section-letter data, so — matching the pattern in
 * 12-calendar.e2e-spec.ts — this exercises the live scenario directly
 * against Nandini's real assignments. Read-only.
 */
describe('Teacher student-progress (real multi-school teacher, read-only)', () => {
  let app: INestApplication;
  let teacherAuth: [string, string];
  let dawnBudsId: string;
  let stLouisId: string;

  beforeAll(async () => {
    app = await bootstrapApp();

    const row = await pool.query(
      `SELECT id FROM "User" WHERE email = 'Nandini@yugminds.org'`,
    );
    expect(row.rowCount).toBeGreaterThan(0);
    const teacherId: number = row.rows[0].id;
    const user = await getUserById(teacherId);
    teacherAuth = authHeader(
      mintAccessToken({
        id: user.id,
        email: user.email,
        role: 'teacher',
        isSuperAdmin: user.isSuperAdmin,
        tenantId: user.tenantId,
        tokenVersion: user.tokenVersion,
      }),
    );

    const schools = await pool.query(
      `SELECT s.id, s.name FROM "TeacherSchool" ts
       JOIN "School" s ON s.id = ts."schoolId"
       WHERE ts."teacherId" = $1
       GROUP BY s.id, s.name`,
      [teacherId],
    );
    dawnBudsId = schools.rows.find((r: any) => r.name.includes('Dawn Buds'))?.id;
    stLouisId = schools.rows.find((r: any) => r.name.includes('St Louis'))?.id;
    expect(dawnBudsId).toBeDefined();
    expect(stLouisId).toBeDefined();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    await closePool();
  }, 30000);

  it(
    'requesting a non-primary assigned school (St Louis) does not 401 ' +
      '(regression guard for the cross-tenant auto-logout bug)',
    async () => {
      await request(app.getHttpServer())
        .get(`/teacher/student-progress?school_id=${stLouisId}`)
        .set(...teacherAuth)
        .expect(200);
    },
  );

  it(
    'requesting the primary school (Dawn Buds) returns real students, not ' +
      'an empty list (regression guard for the Section.name vs ' +
      'StudentSchool.section format-mismatch bug)',
    async () => {
      const res = await request(app.getHttpServer())
        .get(`/teacher/student-progress?school_id=${dawnBudsId}`)
        .set(...teacherAuth)
        .expect(200);
      expect(Array.isArray(res.body.students)).toBe(true);
      expect(res.body.students.length).toBeGreaterThan(0);
      expect(res.body.summary.total_students).toBeGreaterThan(0);
    },
  );

  it('requesting with no school_id aggregates across every assigned school without erroring', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/student-progress')
      .set(...teacherAuth)
      .expect(200);
    expect(Array.isArray(res.body.students)).toBe(true);
  });

  // The "school the teacher isn't assigned to is forbidden" case is already
  // covered against disposable fixture data in 09-student-progress.e2e-spec.ts
  // — this environment's only two real schools both belong to Nandini, so
  // there's no real unassigned school to exercise that path against here.
});
