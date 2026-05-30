-- AlterTable TeacherReport: add grade and periodId for production-ready reports
ALTER TABLE "TeacherReport" ADD COLUMN "grade" TEXT;
ALTER TABLE "TeacherReport" ADD COLUMN "periodId" TEXT;

-- Attendance: one record per teacher per school per day (required for upsert)
-- If you have duplicate (teacherId, schoolId, date) rows, remove duplicates before running:
-- DELETE FROM "Attendance" a USING "Attendance" b WHERE a.id > b.id AND a."teacherId" = b."teacherId" AND a."schoolId" = b."schoolId" AND a.date = b.date;
CREATE UNIQUE INDEX IF NOT EXISTS "Attendance_teacherId_schoolId_date_key" ON "Attendance"("teacherId", "schoolId", "date");
