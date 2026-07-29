-- Removes the dead token-based email reset flow: submitPasswordResetRequest()
-- never set resetToken/resetTokenExpiresAt, and no frontend route ever called
-- verify-reset-token/complete-password-reset, so these columns were always null.
DROP INDEX IF EXISTS "PasswordResetRequest_resetToken_idx";
ALTER TABLE "PasswordResetRequest" DROP COLUMN IF EXISTS "resetToken";
ALTER TABLE "PasswordResetRequest" DROP COLUMN IF EXISTS "resetTokenExpiresAt";
