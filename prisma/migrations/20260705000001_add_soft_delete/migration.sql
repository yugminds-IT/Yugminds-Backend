-- ============================================================
-- Soft delete for User / School / Course (2026-07-05)
-- Deleted records land in the admin Trash and can be restored.
-- ============================================================

ALTER TABLE "User"   ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
