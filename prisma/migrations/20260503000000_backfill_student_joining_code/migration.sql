-- Backfill joiningCode on StudentSchool rows where a student self-registered
-- via a join code but the code was not persisted (bug introduced before fix).
--
-- Strategy: for each StudentSchool row with joiningCode IS NULL, find the
-- JoinCode that matches the same schoolId AND grade AND whose usedCount > 0.
-- When exactly one such code exists for that (schoolId, grade) pair we can
-- safely assign it. Where multiple codes match we leave the row NULL to avoid
-- incorrect attribution.

UPDATE "StudentSchool" ss
SET    "joiningCode" = jc.code
FROM   "JoinCode" jc
WHERE  ss."joiningCode" IS NULL
  AND  ss."schoolId"    = jc."schoolId"
  AND  ss."grade"       = jc."grade"
  AND  jc."usedCount"   > 0
  -- Only update when there is exactly one candidate code for this (school, grade)
  AND  (
    SELECT COUNT(*)
    FROM   "JoinCode" jc2
    WHERE  jc2."schoolId"  = ss."schoolId"
      AND  jc2."grade"     = ss."grade"
      AND  jc2."usedCount" > 0
  ) = 1;
