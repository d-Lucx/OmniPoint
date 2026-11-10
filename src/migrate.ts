import { migrate, poolFor } from './postgres.ts';

const { OMNI_MIGRATION_URL, OMNI_RUNTIME_ROLE } = process.env;
if (!OMNI_MIGRATION_URL || !OMNI_RUNTIME_ROLE) throw new Error('Set OMNI_MIGRATION_URL and OMNI_RUNTIME_ROLE');
const pool = poolFor(OMNI_MIGRATION_URL);
try {
  await migrate(pool, OMNI_RUNTIME_ROLE);
  console.log('OmniPoint PostgreSQL schema is ready');
} catch (error) {
  console.error('Migration failed', typeof error === 'object' && error && 'code' in error ? error.code : '');
  process.exitCode = 1;
} finally {
  await pool.end();
}
