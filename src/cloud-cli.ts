import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCloud } from './cloud.ts';
import { poolFor } from './postgres.ts';

const { OMNI_RUNTIME_URL, OMNI_ENROLLMENT_FILE, OMNI_SIGNING_KEY_FILE, OMNI_KEY_ID, OMNI_PORT,
  OMNI_OPERATORS_FILE, OMNI_CUSTODY_PUBLIC_KEY_FILE, OMNI_CUSTODY_KEY_ID, OMNI_SUPERVISORS_FILE } = process.env;
if (!OMNI_RUNTIME_URL || !OMNI_ENROLLMENT_FILE || !OMNI_SIGNING_KEY_FILE || !OMNI_KEY_ID) {
  throw new Error('Set OMNI_RUNTIME_URL, OMNI_ENROLLMENT_FILE, OMNI_SIGNING_KEY_FILE and OMNI_KEY_ID');
}
const pool = poolFor(OMNI_RUNTIME_URL);
pool.on('error', () => console.error('Idle PostgreSQL connection closed'));
if (Boolean(OMNI_CUSTODY_PUBLIC_KEY_FILE) !== Boolean(OMNI_CUSTODY_KEY_ID)) {
  throw new Error('Set both OMNI_CUSTODY_PUBLIC_KEY_FILE and OMNI_CUSTODY_KEY_ID for custody');
}
const server = createCloud(pool, JSON.parse(readFileSync(OMNI_ENROLLMENT_FILE, 'utf8')), {
  id: OMNI_KEY_ID, key: createPrivateKey(readFileSync(OMNI_SIGNING_KEY_FILE)),
}, undefined, {
  operators: OMNI_OPERATORS_FILE ? JSON.parse(readFileSync(OMNI_OPERATORS_FILE, 'utf8')) : [],
  supervisors: OMNI_SUPERVISORS_FILE ? (JSON.parse(readFileSync(OMNI_SUPERVISORS_FILE, 'utf8')) as Array<{
    tenantId: string; storeId: string; actorId: string; publicKeyFile: string;
  }>).map(({ publicKeyFile, ...scope }) => ({ ...scope, publicKey: createPublicKey(readFileSync(publicKeyFile)) })) : [],
  custodyKeys: OMNI_CUSTODY_PUBLIC_KEY_FILE && OMNI_CUSTODY_KEY_ID
    ? new Map([[OMNI_CUSTODY_KEY_ID, createPublicKey(readFileSync(OMNI_CUSTODY_PUBLIC_KEY_FILE))]])
    : undefined,
});
const { rows: [role] } = await pool.query(`
  SELECT NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR
    pg_has_role(current_user, nspowner, 'MEMBER')) AS restricted
  FROM pg_roles JOIN pg_namespace ON nspname = 'omni' WHERE rolname = current_user
`);
if (!role?.restricted) {
  await pool.end();
  throw new Error('Run the migration and connect as a restricted runtime role');
}
server.listen(Number(OMNI_PORT ?? 3000), '127.0.0.1', () => console.log('OmniPoint cloud listening on loopback'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => void pool.end()));
}
