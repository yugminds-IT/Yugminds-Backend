-- Add reset token fields to PasswordResetRequest
-- SECURITY: Replace plaintext temporary password with hashed reset tokens

ALTER TABLE "PasswordResetRequest" 
ADD COLUMN "resetToken" TEXT,
ADD COLUMN "resetTokenExpiresAt" TIMESTAMP(3);

-- Add index for faster token lookups
CREATE INDEX "PasswordResetRequest_resetToken_idx" ON "PasswordResetRequest"("resetToken");
