-- CourseService.create()'s duplicate-name guard was a read-then-write
-- check with no DB-level backing (findFirst, then create()), so two
-- concurrent POST /admin/courses with the same name could both pass the
-- check before either insert committed. Add a real partial unique index
-- (case-insensitive, live courses only) so the DB itself rejects the race,
-- and the service catches the resulting P2002 as a friendly error.
CREATE UNIQUE INDEX "Course_title_live_unique_idx"
  ON "Course" (lower("title"))
  WHERE "deletedAt" IS NULL;
