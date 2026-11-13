-- Half-day slots per weekday for split-day (two-school) teachers.
ALTER TABLE "TeacherSchool" ADD COLUMN "workingDaySlots" JSONB;
ALTER TABLE "TeacherWorkingDaysHistory" ADD COLUMN "workingDaySlots" JSONB;
