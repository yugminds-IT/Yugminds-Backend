-- ============================================================
-- Admin audit log + saved table views (2026-07-05)
-- ============================================================

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id"         TEXT NOT NULL,
  "actorId"    INTEGER,
  "actorEmail" TEXT,
  "actorRole"  TEXT,
  "method"     TEXT NOT NULL,
  "path"       TEXT NOT NULL,
  "entityType" TEXT,
  "entityId"   TEXT,
  "payload"    JSONB,
  "statusCode" INTEGER,
  "success"    BOOLEAN NOT NULL DEFAULT true,
  "ipAddress"  TEXT,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditLog_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_idx" ON "AuditLog"("entityType");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_method_idx" ON "AuditLog"("method");

CREATE TABLE IF NOT EXISTS "AdminSavedView" (
  "id"        TEXT NOT NULL,
  "userId"    INTEGER NOT NULL,
  "tableKey"  TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "state"     JSONB NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminSavedView_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminSavedView_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdminSavedView_userId_tableKey_name_key"
  ON "AdminSavedView"("userId", "tableKey", "name");
CREATE INDEX IF NOT EXISTS "AdminSavedView_userId_tableKey_idx"
  ON "AdminSavedView"("userId", "tableKey");
