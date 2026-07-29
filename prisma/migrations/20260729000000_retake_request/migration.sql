-- ============================================================
-- Student-initiated retake requests, routed to the teacher(s) who
-- actually teach that student's grade/section (2026-07-29)
-- ============================================================

CREATE TABLE IF NOT EXISTS "RetakeRequest" (
  "id"                 TEXT NOT NULL,
  "assignmentId"       TEXT NOT NULL,
  "studentId"          INTEGER NOT NULL,
  "reason"             TEXT,
  "status"             TEXT NOT NULL DEFAULT 'pending',
  "targetTeacherIds"   INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "decidedByTeacherId" INTEGER,
  "teacherRemarks"     TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt"          TIMESTAMP(3),
  CONSTRAINT "RetakeRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetakeRequest_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RetakeRequest_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RetakeRequest_decidedByTeacherId_fkey"
    FOREIGN KEY ("decidedByTeacherId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RetakeRequest_assignmentId_idx" ON "RetakeRequest"("assignmentId");
CREATE INDEX IF NOT EXISTS "RetakeRequest_studentId_idx" ON "RetakeRequest"("studentId");
CREATE INDEX IF NOT EXISTS "RetakeRequest_status_idx" ON "RetakeRequest"("status");
