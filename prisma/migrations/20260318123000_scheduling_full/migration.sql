-- Extend Room for scheduling UI
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "roomNumber" TEXT;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "roomName" TEXT;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "location" TEXT;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "facilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill roomNumber from name if empty
UPDATE "Room" SET "roomNumber" = COALESCE("roomNumber", "name") WHERE "roomNumber" IS NULL;

-- Extend Period for scheduling UI
ALTER TABLE "Period" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "Period" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Extend ClassSchedule for full timetable entries
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "teacherId" INTEGER;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "roomId" TEXT;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "grade" TEXT;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "classId" TEXT;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "academicYear" TEXT DEFAULT '2024-25';
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "startTime" TEXT;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "endTime" TEXT;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;

-- Helpful indexes
CREATE INDEX IF NOT EXISTS "ClassSchedule_teacherId_idx" ON "ClassSchedule"("teacherId");
CREATE INDEX IF NOT EXISTS "ClassSchedule_roomId_idx" ON "ClassSchedule"("roomId");
