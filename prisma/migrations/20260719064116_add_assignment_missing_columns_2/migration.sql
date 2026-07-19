-- Align DB schema with Prisma models: prisma/schema.prisma's Assignment model
-- declares assignmentType/academicYear/instructions/attachments, but no prior
-- migration ever added them (they were introduced by a direct schema.prisma
-- edit without a matching migration, on a database this project's history
-- shows was already patched once before for the same reason — see
-- 20260402021000_add_assignment_missing_columns). Any query that touches the
-- Assignment table 500s with "The column `(not available)` does not exist"
-- until these are added.

ALTER TABLE "Assignment"
ADD COLUMN IF NOT EXISTS "assignmentType" TEXT NOT NULL DEFAULT 'COURSE';

ALTER TABLE "Assignment"
ADD COLUMN IF NOT EXISTS "academicYear" TEXT;

ALTER TABLE "Assignment"
ADD COLUMN IF NOT EXISTS "instructions" TEXT;

ALTER TABLE "Assignment"
ADD COLUMN IF NOT EXISTS "attachments" JSONB;

CREATE INDEX IF NOT EXISTS "Assignment_assignmentType_idx" ON "Assignment"("assignmentType");
