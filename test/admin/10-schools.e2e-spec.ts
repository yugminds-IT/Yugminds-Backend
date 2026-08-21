import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool, pool } from './support/db';

describe('Admin schools CRUD + soft-delete/restore blast radius', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/schools lists the fixture school', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/schools?limit=200')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const schools = res.body?.data?.schools ?? res.body?.schools ?? [];
    expect(schools.some((s: { id: string }) => s.id === fixture.schoolId)).toBe(true);
  });

  it('GET /admin/schools/:id returns full detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const school = res.body?.data ?? res.body;
    expect(school.id ?? school.school?.id).toBe(fixture.schoolId);
  });

  it('GET /admin/schools/:id/teacher-assignments works', async () => {
    await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}/teacher-assignments`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
  });

  it('PUT /admin/schools updates the school name', async () => {
    const newName = `${fixture.schoolId}-renamed`;
    await request(app.getHttpServer())
      .put('/admin/schools')
      .set(...authHeader(fixture.admin.token))
      .send({ id: fixture.schoolId, name: newName })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const school = res.body?.data ?? res.body;
    expect(school.name ?? school.school?.name).toBe(newName);
  });

  it(
    'PUT /admin/schools with a new grade in grades_offered adds that grade ' +
      '(and its sections + join codes) without touching existing grades ' +
      "or duplicating their join codes (regression: update() never wrote " +
      'academic structure at all, and the underlying write method minted a ' +
      'fresh join code for every already-existing section on every call)',
    async () => {
      const before = await request(app.getHttpServer())
        .get(`/admin/schools/${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      const beforeSchool = before.body?.data ?? before.body;
      const existingGrade = beforeSchool.grades.find(
        (g: { name: string }) => g.name === fixture.grade,
      );
      const existingJoinCodeIds = existingGrade.sections
        .flatMap((s: { joinCodes: { id: string }[] }) => s.joinCodes)
        .map((jc: { id: string }) => jc.id)
        .sort();

      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(fixture.admin.token))
        .send({
          id: fixture.schoolId,
          grades_offered: [...beforeSchool.gradesOffered, 'Grade 9'],
          sections_per_grade: { 'Grade 9': 2 },
        })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/admin/schools/${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      const afterSchool = after.body?.data ?? after.body;

      const newGrade = afterSchool.grades.find(
        (g: { name: string }) => g.name === 'Grade 9',
      );
      expect(newGrade).toBeDefined();
      expect(newGrade.sections).toHaveLength(2);
      expect(newGrade.sections[0].joinCodes).toHaveLength(1);
      expect(newGrade.sections[1].joinCodes).toHaveLength(1);

      // Existing grade's join codes must be exactly the same rows, not
      // duplicated or replaced.
      const afterExistingGrade = afterSchool.grades.find(
        (g: { name: string }) => g.name === fixture.grade,
      );
      const afterExistingJoinCodeIds = afterExistingGrade.sections
        .flatMap((s: { joinCodes: { id: string }[] }) => s.joinCodes)
        .map((jc: { id: string }) => jc.id)
        .sort();
      expect(afterExistingJoinCodeIds).toEqual(existingJoinCodeIds);
    },
  );

  it('PUT /admin/schools without grades_offered in the body leaves academic structure untouched', async () => {
    const before = await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const beforeSchool = before.body?.data ?? before.body;

    await request(app.getHttpServer())
      .put('/admin/schools')
      .set(...authHeader(fixture.admin.token))
      .send({ id: fixture.schoolId, contact_phone: '+91 9000000000' })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`/admin/schools/${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const afterSchool = after.body?.data ?? after.body;
    expect(afterSchool.grades.length).toBe(beforeSchool.grades.length);
  });

  it(
    'PUT /admin/schools removes a grade dropped from grades_offered, and ' +
      "shrinks a kept grade's sections to match a reduced section count " +
      '(regression: update() only ever added grades/sections, never removed ' +
      'ones no longer wanted)',
    async () => {
      // Builds on the earlier "adds Grade 9" test in this file — add a
      // second throwaway grade so there's something to remove alongside
      // something to shrink, without touching the original fixture grade.
      const before = await request(app.getHttpServer())
        .get(`/admin/schools/${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      const beforeSchool = before.body?.data ?? before.body;

      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(fixture.admin.token))
        .send({
          id: fixture.schoolId,
          grades_offered: [...beforeSchool.gradesOffered, 'Grade 10'],
          sections_per_grade: { 'Grade 9': 2, 'Grade 10': 2 },
        })
        .expect(200);

      const withBothGrades = await request(app.getHttpServer())
        .get(`/admin/schools/${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      const withBothSchool = withBothGrades.body?.data ?? withBothGrades.body;
      expect(
        withBothSchool.grades.some((g: { name: string }) => g.name === 'Grade 9'),
      ).toBe(true);
      const grade10Before = withBothSchool.grades.find(
        (g: { name: string }) => g.name === 'Grade 10',
      );
      expect(grade10Before.sections).toHaveLength(2);

      // Now drop Grade 9 entirely and shrink Grade 10 from 2 sections to 1.
      const remainingGrades = withBothSchool.gradesOffered.filter(
        (g: string) => g !== 'Grade 9',
      );
      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(fixture.admin.token))
        .send({
          id: fixture.schoolId,
          grades_offered: remainingGrades,
          sections_per_grade: { 'Grade 10': 1 },
        })
        .expect(200);

      const finalRes = await request(app.getHttpServer())
        .get(`/admin/schools/${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      const finalSchool = finalRes.body?.data ?? finalRes.body;

      expect(
        finalSchool.grades.some((g: { name: string }) => g.name === 'Grade 9'),
      ).toBe(false);
      const grade10After = finalSchool.grades.find(
        (g: { name: string }) => g.name === 'Grade 10',
      );
      expect(grade10After).toBeDefined();
      expect(grade10After.sections).toHaveLength(1);
      // The original fixture grade must be completely unaffected throughout.
      expect(
        finalSchool.grades.some((g: { name: string }) => g.name === fixture.grade),
      ).toBe(true);

      // Doing it again with the exact same (already-shrunk) list must be a
      // safe no-op, not an error or a further change.
      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(fixture.admin.token))
        .send({
          id: fixture.schoolId,
          grades_offered: remainingGrades,
          sections_per_grade: { 'Grade 10': 1 },
        })
        .expect(200);
      const idempotentRes = await request(app.getHttpServer())
        .get(`/admin/schools/${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      const idempotentSchool = idempotentRes.body?.data ?? idempotentRes.body;
      const grade10Idempotent = idempotentSchool.grades.find(
        (g: { name: string }) => g.name === 'Grade 10',
      );
      expect(grade10Idempotent.sections).toHaveLength(1);
    },
  );

  describe('growing a grade\'s section count (e.g. 2 -> 3 sections)', () => {
    async function getSchool() {
      const res = await request(app.getHttpServer())
        .get(`/admin/schools/${fixture.schoolId}`)
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      return res.body?.data ?? res.body;
    }
    function findGrade(school: any, name: string) {
      return school.grades.find((g: { name: string }) => g.name === name);
    }

    it(
      'sending a higher section count for a grade adds the new section(s) and ' +
        "leaves the grade's existing sections/join codes byte-for-byte unchanged " +
        '(the exact "2 sections -> 3 sections" scenario)',
      async () => {
        const before = await getSchool();
        const beforeGrade = findGrade(before, fixture.grade);
        expect(beforeGrade.sections).toHaveLength(2);
        const beforeSectionIds = beforeGrade.sections.map((s: { id: string }) => s.id).sort();
        const beforeJoinCodeIds = beforeGrade.sections
          .flatMap((s: { joinCodes: { id: string }[] }) => s.joinCodes)
          .map((jc: { id: string }) => jc.id)
          .sort();

        await request(app.getHttpServer())
          .put('/admin/schools')
          .set(...authHeader(fixture.admin.token))
          .send({
            id: fixture.schoolId,
            grades_offered: before.gradesOffered,
            sections_per_grade: { [fixture.grade]: 3 },
          })
          .expect(200);

        const after = await getSchool();
        const afterGrade = findGrade(after, fixture.grade);
        expect(afterGrade.sections).toHaveLength(3);
        expect(afterGrade.sections.map((s: { name: string }) => s.name).sort()).toEqual([
          'Section A',
          'Section B',
          'Section C',
        ]);
        // The original two sections must be the SAME rows, not recreated.
        const afterOriginalSectionIds = afterGrade.sections
          .filter((s: { name: string }) => s.name !== 'Section C')
          .map((s: { id: string }) => s.id)
          .sort();
        expect(afterOriginalSectionIds).toEqual(beforeSectionIds);
        const afterOriginalJoinCodeIds = afterGrade.sections
          .filter((s: { name: string }) => s.name !== 'Section C')
          .flatMap((s: { joinCodes: { id: string }[] }) => s.joinCodes)
          .map((jc: { id: string }) => jc.id)
          .sort();
        expect(afterOriginalJoinCodeIds).toEqual(beforeJoinCodeIds);
        // Exactly one new section, with exactly one new join code.
        const newSection = afterGrade.sections.find((s: { name: string }) => s.name === 'Section C');
        expect(newSection.joinCodes).toHaveLength(1);

        // Reverting to 2 for later tests in this block isn't needed — each
        // test re-reads real current state via getSchool()/findGrade().
      },
    );

    it(
      "a grade not mentioned in sections_per_grade keeps its section count " +
        'exactly as-is, even though this same request grows a different grade',
      async () => {
        // fixture.grade is now at 3 sections from the previous test. Add a
        // second grade so there's something to leave untouched while only
        // fixture.grade is grown further.
        const before = await getSchool();
        await request(app.getHttpServer())
          .put('/admin/schools')
          .set(...authHeader(fixture.admin.token))
          .send({
            id: fixture.schoolId,
            grades_offered: [...before.gradesOffered, 'Grade 11'],
            sections_per_grade: { 'Grade 11': 2 },
          })
          .expect(200);

        const withGrade11 = await getSchool();
        const grade11Before = findGrade(withGrade11, 'Grade 11');
        expect(grade11Before.sections).toHaveLength(2);
        const grade11SectionIds = grade11Before.sections
          .map((s: { id: string }) => s.id)
          .sort();

        // Now grow fixture.grade to 4 sections; Grade 11 isn't mentioned at all.
        await request(app.getHttpServer())
          .put('/admin/schools')
          .set(...authHeader(fixture.admin.token))
          .send({
            id: fixture.schoolId,
            grades_offered: withGrade11.gradesOffered,
            sections_per_grade: { [fixture.grade]: 4 },
          })
          .expect(200);

        const after = await getSchool();
        expect(findGrade(after, fixture.grade).sections).toHaveLength(4);
        const grade11After = findGrade(after, 'Grade 11');
        expect(grade11After.sections).toHaveLength(2);
        expect(
          grade11After.sections.map((s: { id: string }) => s.id).sort(),
        ).toEqual(grade11SectionIds);
      },
    );

    it(
      "growing a grade's sections doesn't disturb an existing student's " +
        "enrollment or an existing teacher's section assignment",
      async () => {
        const before = await getSchool();
        const beforeGrade = findGrade(before, fixture.grade);
        const sectionA = beforeGrade.sections.find(
          (s: { name: string }) => s.name === 'Section A',
        );

        const teacherRes = await request(app.getHttpServer())
          .get(`/admin/schools/${fixture.schoolId}/teacher-assignments`)
          .set(...authHeader(fixture.admin.token))
          .expect(200);
        const teacherBefore = teacherRes.body.assignments.find(
          (a: { sectionId: string }) => a.sectionId === sectionA.id,
        );
        expect(teacherBefore).toBeDefined();
        expect(teacherBefore.teacherId).toBe(fixture.teachers[0].id);

        const studentRes = await request(app.getHttpServer())
          .get(`/admin/students/${fixture.students[0].id}`)
          .set(...authHeader(fixture.admin.token))
          .expect(200);
        const studentBeforeBody = studentRes.body?.data ?? studentRes.body;
        const studentSchoolBefore = studentBeforeBody.student_schools.find(
          (ss: { school_id: string }) => ss.school_id === fixture.schoolId,
        );

        await request(app.getHttpServer())
          .put('/admin/schools')
          .set(...authHeader(fixture.admin.token))
          .send({
            id: fixture.schoolId,
            grades_offered: before.gradesOffered,
            sections_per_grade: { [fixture.grade]: beforeGrade.sections.length + 1 },
          })
          .expect(200);

        const teacherAfterRes = await request(app.getHttpServer())
          .get(`/admin/schools/${fixture.schoolId}/teacher-assignments`)
          .set(...authHeader(fixture.admin.token))
          .expect(200);
        const teacherAfter = teacherAfterRes.body.assignments.find(
          (a: { sectionId: string }) => a.sectionId === sectionA.id,
        );
        expect(teacherAfter).toBeDefined();
        expect(teacherAfter.teacherId).toBe(fixture.teachers[0].id);

        const studentAfterRes = await request(app.getHttpServer())
          .get(`/admin/students/${fixture.students[0].id}`)
          .set(...authHeader(fixture.admin.token))
          .expect(200);
        const studentAfterBody = studentAfterRes.body?.data ?? studentAfterRes.body;
        const studentSchoolAfter = studentAfterBody.student_schools.find(
          (ss: { school_id: string }) => ss.school_id === fixture.schoolId,
        );
        expect(studentSchoolAfter.section).toBe(studentSchoolBefore.section);
        expect(studentSchoolAfter.is_active).toBe(studentSchoolBefore.is_active);
      },
    );

    it('sending the exact same grown section count twice in a row is a safe no-op', async () => {
      const before = await getSchool();
      const beforeGrade = findGrade(before, fixture.grade);
      const targetCount = beforeGrade.sections.length;

      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(fixture.admin.token))
        .send({
          id: fixture.schoolId,
          grades_offered: before.gradesOffered,
          sections_per_grade: { [fixture.grade]: targetCount },
        })
        .expect(200);

      const after = await getSchool();
      const afterGrade = findGrade(after, fixture.grade);
      expect(afterGrade.sections).toHaveLength(targetCount);
      expect(
        afterGrade.sections.map((s: { id: string }) => s.id).sort(),
      ).toEqual(beforeGrade.sections.map((s: { id: string }) => s.id).sort());
      const totalJoinCodes = afterGrade.sections.flatMap(
        (s: { joinCodes: unknown[] }) => s.joinCodes,
      );
      expect(totalJoinCodes).toHaveLength(targetCount);
    });
  });

  describe('a legacy school with no schoolCode gets one persisted on first update, not re-derived every time', () => {
    let codeFixture: QaFixture;

    beforeAll(async () => {
      codeFixture = await createQaFixture(app);
      await pool.query('UPDATE "School" SET "schoolCode" = NULL WHERE id = $1', [
        codeFixture.schoolId,
      ]);
    }, 60000);

    afterAll(async () => {
      if (app && codeFixture) await teardownQaFixture(app, codeFixture);
    }, 60000);

    it('growing sections persists a derived schoolCode, and a second growth reuses it', async () => {
      const firstGrow = await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(codeFixture.admin.token))
        .send({
          id: codeFixture.schoolId,
          grades_offered: [codeFixture.grade],
          sections_per_grade: { [codeFixture.grade]: 3 },
        })
        .expect(200);
      void firstGrow;

      const afterFirst = await request(app.getHttpServer())
        .get(`/admin/schools/${codeFixture.schoolId}`)
        .set(...authHeader(codeFixture.admin.token))
        .expect(200);
      const schoolAfterFirst = afterFirst.body?.data ?? afterFirst.body;
      expect(schoolAfterFirst.schoolCode).toBeTruthy();
      const persistedCode = schoolAfterFirst.schoolCode as string;
      const gradeAfterFirst = schoolAfterFirst.grades.find(
        (g: { name: string }) => g.name === codeFixture.grade,
      );
      // Join codes are shaped YUG-<schoolCode>-<gradeAbbr>-<sectionAbbr>.
      const codePrefix = `YUG-${persistedCode}-`;
      const firstGradeCodes: string[] = gradeAfterFirst.sections.flatMap(
        (s: { joinCodes: { code: string }[] }) => s.joinCodes.map((jc) => jc.code),
      );
      expect(firstGradeCodes.length).toBeGreaterThan(0);
      for (const code of firstGradeCodes) {
        expect(code.startsWith(codePrefix)).toBe(true);
      }

      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(codeFixture.admin.token))
        .send({
          id: codeFixture.schoolId,
          grades_offered: [codeFixture.grade],
          sections_per_grade: { [codeFixture.grade]: 4 },
        })
        .expect(200);

      const afterSecond = await request(app.getHttpServer())
        .get(`/admin/schools/${codeFixture.schoolId}`)
        .set(...authHeader(codeFixture.admin.token))
        .expect(200);
      const schoolAfterSecond = afterSecond.body?.data ?? afterSecond.body;
      expect(schoolAfterSecond.schoolCode).toBe(persistedCode);
      const gradeAfterSecond = schoolAfterSecond.grades.find(
        (g: { name: string }) => g.name === codeFixture.grade,
      );
      const allCodes: string[] = gradeAfterSecond.sections.flatMap(
        (s: { joinCodes: { code: string }[] }) => s.joinCodes.map((jc) => jc.code),
      );
      for (const code of allCodes) {
        expect(code.startsWith(codePrefix)).toBe(true);
      }
    });
  });

  describe('deactivating a school blocks sign-in for its teachers/students (own throwaway school)', () => {
    let deactivateFixture: QaFixture;

    beforeAll(async () => {
      deactivateFixture = await createQaFixture(app);
    }, 60000);

    afterAll(async () => {
      if (app && deactivateFixture) await teardownQaFixture(app, deactivateFixture);
    }, 60000);

    it('login is blocked while the school is inactive, and works again once reactivated', async () => {
      const teacher = deactivateFixture.teachers[0];

      // Sanity check: login works while the school is active.
      const before = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: teacher.email, password: teacher.password });
      expect([200, 201]).toContain(before.status);

      await request(app.getHttpServer())
        .put('/admin/schools')
        .set(...authHeader(deactivateFixture.admin.token))
        .send({ id: deactivateFixture.schoolId, is_active: false })
        .expect(200);

      try {
        const blocked = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: teacher.email, password: teacher.password });
        expect(blocked.status).toBe(401);
        expect(blocked.body?.message).toMatch(/deactivated/i);

        // The platform admin is exempt — deactivating a school must not lock
        // the admin who deactivated it out of the platform.
        const adminLogin = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'admin@yugminds.com', password: process.env.ADMIN_SEED_PASSWORD });
        expect([200, 201]).toContain(adminLogin.status);
      } finally {
        await request(app.getHttpServer())
          .put('/admin/schools')
          .set(...authHeader(deactivateFixture.admin.token))
          .send({ id: deactivateFixture.schoolId, is_active: true })
          .expect(200);
      }

      const after = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: teacher.email, password: teacher.password });
      expect([200, 201]).toContain(after.status);
    });
  });

  describe('soft-delete blast radius (own throwaway school, not the shared fixture)', () => {
    let tempFixture: QaFixture;

    beforeAll(async () => {
      tempFixture = await createQaFixture(app);
    }, 60000);

    it('deleting the school force-logs-out every user at that school', async () => {
      const teacherToken = tempFixture.teachers[0].token;
      // Sanity check: the token works before delete.
      await request(app.getHttpServer())
        .get('/teacher/dashboard')
        .set(...authHeader(teacherToken))
        .then((res) => expect([200, 404]).toContain(res.status));

      await request(app.getHttpServer())
        .delete(`/admin/schools/${tempFixture.schoolId}`)
        .set(...authHeader(tempFixture.admin.token))
        .expect(200);

      const after = await request(app.getHttpServer())
        .get('/teacher/dashboard')
        .set(...authHeader(teacherToken));
      expect(after.status).toBe(401);
    });

    // AdminSchoolsService.delete() is a deliberate PERMANENT delete (see its
    // doc comment) — the school, its users, and cascaded data are gone
    // immediately, not soft-deleted into the Trash page's restore flow.
    // "Restoring" a school that was deleted via this endpoint should fail:
    // there's nothing left to restore.
    it('the school cannot be restored after a permanent delete', async () => {
      await request(app.getHttpServer())
        .get(`/admin/schools/${tempFixture.schoolId}`)
        .set(...authHeader(tempFixture.admin.token))
        .expect(404);

      await request(app.getHttpServer())
        .post('/admin/trash/restore')
        .set(...authHeader(tempFixture.admin.token))
        .send({ entity_type: 'schools', id: tempFixture.schoolId })
        .expect(404);
    });

    afterAll(async () => {
      // The school (and its fixture users) were already permanently deleted
      // by the test above — nothing left to tear down via the normal flow.
    }, 30000);
  });
});
