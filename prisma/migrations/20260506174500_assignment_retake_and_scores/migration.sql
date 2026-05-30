-- Assignment + retake + score-summary expansion

ALTER TABLE "Assignment"
  ADD COLUMN IF NOT EXISTS "courseId" TEXT,
  ADD COLUMN IF NOT EXISTS "gradeId" TEXT,
  ADD COLUMN IF NOT EXISTS "teacherId" INTEGER,
  ADD COLUMN IF NOT EXISTS "schoolId" TEXT,
  ADD COLUMN IF NOT EXISTS "subject" TEXT,
  ADD COLUMN IF NOT EXISTS "totalMarks" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "isPublished" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "publishScope" TEXT NOT NULL DEFAULT 'grade',
  ADD COLUMN IF NOT EXISTS "publishedGradeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "publishedSectionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "retakeEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "maxRetakeAttempts" INTEGER,
  ADD COLUMN IF NOT EXISTS "retakeScoringRule" TEXT NOT NULL DEFAULT 'latest',
  ADD COLUMN IF NOT EXISTS "retakeWindowOpen" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "retakeAccessScope" TEXT NOT NULL DEFAULT 'all';

UPDATE "Assignment" a
SET "courseId" = ch."courseId"
FROM "Chapter" ch
WHERE ch."id" = a."chapterId" AND a."courseId" IS NULL;

UPDATE "Assignment" a
SET "totalMarks" = q."sumMarks"
FROM (
  SELECT "assignmentId", COALESCE(SUM("marks"), 0)::double precision AS "sumMarks"
  FROM "AssignmentQuestion"
  GROUP BY "assignmentId"
) q
WHERE q."assignmentId" = a."id" AND a."totalMarks" IS NULL;

ALTER TABLE "AssignmentSubmission"
  ADD COLUMN IF NOT EXISTS "attemptNumber" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "feedback" TEXT,
  ADD COLUMN IF NOT EXISTS "isRetake" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'AssignmentSubmission_assignmentId_studentId_key'
  ) THEN
    ALTER TABLE "AssignmentSubmission"
      DROP CONSTRAINT "AssignmentSubmission_assignmentId_studentId_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AssignmentSubmission_assignmentId_studentId_attemptNumber_key"
  ON "AssignmentSubmission"("assignmentId", "studentId", "attemptNumber");

CREATE INDEX IF NOT EXISTS "AssignmentSubmission_assignmentId_studentId_idx"
  ON "AssignmentSubmission"("assignmentId", "studentId");

CREATE TABLE IF NOT EXISTS "RetakeGrant" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "studentId" INTEGER NOT NULL,
  "grantedByTeacherId" INTEGER NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "RetakeGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RetakeGrant_assignmentId_studentId_key"
  ON "RetakeGrant"("assignmentId", "studentId");
CREATE INDEX IF NOT EXISTS "RetakeGrant_studentId_idx" ON "RetakeGrant"("studentId");
CREATE INDEX IF NOT EXISTS "RetakeGrant_grantedByTeacherId_idx" ON "RetakeGrant"("grantedByTeacherId");

CREATE TABLE IF NOT EXISTS "StudentScore" (
  "id" TEXT NOT NULL,
  "studentId" INTEGER NOT NULL,
  "schoolId" TEXT,
  "gradeId" TEXT,
  "courseId" TEXT,
  "subject" TEXT,
  "cumulativeScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cumulativeMaxScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "gpaLikeScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "scoringRule" TEXT NOT NULL DEFAULT 'latest',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudentScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StudentScore_studentId_courseId_subject_key"
  ON "StudentScore"("studentId", "courseId", "subject");
CREATE INDEX IF NOT EXISTS "StudentScore_studentId_idx" ON "StudentScore"("studentId");
CREATE INDEX IF NOT EXISTS "StudentScore_schoolId_idx" ON "StudentScore"("schoolId");
CREATE INDEX IF NOT EXISTS "StudentScore_gradeId_idx" ON "StudentScore"("gradeId");
CREATE INDEX IF NOT EXISTS "StudentScore_courseId_idx" ON "StudentScore"("courseId");

ALTER TABLE "Assignment"
  ADD CONSTRAINT "Assignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Assignment_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Assignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Assignment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RetakeGrant"
  ADD CONSTRAINT "RetakeGrant_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RetakeGrant_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RetakeGrant_grantedByTeacherId_fkey" FOREIGN KEY ("grantedByTeacherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentScore"
  ADD CONSTRAINT "StudentScore_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "StudentScore_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "StudentScore_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "StudentScore_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One-time bootstrap backfill for StudentScore from existing graded submissions
WITH latest_attempt_per_assignment AS (
  SELECT DISTINCT ON (s."assignmentId", s."studentId")
    s."id",
    s."assignmentId",
    s."studentId",
    s."score",
    s."maxScore",
    s."gradedAt",
    s."submittedAt"
  FROM "AssignmentSubmission" s
  ORDER BY s."assignmentId", s."studentId", s."attemptNumber" DESC, s."submittedAt" DESC
),
agg AS (
  SELECT
    la."studentId",
    a."schoolId",
    a."gradeId",
    a."courseId",
    COALESCE(a."subject", 'General') AS "subject",
    COALESCE(SUM(la."score"), 0)::double precision AS "cumulativeScore",
    COALESCE(SUM(COALESCE(la."maxScore", a."totalMarks", 0)), 0)::double precision AS "cumulativeMaxScore"
  FROM latest_attempt_per_assignment la
  JOIN "Assignment" a ON a."id" = la."assignmentId"
  GROUP BY la."studentId", a."schoolId", a."gradeId", a."courseId", COALESCE(a."subject", 'General')
)
INSERT INTO "StudentScore" (
  "id",
  "studentId",
  "schoolId",
  "gradeId",
  "courseId",
  "subject",
  "cumulativeScore",
  "cumulativeMaxScore",
  "percentage",
  "gpaLikeScore",
  "scoringRule",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  agg."studentId",
  agg."schoolId",
  agg."gradeId",
  agg."courseId",
  agg."subject",
  agg."cumulativeScore",
  agg."cumulativeMaxScore",
  CASE WHEN agg."cumulativeMaxScore" > 0 THEN ROUND(((agg."cumulativeScore" / agg."cumulativeMaxScore") * 100)::numeric, 2)::double precision ELSE 0 END,
  CASE WHEN agg."cumulativeMaxScore" > 0 THEN ROUND(((agg."cumulativeScore" / agg."cumulativeMaxScore") * 4)::numeric, 2)::double precision ELSE 0 END,
  'latest',
  NOW()
FROM agg
ON CONFLICT ("studentId", "courseId", "subject")
DO UPDATE SET
  "cumulativeScore" = EXCLUDED."cumulativeScore",
  "cumulativeMaxScore" = EXCLUDED."cumulativeMaxScore",
  "percentage" = EXCLUDED."percentage",
  "gpaLikeScore" = EXCLUDED."gpaLikeScore",
  "updatedAt" = NOW();
