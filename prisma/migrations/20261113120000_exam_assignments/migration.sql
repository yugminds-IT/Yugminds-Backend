ALTER TABLE "Assignment" ADD COLUMN IF NOT EXISTS "examType" TEXT;
ALTER TABLE "Assignment" ADD COLUMN IF NOT EXISTS "startsAt" TIMESTAMP(3);
ALTER TABLE "Assignment" ADD COLUMN IF NOT EXISTS "endsAt" TIMESTAMP(3);
ALTER TABLE "Assignment" ADD COLUMN IF NOT EXISTS "durationMinutes" INTEGER;
CREATE INDEX IF NOT EXISTS "Assignment_assignmentType_schoolId_idx" ON "Assignment"("assignmentType", "schoolId");

CREATE TABLE IF NOT EXISTS "AssignmentAttemptStart" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "studentId" INTEGER NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssignmentAttemptStart_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssignmentAttemptStart_assignmentId_studentId_attemptNumber_key" ON "AssignmentAttemptStart"("assignmentId", "studentId", "attemptNumber");
CREATE INDEX IF NOT EXISTS "AssignmentAttemptStart_studentId_idx" ON "AssignmentAttemptStart"("studentId");
DO $$ BEGIN
  ALTER TABLE "AssignmentAttemptStart" ADD CONSTRAINT "AssignmentAttemptStart_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AssignmentAttemptStart" ADD CONSTRAINT "AssignmentAttemptStart_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
