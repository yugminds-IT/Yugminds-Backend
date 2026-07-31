import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { authHeader, mintAccessToken } from '../admin/support/auth';
import { getUserById, closePool, pool } from '../admin/support/db';

/**
 * `/teacher/calendar` has no disposable-fixture equivalent for a real
 * multi-school, mid-month-pattern-change teacher — QA fixtures are
 * single-school only. This exercises the exact live scenario that motivated
 * the "Weekly off" mislabeling fix: a real multi-school teacher
 * (Nandini@yugminds.org) with a Dawn Buds assignment starting 2026-07-23
 * (Mon-Thu), a mid-month pattern swap to Tue-Fri effective 2026-07-26, and a
 * brand-new second school (St Louis, Mon/Sat) also starting 2026-07-26.
 * Read-only — this endpoint has no write path.
 */
describe('Teacher calendar (real multi-school teacher, read-only)', () => {
  let app: INestApplication;
  let teacherAuth: [string, string];
  let dawnBudsId: string;
  let stLouisId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    await closePool();
  }, 30000);

  it('setup: resolve Nandini and her two real schools', async () => {
    const row = await pool.query(
      `SELECT id, "tenantId" FROM "User" WHERE email = 'Nandini@yugminds.org'`,
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
      `SELECT s.id, s.name FROM "TeacherWorkingDaysHistory" h
       JOIN "School" s ON s.id = h."schoolId"
       WHERE h."teacherId" = $1
       GROUP BY s.id, s.name`,
      [teacherId],
    );
    dawnBudsId = schools.rows.find((r: any) => r.name.includes('Dawn Buds'))?.id;
    stLouisId = schools.rows.find((r: any) => r.name.includes('St Louis'))?.id;
    expect(dawnBudsId).toBeDefined();
    expect(stLouisId).toBeDefined();
  });

  it(
    'dates before the earliest assignment (2026-07-01..22) are flagged ' +
      'unassigned_dates, not silently folded into "off"',
    async () => {
      const res = await request(app.getHttpServer())
        .get('/teacher/calendar?year=2026&month=07')
        .set(...teacherAuth)
        .expect(200);
      const unassigned: string[] = res.body.unassigned_dates;
      expect(unassigned).toEqual(expect.arrayContaining(['2026-07-01', '2026-07-10', '2026-07-22']));
      expect(unassigned).not.toEqual(expect.arrayContaining(['2026-07-23']));
    },
  );

  it('2026-07-23 (first Dawn Buds day, Mon-Thu pattern) resolves to Dawn Buds only', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/calendar?year=2026&month=07')
      .set(...teacherAuth)
      .expect(200);
    const day = (res.body.schedule as Array<{ date: string; school_id: string }>).filter(
      (s) => s.date === '2026-07-23',
    );
    expect(day).toHaveLength(1);
    expect(day[0].school_id).toBe(dawnBudsId);
  });

  it(
    '2026-07-24 (Friday) is genuinely "off" (not unassigned) — Dawn Buds\' ' +
      'pre-swap Mon-Thu pattern excludes it and St Louis did not exist yet',
    async () => {
      const res = await request(app.getHttpServer())
        .get('/teacher/calendar?year=2026&month=07')
        .set(...teacherAuth)
        .expect(200);
      expect(res.body.unassigned_dates).not.toEqual(
        expect.arrayContaining(['2026-07-24']),
      );
      const day = (res.body.schedule as Array<{ date: string }>).filter(
        (s) => s.date === '2026-07-24',
      );
      expect(day).toHaveLength(0);
    },
  );

  it('2026-07-27 (Monday, after the mid-month swap) resolves to St Louis only', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/calendar?year=2026&month=07')
      .set(...teacherAuth)
      .expect(200);
    const day = (res.body.schedule as Array<{ date: string; school_id: string }>).filter(
      (s) => s.date === '2026-07-27',
    );
    expect(day).toHaveLength(1);
    expect(day[0].school_id).toBe(stLouisId);
  });

  it('2026-07-28 (Tuesday, post-swap Dawn Buds pattern) resolves to Dawn Buds only', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/calendar?year=2026&month=07')
      .set(...teacherAuth)
      .expect(200);
    const day = (res.body.schedule as Array<{ date: string; school_id: string }>).filter(
      (s) => s.date === '2026-07-28',
    );
    expect(day).toHaveLength(1);
    expect(day[0].school_id).toBe(dawnBudsId);
  });

  it('navigating to a month before the teacher existed (Jan 2026) has every date unassigned, no error', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/calendar?year=2026&month=01')
      .set(...teacherAuth)
      .expect(200);
    expect(res.body.schedule).toEqual([]);
    expect(res.body.unassigned_dates.length).toBe(31);
  });

  it('navigating to a future month projects the latest pattern forward (no special-casing needed)', async () => {
    const res = await request(app.getHttpServer())
      .get('/teacher/calendar?year=2026&month=08')
      .set(...teacherAuth)
      .expect(200);
    // 2026-08-03 is a Monday -> St Louis under the pattern effective 07-26.
    const day = (res.body.schedule as Array<{ date: string; school_id: string }>).filter(
      (s) => s.date === '2026-08-03',
    );
    expect(day).toHaveLength(1);
    expect(day[0].school_id).toBe(stLouisId);
    expect(res.body.unassigned_dates).toEqual([]);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/teacher/calendar').expect(401);
  });
});
