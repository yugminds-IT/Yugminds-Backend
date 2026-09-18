-- Admin / school-admin in-app notification preference flags
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "systemAlerts" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "teacherLeaveRequests" BOOLEAN NOT NULL DEFAULT true;
