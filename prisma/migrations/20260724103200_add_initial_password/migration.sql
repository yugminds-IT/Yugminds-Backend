-- Store the plaintext initial password until the user changes it, so admins
-- can retrieve/export a working password for accounts that haven't logged in.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "initialPassword" TEXT;
