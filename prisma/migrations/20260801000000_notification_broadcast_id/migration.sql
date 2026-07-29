ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "broadcastId" TEXT;

CREATE INDEX IF NOT EXISTS "Notification_broadcastId_idx" ON "Notification"("broadcastId");
