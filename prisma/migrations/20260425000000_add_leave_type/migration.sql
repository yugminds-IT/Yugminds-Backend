-- AlterTable
ALTER TABLE "TeacherLeave" ADD COLUMN IF NOT EXISTS "leaveType" TEXT NOT NULL DEFAULT 'General';
