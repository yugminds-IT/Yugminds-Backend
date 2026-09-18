-- Track how many times a teacher has granted retake access per student.
ALTER TABLE "RetakeGrant"
  ADD COLUMN IF NOT EXISTS "grantCount" INTEGER NOT NULL DEFAULT 1;
