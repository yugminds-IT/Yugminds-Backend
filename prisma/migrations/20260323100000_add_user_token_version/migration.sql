-- Add tokenVersion to enable immediate access-token invalidation.
-- Old access tokens become invalid once tokenVersion is incremented on logout.

ALTER TABLE "User"
ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

