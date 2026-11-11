import type { Pool } from 'pg';
import { canonical, ledgerLock } from './period-close.ts';
import { tenantTransaction } from './postgres.ts';
import { digest, jsonBytes } from './protocol.ts';
import { Treasury } from './treasury-store.ts';
import { cents, fail, railRequest, text, time, uuid, verifyTreasury } from './treasury-protocol.ts';
import type { Source, TreasuryTrust } from './treasury-protocol.ts';
import { acceptAttemptStatus, attempts, filingAndAssessment, prepare, settleFunding, sourceFor } from './treasury-outbound.ts';
import { bookedCash, correctAllocations, disputes, reimburse } from './treasury-inbound.ts';
import { attestations, statements } from './treasury-statements.ts';

async function project(ctx:Treasury) {
  const held=(await ctx.positions('incident')).some(row=>row.state==='EVIDENCE_COLLISION');
  if (!held) await filingAndAssessment(ctx);
  await settleFunding(ctx,!held);
  await bookedCash(ctx);
  if (held) return;
  await reimburse(ctx);
  await correctAllocations(ctx);
  await disputes(ctx);
  // A tombstone can reserve a booked credit before a statement amendment consumes it.
  await attestations(ctx);
  await statements(ctx);
  await attestations(ctx);
}

async function checked<T>(promise:Promise<T>) {
  const result=await promise;
  if (result && typeof result==='object' && 'collision' in result) return fail('TREASURY_EVIDENCE_COLLISION',409);
  return result;
}

export async function treasuryAction(pool:Pool,tenant:string,actor:string,input:Record<string,unknown>,trust:TreasuryTrust) {
  const account=uuid(input.account);
  const action=input.action;
  const transact=<T>(work:(ctx:Treasury)=>Promise<T>)=>tenantTransaction(pool,tenant,async db=>
    work(await Treasury.open(db,tenant,account,actor)));
  if (action==='treasury-open') {
    const values=[tenant,account,text(input.taxpayer),text(input.remitter),cents(input.opening,0),actor];
    return tenantTransaction(pool,tenant,async db=>{
      await ledgerLock(db,tenant);
      const {rows:[prior]}=await db.query(`SELECT * FROM omni.treasury_accounts WHERE tenant_id=$1 AND account_id=$2`,[tenant,account]);
      if (prior) {
        if (prior.taxpayer!==values[2] || prior.remitter!==values[3] || prior.opening_minor!==values[4])
          return fail('TREASURY_ACCOUNT_COLLISION',409);
        return {account};
      }
      await db.query('INSERT INTO omni.treasury_accounts VALUES($1,$2,$3,$4,$5,$6)',values);
      return {account};
    });
  }
  if (action==='treasury-send' || action==='treasury-recover' || action==='treasury-resume') {
    const prepared=action==='treasury-send' ? await transact(ctx=>prepare(ctx,input)) : await transact(async ctx=>{
      const id=uuid(input.attempt);
      const attempt=(await attempts(ctx)).find(row=>row.attempt===id);
      if (!attempt) return fail('TREASURY_ATTEMPT_UNKNOWN',404);
      return {attempt,dispatch:false};
    });
    const {attempt,dispatch}=prepared;
    if (attempt.state!=='MAY_HAVE_SENT') return {attempt:attempt.attempt,state:attempt.state};
    const source=sourceFor(attempt.kind);
    let packet:unknown;
    try {
      packet=await railRequest(trust[source],dispatch?'/execute':'/status',attempt.request);
      if (!dispatch && action==='treasury-resume' &&
          verifyTreasury(packet,trust,source,tenant,account).fact.kind==='UNKNOWN') {
        // The fixtures retain permanent attempt identities and reject altered bytes.
        packet=await railRequest(trust[source],'/execute',attempt.request);
      }
    } catch {
      return {attempt:attempt.attempt,state:'MAY_HAVE_SENT'};
    }
    const {fact,bytes}=verifyTreasury(packet,trust,source,tenant,account);
    return checked(transact(async ctx=>{
      const current=(await attempts(ctx)).find(row=>row.attempt===attempt.attempt)!;
      if (await ctx.store(fact,bytes,packet)==='COLLISION') return {collision:true};
      await acceptAttemptStatus(ctx,fact,current);
      await project(ctx);
      return {attempt:attempt.attempt,state:fact.kind==='UNKNOWN'?'MAY_HAVE_SENT':fact.kind};
    }));
  }
  return checked(transact(async ctx=>{
    if (action==='treasury-get') {
      const {rows:positions}=await ctx.db.query(`SELECT kind,id,remaining,state,facts FROM omni.treasury_positions
        WHERE tenant_id=$1 AND account_id=$2 ORDER BY kind,id`,ctx.args());
      return {account:ctx.account,positions,effects:await ctx.effects(),
        attempts:(await attempts(ctx)).map(row=>({...row,request:row.request.toString('base64url')})),
        evidence:(await ctx.db.query(`SELECT source,id,kind,digest,packet FROM omni.treasury_facts
          WHERE tenant_id=$1 AND account_id=$2 ORDER BY source,id`,ctx.args())).rows,
        collisions:(await ctx.db.query(`SELECT source,id,digest,original_digest,packet FROM omni.treasury_collisions
          WHERE tenant_id=$1 AND account_id=$2 ORDER BY source,id,digest`,ctx.args())).rows};
    }
    if (action==='treasury-ingest') {
      const source=input.source;
      if (source!=='bank' && source!=='agency') return fail('TREASURY_SOURCE_REQUIRED');
      const {fact,bytes}=verifyTreasury(input.packet,trust,source,tenant,account);
      if (['TRANSMITTED','REJECTED','UNKNOWN'].includes(fact.kind)) return fail('USE_ATTEMPT_STATUS_RECOVERY');
      const inserted=await ctx.store(fact,bytes,input.packet);
      if (inserted==='COLLISION') return {collision:true};
      await project(ctx);
      return {id:fact.id,digest:digest(bytes),state:inserted?'RECORDED':'REPLAY'};
    }
    if (action==='treasury-receivable') {
      const id=uuid(input.id), minor=cents(input.minor), at=time(input.at), approval=uuid(input.approval);
      const intent={minor,at,approval}, original=await ctx.position('receivable-intent',id);
      if (original && !canonical(original.facts).equals(canonical(intent))) return fail('RECEIVABLE_ID_COLLISION',409);
      if (!original) await ctx.set('receivable-intent',id,0,'PREPARED',intent);
      const key='receivable:'+id, prior=await ctx.effect(key);
      if (prior) {
        if (prior.facts.minor!==minor || prior.facts.originalAt!==at || prior.evidence!==approval)
          return fail('RECEIVABLE_ID_COLLISION',409);
        return {id,state:'OPEN'};
      }
      if (await ctx.journal(key,{id:approval,at},'AgencyReceivable','AgencyIncome',minor,{receivable:id}))
        await ctx.set('receivable',id,minor,'OPEN',{approval});
      return {id,state:(await ctx.effect(key))?'OPEN':'PERIOD_SEALED'};
    }
    if (action==='treasury-credit-use') {
      const id=uuid(input.id), credit=uuid(input.credit), minor=cents(input.minor), approval=uuid(input.approval);
      const mode=input.mode;
      if (mode!=='APPLY' && mode!=='REFUND') return fail('INVALID_CREDIT_ACTION');
      const prior=await ctx.effect('credit-use:'+id);
      if (prior) {
        if (prior.evidence!==approval || !canonical(prior.facts).equals(canonical({credit,minor,mode})))
          return fail('CREDIT_USE_COLLISION',409);
        return {id,credit,minor,mode,state:'RESERVED'};
      }
      const available=await ctx.position('agency-credit',credit);
      if (!available || available.state!=='AVAILABLE' || available.remaining<minor ||
          (await ctx.positions('incident')).some(item=>item.state==='EVIDENCE_COLLISION') ||
          (await ctx.positions('surplus')).some(item=>item.facts.paymentHold===true))
        return fail('AGENCY_CREDIT_HELD',409);
      await ctx.claim(available,minor,available.remaining===minor?'RESERVED':'AVAILABLE');
      await ctx.record('credit-use:'+id,approval,null,{credit,minor,mode});
      return {id,credit,minor,mode,state:'RESERVED'};
    }
    if (action==='treasury-authorize-period') {
      const id=uuid(input.evidence), at=time(input.at), approval=uuid(input.approval);
      const previous=await ctx.position('period-approval',id);
      if (previous && (previous.facts.at!==at || previous.facts.approval!==approval))
        return fail('SUCCESSOR_APPROVAL_CONFLICT',409);
      if (previous) return {id,state:'APPROVED'};
      const held=(await ctx.positions('late')).find(row=>row.state==='PERIOD_SEALED' && row.facts.evidence===id);
      if (!held || at.slice(0,7)<=String(held.facts.at).slice(0,7)) return fail('SUCCESSOR_PERIOD_REQUIRED',409);
      await ctx.db.query('SELECT omni.ledger_open($1,$2)',[tenant,at.slice(0,7)]);
      await ctx.set('period-approval',id,0,'APPROVED',{at,approval,actor});
      await project(ctx);
      return {id,state:'APPROVED'};
    }
    if (action==='treasury-report-link') {
      const id=uuid(input.evidence);
      const source=input.source as Source;
      const line=typeof input.line==='string' ? input.line : fail('REPORT_LINE_REQUIRED');
      const fact=(await ctx.facts()).find(row=>row.fact.id===id && row.fact.source===source);
      const {rows:[posting]}=await ctx.db.query<{minor:number;evidence:string}>(`SELECT l.minor,a.evidence FROM omni.ledger_lines l
        JOIN omni.governed_adjustments a ON l.tenant_id=a.tenant_id AND l.journal_id='adjustment:'||a.id
        WHERE l.tenant_id=$1 AND l.line_id=$2`,[tenant,line]);
      const kind=fact?.fact.kind;
      if (!fact || !posting || posting.evidence!==id || (kind!=='DEBIT' && kind!=='CREDIT') ||
          posting.minor!==(kind==='DEBIT'?-cents(fact.fact.data.minor):cents(fact.fact.data.minor)) ||
          !await ctx.effect('bank-'+kind.toLowerCase()+':'+id)) return fail('UNVERIFIED_REPORT_LINE');
      const key='report-link:'+digest(jsonBytes([line,id,source]));
      const provenance={line,id,source,digest:fact.digest,minor:posting.minor};
      if (!await ctx.effect(key)) await ctx.record(key,id,null,provenance);
      return {key,...provenance};
    }
    return fail('UNKNOWN_TREASURY_ACTION',400);
  }));
}
