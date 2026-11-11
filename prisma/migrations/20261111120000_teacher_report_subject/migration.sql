-- Subject taught, recorded on the report itself (chosen by the teacher).
ALTER TABLE "TeacherReport" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "TeacherReport" ADD COLUMN IF NOT EXISTS "subjectSource" TEXT;

-- One-time fill for reports sent before this existed, from the timetable slot of that period and weekday.
-- Pass 1: the exact slot (school, period, weekday, teacher, class), only when it names a single subject.
UPDATE "TeacherReport" r
SET "subject" = x.subject, "subjectSource" = 'timetable'
FROM (
  SELECT r2.id, MIN(s.subject) AS subject
  FROM "TeacherReport" r2
  JOIN "ClassSchedule" s
    ON s."schoolId" = r2."schoolId"
   AND s."periodId" = r2."periodId"
   AND s."teacherId" = r2."teacherId"
   AND s."dayOfWeek" = EXTRACT(DOW FROM r2."reportDate")::int
   AND s."isActive" = true
   AND s."subject" IS NOT NULL
   AND LOWER(TRIM(COALESCE(s."grade", ''))) = LOWER(TRIM(COALESCE(r2."grade", '')))
   AND LOWER(TRIM(COALESCE(s."section", ''))) = LOWER(TRIM(COALESCE(r2."section", '')))
  WHERE r2."subject" IS NULL
  GROUP BY r2.id
  HAVING COUNT(DISTINCT s.subject) = 1
) x
WHERE r.id = x.id;

-- Pass 2: same teacher, period and weekday when the class did not match, again only if it names one subject.
UPDATE "TeacherReport" r
SET "subject" = x.subject, "subjectSource" = 'timetable'
FROM (
  SELECT r2.id, MIN(s.subject) AS subject
  FROM "TeacherReport" r2
  JOIN "ClassSchedule" s
    ON s."schoolId" = r2."schoolId"
   AND s."periodId" = r2."periodId"
   AND s."teacherId" = r2."teacherId"
   AND s."dayOfWeek" = EXTRACT(DOW FROM r2."reportDate")::int
   AND s."isActive" = true
   AND s."subject" IS NOT NULL
  WHERE r2."subject" IS NULL
  GROUP BY r2.id
  HAVING COUNT(DISTINCT s.subject) = 1
) x
WHERE r.id = x.id;
