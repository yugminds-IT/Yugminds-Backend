-- Make chapterId nullable so DAILY assignments no longer require a course/chapter link.
-- Existing daily assignments already have a chapterId set (legacy internal link) — those are left intact.
ALTER TABLE "Assignment" ALTER COLUMN "chapterId" DROP NOT NULL;
