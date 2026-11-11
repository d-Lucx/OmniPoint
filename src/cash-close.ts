import type { PoolClient } from 'pg';
import { canonical, ledgerLock } from './period-close.ts';
import { digest, isIsoDate, isUuid, jsonBytes } from './protocol.ts';
import { InventoryError } from './quota-cloud.ts';
import { money } from './retail-money.ts';

type Custody = { id:string; kind:string; source:string; vault:string; destination:string|null; minor:number;
  actor:string; evidence:string; facts:Record<string,unknown> };

async function vaultFacts(db: PoolClient, tenant: string, vault: string) {
  const {rows} = await db.query<Custody>(`SELECT id,kind,source,vault,destination,minor,actor,evidence,facts
    FROM omni.cash_custody WHERE tenant_id=$1 AND vault=$2 ORDER BY id`,[tenant,vault]);
  const minor = rows.reduce((sum,row) => sum + (row.kind==='DEPOSIT_SEND' ? -row.minor :
    row.kind==='VAULT_RECEIVE' || row.kind==='VAULT_COUNT' ? row.minor : 0),0);
  const counted = rows.filter(row => row.kind === 'VAULT_COUNT');
  const prior = counted.find(row => !counted.some(other => other.source===row.id));
  return { rows, minor, prior:prior?.id ?? null,
    cut:digest(canonical(rows.filter(row=>row.kind!=='VAULT_WITNESS'))) };
}

async function drawerVariance(db:PoolClient,tenant:string,shift:string) {
  const {rows:[row]}=await db.query<{minor:string}>(`SELECT coalesce(sum(minor),0) AS minor FROM omni.cash_custody
    WHERE tenant_id=$1 AND kind='DRAWER_VARIANCE' AND facts->>'shift'=$2`,[tenant,shift]);
  return Number(row.minor);
}

async function cashState(db: PoolClient, tenant:string, input:Record<string,unknown>) {
  const { shift, vault, through } = input;
  if (!isUuid(shift) || !isUuid(vault) || !money(through))
    throw new InventoryError('INVALID_DRAWER_CUT',422);
  const {rows:[header]} = await db.query<{drawer_id:string;source_no:number;closed:boolean}>(
    'SELECT drawer_id,source_no,closed FROM omni.retail_shifts WHERE tenant_id=$1 AND shift_id=$2',[tenant,shift]);
  if (!header) throw new InventoryError('SHIFT_UNKNOWN',404);
  const {rows:source} = await db.query<{event_id:string;source_no:number;kind:string;signed_minor:number|null;destination_id:string|null}>(`
    SELECT e.event_id,e.source_no,e.kind,c.signed_minor,c.destination_id FROM omni.retail_events e
    LEFT JOIN omni.retail_cash c USING(tenant_id,event_id)
    WHERE e.tenant_id=$1 AND e.shift_id=$2 ORDER BY e.source_no`,[tenant,shift]);
  const vaultCut = await vaultFacts(db,tenant,vault);
  const expected = source.reduce((sum,row) => sum+(row.signed_minor ?? 0),0);
  const drops = source.filter(row => row.kind==='DROP' && row.destination_id===vault);
  const pending = drops.filter(row => !vaultCut.rows.some(c => c.kind==='VAULT_RECEIVE' && c.source===row.event_id));
  const count = (await db.query(`SELECT event_id,covered_no,counted_minor,expected_minor,variance_minor,delta_minor
    FROM omni.retail_closes WHERE tenant_id=$1 AND shift_id=$2 ORDER BY covered_no DESC LIMIT 1`,[tenant,shift])).rows[0] ?? null;
  const physical = count?.counted_minor ?? expected;
  const retainedEntry = vaultCut.rows.find(row => row.kind==='DRAWER_RETAIN' && row.source===shift);
  const retained = retainedEntry?.minor ?? 0;
  const recognized = await drawerVariance(db,tenant,shift);
  const unapprovedVariance = (count?.variance_minor ?? 0)-recognized;
  if (retained > physical) throw new InventoryError('RETAINED_FLOAT_EXCEEDS_DRAWER',422);
  const sent = vaultCut.rows.filter(row => row.kind==='DEPOSIT_SEND');
  const deposited = sent.filter(row => vaultCut.rows.some(c => c.kind==='DEPOSIT_RECEIVE' && c.source===row.id));
  return {shift, drawer:header.drawer_id, vault, through, covered:header.source_no,
    missing:Math.max(0,through-header.source_no), finalized:header.closed && through===header.source_no && pending.length===0 &&
      deposited.length===sent.length && unapprovedVariance===0,
    source:source.map(row => row.event_id), expected, counted:count, retained, retainedId:retainedEntry?.id ?? null,
    drawerAvailable:physical-retained,recognizedVariance:recognized,unapprovedVariance,
    vaultMinor:vaultCut.minor, vaultCut:vaultCut.cut, priorCount:vaultCut.prior, unmatchedDrops:pending.map(row=>row.event_id),
    drawerInTransit:pending.reduce((sum,row)=>sum-(row.signed_minor ?? 0),0),
    depositInTransit:sent.filter(row=>!deposited.includes(row)).reduce((sum,row)=>sum+row.minor,0),
    deposited:deposited.map(row=>({id:row.id,destination:row.destination,minor:row.minor}))};
}

export async function cashAction(db: PoolClient, tenant:string, actor:string, input:Record<string,unknown>) {
  await ledgerLock(db,tenant);
  if (input.action === 'cash-state') return cashState(db,tenant,input);
  const {id,vault,evidence,action} = input;
  if (!isUuid(id) || !isUuid(vault) || !isUuid(evidence)) throw new InventoryError('INVALID_CUSTODY_IDENTITY',422);
  const hash = digest(canonical(input));
  const prior = (await db.query<Custody>('SELECT * FROM omni.cash_custody WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];
  if (prior) {
    if (prior.facts.request !== hash || prior.actor !== actor) throw new InventoryError('CUSTODY_ID_CONFLICT',409);
    return prior;
  }
  let destination:string|null = null;
  let source:string;
  let minor:number;
  let kind:string;
  let facts:Record<string,unknown> = {request:hash};
  if (action === 'cash-vault-receive') {
    if (!isUuid(input.drop)) throw new InventoryError('DROP_REQUIRED',422);
    source=input.drop;
    const drop = (await db.query<{signed_minor:number;destination_id:string}>(
      "SELECT signed_minor,destination_id FROM omni.retail_cash WHERE tenant_id=$1 AND event_id=$2 AND kind='DROP'",
      [tenant,source])).rows[0];
    if (!drop || drop.destination_id!==vault) throw new InventoryError('DROP_SCOPE_MISMATCH',409);
    minor=-drop.signed_minor;
    kind='VAULT_RECEIVE';
  } else if (action === 'cash-deposit-send') {
    if (!money(input.minor,1) || !isUuid(input.destination) || input.destination===vault ||
        input.minor > (await vaultFacts(db,tenant,vault)).minor) throw new InventoryError('DEPOSIT_FUNDS_UNAVAILABLE',409);
    minor=input.minor; source=id; destination=input.destination; kind='DEPOSIT_SEND';
  } else if (action === 'cash-deposit-receive') {
    if (!isUuid(input.transfer) || !isUuid(input.destination)) throw new InventoryError('TRANSFER_REQUIRED',422);
    const sent = (await db.query<Custody>(`SELECT * FROM omni.cash_custody
      WHERE tenant_id=$1 AND id=$2 AND kind='DEPOSIT_SEND' AND vault=$3 AND destination=$4`,
    [tenant,input.transfer,vault,input.destination])).rows[0];
    if (!sent) throw new InventoryError('DEPOSIT_SCOPE_MISMATCH',409);
    source=input.transfer; destination=input.destination; minor=sent.minor; kind='DEPOSIT_RECEIVE';
  } else if (action === 'cash-drawer-retain') {
    if (!isUuid(input.shift) || !money(input.minor,1)) throw new InventoryError('INVALID_RETAINED_FLOAT',422);
    const count = (await db.query<{counted_minor:number;event_id:string}>(`SELECT c.counted_minor,c.event_id
      FROM omni.retail_closes c JOIN omni.retail_shifts s USING(tenant_id,shift_id)
      WHERE c.tenant_id=$1 AND c.shift_id=$2 AND s.closed ORDER BY c.covered_no DESC LIMIT 1`,
    [tenant,input.shift])).rows[0];
    if (!count || input.minor>count.counted_minor || input.close!==count.event_id)
      throw new InventoryError('APPROVED_DRAWER_CLOSE_REQUIRED',409);
    source=input.shift; minor=input.minor; kind='DRAWER_RETAIN';
    facts={request:hash,close:count.event_id};
  } else if (action === 'cash-drawer-adjust') {
    if (!isUuid(input.shift) || !isIsoDate(input.businessAt) || !isUuid(input.close))
      throw new InventoryError('INVALID_DRAWER_ADJUSTMENT',422);
    const latest = (await db.query<{event_id:string;kind:string;variance_minor:number}>(`SELECT c.event_id,e.kind,c.variance_minor
      FROM omni.retail_closes c JOIN omni.retail_events e USING(tenant_id,event_id)
      WHERE c.tenant_id=$1 AND c.shift_id=$2 ORDER BY c.covered_no DESC LIMIT 1`,[tenant,input.shift])).rows[0];
    if (latest?.kind!=='REVISION' || latest.event_id!==input.close) throw new InventoryError('APPROVED_DRAWER_REVISION_REQUIRED',409);
    const prior = await drawerVariance(db,tenant,input.shift);
    source=latest.event_id; minor=latest.variance_minor-prior; kind='DRAWER_VARIANCE';
    facts={request:hash,shift:input.shift,previous:prior,variance:latest.variance_minor,delta:minor};
    if (minor) await db.query(`INSERT INTO omni.governed_adjustments VALUES
      ($1,$2,$3,'CashDrawer','CashVarianceClearing',$4,$5,$6,'drawer-variance','COUNT',$7)`,
    [tenant,id,input.businessAt,minor,evidence,actor,source]);
  } else if (action === 'cash-vault-count' || action === 'cash-vault-witness') {
    const cut = await vaultFacts(db,tenant,vault);
    if (!money(input.counted) || input.cut!==cut.cut || input.previous!==cut.prior || !isIsoDate(input.businessAt))
      throw new InventoryError('INVALID_VAULT_COUNT_CUT_OR_WITNESS',409);
    if (action === 'cash-vault-witness') {
      return (await db.query(`INSERT INTO omni.cash_custody VALUES($1,$2,'VAULT_WITNESS',$2,$3,NULL,0,$4,$5,$6)
        RETURNING *`,[tenant,id,vault,actor,evidence,JSON.stringify({request:hash,cut:cut.cut,previous:cut.prior,
        counted:input.counted,businessAt:input.businessAt})])).rows[0];
    }
    const witness=cut.rows.find(row=>row.kind==='VAULT_WITNESS' && row.id===input.witness);
    if (!witness || witness.actor===actor || witness.facts.cut!==cut.cut || witness.facts.previous!==cut.prior ||
        witness.facts.counted!==input.counted || witness.facts.businessAt!==input.businessAt)
      throw new InventoryError('INVALID_VAULT_COUNT_CUT_OR_WITNESS',409);
    source=cut.prior ?? vault;
    minor=input.counted-cut.minor;
    kind='VAULT_COUNT';
    facts={request:hash,cut:cut.cut,covered:cut.rows.filter(row=>row.kind!=='VAULT_WITNESS').map(row=>row.id),previous:cut.prior,
      witness:input.witness,expected:cut.minor,counted:input.counted,delta:minor};
    if (minor) await db.query(`INSERT INTO omni.governed_adjustments VALUES
      ($1,$2,$3,'CashVault','CashVarianceClearing',$4,$5,$6,'vault-variance','COUNT',$7)`,
    [tenant,id,input.businessAt,minor,evidence,actor,cut.prior]);
  } else throw new InventoryError('UNKNOWN_CUSTODY_ACTION',400);
  return (await db.query(`INSERT INTO omni.cash_custody VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenant,id,kind,source,vault,destination,minor,actor,evidence,jsonBytes(facts).toString()])).rows[0];
}
