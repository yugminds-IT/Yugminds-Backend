-- AlterTable User: add isActive
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable Profile: add qualification and experience
ALTER TABLE "Profile" ADD COLUMN "qualification" TEXT;
ALTER TABLE "Profile" ADD COLUMN "experience" TEXT;
