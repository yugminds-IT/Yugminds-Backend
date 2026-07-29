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
});
