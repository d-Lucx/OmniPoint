import assert from 'node:assert/strict';
import { generateKeyPairSync,randomBytes,randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync,renameSync,writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { signArtifact } from '../src/authority.ts';
import { createCloud } from '../src/cloud.ts';
import { verifyExport,verifyPlan } from '../src/governed-report.ts';
import { captureModuleCut,restoreModuleCuts,sealModuleCuts } from '../src/module-restore.ts';
import { verifyRestoredSeal,verifySeal } from '../src/period-close.ts';
import { tenantTransaction } from '../src/postgres.ts';
import { digest,jsonBytes } from '../src/protocol.ts';
import { treasuryFixture } from '../src/treasury-fixture.ts';
import { purpose } from '../src/treasury-protocol.ts';
import type { Fact,Source } from '../src/treasury-protocol.ts';
import { local,seed,testDatabase,testResources } from './fixture.ts';
import type { TestDatabase } from './fixture.ts';
import { post,removeTreasuryFixture,stop } from './retail-fixture.ts';

const march='2026-03', april='2026-04';
const date=(period=march)=>period+'-15T12:00:00.000Z';
const id=randomUUID;
type Recorded={fact:Fact;packet:unknown;digest:string};

async function setup(t:TestContext,db:TestDatabase) {
  const f=await testResources(t), enrollment=await seed(db), foreign=await seed(db);
  const actor=id(), token=randomBytes(32).toString('base64url'), foreignToken=randomBytes(32).toString('base64url');
  const governance=generateKeyPairSync('ed25519'), govSigner={id:'treasury-governance',key:governance.privateKey};
  const trust=new Map([[govSigner.id,governance.publicKey]]);
  const createRail=async (source:Source)=>{
    const keys=generateKeyPairSync('ed25519');
    const signer={id:'treasury-'+source,key:keys.privateKey};
    const token=randomBytes(32).toString('base64url'), path=join(f.dir,source+'.sqlite');
    let drop:string|undefined;
    let decline:string|undefined;
    const make=()=>treasuryFixture(path,source,token,signer,{afterCommit(attempt,response){
      if (attempt===drop) {drop=undefined;response.destroy();}
    },reject(request){return request.attempt===decline;}});
    let rail=make();
    let url=new URL('/',await f.listen(rail.server)).href;
    const adapter={url,token,keyId:signer.id,key:keys.publicKey};
    f.dispose(()=>rail.close());
    return {path,signer,adapter,
      lose(attempt:string){drop=attempt},
      reject(attempt:string){decline=attempt},
      async restart(){await stop(rail.server);rail.close();rail=make();url=new URL('/',await f.listen(rail.server)).href;adapter.url=url;},
      async mint(fact:Fact){
        const result=await post(new URL('/fact',url).href,token,jsonBytes(fact));
        assert.equal(result.status,200);
        const packet=result.json();
        return {fact,packet,digest:digest(Buffer.from(packet.body,'base64url'))} as Recorded;
      }};
  };
  const agency=await createRail('agency'),bank=await createRail('bank');
  const opts={governanceSigner:govSigner,operators:[
    {tenantId:enrollment.tenantId,actorId:actor,token,governance:true as const},
    {tenantId:foreign.tenantId,actorId:id(),token:foreignToken,governance:true as const},
  ],treasury:{agency:agency.adapter,bank:bank.adapter}};
  let failure:unknown;
  const create=(pool=db.runtime)=>createCloud(pool,[enrollment],f.signer,{failed(error){failure=error}},opts);
  let cloud=create();
  let url=await f.listen(cloud);
  function call(input:object,credential=token,base=url){
    return post(new URL('/v6/governance',base).href,credential,jsonBytes(input));
  }
  const go=async (input:object,status=200)=>{
    const result=await call(input);
    assert.equal(result.status,status,`${(input as {action?:string}).action}: ${failure instanceof Error ? failure.message : ''}`);
    return result.json();
  };
  async function account(opening=0, account=id()){
    await go({action:'treasury-open',account,taxpayer:'SYNTHETIC-TAXPAYER',remitter:'DEMO-AGENCY',opening});
    return account;
  }
  function mint(account:string,source:Source,kind:string,data:Record<string,unknown>,opts:{
    cut?:number;at?:string;lineage?:string;id?:string;
  }={}) {
    return (source==='bank'?bank:agency).mint({tenant:enrollment.tenantId,account,source,kind,data,
      id:opts.id ?? id(),lineage:opts.lineage ?? account,cut:opts.cut ?? 1,currency:'USD',at:opts.at ?? date()});
  }
  function ingest(value:Recorded,status=200){
    return go({action:'treasury-ingest',account:value.fact.account,source:value.fact.source,packet:value.packet},status);
  }
  function state(account:string){return go({action:'treasury-get',account});}
  async function amounts(account:string) {
    const {rows}=await db.fixture.query<{account:string;minor:number}>(`SELECT l.account,sum(l.minor)::integer AS minor
      FROM omni.treasury_effects e JOIN omni.ledger_lines l ON l.tenant_id=e.tenant_id AND l.journal_id='adjustment:'||e.journal
      WHERE e.tenant_id=$1 AND e.account_id=$2 GROUP BY l.account ORDER BY l.account`,[enrollment.tenantId,account]);
    return Object.fromEntries(rows.map(row=>[row.account,row.minor]));
  }
  return {...f,enrollment,agency,bank,go,call,account,mint,ingest,state,amounts,token,foreignToken,trust,create,
    async restart(){await stop(cloud);cloud=create();url=await f.listen(cloud);}};
}
type Harness=Awaited<ReturnType<typeof setup>>;
type State={positions:{kind:string;id:string;remaining:number;state:string;facts:Record<string,unknown>}[];
  effects:{effect:string;facts:Record<string,unknown>;journal:string|null}[];
  attempts:{attempt:string;digest:string;state:string;request:string}[]};
const pos=(state:State,kind:string,key:string)=>state.positions.find(row=>row.kind===kind&&row.id===key);
const close=(period:string,previous:string|null=null)=>({action:'period-close',period,id:id(),previous,approval:id()});
const filingRequest=(account:string)=>({action:'treasury-send',account,operation:id(),attempt:id(),subject:id(),
  predecessor:null,kind:'FILING',minor:0,terms:{period:march,timezone:'America/Denver',jurisdiction:'OMNI-DEMO',
    channel:'fixture-api',payload:Buffer.from('synthetic filing bytes').toString('base64url'),deadline:'2026-04-15T23:59:00.000Z'}});

test('M7-01 lost filing and funding responses recover exact attempts, split settlement and credit capacity', {timeout:35_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());
  const h=await setup(t,db), account=await h.account(1000);
  const filing=filingRequest(account);
  h.agency.lose(filing.attempt);
  assert.equal((await h.go(filing)).state,'MAY_HAVE_SENT');
  const first:State=await h.state(account);
  const original=first.attempts[0];
  assert.equal(digest(Buffer.from(original.request,'base64url')),original.digest);
  assert.equal(local(h.agency.path,sqlite=>sqlite.prepare('SELECT count(*) AS n FROM attempts').get()?.n),1);
  await h.agency.restart(); await h.restart();
  assert.equal((await h.go({action:'treasury-recover',account,attempt:filing.attempt})).state,'TRANSMITTED');
  const filed=await h.mint(account,'agency','FILED',{attempt:filing.attempt,subject:filing.subject,docket:'DOCKET-0001',
    requestDigest:original.digest},{lineage:filing.subject,cut:2,at:new Date().toISOString()});
  await h.ingest(filed);
  assert.equal(pos(await h.state(account),'filing',filing.subject)?.facts.timely,filed.fact.at<=filing.terms.deadline);
  const amendment=await h.mint(account,'agency','FILING_CHANGE',{subject:filing.subject,previous:filed.fact.id,
    transition:'AMEND',payload:Buffer.from('revised filing').toString('base64url')},{lineage:filing.subject,cut:3});
  await h.ingest(amendment);
  assert.equal(pos(await h.state(account),'filing',filing.subject)?.facts.previous,filed.fact.id);
  const subject=id();
  const assessment=await h.mint(account,'agency','ASSESSMENT',{subject,outstanding:1000,covered:[]},{lineage:subject,cut:1});
  await h.ingest(assessment);
  await h.ingest(await h.mint(account,'agency','COLLECTION',{subject,minor:1000},{lineage:subject,cut:2}));
  const funding={action:'treasury-send',account,operation:id(),attempt:id(),subject,predecessor:null,kind:'FUNDING',
    minor:1000,terms:{assessment:assessment.fact.id,cut:1}};
  h.bank.lose(funding.attempt);
  assert.equal((await h.go(funding)).state,'MAY_HAVE_SENT');
  await h.go({...funding,minor:1,attempt:id(),operation:id()},409);
  await h.bank.restart(); await h.restart();
  assert.equal((await h.go({action:'treasury-recover',account,attempt:funding.attempt})).state,'TRANSMITTED');
  const leg=(source:Source,kind:string,minor:number,cut:number)=>
    h.mint(account,source,kind,{attempt:funding.attempt,subject,minor},{lineage:subject,cut});
  const apply=await leg('agency','APPLIED',1000,5), receive=await leg('agency','RECEIVED',1000,4);
  await h.ingest(apply);await h.ingest(receive);
  assert.deepEqual(await h.amounts(account),{});
  const one=await leg('bank','SETTLED',600,2),two=await leg('bank','SETTLED',400,3);
  await h.ingest(two);await h.ingest(one);await h.ingest(two);
  assert.deepEqual(await h.amounts(account),{Cash:-1000,OutboundClearing:0,StatutoryPayable:1000});
  await h.ingest(await h.mint(account,'bank','STATEMENT',{opening:1000,closing:0,booked:true,sequence:1,revision:1,
    previous:null,lines:[{id:id(),canonical:one.fact.id,minor:600},{id:id(),canonical:two.fact.id,minor:400}]},{cut:3}));
  assert.equal((await h.state(account) as State).positions.filter(row=>row.kind==='alias').length,2);
  assert.deepEqual(await h.amounts(account),{Cash:-1000,OutboundClearing:0,StatutoryPayable:1000});
  const later=await h.mint(account,'agency','ASSESSMENT',{subject,outstanding:200,covered:[funding.attempt]},
    {lineage:subject,cut:6});
  await h.ingest(later);
  await h.go({...funding,minor:200,attempt:id(),operation:id(),terms:{assessment:later.fact.id,cut:6}});
  const credit=await h.mint(account,'agency','HELD_CREDIT',{subject,minor:100},{lineage:subject,cut:7});
  await h.ingest(credit);
  const race=await Promise.all(['APPLY','REFUND'].map(mode=>h.call({action:'treasury-credit-use',account,
    id:id(),credit:credit.fact.id,minor:100,approval:id(),mode})));
  assert.deepEqual(race.map(row=>row.status).sort(),[200,409]);
  assert.equal(local(h.bank.path,sqlite=>sqlite.prepare('SELECT count(*) AS n FROM attempts').get()?.n),2);
  assert.equal(local(h.agency.path,sqlite=>sqlite.prepare('SELECT count(*) AS n FROM attempts').get()?.n),1);
});

async function receivable(h:Harness,account:string,feeAccount='FeeExpense',receive=true) {
  const invoice=id(),fee=id(),credit=id();
  await h.go({action:'treasury-receivable',account,id:invoice,minor:1000,at:date(),approval:id()});
  const principal=await h.mint(account,'bank','CREDIT',{minor:950,purpose:'PRINCIPAL',remitter:'DEMO-AGENCY',
    remittance:invoice,trace:'TRACE-950'});
  await h.ingest(principal);
  const advice=await h.mint(account,'agency','FEE',{minor:50,receivable:invoice,principal:principal.fact.id,
    account:feeAccount},{id:fee,cut:2});
  const refund=await h.mint(account,'bank','CREDIT',{minor:50,purpose:'REIMBURSEMENT',remitter:'DEMO-AGENCY',
    remittance:fee,trace:'TRACE-50'},{id:credit,cut:3});
  const proof=await h.mint(account,'agency','PROOF',{minor:50,fee,credit,supersedes:null},{cut:4});
  const final=await h.mint(account,'agency','FINAL',{fee,candidates:[proof.fact.id]},{cut:5});
  if (receive) for (const entry of [advice,refund,proof,final]) await h.ingest(entry);
  return {invoice,fee,credit,principal,advice,refund,proof,final};
}

test('M7-02 six arrival orders converge, unrelated cash stays suspended and incomparable proofs freeze', {timeout:45_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());const h=await setup(t,db);
  for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
    const account=await h.account();
    const f=await receivable(h,account,'FeeExpense',false);
    assert.equal(pos(await h.state(account),'receivable',f.invoice)?.remaining,50);
    await h.ingest(f.final);
    const legs=[f.advice,f.refund,f.proof];
    for (const index of order) await h.ingest(legs[index]);
    assert.equal((await h.ingest(f.proof)).state,'REPLAY');
    const state:State=await h.state(account);
    assert.equal(state.effects.filter(row=>row.effect.startsWith('reimbursement:')).length,1);
    assert.equal(state.effects.filter(row=>row.effect.startsWith('bank-credit:')).length,2);
    assert.deepEqual(await h.amounts(account),{AgencyIncome:-1000,AgencyReceivable:0,Cash:1000,FeeExpense:0,InboundSuspense:0});
    if (order[0]===0 && order[1]===1) {
      const forged={...f.refund.fact,data:{...f.refund.fact.data,minor:51}};
      const collision={...f.refund,packet:signArtifact(purpose('bank'),forged,h.bank.signer)};
      await h.ingest(collision,409);await h.ingest(collision,409);
      const disputed=await h.state(account);
      assert.equal(disputed.collisions.length,1);
      assert.equal(pos(disputed,'incident',f.refund.fact.id)?.state,'EVIDENCE_COLLISION');
      assert.deepEqual(await h.amounts(account),{AgencyIncome:-1000,AgencyReceivable:0,Cash:1000,FeeExpense:0,InboundSuspense:0});
    }
  }
  const account=await h.account(), f=await receivable(h,account,'FeeExpense',false);
  await h.ingest(f.advice);await h.ingest(f.refund);
  const stranger=await h.mint(account,'bank','CREDIT',{minor:50,purpose:'REIMBURSEMENT',remitter:'OTHER',
    remittance:f.fee,trace:'TRACE-50'});
  await h.ingest(stranger);
  const other=await h.mint(account,'agency','PROOF',{minor:50,fee:f.fee,credit:f.credit,supersedes:null},{lineage:id(),cut:4});
  await h.ingest(await h.mint(account,'agency','FINAL',{fee:f.fee,candidates:[f.proof.fact.id,other.fact.id]},{cut:5}));
  await Promise.all([h.ingest(f.proof),h.ingest(other)]);
  const frozen:State=await h.state(account);
  assert.equal(pos(frozen,'incident',f.fee)?.state,'PROOF_CONFLICT');
  assert.equal(pos(frozen,'credit',f.credit)?.state,'FROZEN');
  assert.equal(pos(frozen,'credit',stranger.fact.id)?.remaining,50);
  assert.equal(pos(frozen,'fee',f.fee)?.remaining,50);
  const selected=await h.account(), target=await receivable(h,selected,'FeeExpense',false);
  await h.ingest(target.advice);await h.ingest(target.refund);
  const successor=await h.mint(selected,'agency','PROOF',{minor:50,fee:target.fee,credit:target.credit,
    supersedes:target.proof.fact.id},{lineage:target.proof.fact.lineage,cut:6});
  await h.ingest(await h.mint(selected,'agency','FINAL',{fee:target.fee,candidates:[target.proof.fact.id,successor.fact.id]},
    {cut:7}));
  await h.ingest(successor);await h.ingest(target.proof);
  assert.equal(pos(await h.state(selected),'reimbursement',target.fee)?.facts.proof,successor.fact.id);
  assert.deepEqual(await h.amounts(selected),{AgencyIncome:-1000,AgencyReceivable:0,Cash:1000,FeeExpense:0,InboundSuspense:0});
});

test('M7-03 sealed allocations, fenced surplus and dual execution preserve the original journal', {timeout:45_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());const h=await setup(t,db);
  const cases=[];
  for (const satisfied of [false,true]) {
    const account=await h.account(), a=await receivable(h,account,'FeeA'), b=await receivable(h,account,'FeeB',satisfied);
    if (!satisfied) await h.ingest(b.advice);
    cases.push({satisfied,account,a,b});
  }
  const seal=close(march), original=await h.go(seal);
  for (const {satisfied,account,a,b} of cases) {
    const fix=await h.mint(account,'agency','ALLOCATION_CORRECT',{from:a.fee,to:b.fee,proof:a.proof.fact.id,minor:50},
      {at:date(april),cut:10});
    await h.ingest(fix);await h.ingest(fix);
    const state:State=await h.state(account);
    assert.equal(pos(state,'fee',a.fee)?.remaining,50);
    assert.equal(pos(state,'fee',b.fee)?.facts.credit,a.credit);
    assert.equal(pos(state,'fee',b.fee)?.remaining,0);
    if (!satisfied) {
      assert.equal((await h.amounts(account)).FeeB,0);
      continue;
    }
    assert.equal(pos(state,'surplus',fix.fact.id)?.remaining,0);
    assert.equal(pos(state,'surplus',fix.fact.id)?.facts.credit,b.credit);
    const details={surplus:fix.fact.id,minor:50};
    await h.ingest(await h.mint(account,'bank','CLAWBACK',details,{at:date(april),cut:11}));
    await h.ingest(await h.mint(account,'agency','OFFSET',{...details,phase:'DIRECTIVE'},{at:date(april),cut:11}));
    assert.equal(pos(await h.state(account),'surplus',fix.fact.id)?.state,'DISPUTED');
    const bank=await h.mint(account,'bank','DEBIT',details,{at:date(april),cut:12});
    const agency=await h.mint(account,'agency','OFFSET',{...details,phase:'EXECUTED'},{at:date(april),cut:13});
    await Promise.all([h.ingest(bank),h.ingest(agency)]);
    await h.ingest(bank);await h.ingest(agency);
    const final:State=await h.state(account);
    assert.equal(final.effects.filter(row=>row.effect.startsWith('bank-debit:')).length,1);
    const hold=pos(final,'surplus',fix.fact.id)!;
    assert.equal(hold.state,'DUAL_EXECUTION');
    assert.deepEqual([hold.remaining,hold.facts.recognitionHold,hold.facts.dischargeHold,hold.facts.paymentHold],[0,true,true,true]);
    const money=await h.amounts(account);
    assert.deepEqual([money.Cash,money.SurplusHold,money.DisputeReceivable],[1950,0,50]);
    const subject=id(), assessment=await h.mint(account,'agency','ASSESSMENT',{subject,outstanding:50,covered:[]},
      {lineage:subject,at:date(april)});
    await h.ingest(assessment);
    await h.go({action:'treasury-send',account,operation:id(),attempt:id(),predecessor:null,kind:'FUNDING',
      subject,minor:50,terms:{assessment:assessment.fact.id,cut:1}},409);
  }
  assert.deepEqual(await h.go(seal),original);
  verifySeal(original,h.trust,{tenant:h.enrollment.tenantId,period:march,previous:null});
});

async function debitEnvelope(h:Harness,account:string,prior:Recorded,at=date(april)) {
  const candidates=[id(),id()], alias=id();
  const statement=await h.mint(account,'bank','STATEMENT',{opening:1000,closing:900,booked:true,sequence:1,revision:1,
    previous:null,lines:[{id:alias,canonical:prior.fact.id,minor:50},...candidates.map(id=>({id,canonical:null,minor:50}))]},
  {cut:2,at});
  await h.ingest(statement);
  return {statement,alias,candidates};
}
const bankDebit=(h:Harness,account:string)=>h.mint(account,'bank','DEBIT',{minor:50,trace:'SAME-AMOUNT'},{cut:1});
const bankReturn=(h:Harness,account:string,envelope:string,cut=3)=>
  h.mint(account,'bank','CREDIT',{minor:50,purpose:'RETURN',remitter:'DEMO-AGENCY',remittance:envelope},{cut,at:date(april)});

test('M7-04 sealed overlap books one aggregate debit and differentiates four amendment effects', {timeout:40_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());const h=await setup(t,db);
  const examples=[];
  for (const mode of ['GHOST','REAL_RETURN','FORWARD','AMBIGUOUS']) {
    const account=await h.account(1000), prior=await bankDebit(h,account);
    await h.ingest(prior);
    examples.push({mode,account,prior});
  }
  const sealed=close(march), original=await h.go(sealed);
  for (const {mode,account,prior} of examples) {
    const {statement,alias,candidates}=await debitEnvelope(h,account,prior);
    await h.ingest(statement);
    const envelope=statement.fact.id;
    const initial:State=await h.state(account);
    assert.equal(pos(initial,'alias',alias)?.facts.canonical,prior.fact.id);
    assert.deepEqual(pos(initial,'envelope',envelope)?.facts.candidates,candidates);
    assert.equal((await h.amounts(account)).Cash,-100);
    const credit=mode==='REAL_RETURN'||mode==='FORWARD' ? await bankReturn(h,account,envelope) : undefined;
    if (mode==='FORWARD') {
      await h.ingest(credit!);
      await h.ingest(await h.mint(account,'bank','STATEMENT',{opening:1000,closing:950,booked:true,sequence:2,revision:1,
        previous:statement.digest,lines:[]},{cut:3,at:date(april)}));
    }
    const amendment=await h.mint(account,'bank','STATEMENT',{opening:1000,closing:mode==='GHOST'||mode==='REAL_RETURN'?950:900,
      booked:true,sequence:1,revision:2,previous:statement.digest,mode,envelope,credit:credit?.fact.id ?? null},
    {cut:mode==='REAL_RETURN'?3:2,at:date(april)});
    await h.ingest(amendment);
    if (mode==='REAL_RETURN') await h.ingest(credit!);
    await h.ingest(amendment);
    const result:State=await h.state(account);
    if (mode==='AMBIGUOUS') {
      assert.equal(pos(result,'incident',amendment.fact.id)?.state,'AMBIGUOUS_AMENDMENT');
      assert.equal((await h.amounts(account)).Cash,-100);
    } else {
      assert.equal((await h.amounts(account)).Cash,-50);
      assert.equal(pos(result,'envelope',envelope)?.remaining,0);
      const matched=result.effects.find(row=>row.effect.startsWith('statement-match:'));
      if (credit) {
        assert.ok(matched);
        assert.equal(matched.facts.cash,undefined);
        assert.equal(result.effects.filter(row=>row.effect.startsWith('bank-credit:')).length,1);
      }
    }
  }
  assert.deepEqual(await h.go(sealed),original);
});

test('M7-05 permanent revocation, early reinstatement, continuity and open-period inverse', {timeout:40_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());const h=await setup(t,db);
  const cases=[];
  for (const mode of ['early','continuity','inverse','race']) {
    const account=await h.account(1000), prior=await bankDebit(h,account);
    await h.ingest(prior);
    const {statement}=await debitEnvelope(h,account,prior,date());
    const credit=await h.mint(account,'bank','CREDIT',{minor:50,purpose:'RETURN',remitter:'DEMO-AGENCY',
      remittance:statement.fact.id},{cut:3,at:mode==='early'?date(april):date()});
    const binding={envelope:statement.fact.id,credit:credit.fact.id,minor:50};
    const original=await h.mint(account,'agency','ATTEST',binding,{cut:4,at:mode==='race'?date(april):date()});
    const revoke=await h.mint(account,'agency','REVOKE',{...binding,original:original.fact.id},{cut:5,at:date(april)});
    const next=await h.mint(account,'agency','REINSTATE',{...binding,original:original.fact.id,revocation:revoke.fact.id},
      {cut:6,at:date(april)});
    if (mode!=='early') await h.ingest(credit);
    if (mode!=='early' && mode!=='race') await h.ingest(original);
    cases.push({mode,account,credit,original,revoke,next,binding});
  }
  const seal=close(march), original=await h.go(seal);
  for (const {mode,account,credit,original,revoke,next,binding} of cases) {
    if (mode!=='inverse' && mode!=='race') {
      await h.ingest(next);
      assert.equal(pos(await h.state(account),'pending-attestation',next.fact.id)?.state,'WAITING');
    }
    if (mode==='race') await Promise.all([h.ingest(original),h.ingest(revoke)]);
    else await h.ingest(revoke);
    assert.equal(pos(await h.state(account),'tombstone',original.fact.id)?.state,'PERMANENT');
    if (mode==='early') {
      await h.ingest(original);
      assert.ok(!(await h.state(account) as State).effects.some(row=>row.effect==='attest:'+original.fact.id));
      await h.ingest(credit);
    } else if (mode==='inverse') {
      assert.equal(pos(await h.state(account),'credit',credit.fact.id)?.state,'REVOKED_HELD');
      assert.equal(pos(await h.state(account),'envelope',binding.envelope)?.remaining,50);
      await h.ingest(next);
    } else if (mode==='race') {
      await h.ingest(next);
    }
    await h.ingest(original);await h.ingest(revoke);await h.ingest(next);
    const state:State=await h.state(account);
    assert.equal(pos(state,'tombstone',original.fact.id)?.state,'PERMANENT');
    assert.equal(pos(state,'credit',credit.fact.id)?.remaining,0);
    assert.equal(pos(state,'envelope',binding.envelope)?.remaining,0);
    assert.equal(pos(state,'attestation',original.fact.id)?.facts.mode,mode==='continuity'?'CONTINUITY':'REPOSTED');
    const inverses=state.effects.filter(row=>row.effect.startsWith('revoke:')).length;
    if (mode==='race') assert.ok(inverses<=1); else assert.equal(inverses,mode==='inverse'?1:0);
    assert.equal(state.effects.filter(row=>row.effect.startsWith('authority-only:')).length,mode==='continuity'?1:0);
  }
  assert.deepEqual(await h.go(seal),original);
});

function report(seal:string,lineage=id(),predecessor:string|null=null,slices:object[]=[],treasury?:object[]) {
  return {action:'report-approve',id:id(),lineage,predecessor,seal,april,approval:id(),slices,replacement:null,
    ...(treasury ? {treasury} : {})};
}
function movement(effect:string,minor:number,evidence:string=id(),reference:string|null=null) {
  return {action:'period-adjust',id:id(),businessAt:date(april),account:'TreasuryClearing',
    counteraccount:'TreasuryOffset',minor,evidence,effect,reference};
}

test('M7-06 signed treasury report provenance and cold restore preserve alias, tombstone and holds', {timeout:65_000}, async t=>{
  const db=await testDatabase(), restored=await testDatabase();
  t.after(async()=>{await restored.close();await db.close()});
  const h=await setup(t,db), account=await h.account(1000);
  const prior=await bankDebit(h,account);await h.ingest(prior);
  const terminal=h.register(h.enrollment);
  const filing=filingRequest(account);
  h.agency.lose(filing.attempt);
  assert.equal((await h.go(filing)).state,'MAY_HAVE_SENT');
  const seal=close(march);await h.go(seal);
  const root=await captureModuleCut(h.dir,db.fixture,terminal.path,0,null);
  const {statement,alias}=await debitEnvelope(h,account,prior);
  const missing=id(), original=id();
  await h.ingest(await h.mint(account,'agency','REVOKE',{original,envelope:statement.fact.id,credit:missing,minor:50},
    {at:date(april),cut:5}));
  const railAccount=await h.account();
  const bind=async (kind:'CREDIT'|'DEBIT',minor:number,effect:string,reference:string|null=null)=>{
    const fact=await h.mint(railAccount,'bank',kind,{minor:Math.abs(minor),purpose:'UNMATCHED',remitter:'DEMO-AGENCY',
      remittance:id()},{at:date(april)});
    await h.ingest(fact);
    const classified=movement(effect,minor,fact.fact.id,reference);
    await h.go(classified);
    const line='adjustment:'+classified.id+':TreasuryClearing';
    const link=await h.go({action:'treasury-report-link',account:railAccount,source:'bank',line,evidence:fact.fact.id});
    return {line,link:{account:railAccount,key:link.key}};
  };
  const lineage=id(), synthetic=report(seal.id,lineage);await h.go(synthetic);
  const historic=await h.go({action:'report-publish',plan:synthetic.id,id:id()});
  const restore=await bind('CREDIT',50,'RESTORE'), thirty=await bind('DEBIT',-30,'POST');
  const partial=report(seal.id,lineage,synthetic.id,[{line:thirty.line,start:0,minor:30}],[restore.link,thirty.link]);
  assert.equal((await h.go(partial)).facts.bridge.TreasuryClearing.synthetic,-20);
  const twenty=await bind('DEBIT',-20,'POST');
  const unrelated=movement('UNRELATED',125);await h.go(unrelated);
  const parts=[{line:thirty.line,start:0,minor:30},{line:twenty.line,start:30,minor:20}];
  const full=report(seal.id,lineage,partial.id,parts,[restore.link,thirty.link,twenty.link]);
  assert.equal((await h.go(full)).facts.bridge.TreasuryClearing.closing,0);
  const replacement={line:thirty.line,evidence:id()};
  await h.go({action:'period-technical-replace',id:id(),reverseId:id(),businessAt:date(april),...replacement});
  const reopen=await bind('CREDIT',20,'REVOKE',twenty.line);
  const revised={...report(seal.id,lineage,full.id,parts,[restore.link,thirty.link,twenty.link,reopen.link]),replacement};
  const approved=await h.go(revised);
  const facts=verifyPlan(approved,h.trust,{tenant:h.enrollment.tenantId,id:revised.id,seal:seal.id});
  assert.equal(approved.facts.bridge.TreasuryClearing.closing,20);
  assert.equal(approved.facts.unrelated[0].proof[0].minor,125);
  assert.equal((facts.treasury as unknown[]).length,4);
  const exported=await h.go({action:'report-publish',plan:revised.id,id:id()});
  const before=verifyExport(exported,h.trust,{tenant:h.enrollment.tenantId,plan:revised.id,seal:seal.id});
  const second=close(april,seal.id);await h.go(second);
  const later=await captureModuleCut(h.dir,db.fixture,terminal.path,1,root);
  const manifest=sealModuleCuts(h.dir,{id:id(),segments:[root,later]});
  const target=join(h.dir,'restored.sqlite'), segment=join(h.dir,later+'.json');
  renameSync(segment,segment+'.absent');
  try {await assert.rejects(restoreModuleCuts(h.dir,manifest,restored.fixture,target),/Missing restore segment/);}
  finally {renameSync(segment+'.absent',segment);}
  assert.equal((await restored.fixture.query('SELECT * FROM omni.treasury_accounts')).rowCount,0);
  const originalSegment=readFileSync(segment);
  writeFileSync(segment,Buffer.concat([originalSegment,Buffer.from(' ')]));
  try {await assert.rejects(restoreModuleCuts(h.dir,manifest,restored.fixture,target),/segment digest mismatch/);}
  finally {writeFileSync(segment,originalSegment);}
  assert.equal((await restored.fixture.query('SELECT * FROM omni.treasury_accounts')).rowCount,0);
  await restoreModuleCuts(h.dir,manifest,restored.fixture,target);
  await tenantTransaction(restored.runtime,h.enrollment.tenantId,async conn=>{
    await verifyRestoredSeal(conn,h.enrollment.tenantId,march,null,h.trust);
    await verifyRestoredSeal(conn,h.enrollment.tenantId,april,seal.id,h.trust);
  });
  const url=await h.listen(h.create(restored.runtime));
  await h.agency.restart();
  const recovered=(await h.call({action:'treasury-recover',account,attempt:filing.attempt},h.token,url)).json();
  assert.equal(recovered.state,'TRANSMITTED');
  assert.equal(local(h.agency.path,sqlite=>sqlite.prepare('SELECT count(*) AS n FROM attempts').get()?.n),1);
  const state=(await h.call({action:'treasury-get',account},h.token,url)).json();
  assert.equal(pos(state,'alias',alias)?.facts.canonical,prior.fact.id);
  assert.equal(pos(state,'tombstone',original)?.state,'PERMANENT');
  assert.equal(pos(state,'envelope',statement.fact.id)?.remaining,50);
  const replay=(await h.call({action:'treasury-ingest',account,source:'bank',packet:statement.packet},h.token,url)).json();
  assert.equal(replay.state,'REPLAY');
  const current=(await h.call({action:'report-get',plan:revised.id},h.token,url)).json();
  assert.deepEqual(verifyExport(current.export,h.trust,{tenant:h.enrollment.tenantId,plan:revised.id,seal:seal.id}),before);
  assert.deepEqual((await h.call({action:'report-get',plan:synthetic.id},h.token,url)).json().export,historic);
});

test('M7-07 populated 007 upgrade preserves exact vouchers, seals and reports, and isolates tenant data', {timeout:30_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());const h=await setup(t,db);
  const terminal=h.register(h.enrollment);
  assert.ok((await terminal.child().send({action:'checkout',input:terminal.input})).value);
  const row=local(terminal.path,sqlite=>sqlite.prepare('SELECT event_bytes FROM outbox').get())!;
  const sale=jsonBytes({...JSON.parse(Buffer.from(row.event_bytes as Uint8Array).toString()),occurredAt:date()});
  const saleUrl=await h.listen(h.create());
  const voucher=await post(saleUrl,h.enrollment.token,sale);
  assert.equal(voucher.status,200);
  await removeTreasuryFixture(db);
  const closed=close(march), bundle=await h.go(closed);
  assert.equal('treasury_facts' in bundle.objects.evidence,false);
  const plan=report(closed.id);await h.go(plan);
  const published=await h.go({action:'report-publish',plan:plan.id,id:id()});
  await db.upgrade();
  const replay=await post(saleUrl,h.enrollment.token,sale);
  assert.deepEqual(replay.bytes,voucher.bytes);
  assert.equal(replay.headers.get('omni-signature'),voucher.headers.get('omni-signature'));
  assert.deepEqual(await h.go({action:'period-get',period:march}),bundle);
  assert.deepEqual((await h.go({action:'report-get',plan:plan.id})).export,published);
  const account=await h.account();
  const late=await h.mint(account,'bank','CREDIT',{minor:50,purpose:'UNMATCHED',remitter:'DEMO-AGENCY',remittance:id()});
  const attacker=generateKeyPairSync('ed25519');
  await h.ingest({...late,packet:signArtifact(purpose('bank'),late.fact,{id:h.bank.signer.id,key:attacker.privateKey})},422);
  const cross={...late.fact,tenant:id()};
  await h.ingest({...late,packet:signArtifact(purpose('bank'),cross,h.bank.signer)},403);
  await h.ingest(late);
  assert.deepEqual(await h.amounts(account),{});
  assert.ok((await h.state(account) as State).positions.some(row=>row.kind==='late' && row.state==='PERIOD_SEALED'));
  const authorization={action:'treasury-authorize-period',account,evidence:late.fact.id,approval:id(),at:date(april)};
  assert.deepEqual(await h.go(authorization),await h.go(authorization));
  assert.deepEqual(await h.amounts(account),{Cash:50,InboundSuspense:-50});
  await h.ingest(late);
  assert.deepEqual(await h.go({action:'period-get',period:march}),bundle);
  assert.equal((await h.call({action:'treasury-get',account},h.foreignToken)).status,404);
  assert.equal((await h.call({action:'treasury-get',account},h.enrollment.token)).status,401);
  assert.equal((await db.runtime.query('SELECT * FROM omni.treasury_accounts')).rowCount,0);
  await assert.rejects(tenantTransaction(db.runtime,h.enrollment.tenantId,conn=>conn.query('DELETE FROM omni.treasury_accounts')),
    /permission denied/);
});

test('M7-01 unknown execution is held, explicit idempotent resume and rejected replacement preserve lineage', {timeout:25_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());const h=await setup(t,db);
  const account=await h.account();
  const request=filingRequest(account), actual=h.agency.adapter.url;
  h.agency.adapter.url='http://127.0.0.1:1';
  try {assert.equal((await h.go(request)).state,'MAY_HAVE_SENT');}
  finally {h.agency.adapter.url=actual;}
  assert.equal(local(h.agency.path,sqlite=>sqlite.prepare('SELECT count(*) AS n FROM attempts').get()?.n),0);
  assert.equal((await h.go({action:'treasury-recover',account,attempt:request.attempt})).state,'MAY_HAVE_SENT');
  assert.equal(local(h.agency.path,sqlite=>sqlite.prepare('SELECT count(*) AS n FROM attempts').get()?.n),0);
  assert.equal((await h.go({action:'treasury-resume',account,attempt:request.attempt})).state,'TRANSMITTED');
  const rejected=filingRequest(account);
  h.agency.reject(rejected.attempt);
  assert.equal((await h.go(rejected)).state,'REJECTED');
  await h.go({...rejected,attempt:id()},409);
  const replacement={...rejected,attempt:id(),predecessor:rejected.attempt};
  assert.equal((await h.go(replacement)).state,'TRANSMITTED');
  assert.equal((await h.go({action:'treasury-recover',account,attempt:replacement.attempt})).state,'TRANSMITTED');
  const state:State=await h.state(account);
  assert.equal(state.attempts.length,3);
  assert.equal(local(h.agency.path,sqlite=>sqlite.prepare('SELECT count(*) AS n FROM attempts').get()?.n),3);
});
