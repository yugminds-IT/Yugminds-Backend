-- ============================================================
-- Consolidation fixes (2026-06-10)
-- ============================================================

-- Issue 2a: Replace CourseAccess.grades[] with CourseAccessGrade junction table
CREATE TABLE IF NOT EXISTS "CourseAccessGrade" (
  "id"             TEXT NOT NULL,
  "courseAccessId" TEXT NOT NULL,
  "gradeName"      TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseAccessGrade_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CourseAccessGrade_courseAccessId_fkey"
    FOREIGN KEY ("courseAccessId") REFERENCES "CourseAccess"("id") ON DELETE CASCADE
);

-- Migrate existing CourseAccess.grades[] data into CourseAccessGrade rows
INSERT INTO "CourseAccessGrade" ("id", "courseAccessId", "gradeName", "createdAt")
SELECT
  gen_random_uuid(),
  ca."id",
  grade_name,
  NOW()
FROM "CourseAccess" ca,
     UNNEST(ca."grades") AS grade_name
WHERE ca."grades" IS NOT NULL
  AND array_length(ca."grades", 1) > 0
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS "CourseAccessGrade_courseAccessId_gradeName_key"
  ON "CourseAccessGrade"("courseAccessId", "gradeName");

CREATE INDEX IF NOT EXISTS "CourseAccessGrade_courseAccessId_idx"
  ON "CourseAccessGrade"("courseAccessId");

-- Drop the old grades array column after data migration
ALTER TABLE "CourseAccess" DROP COLUMN IF EXISTS "grades";

-- Issue 2b: Add completedAt to StudentCourse
ALTER TABLE "StudentCourse"
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "StudentCourse_completedAt_idx"
  ON "StudentCourse"("completedAt");

-- Issue 3: Remove gradesAssigned from TeacherSchool (derived from TeacherSectionAssignment)
ALTER TABLE "TeacherSchool" DROP COLUMN IF EXISTS "gradesAssigned";

-- Issue 5: Add attendanceId FK to TeacherReport
ALTER TABLE "TeacherReport"
  ADD COLUMN IF NOT EXISTS "attendanceId" TEXT;

ALTER TABLE "TeacherReport"
  ADD CONSTRAINT "TeacherReport_attendanceId_fkey"
    FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL
    NOT VALID;

-- Issue 6: Add academicYear and composite index to StudentScore
ALTER TABLE "StudentScore"
  ADD COLUMN IF NOT EXISTS "academicYear" TEXT NOT NULL DEFAULT '2024-25';

CREATE INDEX IF NOT EXISTS "StudentScore_studentId_schoolId_academicYear_idx"
  ON "StudentScore"("studentId", "schoolId", "academicYear");

-- Performance indexes
CREATE INDEX IF NOT EXISTS "AssignmentSubmission_studentId_status_idx"
  ON "AssignmentSubmission"("studentId", "status");

CREATE INDEX IF NOT EXISTS "CourseProgress_studentId_courseId_idx"
  ON "CourseProgress"("studentId", "courseId");

CREATE INDEX IF NOT EXISTS "StudentCourse_studentId_completedAt_idx"
  ON "StudentCourse"("studentId", "completedAt");

-- ============================================================
-- Issue 7: UserSchoolMembership unified view
-- Unions TeacherSchool + StudentSchool + SchoolAdmin into a
-- single query surface so new code can use one table instead of three.
-- Existing services continue to use the original tables unchanged.
-- ============================================================
CREATE OR REPLACE VIEW "UserSchoolMembership" AS
  SELECT
    ts."id",
    ts."teacherId"  AS "userId",
    ts."schoolId",
    'teacher'::TEXT AS "role",
    ts."createdAt"
  FROM "TeacherSchool" ts

  UNION ALL

  SELECT
    ss."id",
    ss."studentId"  AS "userId",
    ss."schoolId",
    'student'::TEXT AS "role",
    ss."createdAt"
  FROM "StudentSchool" ss

  UNION ALL

  SELECT
    sa."id",
    sa."userId",
    sa."schoolId",
    'school_admin'::TEXT AS "role",
    sa."createdAt"
  FROM "SchoolAdmin" sa;

COMMENT ON VIEW "UserSchoolMembership" IS
  'Unified read-only view of all user–school relationships. '
  'Use this for cross-role queries instead of joining the three tables separately. '
  'Writes must still target TeacherSchool / StudentSchool / SchoolAdmin directly.';

-- ClassSchedule composite index: replaces separate schoolId + dayOfWeek indexes.
-- Covers the common query pattern: WHERE schoolId = ? AND dayOfWeek = ? AND isActive = true
DROP INDEX IF EXISTS "ClassSchedule_schoolId_idx";
DROP INDEX IF EXISTS "ClassSchedule_dayOfWeek_idx";
CREATE INDEX IF NOT EXISTS "ClassSchedule_schoolId_dayOfWeek_isActive_idx"
  ON "ClassSchedule"("schoolId", "dayOfWeek", "isActive");
