-- Comprehensive drift-alignment migration.
--
-- A repo-wide scan comparing prisma/schema.prisma (via the generated DMMF)
-- against the actual columns/tables on this database found several models
-- whose fields were added straight to schema.prisma without ever generating
-- a migration for them (same root cause as the Assignment columns fixed in
-- 20260719064116_add_assignment_missing_columns_2, and the same class of bug
-- 20260402021000_add_assignment_missing_columns fixed once before). This
-- migration brings the database back in line with the current schema.

-- AssignmentSubmission.gradedByTeacherId
ALTER TABLE "AssignmentSubmission"
ADD COLUMN IF NOT EXISTS "gradedByTeacherId" INTEGER;

-- RetakeGrant.specific (true = individual grant; false = class-wide)
ALTER TABLE "RetakeGrant"
ADD COLUMN IF NOT EXISTS "specific" BOOLEAN NOT NULL DEFAULT true;

-- CourseProgress.contentId + the schema's composite unique constraint
-- (no duplicate (studentId, courseId, chapterId) groups exist on this DB,
-- confirmed before writing this migration, so the unique index is safe to add).
ALTER TABLE "CourseProgress"
ADD COLUMN IF NOT EXISTS "contentId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "CourseProgress_studentId_courseId_chapterId_contentId_key"
  ON "CourseProgress"("studentId", "courseId", "chapterId", "contentId");

-- CommunityPageConfig.sectionColors
ALTER TABLE "CommunityPageConfig"
ADD COLUMN IF NOT EXISTS "sectionColors" JSONB;

-- StudentScoreSummary (entire table missing)
CREATE TABLE IF NOT EXISTS "StudentScoreSummary" (
  "id" TEXT NOT NULL,
  "studentId" INTEGER NOT NULL,
  "schoolId" TEXT,
  "academicYear" TEXT NOT NULL DEFAULT '2024-25',
  "courseAssignmentScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "dailyAssignmentScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "overallScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "courseAssignmentRank" INTEGER NOT NULL DEFAULT 0,
  "dailyAssignmentRank" INTEGER NOT NULL DEFAULT 0,
  "overallRank" INTEGER NOT NULL DEFAULT 0,
  "badge" TEXT NOT NULL DEFAULT 'NONE',
  "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudentScoreSummary_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StudentScoreSummary_studentId_key" ON "StudentScoreSummary"("studentId");
CREATE INDEX IF NOT EXISTS "StudentScoreSummary_schoolId_idx" ON "StudentScoreSummary"("schoolId");
CREATE INDEX IF NOT EXISTS "StudentScoreSummary_schoolId_overallScore_idx" ON "StudentScoreSummary"("schoolId", "overallScore");
CREATE INDEX IF NOT EXISTS "StudentScoreSummary_schoolId_academicYear_idx" ON "StudentScoreSummary"("schoolId", "academicYear");

-- SchoolCalendar (entire table missing)
CREATE TABLE IF NOT EXISTS "SchoolCalendar" (
  "id" TEXT NOT NULL,
  "schoolId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3),
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "academicYear" TEXT NOT NULL DEFAULT '2024-25',
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchoolCalendar_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SchoolCalendar_schoolId_idx" ON "SchoolCalendar"("schoolId");
CREATE INDEX IF NOT EXISTS "SchoolCalendar_date_idx" ON "SchoolCalendar"("date");
CREATE INDEX IF NOT EXISTS "SchoolCalendar_schoolId_date_idx" ON "SchoolCalendar"("schoolId", "date");
DO $$ BEGIN
  ALTER TABLE "SchoolCalendar" ADD CONSTRAINT "SchoolCalendar_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ContactSubmission (entire table missing — the whole admin Contact
-- Submissions tab is unusable without it)
CREATE TABLE IF NOT EXISTS "ContactSubmission" (
  "id" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "areaCode" TEXT NOT NULL DEFAULT '+91',
  "phoneNumber" TEXT,
  "purpose" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'new',
  "adminNotes" TEXT,
  "source" TEXT NOT NULL DEFAULT 'robocoders',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContactSubmission_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContactSubmission_status_idx" ON "ContactSubmission"("status");
CREATE INDEX IF NOT EXISTS "ContactSubmission_email_idx" ON "ContactSubmission"("email");
CREATE INDEX IF NOT EXISTS "ContactSubmission_createdAt_idx" ON "ContactSubmission"("createdAt");
