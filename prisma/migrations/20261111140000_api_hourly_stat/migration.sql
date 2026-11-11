-- Hourly API traffic totals per role and school, for the System monitoring trends. Old rows are purged by the app.
CREATE TABLE IF NOT EXISTS "ApiHourlyStat" (
    "id" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "role" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL DEFAULT '',
    "requests" INTEGER NOT NULL DEFAULT 0,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "clientErrors" INTEGER NOT NULL DEFAULT 0,
    "serverErrors" INTEGER NOT NULL DEFAULT 0,
    "totalMs" BIGINT NOT NULL DEFAULT 0,
    "maxMs" INTEGER NOT NULL DEFAULT 0,
    "under200" INTEGER NOT NULL DEFAULT 0,
    "under500" INTEGER NOT NULL DEFAULT 0,
    "under1000" INTEGER NOT NULL DEFAULT 0,
    "over1000" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiHourlyStat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApiHourlyStat_hour_role_schoolId_key" ON "ApiHourlyStat"("hour", "role", "schoolId");
CREATE INDEX IF NOT EXISTS "ApiHourlyStat_hour_idx" ON "ApiHourlyStat"("hour");
