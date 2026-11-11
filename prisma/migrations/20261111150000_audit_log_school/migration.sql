-- Which school an audited action was for, so the audit log can be filtered by school and by who did it.
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "schoolId" TEXT;
CREATE INDEX IF NOT EXISTS "AuditLog_schoolId_idx" ON "AuditLog"("schoolId");
CREATE INDEX IF NOT EXISTS "AuditLog_actorRole_idx" ON "AuditLog"("actorRole");
