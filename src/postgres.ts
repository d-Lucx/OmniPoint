import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export const poolFor = (connectionString: string, max = 8): Pool => new pg.Pool({
  connectionString, max, connectionTimeoutMillis: 5000, statement_timeout: 8000,
  idle_in_transaction_session_timeout: 8000,
});

export function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid database identifier');
  return `"${value}"`;
}

export async function tenantTransaction<T>(
  pool: Pool, tenantId: string, work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query("SELECT set_config('omni.tenant_id', $1, true), set_config('synchronous_commit', 'on', true)", [tenantId]);
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

export async function migrate(pool: Pool, runtimeRole: string): Promise<void> {
  const role = identifier(runtimeRole);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(71422101)');
    await db.query('CREATE SCHEMA IF NOT EXISTS omni');
    await db.query('CREATE TABLE IF NOT EXISTS omni.migrations (version integer PRIMARY KEY)');
    const applied = await db.query('SELECT version FROM omni.migrations WHERE version = 1');
    if (!applied.rowCount) {
      await db.query(readFileSync(new URL('../migrations/001-cloud.sql', import.meta.url), 'utf8'));
      await db.query('INSERT INTO omni.migrations VALUES (1)');
    }
    await db.query(`
      GRANT USAGE ON SCHEMA omni TO ${role};
      GRANT SELECT ON omni.tenants, omni.stores, omni.terminals, omni.cashiers, omni.stock TO ${role};
      GRANT UPDATE (on_hand) ON omni.stock TO ${role};
      GRANT SELECT, INSERT ON omni.sales, omni.receipts, omni.sale_lines, omni.stock_movements,
        omni.journals, omni.journal_lines, omni.outcomes, omni.vouchers TO ${role};
    `);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
