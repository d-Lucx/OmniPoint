import type { KeyObject } from 'node:crypto';
import type { PoolClient } from 'pg';
import { openArtifact, signArtifact } from './authority.ts';
import { canonical, isPeriod, ledgerCut, ledgerLock, loadSeal } from './period-close.ts';
import type { LedgerLine } from './period-close.ts';
import { decode, digest, isIsoDate, isUuid, jsonBytes, record } from './protocol.ts';
import type { SigningKey } from './protocol.ts';
import { InventoryError } from './quota-cloud.ts';

const debit = 'TreasuryClearing';
const credit = 'TreasuryOffset';
const family = 'treasury-march';
const size = 50;
type Adjustment = { id:string; account:string; counteraccount:string; minor:number; family:string;
  effect:string; reference:string|null; evidence:string; actor:string; business_at:Date };
type Plan = { id:string; lineage:string; predecessor:string|null; seal_id:string; facts:Record<string,unknown>; packet:unknown };
type Export = { id:string; bytes:Buffer; packet:unknown };

function rejected(message:string, status=422): never { throw new InventoryError(message,status); }

export async function adjustment(db:PoolClient, tenant:string, actor:string, input:Record<string,unknown>) {
  const {id,businessAt,account,counteraccount,minor,evidence,effect,reference} = input;
  if (!isUuid(id) || !isIsoDate(businessAt) || !isUuid(evidence) || typeof account!=='string' ||
      typeof counteraccount!=='string' || !/^[A-Za-z]{1,32}$/.test(account) || !/^[A-Za-z]{1,32}$/.test(counteraccount) ||
      account===counteraccount || typeof minor!=='number' || !Number.isInteger(minor) || !minor || Math.abs(minor)>100_000_000 ||
      (reference!==null && typeof reference!=='string')) rejected('INVALID_ADJUSTMENT');
  const classified = effect==='RESTORE'||effect==='POST'||effect==='REVOKE';
  if (!classified && effect!=='UNRELATED' && effect!=='CORRECTION') rejected('INVALID_CLASSIFICATION');
  if (classified && (account!==debit || counteraccount!==credit || businessAt.slice(5,7)!=='04' ||
    (effect==='RESTORE' ? minor!==size || reference!==null :
      effect==='POST' ? minor>=0 || -minor>size || reference!==null : minor<1 || minor>size || reference===null)))
    rejected('INVALID_TREASURY_FIXTURE');
  await ledgerLock(db,tenant);
  const tag = classified ? family : effect==='UNRELATED' ? 'unrelated' : 'correction';
  const args = [tenant,id,businessAt,account,counteraccount,minor,evidence,actor,tag,effect,reference];
  const prior = (await db.query<Adjustment>('SELECT * FROM omni.governed_adjustments WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];
  if (prior) {
    const original = [tenant,prior.id,prior.business_at.toISOString(),prior.account,prior.counteraccount,prior.minor,prior.evidence,
      prior.actor,prior.family,prior.effect,prior.reference];
    if (!canonical(original).equals(canonical(args))) rejected('ADJUSTMENT_ID_CONFLICT',409);
    return prior;
  }
  if (effect==='CORRECTION' || effect==='REVOKE') {
    const original = (await db.query<LedgerLine>('SELECT * FROM omni.ledger_lines WHERE tenant_id=$1 AND line_id=$2',
      [tenant,reference])).rows[0];
    if (!original) rejected('ADJUSTMENT_SOURCE_REQUIRED');
    if (effect==='CORRECTION') {
      if (original.period >= businessAt.slice(0,7) || !await loadSeal(db,tenant,original.period))
        rejected('CORRECTION_REQUIRES_SEALED_PREDECESSOR');
    } else {
      const origin = (await db.query<Adjustment>(`SELECT a.* FROM omni.governed_adjustments a WHERE a.tenant_id=$1 AND a.effect='POST'
        AND 'adjustment:'||a.id||':'||a.account=$2`,[tenant,reference])).rows[0];
      const used = (await db.query<{minor:string}>(`SELECT coalesce(sum(minor),0) AS minor FROM omni.governed_adjustments
        WHERE tenant_id=$1 AND effect='REVOKE' AND reference=$2`,[tenant,reference])).rows[0];
      if (!origin || original.period!==businessAt.slice(0,7) || minor+Number(used.minor)>-origin.minor)
        rejected('REVOCATION_EXCEEDS_PROVEN_SLICE');
    }
  }
  return (await db.query('INSERT INTO omni.governed_adjustments VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',args)).rows[0];
}

export async function technicalReplacement(db:PoolClient,tenant:string,actor:string,input:Record<string,unknown>) {
  const {id,reverseId,businessAt,evidence,line}=input;
  if (!isUuid(id) || !isUuid(reverseId) || id===reverseId || !isUuid(evidence) || !isIsoDate(businessAt) ||
      typeof line!=='string') rejected('INVALID_TECHNICAL_REPLACEMENT');
  await ledgerLock(db,tenant);
  const original=(await db.query<Adjustment>(`SELECT * FROM omni.governed_adjustments WHERE tenant_id=$1 AND effect='POST'
    AND 'adjustment:'||id||':'||account=$2`,[tenant,line])).rows[0];
  if (!original || original.business_at.toISOString().slice(0,7)!==businessAt.slice(0,7))
    rejected('UNPROVEN_TECHNICAL_REPLACEMENT');
  const entries=[{id:reverseId,effect:'TECH_REVERSE',minor:-original.minor},{id,effect:'TECH_REPLACE',minor:original.minor}];
  const {rows:prior}=await db.query<Adjustment>(`SELECT * FROM omni.governed_adjustments WHERE tenant_id=$1
    AND omni.ledger_month(business_at)=$2 AND effect IN ('TECH_REVERSE','TECH_REPLACE')`,[tenant,businessAt.slice(0,7)]);
  if (prior.length) {
    if (prior.length!==entries.length || entries.some(entry=>!prior.some(row=>
      row.id===entry.id && row.effect===entry.effect && row.reference===line && row.evidence===evidence &&
      row.actor===actor && row.business_at.toISOString()===businessAt))) rejected('TECHNICAL_REPLACEMENT_CONFLICT',409);
    return {line,entries};
  }
  for (const entry of entries) {
    await db.query('INSERT INTO omni.governed_adjustments VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [tenant,entry.id,businessAt,original.account,original.counteraccount,entry.minor,evidence,actor,family,entry.effect,line]);
  }
  return {line,entries};
}

function paired(lines:LedgerLine[], item:Adjustment) {
  const journal = 'adjustment:'+item.id;
  const [left,right] = [item.account,item.counteraccount].map(account =>
    lines.find(line=>line.line_id===journal+':'+account));
  if (!left || !right || left.minor!==item.minor || right.minor!==-item.minor)
    rejected('EXTRACT_POSTING_MISMATCH');
  return [left,right];
}

async function findPlan(db:PoolClient, tenant:string, id:string) {
  return (await db.query<Plan>('SELECT * FROM omni.report_plans WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];
}

async function status(db:PoolClient, tenant:string, plan:Plan) {
  const result = (await db.query(`SELECT
    (SELECT id FROM omni.report_plans WHERE tenant_id=$1 AND predecessor=$2) AS successor,
    EXISTS(SELECT 1 FROM omni.report_withdrawals WHERE tenant_id=$1 AND plan_id=$2) AS withdrawn`,
  [tenant,plan.id])).rows[0];
  return {successor:result.successor as string|null, withdrawn:Boolean(result.withdrawn)};
}

async function approve(db:PoolClient, tenant:string, actor:string, input:Record<string,unknown>, signer:SigningKey) {
  const {id,lineage,predecessor,seal,april,approval,slices,replacement} = input;
  if (!isUuid(id) || !isUuid(lineage) || (predecessor!==null && !isUuid(predecessor)) || !isUuid(seal) ||
      !isPeriod(april) || !april.endsWith('-04') || !isUuid(approval) || !Array.isArray(slices) || slices.length>size)
    rejected('INVALID_REPORT_APPROVAL');
  const request = digest(canonical(input));
  const prior = await findPlan(db,tenant,id);
  if (prior) {
    if (prior.facts.request!==request || prior.facts.actor!==actor) rejected('PLAN_ID_CONFLICT',409);
    return {packet:prior.packet,facts:prior.facts};
  }
  const march = april.slice(0,4)+'-03';
  const marchSeal=await loadSeal(db,tenant,march);
  if (marchSeal?.seal_id!==seal) rejected('MARCH_SEAL_REQUIRED');
  const previous = predecessor ? await findPlan(db,tenant,predecessor) : undefined;
  if ((predecessor && (!previous || previous.lineage!==lineage || previous.seal_id!==seal ||
      previous.facts.april!==april || (await status(db,tenant,previous)).successor)) ||
      (!predecessor && (await db.query('SELECT 1 FROM omni.report_plans WHERE tenant_id=$1 AND lineage=$2 LIMIT 1',
        [tenant,lineage])).rowCount)) rejected('REPORT_PREDECESSOR_MISMATCH',409);
  const lines = await ledgerCut(db,tenant,april);
  const {rows} = await db.query<Adjustment>(`SELECT * FROM omni.governed_adjustments
    WHERE tenant_id=$1 AND omni.ledger_month(business_at)=$2 ORDER BY business_at,id`,[tenant,april]);
  const moves = rows.filter(item=>item.family===family);
  const restored = moves.filter(item=>item.effect==='RESTORE');
  const postings = moves.filter(item=>item.effect==='POST');
  const revoked = moves.filter(item=>item.effect==='REVOKE');
  if ((postings.length ? 1 : 0)!==restored.length || postings.length!==slices.length) rejected('RESTORATION_OR_SLICE_COVERAGE');
  const seen = new Set<string>();
  const used = new Set<number>();
  const absorbed = slices.map(value => {
    const {line,start,minor} = record(value);
    if (typeof line!=='string' || seen.has(line) || typeof start!=='number' || !Number.isInteger(start) || start<0 ||
        typeof minor!=='number' || !Number.isInteger(minor) || minor<1 || start+minor>size) rejected('INVALID_ABSORPTION_SLICE');
    const match = postings.find(item=>'adjustment:'+item.id+':'+debit===line);
    if (!match || -match.minor!==minor) rejected('UNPROVEN_ABSORPTION_LINE');
    for (let offset=start;offset<start+minor;offset++) {
      if (used.has(offset)) rejected('ABSORPTION_SLICE_REUSED');
      used.add(offset);
    }
    seen.add(line);
    return {line,start,minor,proof:paired(lines,match),evidence:match.evidence};
  });
  let technical = null;
  const technicalRows=moves.filter(item=>item.effect==='TECH_REVERSE' || item.effect==='TECH_REPLACE');
  const requestReplacement=replacement ?? previous?.facts.technical ?? null;
  if (requestReplacement!==null) {
    const {line,evidence} = record(requestReplacement);
    if (typeof line!=='string' || !isUuid(evidence) || !seen.has(line) || !previous ||
        !(previous.facts.absorbed as {line:string}[]).some(item=>item.line===line))
      rejected('UNPROVEN_TECHNICAL_REPLACEMENT');
    const reverse=technicalRows.find(item=>item.effect==='TECH_REVERSE' && item.reference===line && item.evidence===evidence);
    const replacement=technicalRows.find(item=>item.effect==='TECH_REPLACE' && item.reference===line && item.evidence===evidence);
    if (technicalRows.length!==2 || !reverse || !replacement || reverse.minor!==-replacement.minor)
      rejected('UNPROVEN_TECHNICAL_REPLACEMENT_PAIR');
    technical = {line,evidence,economicDelta:0,reverse:paired(lines,reverse),replacement:paired(lines,replacement)};
  } else if (technicalRows.length) {
    rejected('TECHNICAL_REPLACEMENT_CLASSIFICATION_REQUIRED');
  }
  const raw = moves.reduce((sum,item)=>sum+item.minor,0);
  const duplicate = restored.length ? -size : 0;
  const synthetic = -(size-used.size);
  const bridge = {marchGrossUp:size,opening:size,raw,duplicate,synthetic,closing:size+raw+duplicate+synthetic};
  let treasury:unknown[]|undefined;
  if (input.treasury!==undefined) {
    if (!Array.isArray(input.treasury) || input.treasury.length>50) rejected('INVALID_TREASURY_PROVENANCE');
    const used=new Set<string>();
    treasury=[];
    for (const item of input.treasury) {
      const {account,key}=record(item);
      if (!isUuid(account) || typeof key!=='string' || !key.startsWith('report-link:') || used.has(key))
        rejected('INVALID_TREASURY_PROVENANCE');
      used.add(key);
      const {rows:[link]}=await db.query<{facts:Record<string,unknown>}>(`SELECT facts FROM omni.treasury_effects
        WHERE tenant_id=$1 AND account_id=$2 AND effect=$3`,[tenant,account,key]);
      if (!link || !lines.some(row=>row.line_id===link.facts.line && row.minor===link.facts.minor))
        rejected('TREASURY_PROVENANCE_OUTSIDE_EXTRACT');
      treasury.push({account,key,...link.facts});
    }
  }
  const facts = {version:1,tenant,id,lineage,predecessor,seal,march,april,actor,approval,request,
    sealRoot:digest(marchSeal.manifest),effective:{marchClosing:march+'-31',aprilOpening:april+'-01'},
    extract:{root:digest(canonical(lines)),lines},absorbed,technical,
    restoration:restored.map(item=>({proof:paired(lines,item),evidence:item.evidence})),
    revoked:revoked.map(item=>({source:item.reference,proof:paired(lines,item),evidence:item.evidence})),
    bridge:{[debit]:bridge,[credit]:Object.fromEntries(Object.entries(bridge).map(([key,value])=>[key,value ? -value : 0]))},
    unrelated:rows.filter(item=>item.family==='unrelated').map(item=>({proof:paired(lines,item),evidence:item.evidence})),
    ...(treasury ? {treasury} : {}),
  };
  const packet = signArtifact('comparative-plan-v1',{version:1,tenant,id,seal,lineage,predecessor,
    digest:digest(canonical(facts))},signer);
  await db.query('INSERT INTO omni.report_plans VALUES($1,$2,$3,$4,$5,$6,$7)',
    [tenant,id,lineage,predecessor,seal,JSON.stringify(facts),JSON.stringify(packet)]);
  return {packet,facts};
}

export function verifyPlan(value:{packet:unknown;facts:Record<string,unknown>}, keys:ReadonlyMap<string,KeyObject>,
  expected:{tenant:string;id:string;seal:string}) {
  const {data} = openArtifact('comparative-plan-v1',value.packet,keys);
  const {facts}=value;
  if (data.version!==1 || facts.version!==1 || data.tenant!==expected.tenant || data.id!==expected.id || data.seal!==expected.seal ||
      facts.tenant!==data.tenant || facts.id!==data.id || facts.seal!==data.seal ||
      facts.lineage!==data.lineage || facts.predecessor!==data.predecessor || data.digest!==digest(canonical(facts)))
    throw new Error('Comparative plan binding mismatch');
  const extract=record(facts.extract);
  if (!Array.isArray(extract.lines) || extract.root!==digest(canonical(extract.lines)))
    throw new Error('Comparative extract mismatch');
  return facts;
}

function published(row:Export) {
  return {id:row.id,bytes:row.bytes.toString('base64url'),packet:row.packet};
}

export function verifyExport(result:{id:string;bytes:string;packet:unknown}, keys:ReadonlyMap<string,KeyObject>,
  expected:{tenant:string;plan:string;seal:string}) {
  const {data} = openArtifact('report-export-v1',result.packet,keys);
  const bytes = Buffer.from(result.bytes,'base64url');
  if (bytes.toString('base64url')!==result.bytes || data.tenant!==expected.tenant ||
      data.plan!==expected.plan || data.seal!==expected.seal || data.id!==result.id || data.digest!==digest(bytes))
    throw new Error('Report export binding mismatch');
  const document=decode(bytes);
  if (document.version!==1 || document.tenant!==expected.tenant || document.plan!==expected.plan ||
      document.seal!==expected.seal || !bytes.equals(canonical(document)))
    throw new Error('Report export content mismatch');
  return bytes;
}

export async function reportAction(db:PoolClient,tenant:string,actor:string,input:Record<string,unknown>,signer:SigningKey) {
  await ledgerLock(db,tenant);
  if (input.action==='report-approve') return approve(db,tenant,actor,input,signer);
  if (!isUuid(input.plan)) rejected('REPORT_PLAN_REQUIRED');
  const plan = await findPlan(db,tenant,input.plan);
  if (!plan) rejected('REPORT_PLAN_UNKNOWN',404);
  const state = await status(db,tenant,plan);
  const stored = (await db.query<Export>('SELECT id,bytes,packet FROM omni.report_exports WHERE tenant_id=$1 AND plan_id=$2',
    [tenant,plan.id])).rows[0];
  switch (input.action) {
    case 'report-get': return {packet:plan.packet,facts:plan.facts,state,export:stored ? published(stored) : null};
    case 'report-withdraw': {
      if (!isUuid(input.evidence)) rejected('WITHDRAWAL_EVIDENCE_REQUIRED');
      await db.query('INSERT INTO omni.report_withdrawals VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [tenant,plan.id,input.evidence,actor]);
      return {...state,withdrawn:true};
    }
    case 'report-publish': {
      if (!isUuid(input.id)) rejected('EXPORT_ID_REQUIRED');
      if (stored && stored.id===input.id) return published(stored);
      if (state.withdrawn || state.successor || stored) rejected('REPORT_APPROVAL_INACTIVE',409);
      const bytes = canonical({version:1,tenant,plan:plan.id,seal:plan.seal_id,report:plan.facts});
      const packet = signArtifact('report-export-v1',{version:1,tenant,plan:plan.id,seal:plan.seal_id,
        id:input.id,digest:digest(bytes),actor},signer);
      const row = (await db.query<Export>('INSERT INTO omni.report_exports VALUES($1,$2,$3,$4,$5) RETURNING id,bytes,packet',
        [tenant,plan.id,input.id,bytes,jsonBytes(packet).toString()])).rows[0];
      return published(row);
    }
    default: rejected('UNKNOWN_REPORT_ACTION',400);
  }
}
