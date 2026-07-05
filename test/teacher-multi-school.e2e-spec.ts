/**
 * Multi-school teacher isolation — integration test (READ-ONLY).
 *
 * Exercises the exact code paths changed for multi-school support:
 *   1. The Prisma client extension (DatabaseService) — relation-tenant injection
 *      is skipped for school-scoped models so a multi-school teacher's rows are
 *      readable in EACH of their schools, while the `schoolId` scalar check still
 *      blocks genuine cross-tenant access.
 *   2. The tenant-switch flow the TenantContextInterceptor performs: validate
 *      membership with a super-admin lookup, then run the request in the selected
 *      school's tenant context.
 *
 * Strictly READ-ONLY: only SELECTs against existing demo data, no writes.
 */
import 'dotenv/config';
import { UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { tenantContext } from '../src/tenants/tenant-context';

describe('Multi-school teacher isolation (integration, read-only)', () => {
  let pool: Pool;
  let db: DatabaseService;

  let teacherId: number;
  let schoolA: string; // primary (JWT tenantId)
  let schoolB: string; // a different assigned school
  let nonMemberSchool: string | null;

  /** Mirrors the interceptor: verify membership unscoped, then run in school ctx. */
  async function asTeacherInSchool<T>(
    schoolId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const member = await tenantContext.runSuperAdmin(
      async () =>
        await db.teacherSchool.findFirst({
          where: { teacherId, schoolId },
          select: { id: true },
        }),
    );
    if (!member) throw new Error('not a member (interceptor would 403)');
    return tenantContext.run(schoolId, async () => await fn());
  }

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 8000,
    });

    const t = await pool.query(`
      SELECT u.id, u."tenantId"
      FROM "User" u
      WHERE u.role = 'teacher' AND u."tenantId" IS NOT NULL
        AND (SELECT count(*) FROM "TeacherSchool" ts WHERE ts."teacherId" = u.id) >= 2
        AND EXISTS (SELECT 1 FROM "TeacherSchool" ts
                    WHERE ts."teacherId" = u.id AND ts."schoolId" = u."tenantId")
      ORDER BY u.id LIMIT 1
    `);
    if (t.rowCount === 0) throw new Error('No multi-school teacher in DB.');
    teacherId = t.rows[0].id;
    schoolA = t.rows[0].tenantId;

    schoolB = (
      await pool.query(
        `SELECT "schoolId" FROM "TeacherSchool"
          WHERE "teacherId"=$1 AND "schoolId"<>$2 LIMIT 1`,
        [teacherId, schoolA],
      )
    ).rows[0].schoolId;

    nonMemberSchool =
      (
        await pool.query(
          `SELECT id FROM "School"
            WHERE id NOT IN (SELECT "schoolId" FROM "TeacherSchool" WHERE "teacherId"=$1)
            LIMIT 1`,
          [teacherId],
        )
      ).rows[0]?.id ?? null;

    db = new DatabaseService();

    // eslint-disable-next-line no-console
    console.log(
      `\n[multi-school] teacher=${teacherId}\n  A(primary)=${schoolA}\n  B(other)  =${schoolB}\n  nonMember =${nonMemberSchool}\n`,
    );
  });

  afterAll(async () => {
    await (db as unknown as { $disconnect: () => Promise<void> })?.$disconnect();
    await pool?.end();
  });

  it('schedules load in BOTH schools and stay isolated (regression for the 401)', async () => {
    const aRows = await asTeacherInSchool(schoolA, () =>
      db.classSchedule.findMany({ where: { schoolId: schoolA, teacherId } }),
    );
    const bRows = await asTeacherInSchool(schoolB, () =>
      db.classSchedule.findMany({ where: { schoolId: schoolB, teacherId } }),
    );

    expect(aRows.every((r) => r.schoolId === schoolA)).toBe(true);
    expect(bRows.every((r) => r.schoolId === schoolB)).toBe(true);

    const aIds = new Set(aRows.map((r) => r.id));
    expect(bRows.filter((r) => aIds.has(r.id))).toHaveLength(0);
    // eslint-disable-next-line no-console
    console.log(`  schedules: A=${aRows.length} B=${bRows.length}`);
  });

  it('assignments for a multi-school teacher are readable in the non-primary school', async () => {
    // This is the case that previously returned 0 rows because `teacher: {tenantId}`
    // was injected and the teacher's primary tenant != school B.
    const bAssignments = await asTeacherInSchool(schoolB, () =>
      db.assignment.findMany({
        where: { teacherId, schoolId: { in: [schoolB] } },
        select: { id: true, schoolId: true },
      }),
    );
    expect(bAssignments.every((a) => a.schoolId === schoolB)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`  assignments in B: ${bAssignments.length}`);
  });

  it('section assignments: a multi-school teacher SEES their non-primary-school rows and they stay isolated', async () => {
    // TeacherSectionAssignment has a `teacher` relation. With the old injection,
    // running in school B would add `teacher: { tenantId: B }` and return 0 rows
    // (the teacher's User.tenantId is their primary school A). This proves the
    // injection-skip fix actually surfaces the data.
    const inB = await asTeacherInSchool(schoolB, () =>
      db.teacherSectionAssignment.findMany({
        where: { teacherId, schoolId: schoolB },
        select: { id: true, schoolId: true },
      }),
    );
    const inA = await asTeacherInSchool(schoolA, () =>
      db.teacherSectionAssignment.findMany({
        where: { teacherId, schoolId: schoolA },
        select: { id: true, schoolId: true },
      }),
    );

    expect(inB.length).toBeGreaterThan(0); // real demo data exists in school B
    expect(inB.every((r) => r.schoolId === schoolB)).toBe(true);
    expect(inA.every((r) => r.schoolId === schoolA)).toBe(true);

    const aIds = new Set(inA.map((r) => r.id));
    expect(inB.filter((r) => aIds.has(r.id))).toHaveLength(0); // disjoint
    // eslint-disable-next-line no-console
    console.log(`  section assignments: A=${inA.length} B=${inB.length}`);
  });

  it("students of the non-primary school are visible (and scoped to that school)", async () => {
    const students = await asTeacherInSchool(schoolB, () =>
      db.studentSchool.findMany({
        where: { schoolId: schoolB, isActive: true },
        select: { id: true, schoolId: true },
      }),
    );
    expect(students.length).toBeGreaterThan(0);
    expect(students.every((s) => s.schoolId === schoolB)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`  active students in B: ${students.length}`);
  });

  it('other teacher-owned school-scoped models read without error in the non-primary school', async () => {
    await expect(
      asTeacherInSchool(schoolB, () =>
        db.teacherLeave.findMany({ where: { teacherId, schoolId: schoolB } }),
      ),
    ).resolves.toBeDefined();
    await expect(
      asTeacherInSchool(schoolB, () =>
        db.teacherReport.findMany({ where: { teacherId, schoolId: schoolB } }),
      ),
    ).resolves.toBeDefined();
    await expect(
      asTeacherInSchool(schoolB, () =>
        db.attendance.findMany({ where: { teacherId, schoolId: schoolB } }),
      ),
    ).resolves.toBeDefined();
  });

  it('notifications are user-global (identical in either school context)', async () => {
    const inA = await tenantContext.run(
      schoolA,
      async () =>
        await db.notification.findMany({
          where: { userId: teacherId, deletedAt: null },
          select: { id: true },
        }),
    );
    const inB = await tenantContext.run(
      schoolB,
      async () =>
        await db.notification.findMany({
          where: { userId: teacherId, deletedAt: null },
          select: { id: true },
        }),
    );
    expect(inA.map((n) => n.id).sort()).toEqual(inB.map((n) => n.id).sort());
    // eslint-disable-next-line no-console
    console.log(`  notifications visible: ${inA.length}`);
  });

  it('STILL blocks genuine cross-tenant access (school B data from school A context)', async () => {
    await expect(
      tenantContext.run(
        schoolA,
        async () =>
          await db.classSchedule.findMany({
            where: { schoolId: schoolB, teacherId },
          }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a school the teacher is not assigned to (interceptor 403 path)', async () => {
    if (!nonMemberSchool) {
      // eslint-disable-next-line no-console
      console.warn('  no non-member school available; skipping');
      return;
    }
    const member = await tenantContext.runSuperAdmin(
      async () =>
        await db.teacherSchool.findFirst({
          where: { teacherId, schoolId: nonMemberSchool as string },
          select: { id: true },
        }),
    );
    expect(member).toBeNull(); // => interceptor throws ForbiddenException
  });
});
