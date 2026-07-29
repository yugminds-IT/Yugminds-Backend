-- Migration 20260318133000_assignment_submissions created a 2-column unique
-- index on AssignmentSubmission(assignmentId, studentId). Migration
-- 20260506174500_assignment_retake_and_scores later introduced retakes via a
-- 3-column unique index (assignmentId, studentId, attemptNumber) but never
-- dropped the original 2-column index, so it silently coexisted and blocked
-- every second attempt at the database layer regardless of retake settings.
DROP INDEX IF EXISTS "AssignmentSubmission_assignmentId_studentId_key";
