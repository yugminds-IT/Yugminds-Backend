-- Contact submissions were hard-deleted with no recovery path, unlike every
-- other admin-deletable entity (users, courses, schools use deletedAt).
-- Adds soft-delete support so an admin can undo an accidental delete.
ALTER TABLE "ContactSubmission" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "ContactSubmission_deletedAt_idx" ON "ContactSubmission"("deletedAt");
