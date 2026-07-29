-- ============================================================
-- Admin-only school calendar: batch tracking for "apply to all
-- schools" holidays + attribution of who created an entry (2026-07-25)
-- ============================================================

ALTER TABLE "SchoolCalendar" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
ALTER TABLE "SchoolCalendar" ADD COLUMN IF NOT EXISTS "createdByUserId" INTEGER;

CREATE INDEX IF NOT EXISTS "SchoolCalendar_batchId_idx" ON "SchoolCalendar"("batchId");
