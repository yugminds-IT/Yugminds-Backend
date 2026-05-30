-- AlterTable TeacherReport: add rich report fields
ALTER TABLE "TeacherReport" ADD COLUMN "topicsTaught" TEXT;
ALTER TABLE "TeacherReport" ADD COLUMN "studentCount" INTEGER;
ALTER TABLE "TeacherReport" ADD COLUMN "durationHours" DOUBLE PRECISION;
ALTER TABLE "TeacherReport" ADD COLUMN "notes" TEXT;
