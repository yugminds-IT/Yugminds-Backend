import './env';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { mintAccessToken, authHeader, TokenSubject } from './auth';
import { getBootstrapAdmin, getUserById, pool } from './db';

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const QA_PREFIX = `__qa_test_${RUN_ID}__`;

export interface QaUser {
  id: number;
  email: string;
  password: string;
  token: string;
}

export interface QaFixture {
  admin: { token: string; id: number; email: string };
  schoolId: string;
  schoolAdmin: QaUser;
  teachers: QaUser[];
  students: QaUser[];
  courseId: string;
  grade: string;
  section: string;
  roomId?: string;
  periodId?: string;
  scheduleId?: string;
  calendarId?: string;
}

export interface CreateQaFixtureOptions {
  /**
   * When true, additionally provisions one room, one period, one class
   * schedule (assigned to the first fixture teacher), and one calendar
   * entry, all via real school-admin HTTP calls. Off by default so plain
   * `createQaFixture(app)` consumers (e.g. 00-fixture-lifecycle) keep their
   * existing behavior/timing unchanged.
   */
  withScheduling?: boolean;
}

async function subjectFromUserId(
  id: number,
  role: TokenSubject['role'],
): Promise<TokenSubject> {
  const row = await getUserById(id);
  return {
    id: row.id,
    email: row.email,
    role,
    isSuperAdmin: row.isSuperAdmin,
    tenantId: row.tenantId,
    tokenVersion: row.tokenVersion,
  };
}

/**
 * Creates one disposable "QA Test School" tenant plus a school-admin, two
 * teachers, three students, and one course scoped to it — all through the
 * real admin HTTP endpoints (so this doubles as a correctness check on
 * those create paths). Never touches real/pre-existing data.
 */
export async function createQaFixture(
  app: INestApplication,
  options: CreateQaFixtureOptions = {},
): Promise<QaFixture> {
  const http = app.getHttpServer();
  const bootstrapAdmin = await getBootstrapAdmin();
  const adminToken = mintAccessToken({
    id: bootstrapAdmin.id,
    email: bootstrapAdmin.email,
    role: 'admin',
    isSuperAdmin: bootstrapAdmin.isSuperAdmin,
    tenantId: bootstrapAdmin.tenantId,
    tokenVersion: bootstrapAdmin.tokenVersion,
  });
  const adminAuth = authHeader(adminToken);

  // QA_PREFIX is computed once per test *file* (module load), not per call —
  // so a spec that creates two fixtures in the same process (e.g. a second
  // fixture for tenant-scoping checks) must not reuse it verbatim, or both
  // schools get the identical generated `domain` slug and the second
  // `POST /admin/schools` 400s on a unique-constraint violation. Each call
  // gets its own suffix; the `__qa_test_` substring is preserved so DB-level
  // "any lingering QA fixture?" scans (see 00-fixture-lifecycle) still match.
  const CALL_PREFIX = `${QA_PREFIX}${Math.random().toString(36).slice(2, 8)}__`;

  const grade = 'Grade 1';
  const section = 'Section A';
  // Two sections so the two fixture teachers below get distinct section
  // assignments — the backend rejects assigning the same section to two
  // different teachers (checkDuplicateSectionAssignments).
  const sections = ['Section A', 'Section B'];
  const schoolAdminEmail = `${CALL_PREFIX}_school_admin@example.test`;
  const schoolAdminPassword = 'QaTest123!';

  const schoolRes = await request(http)
    .post('/admin/schools')
    .set(...adminAuth)
    .send({
      name: `${CALL_PREFIX} School`,
      grades_offered: [grade],
      number_of_sections: sections.length,
      school_admin_email: schoolAdminEmail,
      school_admin_temp_password: schoolAdminPassword,
      school_admin_name: 'QA School Admin',
    })
    .expect(201);
  const schoolId: string =
    schoolRes.body?.data?.school?.id ?? schoolRes.body?.school?.id ?? schoolRes.body?.id;
  if (!schoolId) {
    throw new Error(
      `createQaFixture: could not read school id from response: ${JSON.stringify(schoolRes.body)}`,
    );
  }

  const { rows: schoolAdminRows } = await pool.query(
    `SELECT id FROM "User" WHERE email = $1`,
    [schoolAdminEmail],
  );
  const schoolAdminId: number = schoolAdminRows[0].id;
  const schoolAdminSubject = await subjectFromUserId(schoolAdminId, 'school_admin');

  const teachers: QaUser[] = [];
  for (let i = 0; i < 2; i++) {
    const email = `${CALL_PREFIX}_teacher${i}@example.test`;
    const password = 'QaTest123!';
    const res = await request(http)
      .post('/admin/teachers')
      .set(...adminAuth)
      .send({
        email,
        password,
        full_name: `QA Teacher ${i}`,
        school_assignments: [
          {
            school_id: schoolId,
            grade_sections_assigned: [{ grade, sections: [sections[i]] }],
            subjects: ['General'],
          },
        ],
      })
      .expect(201);
    const id: number = res.body?.data?.id ?? res.body?.id;
    const subject = await subjectFromUserId(id, 'teacher');
    teachers.push({ id, email, password, token: mintAccessToken(subject) });
  }

  const students: QaUser[] = [];
  for (let i = 0; i < 3; i++) {
    const email = `${CALL_PREFIX}_student${i}@example.test`;
    const password = 'QaTest123!';
    const res = await request(http)
      .post('/admin/students')
      .set(...adminAuth)
      .send({
        email,
        password,
        full_name: `QA Student ${i}`,
        school_id: schoolId,
        grade,
        section,
      })
      .expect(201);
    const id: number = res.body?.data?.id ?? res.body?.id;
    const subject = await subjectFromUserId(id, 'student');
    students.push({ id, email, password, token: mintAccessToken(subject) });
  }

  const courseRes = await request(http)
    .post('/admin/courses')
    .set(...adminAuth)
    .send({
      name: `${CALL_PREFIX} Course`,
      description: 'QA fixture course',
      school_ids: [schoolId],
      grades: [grade],
      // Published so AdminCoursesService.create() auto-enrolls the fixture
      // students (already created above) via enrollRelevantStudentsInCourse —
      // otherwise the course sits in Draft with zero StudentCourse rows and
      // every progress/leaderboard endpoint that reads real enrollment data
      // has nothing to report against.
      is_published: true,
      status: 'Published',
    })
    .expect(201);
  const courseId: string = courseRes.body?.data?.id ?? courseRes.body?.id;

  const schoolAdminToken = mintAccessToken(schoolAdminSubject);

  let roomId: string | undefined;
  let periodId: string | undefined;
  let scheduleId: string | undefined;
  let calendarId: string | undefined;

  if (options.withScheduling) {
    const schoolAdminAuth = authHeader(schoolAdminToken);

    const roomRes = await request(http)
      .post('/school-admin/rooms')
      .set(...schoolAdminAuth)
      .send({
        room_number: `${CALL_PREFIX}_Room1`,
        room_name: 'QA Test Room',
        capacity: 30,
      })
      .expect(201);
    roomId = roomRes.body?.room?.id;
    if (!roomId) {
      throw new Error(
        `createQaFixture: could not read room id from response: ${JSON.stringify(roomRes.body)}`,
      );
    }

    const periodRes = await request(http)
      .post('/school-admin/periods')
      .set(...schoolAdminAuth)
      .send({
        period_number: 1,
        start_time: '09:00',
        end_time: '10:00',
      })
      .expect(201);
    periodId = periodRes.body?.period?.id;
    if (!periodId) {
      throw new Error(
        `createQaFixture: could not read period id from response: ${JSON.stringify(periodRes.body)}`,
      );
    }

    const scheduleRes = await request(http)
      .post('/school-admin/schedules')
      .set(...schoolAdminAuth)
      .send({
        period_id: periodId,
        room_id: roomId,
        teacher_id: teachers[0].id,
        grade,
        subject: 'General',
        day_of_week: 'Monday',
      })
      .expect(201);
    scheduleId = scheduleRes.body?.schedule?.id;
    if (!scheduleId) {
      throw new Error(
        `createQaFixture: could not read schedule id from response: ${JSON.stringify(scheduleRes.body)}`,
      );
    }

    const calendarRes = await request(http)
      .post('/school-admin/calendar')
      .set(...schoolAdminAuth)
      .send({
        date: '2026-08-15',
        name: `${CALL_PREFIX} Holiday`,
        type: 'Holiday',
        academic_year: currentAcademicYearForFixture(),
      })
      .expect(201);
    calendarId =
      calendarRes.body?.entry?.id ??
      calendarRes.body?.calendar?.id ??
      calendarRes.body?.id;
    if (!calendarId) {
      throw new Error(
        `createQaFixture: could not read calendar entry id from response: ${JSON.stringify(calendarRes.body)}`,
      );
    }
  }

  return {
    admin: { token: adminToken, id: bootstrapAdmin.id, email: bootstrapAdmin.email },
    schoolId,
    schoolAdmin: {
      id: schoolAdminId,
      email: schoolAdminEmail,
      password: schoolAdminPassword,
      token: schoolAdminToken,
    },
    teachers,
    students,
    courseId,
    grade,
    section,
    roomId,
    periodId,
    scheduleId,
    calendarId,
  };
}

/** Academic year string matching the same "starts June" convention used server-side. */
function currentAcademicYearForFixture(): string {
  const now = new Date();
  const year = now.getFullYear();
  const start = now.getMonth() < 5 ? year - 1 : year;
  return `${start}-${String(start + 1).slice(-2)}`;
}

/**
 * Hard-purges everything created by createQaFixture, in dependency order,
 * via the real trash purge endpoint (course, then users) followed by the
 * school purge (which cascades its own users). Safe to call even if some
 * entities were already deleted mid-test.
 */
export async function teardownQaFixture(
  app: INestApplication,
  fixture: QaFixture,
): Promise<void> {
  const http = app.getHttpServer();
  const adminAuth = authHeader(fixture.admin.token);

  // ClassSchedule has no FK relation to School in prisma/schema.prisma (only
  // a bare schoolId column, no `onDelete: Cascade`), so a school purge does
  // NOT clean it up — it would be silently orphaned forever. Room, Period,
  // and SchoolCalendar all declare `onDelete: Cascade` on their School
  // relation, so those are safe to leave for the school purge below.
  if (fixture.scheduleId) {
    const schoolAdminAuth = authHeader(fixture.schoolAdmin.token);
    await request(http)
      .delete(`/school-admin/schedules/${fixture.scheduleId}`)
      .set(...schoolAdminAuth)
      .catch(() => undefined);
  }

  // Course: soft-delete then purge (trash purge requires deletedAt set first).
  await request(http)
    .delete(`/admin/courses/${fixture.courseId}`)
    .set(...adminAuth)
    .catch(() => undefined);
  await request(http)
    .delete(`/admin/trash?entity_type=courses&id=${fixture.courseId}`)
    .set(...adminAuth)
    .catch(() => undefined);

  // School purge cascades to its users (school-admin/teachers/students).
  await request(http)
    .delete(`/admin/schools/${fixture.schoolId}`)
    .set(...adminAuth)
    .catch(() => undefined);
  await request(http)
    .delete(`/admin/trash?entity_type=schools&id=${fixture.schoolId}`)
    .set(...adminAuth)
    .catch(() => undefined);
}
