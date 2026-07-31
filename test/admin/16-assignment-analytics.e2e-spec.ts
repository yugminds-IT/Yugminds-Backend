import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool, pool } from './support/db';

/**
 * Regression coverage for a real bug: GET /admin/assignment-analytics used
 * to stamp the PLATFORM-WIDE total assignment count on every single
 * school's `assignments_created` field (AdminDashboardService.
 * getAssignmentAnalytics, `assignments_created: assignments.length`) —
 * every school in the leaderboard showed the identical number regardless
 * of how many assignments were actually relevant to it. Fixed to count only
 * assignments actually scoped/granted to that specific school.
 */
describe('Admin assignment-analytics per-school scoping', () => {
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

  it("a school's assignments_created reflects only its OWN assignments, not the platform-wide total", async () => {
    const teacherAuth = authHeader(fixture.teachers[0].token);

    // Create exactly 2 DAILY assignments scoped to the fixture's own school.
    // Assignment.teacherId/schoolId use onDelete:SetNull, not Cascade — so
    // teardownQaFixture deleting the fixture's teacher/school would NOT
    // delete these rows, just null their FKs, leaving orphaned debris behind
    // (exactly the kind of stale-assignment pollution this test exists to
    // catch in the first place). Track ids and delete them explicitly.
    const createdIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer())
        .post('/teacher/assignments')
        .set(...teacherAuth)
        .send({
          title: `QA analytics assignment ${i}`,
          schoolId: fixture.schoolId,
          assignmentType: 'DAILY',
          isPublished: true,
          publishScope: 'grade',
          publishedGradeIds: [],
          questions: [],
        })
        .expect(201);
      const id = res.body?.assignment?.id ?? res.body?.id;
      if (id) createdIds.push(id);
    }

    const res = await request(app.getHttpServer())
      .get('/admin/assignment-analytics')
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const rows = res.body?.analytics?.school_rankings ?? [];
    const fixtureRow = rows.find(
      (r: { school_id: string }) => r.school_id === fixture.schoolId,
    );
    expect(fixtureRow).toBeDefined();

    // The core regression check: this school's count must be exactly its
    // own 2 assignments — NOT the platform-wide total (which necessarily
    // differs, since other real schools have their own separate
    // assignments coexisting in the same live database during this test).
    expect(fixtureRow.assignments_created).toBe(2);

    const totalPlatformAssignments = res.body?.analytics?.summary?.total_assignments;
    if (typeof totalPlatformAssignments === 'number') {
      // Only meaningful when other assignments exist elsewhere on the
      // platform (true for this live/shared DB) — guards against a
      // regression back to "every row shows the platform total."
      expect(fixtureRow.assignments_created).toBeLessThan(totalPlatformAssignments);
    }

    if (createdIds.length) {
      await pool.query('DELETE FROM "Assignment" WHERE id = ANY($1)', [createdIds]);
    }
  });

  it('excludes unpublished (draft) assignments from assignments_created/total_assignments, matching /school-admin/leaderboard\'s own isPublished filter', async () => {
    const teacherAuth = authHeader(fixture.teachers[0].token);

    const before = await request(app.getHttpServer())
      .get('/admin/assignment-analytics')
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const beforeTotal = before.body.analytics.summary.total_assignments;
    const beforeSchoolRow = before.body.analytics.school_rankings.find(
      (r: { school_id: string }) => r.school_id === fixture.schoolId,
    );
    const beforeSchoolCount = beforeSchoolRow?.assignments_created ?? 0;

    const draftRes = await request(app.getHttpServer())
      .post('/teacher/assignments')
      .set(...teacherAuth)
      .send({
        title: 'QA analytics draft (unpublished)',
        schoolId: fixture.schoolId,
        assignmentType: 'DAILY',
        isPublished: false,
        publishScope: 'grade',
        publishedGradeIds: [],
        questions: [],
      })
      .expect(201);
    const draftId: string = draftRes.body?.assignment?.id ?? draftRes.body?.id;
    expect(draftId).toBeDefined();

    try {
      const after = await request(app.getHttpServer())
        .get('/admin/assignment-analytics')
        .set(...authHeader(fixture.admin.token))
        .expect(200);
      expect(after.body.analytics.summary.total_assignments).toBe(beforeTotal);
      const afterSchoolRow = after.body.analytics.school_rankings.find(
        (r: { school_id: string }) => r.school_id === fixture.schoolId,
      );
      expect(afterSchoolRow?.assignments_created ?? 0).toBe(beforeSchoolCount);
    } finally {
      await pool.query('DELETE FROM "Assignment" WHERE id = $1', [draftId]);
    }
  });

  it(
    "honors the assignment's retakeScoringRule ('latest') when picking the best submission per " +
      'student — regression: this endpoint used to always prefer the higher-scoring attempt ' +
      'regardless of the rule, disagreeing with the canonical StudentRankingService used by ' +
      'top_students_platform and every other dashboard',
    async () => {
      const teacherAuth = authHeader(fixture.teachers[0].token);
      const student = fixture.students[0];

      const createRes = await request(app.getHttpServer())
        .post('/teacher/assignments')
        .set(...teacherAuth)
        .send({
          title: 'QA analytics retake-rule assignment',
          schoolId: fixture.schoolId,
          assignmentType: 'DAILY',
          isPublished: true,
          publishScope: 'grade',
          publishedGradeIds: [],
          retakeEnabled: true,
          retakeScoringRule: 'latest',
          questions: [],
        })
        .expect(201);
      const assignmentId: string = createRes.body?.assignment?.id ?? createRes.body?.id;
      expect(assignmentId).toBeDefined();

      try {
        // Attempt 1: high score. Attempt 2 (the real "latest"): lower score.
        await pool.query(
          `INSERT INTO "AssignmentSubmission"
             (id, "assignmentId", "studentId", "attemptNumber", status, score, "maxScore", "submittedAt")
           VALUES (gen_random_uuid(), $1, $2, 1, 'graded', 9, 10, now() - interval '1 hour')`,
          [assignmentId, student.id],
        );
        await pool.query(
          `INSERT INTO "AssignmentSubmission"
             (id, "assignmentId", "studentId", "attemptNumber", status, score, "maxScore", "submittedAt")
           VALUES (gen_random_uuid(), $1, $2, 2, 'graded', 3, 10, now())`,
          [assignmentId, student.id],
        );

        const res = await request(app.getHttpServer())
          .get('/admin/assignment-analytics')
          .set(...authHeader(fixture.admin.token))
          .expect(200);
        const schoolRow = res.body.analytics.school_rankings.find(
          (r: { school_id: string }) => r.school_id === fixture.schoolId,
        );
        expect(schoolRow).toBeDefined();
        // With only this one graded submission-pair contributing to the
        // school's score aggregate (a fresh assignment, no other activity on
        // it), average_score_percentage must reflect the LATEST attempt
        // (3/10 = 30%), not the higher-scoring first attempt (9/10 = 90%).
        expect(schoolRow.average_score_percentage).toBeCloseTo(30, 0);
      } finally {
        await pool.query('DELETE FROM "AssignmentSubmission" WHERE "assignmentId" = $1', [
          assignmentId,
        ]);
        await pool.query('DELETE FROM "Assignment" WHERE id = $1', [assignmentId]);
      }
    },
  );
});
