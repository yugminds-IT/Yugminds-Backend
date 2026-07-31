-- TeacherSchool had no concept of a date range for a teacher's presence at
-- a school — only a day-of-week working-days pattern with no calendar
-- bound. Class Scheduling (school-admin) could therefore schedule a
-- teacher at a school they'd never actually be assigned to during that
-- window. Both columns are nullable and default to NULL on existing rows,
-- so no existing assignment/schedule is retroactively restricted — the
-- constraint only applies once an admin explicitly sets these dates.
ALTER TABLE "TeacherSchool" ADD COLUMN "assignedFrom" TIMESTAMP(3);
ALTER TABLE "TeacherSchool" ADD COLUMN "assignedUntil" TIMESTAMP(3);
