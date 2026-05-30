-- Add joiningCode to StudentSchool enrollment
ALTER TABLE "StudentSchool" ADD COLUMN IF NOT EXISTS "joiningCode" TEXT;
