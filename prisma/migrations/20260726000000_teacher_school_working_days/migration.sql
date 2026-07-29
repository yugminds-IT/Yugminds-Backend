-- ============================================================
-- Per-school weekly working days for teachers (2026-07-26)
-- ============================================================

ALTER TABLE "TeacherSchool" ADD COLUMN IF NOT EXISTS "workingDays" INTEGER[] DEFAULT '{1,2,3,4,5}';
