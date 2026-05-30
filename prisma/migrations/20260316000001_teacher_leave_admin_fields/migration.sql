-- Add admin fields to TeacherLeave and User.teacherLeaves relation (relation is implicit via teacherId)
ALTER TABLE "TeacherLeave" ADD COLUMN "adminRemarks" TEXT;
ALTER TABLE "TeacherLeave" ADD COLUMN "approvedBy" TEXT;
