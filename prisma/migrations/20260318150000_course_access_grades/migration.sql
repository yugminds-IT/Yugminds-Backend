-- Add grades array to CourseAccess
ALTER TABLE "CourseAccess"
ADD COLUMN "grades" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

