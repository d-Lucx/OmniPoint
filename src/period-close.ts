import type { KeyObject } from 'node:crypto';
import type { PoolClient } from 'pg';
import { openArtifact, signArtifact } from './authority.ts';
import { digest, isUuid, jsonBytes, record } from './protocol.ts';
import type { SigningKey } from './protocol.ts';
import { InventoryError } from './quota-cloud.ts';

export const isPeriod = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

export function canonical(value: unknown): Buffer {
  function sorted(data: unknown): unknown {
    if (Array.isArray(data)) return data.map(sorted);
    if (data && typeof data === 'object') return Object.fromEntries(
      Object.entries(data).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,field]) => [key,sorted(field)]));
    return data;
  }
  return jsonBytes(sorted(value));
}

export async function ledgerLock(db: PoolClient, tenant: string) {
  await db.query('SELECT omni.ledger_lock($1)',[tenant]);
}

export async function ledgerWriter(db:PoolClient,tenant:string) {
  await db.query('SELECT omni.ledger_lock_shared($1)',[tenant]);
}

export interface LedgerLine {
  line_id: string; journal_id: string; period: string; business_at: string; account: string; minor: number;
}
export async function ledgerCut(db: PoolClient, tenant: string, period: string) {
  return (await db.query<LedgerLine>(`SELECT line_id,journal_id,period,
    to_char(business_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS business_at,account,minor
    FROM omni.ledger_lines WHERE tenant_id=$1 AND period=$2 ORDER BY journal_id COLLATE "C",line_id COLLATE "C"`,
    [tenant,period])).rows;
}

const evidenceTables = [
  'sales','receipts','outcomes','vouchers','retail_shifts','retail_events','retail_receipts','retail_vouchers',
  'retail_closes','retail_cash','retail_refunds','retail_shortfalls','module_tenders','quota_grants','custody_receipts',
  'payment_cases','payment_provider_events','fiscal_epochs','fiscal_observations','cash_custody','governed_adjustments','late_ledger_holds',
] as const;
const treasuryTables=['treasury_accounts','treasury_attempts','treasury_facts','treasury_collisions','treasury_positions','treasury_effects'] as const;

async function evidenceCut(db: PoolClient, tenant: string) {
  const present=(await db.query<{name:string|null}>("SELECT to_regclass('omni.treasury_accounts')::text AS name")).rows[0].name;
  const tables=present ? [...evidenceTables,...treasuryTables] : evidenceTables;
  return db.query<{evidence: Record<string,unknown>}>(`SELECT jsonb_build_object(
    ${tables.map(name => `'${name}', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),'[]')
      FROM omni.${name} t WHERE t.tenant_id=$1)`).join(',')}
  ) AS evidence`,[tenant]).then(result => {
    const {evidence}=result.rows[0];
    return {...evidence,holds:evidenceHolds(evidence)};
  });
}

function evidenceHolds(evidence:Record<string,unknown>) {
  const rows=(name:string)=>((evidence[name] ?? []) as unknown[]).map(record);
  const custody=rows('cash_custody');
  const posted=rows('retail_closes');
  const latest=new Map<unknown,Record<string,unknown>>();
  for (const row of posted) {
    if (!latest.has(row.shift_id) || Number(latest.get(row.shift_id)!.covered_no)<Number(row.covered_no))
      latest.set(row.shift_id,row);
  }
  return [
    ...rows('retail_cash').filter(row=>row.kind==='DROP' &&
      !custody.some(event=>event.kind==='VAULT_RECEIVE' && event.source===row.event_id))
      .map(row=>({kind:'DROP',id:row.event_id,state:'IN_TRANSIT'})),
    ...custody.filter(row=>row.kind==='DEPOSIT_SEND' &&
      !custody.some(event=>event.kind==='DEPOSIT_RECEIVE' && event.source===row.id))
      .map(row=>({kind:'DEPOSIT',id:row.id,state:'IN_TRANSIT'})),
    ...[...latest.values()].flatMap(row=>{
      const recognized=custody.filter(event=>event.kind==='DRAWER_VARIANCE' && record(event.facts).shift===row.shift_id)
        .reduce((sum,event)=>sum+Number(event.minor),0);
      return recognized!==row.variance_minor ? [{kind:'DRAWER',id:row.event_id,state:'VARIANCE_PENDING'}] : [];
    }),
    ...rows('payment_cases').filter(row=>row.state==='CAPTURED' || row.state==='REFUND_RESERVED')
      .map(row=>({kind:'PAYMENT',id:row.intent_id,state:row.state})),
    ...rows('late_ledger_holds').map(row=>({kind:'LATE_POSTING',id:row.digest,state:'PERIOD_SEALED'})),
    ...rows('treasury_attempts').filter(row=>row.state==='MAY_HAVE_SENT')
      .map(row=>({kind:'TREASURY_ATTEMPT',id:row.attempt,state:row.state})),
    ...rows('treasury_positions').filter(row=>['late','surplus','incident','pending-attestation','proof','funding','tombstone']
      .includes(String(row.kind)) && !['FINAL','RESOLVED','APPLIED','RELEASED','CORRECTED'].includes(String(row.state)))
      .map(row=>({kind:'TREASURY_'+String(row.kind).toUpperCase(),id:row.id,state:row.state})),
  ];
}

function balances(lines: LedgerLine[], period: string) {
  const sum = new Map<string,number>();
  const journals = new Map<string,number>();
  const seen = new Set<string>();
  let previous = '';
  if (!Array.isArray(lines)) throw new Error('Ledger object must be an array');
  for (const line of lines) {
    if (typeof line.line_id !== 'string' || typeof line.journal_id !== 'string' || typeof line.account !== 'string' ||
        !Number.isInteger(line.minor) || line.minor === 0 || line.period !== period ||
        typeof line.business_at !== 'string' || line.business_at.slice(0,7) !== period || seen.has(line.line_id))
      throw new Error('Invalid journal member');
    const key = line.journal_id+'\0'+line.line_id;
    const balance = (sum.get(line.account) ?? 0)+line.minor;
    const journal = (journals.get(line.journal_id) ?? 0)+line.minor;
    if (key<=previous || !Number.isSafeInteger(balance) || !Number.isSafeInteger(journal))
      throw new Error('Invalid ledger order or balance');
    previous=key;
    seen.add(line.line_id);
    sum.set(line.account,balance);
    journals.set(line.journal_id,journal);
  }
  if ([...journals.values()].some(value => value !== 0)) throw new Error('Unbalanced journal in close cut');
  return Object.fromEntries(sum);
}

const purpose = 'period-seal-v1';
export type SealBundle = { packet: unknown; objects: Record<string,unknown> };

export function verifySeal(bundle: SealBundle, keys: ReadonlyMap<string,KeyObject>,
  expected: {tenant: string; period: string; previous: string | null}) {
  const {data,bytes} = openArtifact(purpose,bundle.packet,keys);
  if (data.tenant !== expected.tenant || data.period !== expected.period || data.previous !== expected.previous ||
      data.schema !== 1 || data.hash !== 'sha256' || !isUuid(data.id) || !isUuid(data.actor) || !isUuid(data.approval) ||
      !bytes.equals(canonical(data))) throw new Error('Seal scope, lineage or encoding mismatch');
  if (Object.keys(bundle.objects).sort().join() !== 'evidence,ledger') throw new Error('Missing close object');
  const refs = record(data.objects);
  for (const key of ['ledger','evidence']) {
    if (refs[key] !== digest(canonical(bundle.objects[key]))) throw new Error('Close object digest mismatch');
  }
  const lines = bundle.objects.ledger as LedgerLine[];
  if (data.members !== lines.length || !canonical(data.balances).equals(canonical(balances(lines,expected.period))))
    throw new Error('Close membership or balances mismatch');
  const evidence = record(bundle.objects.evidence);
  const tables=treasuryTables.some(table=>Object.hasOwn(evidence,table)) ? [...evidenceTables,...treasuryTables] : evidenceTables;
  for (const table of tables) {
    const rows = evidence[table];
    if (!Array.isArray(rows) || rows.some(row => record(row).tenant_id !== expected.tenant))
      throw new Error('Evidence scope mismatch');
  }
  if (!canonical(evidence.holds).equals(canonical(evidenceHolds(evidence))) ||
      data.holdCount!==(evidence.holds as unknown[]).length) throw new Error('Close hold membership mismatch');
  return {manifest:data,lines,evidence};
}

export async function loadSeal(db: PoolClient, tenant: string, period: string) {
  return (await db.query<{seal_id:string;previous_id:string|null;packet:unknown;manifest:Buffer;objects:Record<string,unknown>}>(
    'SELECT seal_id,previous_id,packet,manifest,objects FROM omni.period_seals WHERE tenant_id=$1 AND period=$2',[tenant,period],
  )).rows[0];
}

export async function sealPeriod(db: PoolClient, tenant: string, actor: string, input: Record<string,unknown>, signer: SigningKey) {
  const {period,id,previous,approval} = input;
  if (!isPeriod(period) || !isUuid(id) || (previous !== null && !isUuid(previous)) || !isUuid(approval))
    throw new InventoryError('INVALID_CLOSE_APPROVAL',422);
  await ledgerLock(db,tenant);
  const prior = await loadSeal(db,tenant,period);
  if (prior) {
    const data = JSON.parse(prior.manifest.toString()) as Record<string,unknown>;
    if (prior.seal_id !== id || prior.previous_id !== previous || data.approval !== approval || data.actor !== actor)
      throw new InventoryError('PERIOD_ALREADY_SEALED',409);
    return {packet:prior.packet,objects:prior.objects};
  }
  const head = (await db.query<{period:string;seal_id:string}>(
    'SELECT period,seal_id FROM omni.period_seals WHERE tenant_id=$1 ORDER BY period DESC LIMIT 1',[tenant],
  )).rows[0];
  if ((head?.seal_id ?? null) !== previous || (head && head.period >= period))
    throw new InventoryError('CLOSE_PREDECESSOR_MISMATCH',409);
  const earlier = await db.query(`SELECT 1 FROM omni.ledger_lines WHERE tenant_id=$1 AND period<$2 AND period>$3 LIMIT 1`,
    [tenant,period,head?.period ?? '0000-00']);
  if (earlier.rowCount) throw new InventoryError('EARLIER_PERIOD_HAS_UNSEALED_ENTRIES',409);
  const ledger = await ledgerCut(db,tenant,period);
  const evidence = await evidenceCut(db,tenant);
  const objects = {ledger,evidence};
  const fields = {schema:1,hash:'sha256',tenant,period,id,previous,actor,approval,
    members:ledger.length,holdCount:objects.evidence.holds.length,balances:balances(ledger,period),objects:{
      ledger:digest(canonical(ledger)),evidence:digest(canonical(evidence)),
    }};
  const manifest = canonical(fields);
  const packet = signArtifact(purpose,JSON.parse(manifest.toString()),signer);
  await db.query('INSERT INTO omni.period_seals VALUES($1,$2,$3,$4,$5,$6,$7)',
    [tenant,period,id,previous,manifest,JSON.stringify(packet),JSON.stringify(objects)]);
  return {packet,objects};
}

export async function verifyRestoredSeal(db: PoolClient, tenant: string, period: string, previous: string | null,
  keys: ReadonlyMap<string,KeyObject>) {
  const stored = await loadSeal(db,tenant,period);
  if (!stored) throw new Error('Authoritative seal missing from restore');
  const verified = verifySeal(stored,keys,{tenant,period,previous});
  if (stored.seal_id !== verified.manifest.id || stored.previous_id !== previous ||
      !stored.manifest.equals(canonical(verified.manifest)) ||
      !canonical(verified.lines).equals(canonical(await ledgerCut(db,tenant,period))))
    throw new Error('Restored ledger or seal does not match the approved cut');
  return verified;
}
