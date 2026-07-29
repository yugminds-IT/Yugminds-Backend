-- ============================================================
-- Certificate status is now real (active | broken | revoked)
-- instead of inferred from certificateUrl string-matching, and
-- revoke becomes a soft delete with an audit trail. (2026-07-31)
-- ============================================================

ALTER TABLE "StudentCertificate" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "StudentCertificate" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "StudentCertificate" ADD COLUMN IF NOT EXISTS "revokedBy" INTEGER;
ALTER TABLE "StudentCertificate" ADD COLUMN IF NOT EXISTS "revokedReason" TEXT;

DO $$ BEGIN
  ALTER TABLE "StudentCertificate"
    ADD CONSTRAINT "StudentCertificate_revokedBy_fkey"
    FOREIGN KEY ("revokedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "StudentCertificate_status_idx" ON "StudentCertificate"("status");

-- Any row stuck on the old transient "pending" URL marker never finished
-- uploading — that's an actually-broken row, not a legitimate ongoing state.
UPDATE "StudentCertificate" SET "status" = 'broken' WHERE "certificateUrl" LIKE 'pending%';
