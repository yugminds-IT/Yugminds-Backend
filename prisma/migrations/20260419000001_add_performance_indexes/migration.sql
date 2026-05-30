-- Add performance indexes for frequently filtered fields
-- PERFORMANCE FIX (DB-01): Add missing indexes to prevent full table scans

-- TeacherLeave: Filter by status for admin queries
CREATE INDEX IF NOT EXISTS "TeacherLeave_status_idx" ON "TeacherLeave"("status");
CREATE INDEX IF NOT EXISTS "TeacherLeave_teacherId_schoolId_status_idx" ON "TeacherLeave"("teacherId", "schoolId", "status");

-- StudentSchool: Filter students by grade and section
CREATE INDEX IF NOT EXISTS "StudentSchool_schoolId_grade_section_idx" ON "StudentSchool"("schoolId", "grade", "section");
CREATE INDEX IF NOT EXISTS "StudentSchool_grade_idx" ON "StudentSchool"("grade");
CREATE INDEX IF NOT EXISTS "StudentSchool_section_idx" ON "StudentSchool"("section");

-- Notification: Unread count queries
CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_deletedAt_idx" ON "Notification"("userId", "readAt", "deletedAt");

-- AssignmentSubmission: Grading queue queries
CREATE INDEX IF NOT EXISTS "AssignmentSubmission_assignmentId_status_idx" ON "AssignmentSubmission"("assignmentId", "status");
CREATE INDEX IF NOT EXISTS "AssignmentSubmission_status_idx" ON "AssignmentSubmission"("status");

-- TeacherReport: Report review queries
CREATE INDEX IF NOT EXISTS "TeacherReport_schoolId_status_reportDate_idx" ON "TeacherReport"("schoolId", "status", "reportDate");
CREATE INDEX IF NOT EXISTS "TeacherReport_status_idx" ON "TeacherReport"("status");

-- Attendance: Performance queries (already has some indexes, adding compound ones)
CREATE INDEX IF NOT EXISTS "Attendance_schoolId_date_idx" ON "Attendance"("schoolId", "date");
CREATE INDEX IF NOT EXISTS "Attendance_teacherId_date_idx" ON "Attendance"("teacherId", "date");

-- CourseProgress: Completion tracking
CREATE INDEX IF NOT EXISTS "CourseProgress_progress_updatedAt_idx" ON "CourseProgress"("progress", "updatedAt");

-- StudentCourse: Enrollment tracking
CREATE INDEX IF NOT EXISTS "StudentCourse_enrolledAt_idx" ON "StudentCourse"("enrolledAt");
CREATE INDEX IF NOT EXISTS "StudentCourse_courseId_idx" ON "StudentCourse"("courseId");
