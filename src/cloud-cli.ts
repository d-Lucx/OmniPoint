import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCloud } from './cloud.ts';
import { cloudPayments } from './payment-config.ts';
import { poolFor } from './postgres.ts';
import type { Rail } from './treasury-protocol.ts';

const { OMNI_RUNTIME_URL, OMNI_ENROLLMENT_FILE, OMNI_SIGNING_KEY_FILE, OMNI_KEY_ID, OMNI_PORT,
  OMNI_OPERATORS_FILE, OMNI_CUSTODY_PUBLIC_KEY_FILE, OMNI_CUSTODY_KEY_ID, OMNI_SUPERVISORS_FILE,OMNI_PAYMENT_TRUST_FILE,
  OMNI_GOVERNANCE_KEY_FILE, OMNI_GOVERNANCE_KEY_ID, OMNI_TREASURY_TRUST_FILE } = process.env;
if (!OMNI_RUNTIME_URL || !OMNI_ENROLLMENT_FILE || !OMNI_SIGNING_KEY_FILE || !OMNI_KEY_ID) {
  throw new Error('Set OMNI_RUNTIME_URL, OMNI_ENROLLMENT_FILE, OMNI_SIGNING_KEY_FILE and OMNI_KEY_ID');
}
const pool = poolFor(OMNI_RUNTIME_URL);
pool.on('error', () => console.error('Idle PostgreSQL connection closed'));
if (Boolean(OMNI_CUSTODY_PUBLIC_KEY_FILE) !== Boolean(OMNI_CUSTODY_KEY_ID)) {
  throw new Error('Set both OMNI_CUSTODY_PUBLIC_KEY_FILE and OMNI_CUSTODY_KEY_ID for custody');
}
if (Boolean(OMNI_GOVERNANCE_KEY_FILE) !== Boolean(OMNI_GOVERNANCE_KEY_ID)) {
  throw new Error('Set both governance signing key variables');
}
const treasuryFile = OMNI_TREASURY_TRUST_FILE ? JSON.parse(readFileSync(OMNI_TREASURY_TRUST_FILE,'utf8')) as
  Record<'agency'|'bank', Omit<Rail,'key'> & { publicKeyFile:string }> : undefined;
function rail(value:NonNullable<typeof treasuryFile>['agency']):Rail {
  const {publicKeyFile,...config}=value;
  return {...config,key:createPublicKey(readFileSync(publicKeyFile))};
}
if (treasuryFile && (treasuryFile.agency.keyId===treasuryFile.bank.keyId || treasuryFile.agency.token===treasuryFile.bank.token))
  throw new Error('Configure separate bank and agency credentials');
const server = createCloud(pool, JSON.parse(readFileSync(OMNI_ENROLLMENT_FILE, 'utf8')), {
  id: OMNI_KEY_ID, key: createPrivateKey(readFileSync(OMNI_SIGNING_KEY_FILE)),
}, undefined, {
  operators: OMNI_OPERATORS_FILE ? JSON.parse(readFileSync(OMNI_OPERATORS_FILE, 'utf8')) : [],
  governanceSigner: OMNI_GOVERNANCE_KEY_FILE && OMNI_GOVERNANCE_KEY_ID ?
    {id:OMNI_GOVERNANCE_KEY_ID,key:createPrivateKey(readFileSync(OMNI_GOVERNANCE_KEY_FILE))} : undefined,
  treasury:treasuryFile ? {agency:rail(treasuryFile.agency),bank:rail(treasuryFile.bank)} : undefined,
  payments:OMNI_PAYMENT_TRUST_FILE?cloudPayments(OMNI_PAYMENT_TRUST_FILE):undefined,
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
