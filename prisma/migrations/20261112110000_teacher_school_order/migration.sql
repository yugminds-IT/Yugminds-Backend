-- Admin-chosen order of a teacher's schools.
ALTER TABLE "TeacherSchool" ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0;
