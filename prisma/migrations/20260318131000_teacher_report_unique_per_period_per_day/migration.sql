-- Ensure only one report per teacher+school+day+period (periodId)
-- Note: reportDate is stored at a fixed time (noon UTC) in code for daily reports.

CREATE UNIQUE INDEX "TeacherReport_teacherId_schoolId_reportDate_periodId_key"
ON "TeacherReport" ("teacherId", "schoolId", "reportDate", "periodId");

-- Supporting indexes for list/dedupe queries
CREATE INDEX "TeacherReport_teacherId_schoolId_reportDate_idx"
ON "TeacherReport" ("teacherId", "schoolId", "reportDate");

CREATE INDEX "TeacherReport_teacherId_schoolId_reportDate_periodId_idx"
ON "TeacherReport" ("teacherId", "schoolId", "reportDate", "periodId");

