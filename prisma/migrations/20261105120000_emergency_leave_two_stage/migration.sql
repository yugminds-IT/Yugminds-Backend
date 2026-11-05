-- Emergency leave needs two sequential approvals (school admin, then admin).
-- All columns are nullable: existing leaves are untouched.
ALTER TABLE "TeacherLeave"
  ADD COLUMN "schoolAdminStatus" TEXT,
  ADD COLUMN "schoolAdminBy" TEXT,
  ADD COLUMN "schoolAdminAt" TIMESTAMP(3),
  ADD COLUMN "adminStatus" TEXT,
  ADD COLUMN "adminBy" TEXT,
  ADD COLUMN "adminAt" TIMESTAMP(3);
