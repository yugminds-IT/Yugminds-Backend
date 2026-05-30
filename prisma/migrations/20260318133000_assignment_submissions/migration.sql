-- CreateTable AssignmentSubmission
CREATE TABLE "AssignmentSubmission" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "studentId" INTEGER NOT NULL,
  "answers" JSONB,
  "status" TEXT NOT NULL DEFAULT 'submitted',
  "score" DOUBLE PRECISION,
  "maxScore" DOUBLE PRECISION,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "gradedAt" TIMESTAMP(3),

  CONSTRAINT "AssignmentSubmission_pkey" PRIMARY KEY ("id")
);

-- Unique: one submission per assignment per student
CREATE UNIQUE INDEX "AssignmentSubmission_assignmentId_studentId_key"
ON "AssignmentSubmission" ("assignmentId", "studentId");

-- Indexes
CREATE INDEX "AssignmentSubmission_studentId_idx"
ON "AssignmentSubmission" ("studentId");

CREATE INDEX "AssignmentSubmission_assignmentId_idx"
ON "AssignmentSubmission" ("assignmentId");

-- Foreign keys
ALTER TABLE "AssignmentSubmission"
ADD CONSTRAINT "AssignmentSubmission_assignmentId_fkey"
FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssignmentSubmission"
ADD CONSTRAINT "AssignmentSubmission_studentId_fkey"
FOREIGN KEY ("studentId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

