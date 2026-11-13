-- One stored form for section names: "Section A", "Section B", ...
-- ("A", "a", "sec a", "Section a" all become "Section A"). Idempotent.
-- Mirrors normalizeSection() in src/common/utils/section-name.util.ts.

UPDATE "StudentSchool"
SET "section" = NULLIF('Section ' || upper(btrim(regexp_replace("section", '^(section|sec)\y[\s._-]*', '', 'i'))), 'Section ')
WHERE "section" IS NOT NULL
  AND "section" IS DISTINCT FROM NULLIF('Section ' || upper(btrim(regexp_replace("section", '^(section|sec)\y[\s._-]*', '', 'i'))), 'Section ');

UPDATE "ClassSchedule"
SET "section" = 'Section ' || upper(btrim(regexp_replace("section", '^(section|sec)\y[\s._-]*', '', 'i')))
WHERE "section" IS NOT NULL AND btrim("section") <> ''
  AND "section" <> 'Section ' || upper(btrim(regexp_replace("section", '^(section|sec)\y[\s._-]*', '', 'i')));

UPDATE "TeacherReport"
SET "section" = 'Section ' || upper(btrim(regexp_replace("section", '^(section|sec)\y[\s._-]*', '', 'i')))
WHERE "section" IS NOT NULL AND btrim("section") <> ''
  AND "section" <> 'Section ' || upper(btrim(regexp_replace("section", '^(section|sec)\y[\s._-]*', '', 'i')));

UPDATE "CourseAccessSection"
SET "sectionName" = 'Section ' || upper(btrim(regexp_replace("sectionName", '^(section|sec)\y[\s._-]*', '', 'i')))
WHERE btrim("sectionName") <> ''
  AND "sectionName" <> 'Section ' || upper(btrim(regexp_replace("sectionName", '^(section|sec)\y[\s._-]*', '', 'i')));
