-- Sequential numeric ids for entities whose primary key is a UUID, used only
-- for S3 storage folder names (e.g. logos/1/..., course-uploads/.../course-2/)
-- so bucket paths read "1, 2, 3" instead of raw UUIDs. Backfilled in creation
-- order for existing rows; new rows get the next sequence value automatically.

-- School.schoolNumber
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "schoolNumber" INTEGER;
CREATE SEQUENCE IF NOT EXISTS "School_schoolNumber_seq";
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn FROM "School"
)
UPDATE "School" s SET "schoolNumber" = ordered.rn
FROM ordered WHERE s.id = ordered.id AND s."schoolNumber" IS NULL;
SELECT setval('"School_schoolNumber_seq"', COALESCE((SELECT MAX("schoolNumber") FROM "School"), 0) + 1, false);
ALTER TABLE "School" ALTER COLUMN "schoolNumber" SET DEFAULT nextval('"School_schoolNumber_seq"');
ALTER TABLE "School" ALTER COLUMN "schoolNumber" SET NOT NULL;
ALTER SEQUENCE "School_schoolNumber_seq" OWNED BY "School"."schoolNumber";
CREATE UNIQUE INDEX IF NOT EXISTS "School_schoolNumber_key" ON "School"("schoolNumber");

-- Course.courseNumber
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "courseNumber" INTEGER;
CREATE SEQUENCE IF NOT EXISTS "Course_courseNumber_seq";
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn FROM "Course"
)
UPDATE "Course" c SET "courseNumber" = ordered.rn
FROM ordered WHERE c.id = ordered.id AND c."courseNumber" IS NULL;
SELECT setval('"Course_courseNumber_seq"', COALESCE((SELECT MAX("courseNumber") FROM "Course"), 0) + 1, false);
ALTER TABLE "Course" ALTER COLUMN "courseNumber" SET DEFAULT nextval('"Course_courseNumber_seq"');
ALTER TABLE "Course" ALTER COLUMN "courseNumber" SET NOT NULL;
ALTER SEQUENCE "Course_courseNumber_seq" OWNED BY "Course"."courseNumber";
CREATE UNIQUE INDEX IF NOT EXISTS "Course_courseNumber_key" ON "Course"("courseNumber");

-- Chapter.chapterNumber
ALTER TABLE "Chapter" ADD COLUMN IF NOT EXISTS "chapterNumber" INTEGER;
CREATE SEQUENCE IF NOT EXISTS "Chapter_chapterNumber_seq";
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn FROM "Chapter"
)
UPDATE "Chapter" ch SET "chapterNumber" = ordered.rn
FROM ordered WHERE ch.id = ordered.id AND ch."chapterNumber" IS NULL;
SELECT setval('"Chapter_chapterNumber_seq"', COALESCE((SELECT MAX("chapterNumber") FROM "Chapter"), 0) + 1, false);
ALTER TABLE "Chapter" ALTER COLUMN "chapterNumber" SET DEFAULT nextval('"Chapter_chapterNumber_seq"');
ALTER TABLE "Chapter" ALTER COLUMN "chapterNumber" SET NOT NULL;
ALTER SEQUENCE "Chapter_chapterNumber_seq" OWNED BY "Chapter"."chapterNumber";
CREATE UNIQUE INDEX IF NOT EXISTS "Chapter_chapterNumber_key" ON "Chapter"("chapterNumber");
