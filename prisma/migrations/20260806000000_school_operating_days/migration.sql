-- School had no concept of which weekdays it operates on — only individual
-- teachers had a workingDays pattern per school, with nothing constraining
-- it against the school's own schedule. Default matches the codebase's
-- existing real-world assumption (teacher-attendance.service.ts's
-- isRegularSchoolDay: "Schools here run six days a week; Saturday is a
-- normal school day... Sunday is the only automatic weekly off"), so this
-- is a true no-op for every existing school's actual behavior.
ALTER TABLE "School" ADD COLUMN "operatingDays" INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6]::INTEGER[];
