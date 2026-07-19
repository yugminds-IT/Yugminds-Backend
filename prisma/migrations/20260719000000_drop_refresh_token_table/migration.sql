-- Refresh tokens moved from Postgres to Redis (see RefreshTokenStoreService).
-- DropForeignKey
ALTER TABLE "RefreshToken" DROP CONSTRAINT IF EXISTS "RefreshToken_userId_fkey";

-- DropTable
DROP TABLE IF EXISTS "RefreshToken";
