-- AlterTable Notification: add optional senderId for admin "sent" view
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Notification' AND column_name = 'senderId') THEN
    ALTER TABLE "Notification" ADD COLUMN "senderId" INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema = 'public' AND constraint_name = 'Notification_senderId_fkey' AND table_name = 'Notification') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Notification_senderId_idx" ON "Notification"("senderId");
