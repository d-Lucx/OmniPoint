import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCloud } from '../src/cloud.ts';
import { verifyExport, verifyPlan } from '../src/governed-report.ts';
import { captureModuleCut, restoreModuleCuts, sealModuleCuts } from '../src/module-restore.ts';
import { canonical, sealPeriod, verifyRestoredSeal, verifySeal } from '../src/period-close.ts';
import type { SealBundle } from '../src/period-close.ts';
import { tenantTransaction } from '../src/postgres.ts';
import { digest, jsonBytes } from '../src/protocol.ts';
import type { RetailRegister } from '../src/retail-local.ts';
import { bounded, latch, local, seed, testDatabase, testResources } from './fixture.ts';
import type { TestDatabase } from './fixture.ts';
import { paymentFixture } from './payment-fixture.ts';
import { pin, post, removeGovernanceFixture, retailFixture, retailUrl, saved } from './retail-fixture.ts';

type Fixture = Pick<Awaited<ReturnType<typeof retailFixture>>,'a'|'b'|'opts'|'listen'|'signer'>;
const evidence = () => randomUUID();
const march = '2026-03';
const april = '2026-04';
const at = (period:string) => period+'-15T12:00:00.000Z';
const nextPeriod = (period:string) => {
  const value = new Date(period+'-01T00:00:00.000Z');
  value.setUTCMonth(value.getUTCMonth()+1);
  return value.toISOString().slice(0,7);
};
function approval(period:string,previous:string|null=null) {
  return {action:'period-close',period,id:randomUUID(),previous,approval:evidence()};
}
function correction(period:string,reference:string) {
  return {action:'period-adjust',id:randomUUID(),businessAt:at(period),account:'Cash',
    counteraccount:'PriorPeriodClearing',minor:17,evidence:evidence(),effect:'CORRECTION',reference};
}

async function governance(db:TestDatabase,f:Fixture,target=db.runtime) {
  const keys = generateKeyPairSync('ed25519');
  const signer = {id:'fixture-governance',key:keys.privateKey};
  const trust = new Map([[signer.id,keys.publicKey]]);
  const actor = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const witnessToken = randomBytes(32).toString('base64url');
  const second = await seed(db);
  const otherToken = randomBytes(32).toString('base64url');
  const opts = {...f.opts,governanceSigner:signer,operators:[...f.opts.operators,
    {tenantId:f.a.tenantId,token,actorId:actor,governance:true as const},
    {tenantId:f.a.tenantId,token:witnessToken,actorId:randomUUID(),governance:true as const},
    {tenantId:second.tenantId,token:otherToken,actorId:randomUUID(),governance:true as const}]};
  const url = await f.listen(createCloud(target,[f.a,f.b],f.signer,undefined,opts));
  const endpoint = new URL('/v6/governance',url).href;
  const send = (input:object,credential=token) => post(endpoint,credential,jsonBytes(input));
  const go = async (input:object,status=200) => {
    const result = await send(input);
    assert.equal(result.status,status,JSON.stringify(input));
    return result.json();
  };
  return {url,endpoint,send,go,opts,signer,trust,actor,token,otherToken,witnessToken};
}

async function waits(db:TestDatabase, count=1) {
  const deadline = Date.now()+4000;
  while(Date.now()<deadline) {
    if (((await db.fixture.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rowCount ?? 0)>=count) return;
  }
  assert.fail('Expected a blocked PostgreSQL advisory lock');
}

async function sync(register:RetailRegister, count:number) {
  for (let index=0;index<count;index++) assert.equal(await register.syncOnce(),'SYNCED');
}

test('M6-01 blind drawer close, unmatched drop, witnessed vault delta and deposit handoff', {timeout:30_000}, async t => {
  const db = await testDatabase(); t.after(()=>db.close());
  const f = await retailFixture(t,db);
  const g = await governance(db,f);
  await f.setup();
  const a = f.terminal(0);
  const r = a.register;
  const shift = randomUUID(), drawer = randomUUID(), vault = randomUUID(), bank = randomUUID(), drop = randomUUID();
  r.openShift(shift,drawer,5000);
  a.connection.importGrant(await f.issue('M1-ITEM',0),f.keys);
  r.scan('210001');
  await r.checkout(randomUUID(),220);
  r.drop(drop,vault,1000,pin);
  assert.equal(r.state().close,null);
  const first = randomUUID(), revised = randomUUID();
  assert.equal(r.close(first,{'2000':2,'100':2})?.variance_minor,-20);
  assert.equal(r.close(revised,{'2000':2,'100':2,'10':2},{previousId:first,reason:'Witness recount',pin})?.delta_minor,20);
  await sync(r,4);
  const state = {action:'cash-state',shift,vault,through:5};
  assert.equal((await g.go(state)).missing,1);
  await sync(r,1);
  const pending = await g.go(state);
  assert.deepEqual([pending.expected,pending.vaultMinor,pending.drawerInTransit,pending.finalized],[4220,0,1000,false]);
  assert.deepEqual(pending.unmatchedDrops,[drop]);
  const receive = {action:'cash-vault-receive',id:randomUUID(),vault,drop,evidence:evidence()};
  assert.deepEqual(await g.go(receive),await g.go(receive));
  const retained = {action:'cash-drawer-retain',id:randomUUID(),vault,shift,close:revised,minor:500,evidence:evidence()};
  await g.go(retained);
  const cut = await g.go(state);
  const count = {action:'cash-vault-count',id:randomUUID(),vault,cut:cut.vaultCut,previous:null as string|null,counted:1030,
    witness:evidence(),evidence:evidence(),businessAt:new Date().toISOString()};
  await g.go(count,409);
  const witness = async (request:typeof count) => {
    assert.equal((await g.send({...request,action:'cash-vault-witness',id:request.witness},g.witnessToken)).status,200);
  };
  await witness(count);
  assert.equal((await g.go(count)).minor,30);
  const after = await g.go(state);
  const recount = {...count,id:randomUUID(),cut:after.vaultCut,previous:count.id,counted:1020,
    evidence:evidence(),witness:evidence()};
  await witness(recount);
  assert.deepEqual(await g.go(recount),await g.go(recount));
  const handoff = {action:'cash-deposit-send',id:randomUUID(),vault,destination:bank,minor:800,evidence:evidence()};
  await g.go(handoff);
  assert.equal((await g.go(state)).depositInTransit,800);
  const accepted = {action:'cash-deposit-receive',id:randomUUID(),vault,destination:bank,transfer:handoff.id,evidence:evidence()};
  assert.deepEqual(await g.go(accepted),await g.go(accepted));
  const final = await g.go(state);
  assert.deepEqual([final.drawer,final.expected,final.retained,final.drawerAvailable,final.vaultMinor,final.depositInTransit,final.finalized],
    [drawer,4220,500,3720,220,0,true]);
  assert.deepEqual(final.deposited,[{id:handoff.id,destination:bank,minor:800}]);
  assert.equal((await db.fixture.query('SELECT count(*)::integer AS n FROM omni.retail_closes')).rows[0].n,2);
  const amounts = await db.fixture.query(`SELECT account,sum(minor)::integer AS minor FROM omni.ledger_lines GROUP BY account ORDER BY account`);
  assert.deepEqual(amounts.rows,[{account:'Cash',minor:220},{account:'CashVarianceClearing',minor:-20},
    {account:'CashVault',minor:20},{account:'Revenue',minor:-210},{account:'SalesTax',minor:-10}]);
});

test('M6-02 real writer versus close in both orders, late hold, exact replay and successor correction', {timeout:35_000}, async t => {
  const db = await testDatabase(); t.after(()=>db.close());
  const f = await retailFixture(t,db);
  const g = await governance(db,f);
  const a=f.registers[0], b=f.registers[1];
  const sale = async (terminal:typeof a, period:string) => {
    assert.ok((await terminal.child().send({action:'checkout',input:terminal.input})).value);
    const row = local(terminal.path,d=>d.prepare('SELECT event_bytes FROM outbox').get());
    return jsonBytes({...JSON.parse(Buffer.from(row!.event_bytes as Uint8Array).toString()),occurredAt:at(period)});
  };
  const first=await sale(a,march);
  const late=await sale(b,april);
  await db.fixture.query(`CREATE FUNCTION omni.m6_hold_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(661702); RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER m6_hold_commit AFTER INSERT ON omni.journal_lines DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION omni.m6_hold_commit()`);
  const blocker=await db.fixture.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(661702)');
  const write=post(g.url,f.a.token,first);
  const close=approval(march);
  let sealRequest: ReturnType<typeof g.go>;
  try {
    await waits(db);
    sealRequest=g.go(close);
    await waits(db,2);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  const original=await write;
  assert.equal(original.status,200);
  const sealed=verifySeal(await sealRequest!,g.trust,{tenant:f.a.tenantId,period:march,previous:null});
  assert.equal(sealed.lines.length,2);
  const open=approval(april,close.id);
  const acquired=latch<void>(), release=latch<void>();
  const closing=tenantTransaction(db.runtime,f.a.tenantId,async conn=>{
    const bundle=await sealPeriod(conn,f.a.tenantId,g.actor,open,g.signer);
    acquired.resolve();
    await bounded(release.promise,'release close transaction');
    return bundle;
  });
  let pending:ReturnType<typeof post>;
  try {
    await bounded(acquired.promise,'period seal insert');
    pending=post(g.url,f.b.token,late);
    await waits(db);
  } finally { release.resolve(); }
  const second=await closing;
  assert.equal(verifySeal(second,g.trust,{tenant:f.a.tenantId,period:april,previous:close.id}).lines.length,0);
  assert.equal((await pending!).json().reason,'PERIOD_SEALED');
  assert.equal((await post(g.url,f.b.token,late)).status,202);
  assert.equal((await db.fixture.query('SELECT * FROM omni.late_ledger_holds')).rowCount,1);
  const replay=await post(g.url,f.a.token,first);
  assert.deepEqual(replay.bytes,original.bytes);
  assert.equal(replay.headers.get('omni-signature'),original.headers.get('omni-signature'));
  await assert.rejects(tenantTransaction(db.runtime,f.a.tenantId,c=>c.query('DELETE FROM omni.journal_lines')),
    /permission denied/);
  await assert.rejects(tenantTransaction(db.runtime,f.a.tenantId,c=>c.query(
    "INSERT INTO omni.ledger_lines SELECT * FROM omni.ledger_lines LIMIT 1")),/permission denied/);
  await assert.rejects(tenantTransaction(db.runtime,f.a.tenantId,c=>c.query(
    "INSERT INTO omni.journal_lines SELECT * FROM omni.journal_lines LIMIT 1")),/PERIOD_SEALED/);
  const corrected=correction('2026-05',sealed.lines[0].line_id);
  await g.go({...corrected,businessAt:at(april)},409);
  assert.deepEqual(await g.go(corrected),await g.go(corrected));
  const rows=await db.fixture.query('SELECT period,count(*)::integer AS n FROM omni.ledger_lines GROUP BY period ORDER BY period');
  assert.deepEqual(rows.rows,[{period:march,n:2},{period:'2026-05',n:2}]);
});

test('M6-03 verifies signed close backing and restores sealed cash and captured funds before successor writes', {timeout:50_000}, async t => {
  const db=await testDatabase(), fresh=await testDatabase();
  t.after(async()=>{await fresh.close();await db.close()});
  const f=await paymentFixture(t,db), g=await governance(db,f);
  const a=f.terminal(), r=a.register;
  const receipt=await r.checkout(randomUUID(),220);
  await sync(r,2);
  const unmatchedDrop=randomUUID();
  r.drop(unmatchedDrop,randomUUID(),100,pin);
  await sync(r,1);
  r.scan('210001');
  f.setGrant(null);
  const intent=randomUUID();
  assert.equal((await r.payment!.start(intent)).state,'CAPTURED');
  const stored=saved(a.target.path,receipt.eventId);
  const month=stored.event.occurredAt.slice(0,7);
  const input=approval(month);
  const bundle:SealBundle=await g.go(input);
  const expected={tenant:f.a.tenantId,period:month,previous:null};
  const approved=verifySeal(bundle,g.trust,expected);
  assert.equal((approved.evidence.payment_cases as {state:string}[])[0].state,'CAPTURED');
  assert.deepEqual(approved.evidence.holds,[{kind:'DROP',id:unmatchedDrop,state:'IN_TRANSIT'},
    {kind:'PAYMENT',id:intent,state:'CAPTURED'}]);
  assert.throws(()=>verifySeal({...bundle,objects:{ledger:bundle.objects.ledger}},g.trust,expected),/Missing/);
  assert.throws(()=>verifySeal({...bundle,objects:{...bundle.objects,ledger:[]}},g.trust,expected),/digest/);
  assert.throws(()=>verifySeal({...bundle,packet:{...(bundle.packet as object),signature:'A'.repeat(86)}},g.trust,expected),/signature/);
  assert.throws(()=>verifySeal(bundle,g.trust,{...expected,tenant:randomUUID()}),/scope/);
  assert.throws(()=>verifySeal(bundle,g.trust,{...expected,previous:randomUUID()}),/lineage/);
  assert.deepEqual(await g.go(input),bundle);
  const original=await post(retailUrl(f.url),f.a.token,stored.bytes);
  const root=await captureModuleCut(f.dir,db.fixture,a.target.path,0,null);
  const successor=nextPeriod(month);
  const line=approved.lines.find(row=>row.journal_id.startsWith('retail:'))!;
  const later=correction(successor,line.line_id);
  await g.go(later);
  const successorSeal=approval(successor,input.id);
  await g.go(successorSeal);
  const image=await captureModuleCut(f.dir,db.fixture,a.target.path,1,root);
  const cut=sealModuleCuts(f.dir,{id:randomUUID(),segments:[root,image]});
  const path=join(f.dir,'m6-restored.sqlite');
  assert.equal((await restoreModuleCuts(f.dir,cut,fresh.fixture,path)).replayCursor,1);
  await tenantTransaction(fresh.runtime,f.a.tenantId,async conn=>{
    await verifyRestoredSeal(conn,f.a.tenantId,month,null,g.trust);
    await verifyRestoredSeal(conn,f.a.tenantId,successor,input.id,g.trust);
  });
  assert.deepEqual(Buffer.from(saved(path,receipt.eventId).bytes),stored.bytes);
  assert.equal(local(path,sqlite=>sqlite.prepare('SELECT state FROM payment_intents WHERE intent_id=?').get(intent)?.state),'CAPTURED');
  assert.equal((await fresh.fixture.query('SELECT state FROM omni.payment_cases WHERE intent_id=$1',[intent])).rows[0].state,'CAPTURED');
  const endpoint=await f.listen(createCloud(fresh.runtime,[f.a,f.b],f.signer,undefined,g.opts));
  const replay=await post(retailUrl(endpoint),f.a.token,stored.bytes);
  assert.deepEqual(replay.bytes,original.bytes);
  assert.equal(replay.headers.get('omni-signature'),original.headers.get('omni-signature'));
  const mutate=(body:object)=>post(new URL('/v6/governance',endpoint).href,g.token,jsonBytes(body));
  assert.equal((await mutate(later)).status,200);
  const open=nextPeriod(successor);
  const freshAdjustment=correction(open,line.line_id);
  assert.equal((await mutate(freshAdjustment)).status,200);
  assert.equal((await mutate(freshAdjustment)).status,200);
  assert.equal((await fresh.fixture.query('SELECT * FROM omni.governed_adjustments')).rowCount,2);
  const next=await mutate(approval(open,successorSeal.id));
  assert.equal(next.status,200);
  assert.equal(verifySeal(next.json(),g.trust,{tenant:f.a.tenantId,period:open,previous:successorSeal.id}).lines.length,2);
  assert.equal(f.evidence('CAPTURED').length,1);
});

function treasury(effect:string,minor:number,reference:string|null=null) {
  return {action:'period-adjust',id:randomUUID(),businessAt:at(april),account:'TreasuryClearing',counteraccount:'TreasuryOffset',
    minor,evidence:evidence(),effect,reference};
}
const treasuryLine=(id:string)=>'adjustment:'+id+':TreasuryClearing';
function plan(seal:string,lineage:string,predecessor:string|null=null,slices:{line:string;start:number;minor:number}[]=[]) {
  return {action:'report-approve',id:randomUUID(),lineage,predecessor,seal,april,approval:evidence(),slices,replacement:null};
}
function bridge(result:{facts:{bridge:{TreasuryClearing:Record<string,number>;TreasuryOffset:Record<string,number>}}}) {
  const {marchGrossUp,opening,raw,duplicate,synthetic,closing}=result.facts.bridge.TreasuryClearing;
  const amounts=[marchGrossUp,opening,raw,duplicate,synthetic,closing];
  assert.deepEqual(result.facts.bridge.TreasuryOffset,Object.fromEntries(
    Object.entries(result.facts.bridge.TreasuryClearing).map(([key,minor])=>[key,minor ? -minor : 0])));
  return amounts;
}

test('M6-04 approved comparative plans pin exact restoration, absorption, replacement and revocation', {timeout:30_000}, async t=>{
  const db=await testDatabase(); t.after(()=>db.close());
  const f=await retailFixture(t,db), g=await governance(db,f);
  const close=approval(march);
  await g.go(close);
  const family=randomUUID(), synthetic=plan(close.id,family);
  const original=await g.go(synthetic);
  assert.deepEqual(bridge(original),[50,50,0,0,-50,0]);
  const old=await g.go({action:'report-publish',plan:synthetic.id,id:randomUUID()});
  await g.go(treasury('RESTORE',50));
  const thirty=treasury('POST',-30);
  await g.go(thirty);
  await g.go(treasury('UNRELATED',125));
  const slice={line:treasuryLine(thirty.id),start:0,minor:30};
  const partial=plan(close.id,family,synthetic.id,[slice]);
  const part=await g.go(partial);
  assert.deepEqual(bridge(part),[50,50,20,-50,-20,0]);
  assert.equal(part.facts.unrelated[0].proof[0].minor,125);
  assert.equal(part.facts.absorbed[0].proof[0].line_id,slice.line);
  const twenty=treasury('POST',-20);
  await g.go(twenty);
  const second={line:treasuryLine(twenty.id),start:30,minor:20};
  await g.go(plan(close.id,family,partial.id,[slice,{...second,start:29}]),422);
  const full=plan(close.id,family,partial.id,[slice,second]);
  assert.deepEqual(bridge(await g.go(full)),[50,50,0,-50,0,0]);
  const replacement={...plan(close.id,family,full.id,[slice,second]),replacement:{line:slice.line,evidence:evidence()}};
  await g.go(replacement,422);
  const technicalRequest={action:'period-technical-replace',id:randomUUID(),reverseId:randomUUID(),
    businessAt:at(april),...replacement.replacement};
  assert.deepEqual(await g.go(technicalRequest),await g.go(technicalRequest));
  const technical=await g.go(replacement);
  assert.deepEqual(bridge(technical),[50,50,0,-50,0,0]);
  assert.equal(technical.facts.technical.economicDelta,0);
  assert.deepEqual([technical.facts.technical.reverse[0].minor,technical.facts.technical.replacement[0].minor],[30,-30]);
  await g.go(treasury('REVOKE',20,second.line));
  await g.go(treasury('REVOKE',1,second.line),422);
  const revoked=await g.go(plan(close.id,family,replacement.id,[slice,second]));
  assert.deepEqual(bridge(revoked),[50,50,20,-50,0,20]);
  assert.equal(revoked.facts.revoked[0].source,second.line);
  assert.deepEqual(await g.go(synthetic),original);
  assert.deepEqual((await g.go({action:'report-get',plan:synthetic.id})).export,old);
  const scope={tenant:f.a.tenantId,id:revoked.facts.id,seal:close.id};
  assert.deepEqual(verifyPlan(revoked,g.trust,scope),revoked.facts);
  assert.throws(()=>verifyPlan({...revoked,facts:{...revoked.facts,unrelated:[]}},g.trust,scope),/binding/);
  assert.equal(revoked.facts.extract.root,digest(canonical(revoked.facts.extract.lines)));
});

test('M6-05 exact signed export, tenant isolation, and publication-versus-withdrawal race', {timeout:30_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());
  const f=await retailFixture(t,db),g=await governance(db,f);
  const close=approval(march);await g.go(close);
  const first=plan(close.id,randomUUID()); await g.go(first);
  const pub={action:'report-publish',plan:first.id,id:randomUUID()};
  const export1=await g.go(pub);
  const expected={tenant:f.a.tenantId,plan:first.id,seal:close.id};
  assert.equal(JSON.parse(verifyExport(export1,g.trust,expected).toString()).plan,first.id);
  assert.throws(()=>verifyExport({...export1,bytes:Buffer.from('forged').toString('base64url')},g.trust,expected),/binding/);
  assert.throws(()=>verifyExport(export1,g.trust,{...expected,tenant:randomUUID()}),/binding/);
  assert.equal((await g.send({action:'report-get',plan:first.id},g.otherToken)).status,404);
  assert.equal((await g.send({action:'report-get',plan:first.id},f.operatorToken)).status,403);
  const next=plan(close.id,first.lineage,first.id); await g.go(next);
  await g.go({action:'report-withdraw',plan:first.id,evidence:evidence()});
  const history=await g.go({action:'report-get',plan:first.id});
  assert.deepEqual(history.state,{successor:next.id,withdrawn:true});
  assert.deepEqual(history.export,export1);
  const locker=await db.runtime.connect();
  await locker.query('BEGIN');
  await locker.query("SELECT set_config('omni.tenant_id',$1,true)",[f.a.tenantId]);
  await locker.query('SELECT omni.ledger_lock($1)',[f.a.tenantId]);
  const blocked=g.send({action:'report-publish',plan:next.id,id:randomUUID()});
  try {
    await waits(db);
    await locker.query('INSERT INTO omni.report_withdrawals VALUES($1,$2,$3,$4)',[f.a.tenantId,next.id,evidence(),g.actor]);
    await locker.query('COMMIT');
  } finally { await locker.query('ROLLBACK'); locker.release(); }
  assert.equal((await blocked).status,409);
  assert.equal((await g.go({action:'report-get',plan:next.id})).export,null);
});

test('M6-06 populated 006 upgrade preserves exact receipts, BLOBs, signed vouchers, postings and open capture', {timeout:35_000}, async t=>{
  const db=await testDatabase();t.after(()=>db.close());
  const f=await paymentFixture(t,db);
  const a=f.terminal(), r=a.register;
  const receipt=await r.checkout(randomUUID(),220);
  await sync(r,2);
  const stored=saved(a.target.path,receipt.eventId);
  const original=await post(retailUrl(f.url),f.a.token,stored.bytes);
  await db.fixture.query('INSERT INTO omni.capability_profiles VALUES($1,1,true,true,true)',[f.a.tenantId]);
  await r.modules.refresh();
  const order=randomUUID();
  r.modules.seat(order,randomUUID(),'T1',2);
  r.modules.dispatch(order,randomUUID(),1,1,'toast','butter');
  r.modules.split(order,randomUUID(),2,{mode:'seat',selected:[]});
  const module=r.moduleTender({id:randomUUID(),aggregate:order,revision:3,check:0,before:0,paid:220,tip:0});
  await sync(r,1);
  const moduleBytes=()=>local(a.target.path,sqlite=>Buffer.from(sqlite.prepare(
    'SELECT event_bytes FROM retail_events WHERE event_id=?').get(module.eventId)!.event_bytes as Uint8Array));
  const moduleBody=moduleBytes();
  const moduleEndpoint=new URL('/v5/register',f.url).href;
  const moduleVoucher=await post(moduleEndpoint,f.a.token,moduleBody);
  assert.equal(moduleVoucher.status,200);
  r.scan('210001'); f.setGrant(null);
  const pending=randomUUID();
  assert.equal((await r.payment!.start(pending)).state,'CAPTURED');
  const snapshot=async()=>Promise.all(['retail_events','retail_postings','retail_vouchers','payment_cases','payment_postings','module_tenders'].map(
    table=>db.fixture.query('SELECT to_jsonb(r)::text AS row FROM omni.'+table+' r ORDER BY 1').then(result=>result.rows)));
  const before=await snapshot();
  await removeGovernanceFixture(db);
  await db.upgrade();
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual(r.receipt(receipt.receiptId),receipt);
  assert.deepEqual(saved(a.target.path,receipt.eventId).bytes,stored.bytes);
  assert.deepEqual(moduleBytes(),moduleBody);
  assert.deepEqual(r.receipt(module.receiptId),module);
  const moduleReplay=await post(moduleEndpoint,f.a.token,moduleBody);
  assert.deepEqual(moduleReplay.bytes,moduleVoucher.bytes);
  assert.equal(moduleReplay.headers.get('omni-signature'),moduleVoucher.headers.get('omni-signature'));
  const replay=await post(retailUrl(f.url),f.a.token,stored.bytes);
  assert.deepEqual(replay.bytes,original.bytes);
  assert.equal(replay.headers.get('omni-signature'),original.headers.get('omni-signature'));
  assert.equal((await db.fixture.query('SELECT * FROM omni.ledger_lines')).rowCount,8);
});
