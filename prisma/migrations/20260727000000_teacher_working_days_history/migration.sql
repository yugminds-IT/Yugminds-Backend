-- ============================================================
-- Date-effective working-days history for teachers (2026-07-27)
-- ============================================================

CREATE TABLE IF NOT EXISTS "TeacherWorkingDaysHistory" (
  "id"              TEXT NOT NULL,
  "teacherId"       INTEGER NOT NULL,
  "schoolId"        TEXT NOT NULL,
  "workingDays"     INTEGER[] NOT NULL,
  "effectiveFrom"   TIMESTAMP(3) NOT NULL,
  "createdByUserId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeacherWorkingDaysHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeacherWorkingDaysHistory_teacherId_fkey"
    FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeacherWorkingDaysHistory_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeacherWorkingDaysHistory_teacherId_schoolId_effectiveFrom_key"
  ON "TeacherWorkingDaysHistory"("teacherId", "schoolId", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "TeacherWorkingDaysHistory_teacherId_schoolId_effectiveFrom_idx"
  ON "TeacherWorkingDaysHistory"("teacherId", "schoolId", "effectiveFrom");

-- Backfill: one initial history row per existing TeacherSchool row, using its
-- current workingDays and the assignment's createdAt (truncated to day) as
-- the best available approximation of "when this pattern started."
INSERT INTO "TeacherWorkingDaysHistory" ("id", "teacherId", "schoolId", "workingDays", "effectiveFrom", "createdAt")
SELECT gen_random_uuid(), "teacherId", "schoolId", "workingDays", date_trunc('day', "createdAt"), NOW()
FROM "TeacherSchool"
ON CONFLICT DO NOTHING;
