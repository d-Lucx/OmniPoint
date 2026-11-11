import { exact } from './authority.ts';
import { isPeriod } from './period-close.ts';
import { digest, jsonBytes } from './protocol.ts';
import { cents, fail, text, time, uuid } from './treasury-protocol.ts';
import type { Fact, Source } from './treasury-protocol.ts';
import { identical, Treasury } from './treasury-store.ts';

export type Attempt = { attempt:string; operation:string; predecessor:string|null; kind:'FILING'|'FUNDING'; subject:string;
  minor:number; request:Buffer; digest:string; state:string };

export const sourceFor=(kind:Attempt['kind']):Source=>kind==='FILING'?'agency':'bank';

function filingDeadline(period:string) {
  const month=new Date(period+'-15T23:59:00.000Z');
  month.setUTCMonth(month.getUTCMonth()+1);
  return month.toISOString();
}

function filingPayload(value:unknown) {
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]{1,1200}$/.test(value)) return fail('INVALID_FILING_PAYLOAD');
  const bytes=Buffer.from(value,'base64url');
  if (bytes.toString('base64url')!==value) return fail('INVALID_FILING_PAYLOAD');
  return digest(bytes);
}

export async function attempts(ctx:Treasury) {
  return (await ctx.db.query<Attempt>(`SELECT * FROM omni.treasury_attempts WHERE tenant_id=$1 AND account_id=$2
    ORDER BY attempt`,ctx.args())).rows;
}

export async function prepare(ctx:Treasury,input:Record<string,unknown>) {
  const operation=uuid(input.operation), attempt=uuid(input.attempt), subject=uuid(input.subject);
  const predecessor=input.predecessor===null ? null : uuid(input.predecessor);
  const kind=input.kind;
  if (kind!=='FILING' && kind!=='FUNDING') return fail('INVALID_TREASURY_OPERATION');
  const known=await attempts(ctx);
  const previous=known.find(row=>row.attempt===attempt);
  const amount=cents(input.minor,kind==='FUNDING'?1:0);
  let terms:unknown;
  if (kind==='FILING') {
    const filing=exact(input.terms,['period','timezone','payload','deadline','jurisdiction','channel']);
    if (amount!==0 || !isPeriod(filing.period) || filing.timezone!=='America/Denver' ||
        filing.jurisdiction!=='OMNI-DEMO' || filing.channel!=='fixture-api' || filing.deadline!==filingDeadline(filing.period))
      return fail('INVALID_STATUTORY_FILING');
    time(filing.deadline);
    terms={...filing,payloadDigest:filingPayload(filing.payload)};
  } else {
    const funding=exact(input.terms,['assessment','cut']);
    uuid(funding.assessment); cents(funding.cut);
    terms={assessment:funding.assessment,cut:funding.cut};
    if (!previous) {
      if ((await ctx.positions('incident')).some(row=>row.state==='EVIDENCE_COLLISION'))
        return fail('TREASURY_EVIDENCE_HELD',409);
      if ((await ctx.positions('surplus')).some(row=>row.facts.paymentHold===true))
        return fail('REPLACEMENT_PAYMENT_HELD',409);
      const assessment=await ctx.position('assessment',subject);
      if (!assessment || assessment.state!=='OPEN' || assessment.facts.evidence!==funding.assessment ||
          assessment.facts.cut!==funding.cut) return fail('OBLIGATION_CUT_STALE',409);
      const covered=assessment.facts.covered as string[];
      const outstanding=known.filter(row=>row.kind==='FUNDING' && row.subject===subject &&
        row.state!=='REJECTED' && !covered.includes(row.attempt)).reduce((sum,row)=>sum+row.minor,0);
      if (amount>assessment.remaining-outstanding) return fail('OBLIGATION_CAPACITY_HELD',409);
    }
  }
  const body=jsonBytes({tenant:ctx.tenant,account:ctx.id,taxpayer:ctx.account.taxpayer,currency:'USD',operation,
    attempt,predecessor,kind,subject,minor:amount,terms});
  const hash=digest(body);
  if (previous) {
    if (previous.digest!==hash) return fail('TREASURY_ATTEMPT_COLLISION',409);
    return {attempt:previous,dispatch:false};
  }
  const siblings=known.filter(row=>row.operation===operation);
  const replaced=siblings.find(row=>row.attempt===predecessor);
  if (predecessor ? !replaced || replaced.state!=='REJECTED' || replaced.kind!==kind ||
      replaced.subject!==subject || replaced.minor!==amount || siblings.some(row=>row.predecessor===predecessor)
    : siblings.length>0) return fail('ATTEMPT_REPLACEMENT_NOT_AUTHORIZED',409);
  if (kind==='FILING' && known.some(row=>row.kind===kind && row.subject===subject && row.operation!==operation))
    return fail('FILING_ID_ALREADY_RESERVED',409);
  const row=(await ctx.db.query<Attempt>(`INSERT INTO omni.treasury_attempts VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'MAY_HAVE_SENT') RETURNING *`,
  ctx.args(attempt,operation,predecessor,kind,subject,amount,body,hash))).rows[0];
  return {attempt:row,dispatch:true};
}

export async function acceptAttemptStatus(ctx:Treasury,fact:Fact,row:Attempt) {
  const body=exact(fact.data,['attempt','operation','requestDigest']);
  if (fact.source!==sourceFor(row.kind) || fact.lineage!==row.operation || body.attempt!==row.attempt ||
      body.operation!==row.operation || body.requestDigest!==row.digest ||
      !['TRANSMITTED','REJECTED','UNKNOWN'].includes(fact.kind)) return fail('ATTEMPT_STATUS_MISMATCH',409);
  if (fact.kind==='UNKNOWN') return;
  if (row.state!==fact.kind && row.state!=='MAY_HAVE_SENT') return fail('ATTEMPT_FINAL_STATUS_CONFLICT',409);
  await ctx.db.query(`UPDATE omni.treasury_attempts SET state=$4 WHERE tenant_id=$1 AND account_id=$2 AND attempt=$3`,
    ctx.args(row.attempt,fact.kind));
}

export async function filingAndAssessment(ctx:Treasury) {
  const source=await ctx.facts('FILED','FILING_CHANGE','ASSESSMENT','COLLECTION','HELD_CREDIT');
  const transmissions=await ctx.facts('TRANSMITTED');
  const rows=await attempts(ctx);
  for (const {fact} of source) {
    const {data,id,kind}=fact;
    const effect='authority:'+id;
    if (await ctx.effect(effect)) continue;
    if (kind==='FILED') {
      const {attempt,subject,docket,requestDigest}=data;
      const row=rows.find(entry=>entry.attempt===attempt && entry.kind==='FILING');
      if (!row || row.state==='MAY_HAVE_SENT') continue;
      if (row.state!=='TRANSMITTED' || row.subject!==subject || row.digest!==requestDigest || fact.lineage!==subject)
        return fail('FILED_SCOPE_MISMATCH');
      const request=JSON.parse(row.request.toString());
      const transmitted=transmissions.find(item=>item.fact.data.attempt===row.attempt)?.fact;
      if (!transmitted || fact.cut<=transmitted.cut || Date.parse(fact.at)<Date.parse(transmitted.at))
        return fail('FILING_DOCKET_PRECEDENCE_REJECTED');
      const prior=await ctx.position('filing',uuid(subject));
      if (prior) return fail('FILING_FINALITY_CONFLICT',409);
      await ctx.set('filing',uuid(subject),0,'FILED',{id,docket:text(docket),attempt,cut:fact.cut,
        timely:Date.parse(fact.at)<=Date.parse(request.terms.deadline),occurredAt:fact.at,payloadDigest:request.terms.payloadDigest});
    } else if (kind==='FILING_CHANGE') {
      const subject=uuid(data.subject), prior=await ctx.position('filing',subject);
      if (!prior || prior.facts.id!==data.previous) continue;
      if (prior.state==='WITHDRAWN' || fact.lineage!==subject || fact.cut<=Number(prior.facts.cut) ||
          !['AMEND','WITHDRAW','MERGE','SEVER'].includes(String(data.transition))) return fail('FILING_LINEAGE_REJECTED');
      let related:string|null=null;
      if (data.transition==='MERGE' || data.transition==='SEVER') {
        related=uuid(data.related);
        const target=await ctx.position('filing',related);
        if (!target || related===subject || target.state==='WITHDRAWN') return fail('RELATED_FILING_REQUIRED');
      }
      const payloadDigest=data.transition==='AMEND' ? filingPayload(data.payload) : prior.facts.payloadDigest;
      await ctx.set('filing',subject,0,data.transition==='WITHDRAW'?'WITHDRAWN':'FILED',
        {...prior.facts,id,previous:data.previous,transition:data.transition,related,cut:fact.cut,payloadDigest});
    } else if (kind==='ASSESSMENT') {
      const subject=uuid(data.subject), amount=cents(data.outstanding,0);
      if (fact.lineage!==subject || !Array.isArray(data.covered) || new Set(data.covered).size!==data.covered.length ||
          data.covered.some(value=>!rows.some(row=>row.attempt===value && row.kind==='FUNDING' &&
            row.subject===subject && row.state==='TRANSMITTED'))) return fail('ASSESSMENT_COVERAGE_REJECTED');
      const prior=await ctx.position('assessment',subject);
      if (prior && fact.cut===prior.facts.cut) {
        if (!identical([prior.remaining,prior.facts.covered],[amount,data.covered]))
          await ctx.set('assessment',subject,prior.remaining,'FROZEN',{...prior.facts,conflict:id});
      } else if (!prior || fact.cut>Number(prior.facts.cut)) {
        if (prior && (prior.facts.covered as string[]).some(value=>!(data.covered as unknown[]).includes(value)))
          return fail('ASSESSMENT_CUT_LOST_COVERAGE');
        await ctx.set('assessment',subject,amount,'OPEN',{evidence:id,cut:fact.cut,covered:data.covered});
      }
    } else if (kind==='COLLECTION') {
      const subject=uuid(data.subject);
      if (!await ctx.position('assessment',subject)) continue;
      await ctx.set('collection',id,cents(data.minor),'COLLECTING',{subject,cut:fact.cut});
    } else {
      const subject=uuid(data.subject);
      await ctx.set('agency-credit',id,cents(data.minor),'AVAILABLE',{subject,cut:fact.cut});
    }
    await ctx.record(effect,id,null,{kind,cut:fact.cut});
  }
}

export async function settleFunding(ctx:Treasury,allowApplication=true) {
  const rows=await attempts(ctx);
  for (const row of rows.filter(entry=>entry.kind==='FUNDING' && entry.state==='TRANSMITTED')) {
    const facts=(await ctx.facts('SETTLED','RETURN','RECEIVED','APPLIED')).map(item=>item.fact)
      .filter(fact=>fact.data.attempt===row.attempt);
    const totals={settled:0,received:0,applied:0,returned:0};
    for (const fact of facts) {
      if (fact.lineage!==row.subject || fact.data.subject!==row.subject) return fail('FUNDING_LEG_SCOPE_REJECTED');
    }
    for (const fact of facts.filter(item=>item.kind==='SETTLED')) {
      const minor=cents(fact.data.minor), key='fund-settlement:'+fact.id;
      if (totals.settled+minor>row.minor) {
        await ctx.set('incident',fact.id,minor,'SETTLEMENT_EXCEEDS_ATTEMPT',{attempt:row.attempt});
        continue;
      }
      if (await ctx.effect(key) || await ctx.journal(key,fact,'OutboundClearing','Cash',minor,
        {cash:-minor,cut:fact.cut,attempt:row.attempt})) {
        totals.settled+=minor;
        if (!await ctx.position('debit',fact.id))
          await ctx.set('debit',fact.id,minor,'AVAILABLE',{...fact.data,cut:fact.cut,canonicalEffect:key});
      }
    }
    for (const fact of facts.filter(item=>item.kind==='RECEIVED')) {
      const minor=cents(fact.data.minor);
      if (totals.received+minor>totals.settled) continue;
      const key='agency-receive:'+fact.id;
      if (!allowApplication && !await ctx.effect(key)) continue;
      if (!await ctx.effect(key)) await ctx.record(key,fact.id,null,{minor,attempt:row.attempt});
      totals.received+=minor;
    }
    for (const fact of facts.filter(item=>item.kind==='APPLIED')) {
      const minor=cents(fact.data.minor);
      if (totals.applied+minor>totals.received) continue;
      const key='agency-apply:'+fact.id;
      if (!allowApplication && !await ctx.effect(key)) continue;
      if (await ctx.effect(key) || await ctx.journal(key,fact,'StatutoryPayable','OutboundClearing',minor,
        {attempt:row.attempt})) totals.applied+=minor;
    }
    for (const fact of facts.filter(item=>item.kind==='RETURN')) {
      const minor=cents(fact.data.minor), key='fund-return:'+fact.id;
      if (await ctx.effect(key) || await ctx.journal(key,fact,'Cash','InboundReturnSuspense',minor,
        {cash:minor,cut:fact.cut,attempt:row.attempt})) totals.returned+=minor;
    }
    await ctx.set('funding',row.attempt,row.minor-totals.settled,
      totals.returned?'RETURN_HELD':totals.applied===row.minor?'APPLIED':'IN_PROGRESS',totals);
  }
}
