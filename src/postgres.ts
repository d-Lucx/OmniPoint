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
    const files = ['001-cloud.sql', '002-cloud.sql', '003-cloud.sql', '004-cloud.sql'];
    const { rows } = await db.query<{ version: number }>('SELECT version FROM omni.migrations');
    for (const [index, file] of files.entries()) {
      const version = index + 1;
      if (rows.some(row => row.version === version)) continue;
      await db.query(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
      await db.query('INSERT INTO omni.migrations VALUES ($1)', [version]);
    }
    await db.query(`
      GRANT USAGE ON SCHEMA omni TO ${role};
      GRANT SELECT ON omni.tenants, omni.stores, omni.terminals, omni.cashiers, omni.stock TO ${role};
      GRANT UPDATE (on_hand) ON omni.stock TO ${role};
      GRANT SELECT, INSERT ON omni.sales, omni.receipts, omni.sale_lines, omni.stock_movements,
        omni.journals, omni.journal_lines, omni.outcomes, omni.vouchers TO ${role};
    `);
    await db.query(`
      GRANT SELECT, INSERT ON omni.stock_positions, omni.quota_slices, omni.quota_grants, omni.quota_grant_units,
        omni.custody_receipts, omni.custody_units, omni.quota_claims, omni.quota_decisions, omni.shortfalls,
        omni.replacement_units, omni.shortfall_resolutions TO ${role};
      GRANT SELECT ON omni.quota_inventory TO ${role};
    `);
    await db.query(`
      GRANT SELECT ON omni.quota_inventory_v2 TO ${role};
      GRANT SELECT, INSERT ON omni.retail_catalogs, omni.retail_positions, omni.retail_shifts,
        omni.retail_events, omni.retail_vouchers, omni.retail_receipts, omni.retail_lines, omni.retail_allocations,
        omni.retail_shortfalls, omni.retail_cash, omni.retail_postings, omni.retail_closes, omni.retail_refunds,
        omni.retail_stock_changes, omni.retail_counts, omni.retail_count_decisions TO ${role};
      GRANT UPDATE (closed, source_no) ON omni.retail_shifts TO ${role};
      GRANT UPDATE (state, payout_event_id, release_evidence) ON omni.retail_refunds TO ${role};
      GRANT SELECT, INSERT ON omni.payment_cases, omni.payment_provider_events, omni.payment_postings,
        omni.fiscal_epochs, omni.fiscal_grants, omni.fiscal_observations TO ${role};
      GRANT UPDATE (state,refund_attempt,refund_reservation,sale_id) ON omni.payment_cases TO ${role};
      GRANT UPDATE (head_sequence,head_digest,retired_by) ON omni.fiscal_epochs TO ${role};
      GRANT UPDATE (status,reason) ON omni.fiscal_observations TO ${role};
    `);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
