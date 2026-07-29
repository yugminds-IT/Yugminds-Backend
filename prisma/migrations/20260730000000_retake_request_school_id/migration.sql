-- ============================================================
-- RetakeRequest.schoolId — course-chapter assignments carry no
-- schoolId of their own (only courseId), so target-teacher
-- resolution needs the school resolved and stored at request
-- creation time instead of re-derived from the assignment row.
-- (2026-07-30)
-- ============================================================

ALTER TABLE "RetakeRequest" ADD COLUMN IF NOT EXISTS "schoolId" TEXT;
