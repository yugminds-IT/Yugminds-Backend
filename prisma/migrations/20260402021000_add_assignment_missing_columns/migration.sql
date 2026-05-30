-- Align DB schema with Prisma models used by AdminCoursesService.get()
-- Required because the DB was missing some columns referenced by deep `include`s.

-- Assignment.description
ALTER TABLE "Assignment"
ADD COLUMN "description" TEXT;

-- AssignmentQuestion.options, correctAnswer, marks
ALTER TABLE "AssignmentQuestion"
ADD COLUMN "options" JSONB;

ALTER TABLE "AssignmentQuestion"
ADD COLUMN "correctAnswer" TEXT;

ALTER TABLE "AssignmentQuestion"
ADD COLUMN "marks" INTEGER NOT NULL DEFAULT 1;

