-- AlterTable TeacherReport: persist time + activities
ALTER TABLE "TeacherReport" ADD COLUMN "startTime" TEXT;
ALTER TABLE "TeacherReport" ADD COLUMN "endTime" TEXT;
ALTER TABLE "TeacherReport" ADD COLUMN "activities" TEXT;

