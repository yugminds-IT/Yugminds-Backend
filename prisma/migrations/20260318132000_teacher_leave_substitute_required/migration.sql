-- AlterTable TeacherLeave: persist substitute required flag
ALTER TABLE "TeacherLeave" ADD COLUMN "substituteRequired" BOOLEAN NOT NULL DEFAULT false;

