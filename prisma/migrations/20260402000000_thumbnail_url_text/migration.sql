-- Allow storing large thumbnail data URLs by switching thumbnailUrl to TEXT.
ALTER TABLE "Course"
ALTER COLUMN "thumbnailUrl" TYPE TEXT;

