import './env';
import { Pool } from 'pg';

/**
 * Raw pg pool for test setup/assertions that need to bypass the tenant-scoped
 * Prisma extension (e.g. looking up the bootstrap admin, or asserting a row's
 * state directly) — mirrors the pattern in
 * test/teacher-multi-school.e2e-spec.ts.
 *
 * This DB's max_connections is 20, and Aiven's own background workers
 * (TimescaleDB, pg_cron, failover-slots, management-agent) permanently hold
 * ~9 of those — real headroom is roughly 8-11 connections. Keep this pool
 * to a single connection and retry transient "remaining connection slots"
 * errors instead of growing the pool.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 8000,
  max: 1,
});

export interface AdminRow {
  id: number;
  email: string;
  role: string;
  isSuperAdmin: boolean;
  tenantId: string | null;
  tokenVersion: number;
}

async function queryWithRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isConnLimit = /remaining connection slots|too many.*connections/i.test(
        msg,
      );
      if (!isConnLimit || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

/** The bootstrap super-admin created on server start (ADMIN_SEED_EMAIL). */
export async function getBootstrapAdmin(): Promise<AdminRow> {
  const seedEmail = process.env.ADMIN_SEED_EMAIL;
  if (!seedEmail) throw new Error('ADMIN_SEED_EMAIL not set');
  const { rows } = await queryWithRetry(() =>
    pool.query(
      `SELECT id, email, role, "isSuperAdmin", "tenantId", "tokenVersion"
         FROM "User" WHERE email = $1 LIMIT 1`,
      [seedEmail],
    ),
  );
  if (rows.length === 0) {
    throw new Error(
      `Bootstrap admin ${seedEmail} not found — has the server booted at least once against this DB?`,
    );
  }
  return rows[0];
}

export async function getUserById(id: number): Promise<AdminRow> {
  const { rows } = await queryWithRetry(() =>
    pool.query(
      `SELECT id, email, role, "isSuperAdmin", "tenantId", "tokenVersion"
         FROM "User" WHERE id = $1 LIMIT 1`,
      [id],
    ),
  );
  if (rows.length === 0) throw new Error(`User ${id} not found`);
  return rows[0];
}

export async function closePool(): Promise<void> {
  await pool.end();
}
