-- Create table for auth/login activity tracking
CREATE TABLE "AuthActivity" (
  "id" TEXT NOT NULL,
  "userId" INTEGER,
  "email" TEXT,
  "action" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL DEFAULT false,
  "failureReason" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthActivity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AuthActivity"
ADD CONSTRAINT "AuthActivity_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AuthActivity_userId_idx" ON "AuthActivity"("userId");
CREATE INDEX "AuthActivity_email_idx" ON "AuthActivity"("email");
CREATE INDEX "AuthActivity_action_idx" ON "AuthActivity"("action");
CREATE INDEX "AuthActivity_createdAt_idx" ON "AuthActivity"("createdAt");

