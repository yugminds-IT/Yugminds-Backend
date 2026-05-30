-- AlterTable Profile: add notification preference fields
ALTER TABLE "Profile" ADD COLUMN "emailNotifications" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Profile" ADD COLUMN "assignmentReminders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Profile" ADD COLUMN "gradeNotifications" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Profile" ADD COLUMN "courseUpdates" BOOLEAN NOT NULL DEFAULT true;

