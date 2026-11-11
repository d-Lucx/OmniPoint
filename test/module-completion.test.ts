import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createCloud } from '../src/cloud.ts';
import { openArtifact } from '../src/authority.ts';
import { appendRestoreNote, captureModuleCut, restoreModuleCuts, sealModuleCuts } from '../src/module-restore.ts';
import { parseModuleSale } from '../src/module-sale.ts';
import { decode, jsonBytes } from '../src/protocol.ts';
import { createRegisterServer } from '../src/register-server.ts';
import { Terminal } from '../src/terminal.ts';
import { bounded, latch, local, testDatabase } from './fixture.ts';
import { paymentFixture } from './payment-fixture.ts';
import { catalog, pin, post, removeGovernanceFixture, retailFixture, secret, stop } from './retail-fixture.ts';

async function capabilities(db: Awaited<ReturnType<typeof testDatabase>>, tenant: string, version = 1, enabled = true) {
  await db.fixture.query('INSERT INTO omni.capability_profiles VALUES ($1,$2,true,$3,$3)', [tenant,version,enabled]);
}

const events = (path: string) => local(path, db => db.prepare(
  "SELECT event_id,event_bytes,digest,state,ack FROM retail_events WHERE kind='SALE' ORDER BY rowid",
).all());
const bytes = (row: ReturnType<typeof events>[number]) => Buffer.from(row.event_bytes as Uint8Array);
const route = (url: string) => new URL('/v5/register',url).href;

async function checkFixture(t: Parameters<typeof retailFixture>[0], db: Awaited<ReturnType<typeof testDatabase>>) {
  const f = await retailFixture(t,db);
  await capabilities(db,f.a.tenantId);
  await f.setup();
  const a = f.terminal(0);
  a.connection.importGrant(await f.issue('M1-ITEM',0),f.keys);
  a.register.openShift(randomUUID(),randomUUID(),5000);
  await a.register.modules.refresh();
  assert.equal(await a.register.syncOnce(),'SYNCED');
  return { f, a };
}

function order(register: ReturnType<typeof Terminal.prototype.retail>, mode: 'seat'|'equal' = 'equal') {
  const id = randomUUID();
  const modules = register.modules;
  modules.seat(id,randomUUID(),'T1',2);
  modules.dispatch(id,randomUUID(),1,1,'toast','butter');
  modules.split(id,randomUUID(),2,{mode,selected:[]});
  return id;
}

test('M5-01 browser offline check splits, exact vouchers, quota and tip replay across capability change', {timeout:40_000}, async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const {f,a} = await checkFixture(t,db);
  const odd = { ...catalog, version:2, variants:catalog.variants.map(item => item.sku === 'M1-ITEM' ?
    {...item,unitMinor:201} : item) };
  await f.op({action:'retail-catalog',storeId:f.a.storeId,catalog:odd});
  a.register.installCatalog(odd,f.positions);
  const hot = randomBytes(32).toString('base64url');
  const port = Number(new URL(f.url).port);
  const server = createRegisterServer(a.register,{drawerId:randomUUID(),cashierSecret:secret,kitchen:{[hot]:'hot'}});
  const base = new URL('/',await f.listen(server)).href;
  const browser = await chromium.launch({channel:process.env.OMNI_BROWSER_CHANNEL ??
    (process.platform === 'win32' ? 'msedge' : undefined),headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByLabel('Cashier secret').fill(secret);
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByRole('button',{name:'Workflows'}).click();
  await stop(f.original);
  await page.getByRole('button',{name:'Refresh capabilities'}).click();
  await page.getByText('Capability profile 1 · Authority OFFLINE',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Seat guests'}).click();
  await page.getByRole('button',{name:'Dispatch to kitchen'}).click();
  const display = await browser.newPage();
  await display.goto(new URL('/kitchen',base).href);
  await display.getByLabel('Station token').fill(hot);
  await display.getByRole('button',{name:'Connect display'}).click();
  await display.getByText('Seat 1 · toast · butter · QUEUED').waitFor();
  a.register.installCatalog({...odd,version:3,variants:catalog.variants},f.positions);
  await page.getByRole('button',{name:'Freeze checks'}).click();
  await page.getByText('106¢ gross · 5¢ tax · 106¢ due').waitFor();
  await page.getByText('105¢ gross · 5¢ tax · 105¢ due').waitFor();
  await page.getByLabel('Cash payment in cents').first().fill('100');
  await page.getByLabel('Tip in cents').first().fill('5');
  await page.getByRole('button',{name:'Tender check 1'}).click();
  await page.getByText('106¢ gross · 5¢ tax · 6¢ due').waitFor();
  const aggregate = a.register.modules.state().order!.id;
  assert.throws(() => a.register.moduleTender({id:randomUUID(),aggregate,revision:3,check:0,before:0,paid:6,tip:0}),/Stale check/);
  await page.getByRole('button',{name:'Tender check 1'}).click();
  await page.getByText('106¢ gross · 5¢ tax · 0¢ due').waitFor();
  await page.getByRole('button',{name:'Tender check 2'}).click();
  await page.getByText('105¢ gross · 5¢ tax · 0¢ due').waitFor();
  await page.reload();
  await page.getByRole('button',{name:'Workflows'}).click();
  await page.getByRole('button',{name:'Recover check receipt 1'}).click();
  const saleRows = events(a.target.path);
  assert.equal(saleRows.length,3);
  const first = parseModuleSale(bytes(saleRows[0]));
  await page.getByRole('heading',{name:'Receipt '+first.sale.receiptId}).waitFor();
  assert.deepEqual(saleRows.map(row => {
    const sale = parseModuleSale(bytes(row));
    return [sale.paid,sale.sale.taxMinor,sale.claims.length];
  }),[[100,4,1],[6,1,0],[105,5,0]]);
  await capabilities(db,f.a.tenantId,2,false);
  let drop = true;
  const restarted = f.cloud({async beforeResponse(voucher,response) {
    if (drop && decode(voucher.bytes).version === 5) {
      drop = false;
      response.destroy();
    }
  }});
  await f.listen(restarted,port);
  await a.register.modules.refresh();
  assert.throws(() => a.register.modules.seat(randomUUID(),randomUUID(),'T2',2),/disabled/);
  assert.equal(await a.register.syncOnce(),'RETRY_WAIT');
  const original = await post(route(f.url),f.a.token,bytes(saleRows[0]));
  assert.equal(original.status,200);
  assert.equal(await a.register.syncOnce(),'SYNCED');
  assert.equal(await a.register.syncOnce(),'SYNCED');
  assert.equal(await a.register.syncOnce(),'SYNCED');
  const synced = events(a.target.path);
  assert.deepEqual(synced.map(bytes),saleRows.map(bytes));
  assert.deepEqual(Buffer.from(synced[0].ack as Uint8Array),original.bytes);
  const replay = await post(route(f.url),f.a.token,bytes(saleRows[0]));
  assert.deepEqual(replay.bytes,original.bytes);
  assert.equal(replay.headers.get('omni-signature'),original.headers.get('omni-signature'));
  const summary = await db.fixture.query(`SELECT account,sum(signed_minor)::integer AS minor
    FROM omni.retail_postings GROUP BY account ORDER BY account`);
  assert.deepEqual(summary.rows,[{account:'Cash',minor:216},{account:'Revenue',minor:-201},
    {account:'SalesTax',minor:-10},{account:'TipsPayable',minor:-5}]);
  const tips = await db.fixture.query("SELECT facts->'tipPool'->'shares' AS shares FROM omni.module_tenders WHERE facts->>'tip'='5'");
  assert.deepEqual(tips.rows[0].shares,[{staff:'alex',weight:1,minor:3},{staff:'sam',weight:1,minor:2}]);
  assert.equal(local(a.target.path,db => db.prepare('SELECT sum(signed_minor) AS cash FROM retail_cash').get()?.cash),5216);
  assert.equal((await db.fixture.query('SELECT * FROM omni.retail_allocations')).rowCount,1);
  assert.equal((await db.fixture.query('SELECT * FROM omni.retail_receipts')).rowCount,3);
  assert.equal((await db.fixture.query("SELECT on_hand FROM omni.stock WHERE sku='M1-ITEM'")).rows[0].on_hand,2);
  assert.equal(await a.register.syncOnce(),'IDLE');
});

test('M5-02 approved service revisions, mixed invoice, restart and one commission', {timeout:30_000}, async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const {f,a} = await checkFixture(t,db);
  const r = a.register;
  const booking = randomUUID();
  const id = randomUUID();
  r.modules.draft(booking,randomUUID(),'alex','2026-12-02T10:00:00.000Z',30);
  await r.modules.book(booking,randomUUID());
  r.modules.intake(id,randomUUID(),booking,'alex');
  r.modules.estimate(id,randomUUID(),1,'M3-TEA');
  const authorize = (revision: number, code: string) => r.authorizeEstimate({id,revision,consent:randomUUID(),pin:code,operationId:randomUUID()});
  assert.throws(() => authorize(2,'bad'),/Supervisor/);
  authorize(2,pin);
  r.modules.startWork(id,randomUUID(),3);
  r.modules.estimate(id,randomUUID(),4,'M1-ITEM');
  const input = {id:randomUUID(),aggregate:id,revision:7,check:0,before:0,paid:1270,tip:0};
  assert.throws(() => r.moduleTender({...input,revision:5}),/Authorized work/);
  assert.throws(() => authorize(2,pin),/Stale/);
  authorize(5,pin);
  r.modules.startWork(id,randomUUID(),6);
  const original = r.moduleTender(input);
  a.connection.close();
  const next = f.terminal(0);
  assert.deepEqual(next.register.moduleTender(input),original);
  assert.throws(() => next.register.moduleTender({...input,id:randomUUID()}),/Stale check/);
  const first = await post(route(f.url),f.a.token,bytes(events(next.target.path)[0]));
  assert.equal(first.status,200);
  assert.equal(await next.register.syncOnce(),'SYNCED');
  const row = (await db.fixture.query('SELECT facts FROM omni.module_tenders')).rows[0];
  assert.deepEqual(row.facts.commission,{id:row.facts.commission.id,version:1,technician:'alex',basisMinor:1000,rateBps:1000,minor:100});
  assert.deepEqual((await db.fixture.query('SELECT account,signed_minor FROM omni.retail_postings ORDER BY account')).rows,
    [{account:'Cash',signed_minor:1270},{account:'Revenue',signed_minor:-1210},{account:'SalesTax',signed_minor:-60}]);
  assert.equal((await db.fixture.query('SELECT * FROM omni.retail_allocations')).rowCount,1);
  assert.equal((await db.fixture.query('SELECT * FROM omni.retail_receipts')).rowCount,1);
  const localServer = createRegisterServer(next.register,{drawerId:randomUUID(),cashierSecret:secret});
  const browser = await chromium.launch({channel:process.env.OMNI_BROWSER_CHANNEL ??
    (process.platform === 'win32' ? 'msedge' : undefined),headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('/',await f.listen(localServer)).href);
  await page.getByLabel('Cashier secret').fill(secret);
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByRole('button',{name:'Workflows'}).click();
  await page.getByText('Work order INVOICED',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Recover invoice receipt'}).click();
  await page.getByRole('heading',{name:'Receipt '+original.receiptId}).waitFor();
});

test('M5-05 restores paired cuts, exact voucher and captured hold, quarantines and refuses a gap', {timeout:45_000}, async t => {
  const db = await testDatabase();
  const restored = await testDatabase();
  t.after(async () => { await restored.close(); await db.close(); });
  const f = await paymentFixture(t,db);
  await capabilities(db,f.a.tenantId);
  const a = f.terminal();
  const r = a.register;
  await r.modules.refresh();
  assert.equal(await r.syncOnce(),'SYNCED');
  const orderId = order(r,'seat');
  const tender = {id:randomUUID(),aggregate:orderId,revision:3,check:0,before:0,paid:220,tip:0};
  const receipt = r.moduleTender(tender);
  assert.equal(await r.syncOnce(),'SYNCED');
  const event = bytes(events(a.target.path)[0]);
  const voucher = await post(route(f.url),f.a.token,event);
  assert.equal(voucher.status,200);
  const root = await captureModuleCut(f.dir,db.fixture,a.target.path,0,null);
  const invalid = appendRestoreNote(f.dir,1,root,{unsupported:true});
  f.setGrant(null);
  const held = randomUUID();
  assert.equal((await r.payment!.start(held)).state,'CAPTURED');
  assert.equal(f.evidence('CAPTURED').length,1);
  r.modules.seat(randomUUID(),randomUUID(),'T2',2);
  const pending = randomUUID();
  r.modules.draft(pending,randomUUID(),'sam','2026-12-02T13:00:00.000Z',30);
  const latest = await captureModuleCut(f.dir,db.fixture,a.target.path,2,invalid);
  const cut = randomUUID();
  const manifest = sealModuleCuts(f.dir,{id:cut,segments:[root,root,invalid,latest]});
  const path = join(f.dir,'restored.sqlite');
  const segment = join(f.dir,latest+'.json');
  renameSync(segment,segment+'.away');
  try { await assert.rejects(restoreModuleCuts(f.dir,manifest,restored.fixture,path),/Missing restore segment/); }
  finally { renameSync(segment+'.away',segment); }
  assert.equal((await restored.fixture.query('SELECT * FROM omni.tenants')).rowCount,0);
  await assert.rejects(restoreModuleCuts(f.dir,'0'.repeat(64),restored.fixture,path),/manifest digest/);
  const result = await restoreModuleCuts(f.dir,manifest,restored.fixture,path);
  assert.deepEqual(result,{checkpoint:cut,replayCursor:2,displayCut:5,quarantined:[1]});
  assert.deepEqual(JSON.parse(readFileSync(path+'.restore.json','utf8')),result);
  for (const relation of ['stock','quota_inventory','retail_postings','retail_receipts','retail_vouchers','payment_cases','payment_provider_events']) {
    const query = 'SELECT to_jsonb(r)::text AS data FROM omni.'+relation+' r ORDER BY 1';
    assert.deepEqual((await restored.fixture.query(query)).rows,(await db.fixture.query(query)).rows);
  }
  assert.equal((await restored.fixture.query('SELECT state FROM omni.payment_cases WHERE intent_id=$1',[held])).rows[0].state,'CAPTURED');
  const endpoint = await f.listen(createCloud(restored.runtime,[f.a],f.signer,undefined,f.opts));
  const reopened = new Terminal(path);
  try {
    const register = reopened.retail({devices:a.devices,supervisor:{actorId:f.actorId,pin,signer:{id:'fixture-supervisor',key:f.supervisor.privateKey}},
      cloud:{url:endpoint,token:f.a.token,keys:f.keys}});
    assert.deepEqual(register.receipt(receipt.receiptId),receipt);
    assert.equal(register.modules.state().appointment?.id,pending);
    assert.equal(register.modules.kitchenFeed('hot',0).revisions.at(-1)?.orderId,orderId);
    assert.deepEqual(register.moduleTender(tender),receipt);
    const replay = await post(route(endpoint),f.a.token,event);
    assert.deepEqual(replay.bytes,voucher.bytes);
    assert.equal(replay.headers.get('omni-signature'),voucher.headers.get('omni-signature'));
    assert.equal(f.evidence('CAPTURED').length,1);
  } finally { reopened.close(); }
});

test('M5-03/M5-04 another tenant settles and an original module voucher replays under background pressure', {timeout:30_000}, async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const first = await checkFixture(t,db);
  const second = await checkFixture(t,db);
  const build = ({a}: typeof first) => {
    const aggregate = order(a.register,'seat');
    a.register.moduleTender({id:randomUUID(),aggregate,revision:3,check:0,before:0,paid:220,tip:0});
    return bytes(events(a.target.path)[0]);
  };
  const a = build(first);
  const b = build(second);
  const {f} = first;
  const other = second.f;
  const holding = latch<void>();
  const service = createCloud(db.runtime,[f.a,other.a],f.signer,{
    async moduleWork(client,scope,action) {
      if (scope.tenantId === f.a.tenantId && action === 'profile') {
        holding.resolve();
        await client.query('SELECT pg_advisory_xact_lock(662501)');
      }
    },
  },f.opts);
  const url = await f.listen(service);
  const endpoint = route(url);
  const module = new URL('/v5/modules',url).href;
  const original = await post(endpoint,f.a.token,a);
  assert.equal(original.status,200);
  const lock = await db.fixture.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT pg_advisory_xact_lock(662501)');
  const hold = post(module,f.a.token,jsonBytes({action:'profile'}));
  try {
    await bounded(holding.promise,'admitted background worker');
    assert.equal((await post(module,f.a.token,jsonBytes({action:'profile'}))).status,429);
    const diagnostics = await post(module,f.a.token,jsonBytes({action:'diagnostics'}));
    const snapshot = openArtifact('module-v5',diagnostics.json(),f.keys).data;
    assert.deepEqual(snapshot.active,{background:1,booking:0,settlement:0});
    assert.equal(snapshot.rejected,1);
    assert.equal((await post(endpoint,other.a.token,a)).status,403);
    const started = performance.now();
    const [live,replay] = await Promise.all([post(endpoint,other.a.token,b),post(endpoint,f.a.token,a)]);
    assert.equal(live.status,200);
    assert.equal(replay.status,200);
    assert.deepEqual(replay.bytes,original.bytes);
    assert.equal(replay.headers.get('omni-signature'),original.headers.get('omni-signature'));
    t.diagnostic('Module live and replay completed in '+Math.round(performance.now()-started)+' ms with one held database worker');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    assert.equal((await hold).status,200);
  }
  assert.equal((await post(endpoint,other.a.token,b)).status,200);
  assert.equal((await db.fixture.query('SELECT * FROM omni.module_tenders')).rowCount,2);
  assert.equal((await db.fixture.query('SELECT * FROM omni.retail_allocations')).rowCount,2);
});

test('M5-06 populated 005 upgrades with exact local receipt and cloud voucher', {timeout:25_000}, async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const {f,a} = await checkFixture(t,db);
  const r = a.register;
  r.modules.draft(randomUUID(),randomUUID(),'alex','2026-12-02T11:00:00.000Z',30);
  r.scan('210001');
  const receipt = await r.checkout(randomUUID(),220);
  const record = bytes(events(a.target.path)[0]);
  assert.equal(await r.syncOnce(),'SYNCED');
  const url = new URL('/v3/register',f.url).href;
  const original = await post(url,f.a.token,record);
  const before = local(a.target.path, db => db.prepare('SELECT * FROM module_events').all());
  a.connection.close();
  const sqlite = new DatabaseSync(a.target.path);
  sqlite.exec('DROP TABLE module_tenders; PRAGMA user_version=5');
  sqlite.close();
  await removeGovernanceFixture(db);
  await db.fixture.query(`DROP TABLE omni.module_tenders;
    ALTER TABLE omni.retail_lines ALTER COLUMN position_id SET NOT NULL;
    ALTER TABLE omni.retail_postings DROP CONSTRAINT retail_postings_account_check;
    ALTER TABLE omni.retail_postings ADD CHECK (account IN ('Cash','Revenue','SalesTax'));
    DELETE FROM omni.migrations WHERE version=6`);
  await db.upgrade();
  const next = f.terminal(0);
  assert.equal(local(a.target.path, db => db.prepare('PRAGMA user_version').get()?.user_version),6);
  assert.deepEqual(local(a.target.path, db => db.prepare('SELECT * FROM module_events').all()),before);
  assert.deepEqual(bytes(events(a.target.path)[0]),record);
  assert.deepEqual(next.register.receipt(receipt.receiptId),receipt);
  const replay = await post(url,f.a.token,record);
  assert.deepEqual(replay.bytes,original.bytes);
  assert.equal(replay.headers.get('omni-signature'),original.headers.get('omni-signature'));
});

test('M5-01 shared check portions inherit a single physical backorder', {timeout:25_000}, async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const f = await retailFixture(t,db);
  await capabilities(db,f.a.tenantId);
  await f.setup();
  const a = f.terminal(0);
  const b = f.terminal(1);
  const grant = await f.issue('M1-ITEM',0);
  a.connection.importGrant(grant,f.keys);
  b.connection.importGrant(await f.overlap(grant),f.keys);
  a.register.openShift(randomUUID(),randomUUID(),5000);
  b.register.openShift(randomUUID(),randomUUID(),5000);
  a.register.scan('210001');
  await a.register.checkout(randomUUID(),220);
  assert.equal(await a.register.syncOnce(),'SYNCED');
  assert.equal(await a.register.syncOnce(),'SYNCED');
  assert.equal(await b.register.syncOnce(),'SYNCED');
  await b.register.modules.refresh();
  const aggregate = order(b.register);
  for (const check of [0,1]) {
    b.register.moduleTender({id:randomUUID(),aggregate,revision:3,check,before:0,paid:110,tip:0});
    assert.equal(await b.register.syncOnce(),'SYNCED');
  }
  const dispos = events(b.target.path).map(row => decode(row.ack as Uint8Array).disposition);
  assert.deepEqual(dispos,['BACKORDER','BACKORDER']);
  const sales = await db.fixture.query("SELECT facts->'allocations'->0->>'stockLine' AS owner FROM omni.module_tenders ORDER BY check_no");
  assert.equal(sales.rows[0].owner,sales.rows[1].owner);
  assert.ok(sales.rows[0].owner);
  assert.equal((await db.fixture.query('SELECT * FROM omni.retail_shortfalls')).rowCount,1);
  assert.equal((await db.fixture.query("SELECT on_hand FROM omni.stock WHERE sku='M1-ITEM'")).rows[0].on_hand,2);
});
