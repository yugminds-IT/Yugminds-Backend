-- ============================================================
-- Section-level course access (2026-07-28)
-- Which sections WITHIN a granted grade may access a course.
-- No rows for a grade = the whole grade (backward compatible).
-- ============================================================

CREATE TABLE IF NOT EXISTS "CourseAccessSection" (
  "id"                  TEXT NOT NULL,
  "courseAccessGradeId" TEXT NOT NULL,
  "sectionName"         TEXT NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseAccessSection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CourseAccessSection_courseAccessGradeId_fkey"
    FOREIGN KEY ("courseAccessGradeId") REFERENCES "CourseAccessGrade"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "CourseAccessSection_courseAccessGradeId_sectionName_key"
  ON "CourseAccessSection"("courseAccessGradeId", "sectionName");
CREATE INDEX IF NOT EXISTS "CourseAccessSection_courseAccessGradeId_idx"
  ON "CourseAccessSection"("courseAccessGradeId");
