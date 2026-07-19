/**
 * Loads .env deterministically for the admin e2e suite (last-DATABASE_URL-
 * wins, matching normal dotenv behavior) and logs which host it resolved to,
 * so a stale/duplicate DATABASE_URL line is always visible in test output
 * instead of silently picking whichever happens to load first.
 *
 * Import this before anything that touches PrismaClient/DatabaseService.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '../../../.env');
const parsed = fs.existsSync(envPath)
  ? dotenv.parse(fs.readFileSync(envPath))
  : {};

for (const [key, value] of Object.entries(parsed)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0';

// This DB's max_connections is 20 (confirmed via `SHOW max_connections`),
// well under DatabaseService's default pool size of 25 — a single app
// instance can already exhaust the server's entire connection budget. Each
// admin e2e spec file boots its own full AppModule (its own DatabaseService
// pool), so keep each instance small; specs run --runInBand (sequential),
// closing the pool between files via DatabaseService's onModuleDestroy.
process.env.DB_POOL_SIZE = process.env.DB_POOL_SIZE ?? '2';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'test/admin/support/env: DATABASE_URL not set — refusing to run admin e2e tests.',
  );
}

// eslint-disable-next-line no-console
console.log(
  `[admin e2e] DATABASE_URL host: ${new URL(process.env.DATABASE_URL).host}`,
);
