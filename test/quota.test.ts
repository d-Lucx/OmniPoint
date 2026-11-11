import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCloud } from '../src/cloud.ts';
import { devItem } from '../src/development.ts';
import { parseGrant, signEvidence } from '../src/inventory-protocol.ts';
import type { CustodyReceipt, Grant } from '../src/inventory-protocol.ts';
import { tenantTransaction } from '../src/postgres.ts';
import { digest, jsonBytes, parseEvent, verifyVoucher } from '../src/protocol.ts';
import type { QuotaSale, SignedEvidence, Voucher } from '../src/protocol.ts';
import { Terminal } from '../src/terminal.ts';
import { bounded, latch, local, seed, testDatabase, testResources } from './fixture.ts';
import type { TestDatabase, TerminalChild } from './fixture.ts';
import { removeRetailCloudFixture, removeRetailLocalFixture } from './retail-fixture.ts';

let database: TestDatabase;
before(async () => { database = await testDatabase(); });
after(async () => { await database?.close(); });
const timeout = { timeout: 45_000 };
const execute = promisify(execFile);

async function post(url: string, token: string, bytes: Buffer) {
  const response = await fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: Uint8Array.from(bytes), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function operator(url: string, token: string, body: object, expected = 200) {
  const response = await post(new URL('/v2/inventory', url).href, token, jsonBytes(body));
  assert.equal(response.status, expected);
  return response.bytes.length ? JSON.parse(response.bytes.toString('utf8')) : undefined;
}

async function closeServer(server: ReturnType<typeof createCloud>) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function pair(t: TestContext, onHand = 1, db = database) {
  const r = await testResources(t);
  const a = await seed(db);
  const b = { ...a, terminalId: randomUUID(), token: randomBytes(32).toString('base64url') };
  await db.fixture.query('INSERT INTO omni.terminals VALUES ($1,$2,$3,$4)', [b.tenantId, b.storeId, b.terminalId, b.generation]);
  await db.fixture.query('UPDATE omni.stock SET on_hand = $2 WHERE tenant_id = $1', [a.tenantId, onHand]);
  const foreign = await seed(db);
  const token = randomBytes(32).toString('base64url');
  const foreignToken = randomBytes(32).toString('base64url');
  const position = { positionId: randomUUID(), locationId: randomUUID(), sku: devItem.sku };
  const custody = generateKeyPairSync('ed25519');
  const custodySigner = { id: 'fixture-custody', key: custody.privateKey };
  const custodyKeys = new Map([[custodySigner.id, custody.publicKey]]);
  const grantKeys = new Map([[r.signer.id, r.publicKey]]);
  const options = {
    operators: [{ token, tenantId: a.tenantId }, { token: foreignToken, tenantId: foreign.tenantId }],
    custodyKeys,
  };
  const terminalA = r.register(a);
  const terminalB = r.register(b);
  const server = (observers?: Parameters<typeof createCloud>[3]) =>
    createCloud(db.runtime, [a, b, foreign], r.signer, observers, options);
  const enable = async (url: string) => {
    await operator(url, token, { action: 'open-position', legacyDrained: true, storeId: a.storeId, ...position });
    for (const terminal of [terminalA, terminalB]) withRegister(terminal, local => local.enableQuota(position));
  };
  const request = (enrollment: typeof a, quantity = 1, expiresAt = new Date(Date.now() + 600_000).toISOString()) => ({
    action: 'issue', positionId: position.positionId, grantId: randomUUID(), terminalId: enrollment.terminalId,
    generation: enrollment.generation, quantity, expiresAt,
  });
  return { ...r, db, a, b, token, foreign, foreignToken, position, custodySigner, custodyKeys, grantKeys,
    options, server, enable, request, terminals: [terminalA, terminalB] as const };
}

type Pair = Awaited<ReturnType<typeof pair>>;
type Register = Pair['terminals'][number];

function withRegister<T>(register: { path: string }, work: (terminal: Terminal) => T): T {
  const terminal = new Terminal(register.path);
  try { return work(terminal); } finally { terminal.close(); }
}

function grantFrom(packet: SignedEvidence): Grant {
  return parseGrant(Buffer.from(packet.body, 'base64url'));
}

function importGrant(f: Pair, index: 0 | 1, packet: SignedEvidence) {
  withRegister(f.terminals[index], terminal => terminal.importGrant(packet, f.grantKeys));
}

async function historicalOverlap(f: Pair, packet: SignedEvidence): Promise<SignedEvidence> {
  const original = grantFrom(packet);
  const overlap = { ...original, grantId: randomUUID(), terminalId: f.b.terminalId };
  const signed = signEvidence(overlap, f.signer);
  const { tenantId, positionId, grantId, storeId, terminalId, generation } = overlap;
  // Deliberate historical overlap. Only the disposable fixture admin may construct this history.
  await f.db.fixture.query(`
    INSERT INTO omni.quota_grants (tenant_id, grant_id, position_id, store_id, terminal_id, generation, body, key_id, signature)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [tenantId, grantId, positionId, storeId, terminalId, generation,
    Buffer.from(signed.body, 'base64url'), signed.keyId, signed.signature]);
  await f.db.fixture.query('INSERT INTO omni.quota_grant_units VALUES ($1,$2,$3,$4)',
    [tenantId, positionId, grantId, original.slices[0]]);
  return signed;
}

function localState(register: Register) {
  return local(register.path, db => ({
    sales: db.prepare('SELECT count(*) AS n FROM sales').get()?.n,
    receipts: db.prepare('SELECT count(*) AS n FROM receipts').get()?.n,
    moves: db.prepare('SELECT count(*) AS n FROM stock_movements').get()?.n,
    spends: db.prepare('SELECT count(*) AS n FROM quota_spends').get()?.n,
    outbox: db.prepare(`
      SELECT event_bytes, digest, state, attempts, ack_id FROM outbox JOIN sales USING (sale_id) ORDER BY local_sequence_no
    `).all().map(row => ({ ...row })),
  }));
}

function eventOf(register: Register) {
  const row = localState(register).outbox.at(-1)!;
  const bytes = Buffer.from(row.event_bytes as Uint8Array);
  const event = parseEvent(bytes);
  assert.equal(event.version, 2);
  assert.equal(row.digest, digest(bytes));
  return { bytes, event: event as QuotaSale };
}

async function snapshot(f: Pair) {
  const tenant = [f.a.tenantId];
  const db = f.db.fixture;
  const { rows: [inventory] } = await db.query(`
    SELECT on_hand, rebuilt_on_hand, encumbered, in_transit, available FROM omni.quota_inventory WHERE tenant_id = $1
  `, tenant);
  const { rows: [counts] } = await db.query(`
    SELECT
      (SELECT count(*)::int FROM omni.sales WHERE tenant_id=$1) AS sales,
      (SELECT count(*)::int FROM omni.receipts WHERE tenant_id=$1) AS receipts,
      (SELECT count(*)::int FROM omni.outcomes WHERE tenant_id=$1) AS outcomes,
      (SELECT count(*)::int FROM omni.quota_claims WHERE tenant_id=$1) AS claims,
      (SELECT count(*)::int FROM omni.shortfalls WHERE tenant_id=$1) AS shortfalls,
      (SELECT count(*)::int FROM omni.stock_movements WHERE tenant_id=$1) AS movements,
      (SELECT count(*)::int FROM omni.vouchers WHERE tenant_id=$1) AS vouchers
  `, tenant);
  const { rows: decisions } = await db.query(`
    SELECT sale_id, disposition, winner_sale_id, slice_id, rule, order_no
    FROM omni.quota_decisions WHERE tenant_id=$1 ORDER BY order_no
  `, tenant);
  const { rows: postings } = await db.query(`
    SELECT sale_id, account, side, amount_minor FROM omni.journal_lines WHERE tenant_id=$1 ORDER BY sale_id, account
  `, tenant);
  return { inventory, counts, decisions, postings };
}

function assertCash(postings: Array<Record<string, unknown>>, saleIds: string[]) {
  assert.deepEqual(postings, [...saleIds].sort().flatMap(sale_id => [
    { sale_id, account: 'Cash', side: 'DR', amount_minor: 2000 },
    { sale_id, account: 'Revenue', side: 'CR', amount_minor: 2000 },
  ]));
}

async function holdStock<T>(f: Pair, run: () => Promise<T>[], blocked = 2) {
  const lock = await f.db.fixture.connect();
  let results: Promise<T>[] = [];
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT 1 FROM omni.stock WHERE tenant_id=$1 FOR NO KEY UPDATE', [f.a.tenantId]);
    results = run();
    for (const result of results) void result.catch(() => {});
    const deadline = Date.now() + 4500;
    let waiting = 0;
    while (Date.now() < deadline) {
      const { rows: [row] } = await f.db.fixture.query(`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT on_hand FROM omni.stock%FOR NO KEY UPDATE%'
      `);
      waiting = row.n;
      if (waiting === blocked) break;
      await delay(20);
    }
    assert.equal(waiting, blocked, 'both requests reached the held stock anchor');
  } finally {
    try { await lock.query('ROLLBACK'); } finally { lock.release(); }
  }
  return Promise.all(results);
}

async function checkout(register: Register, child: TerminalChild = register.child()) {
  const result = await child.send({ action: 'checkout', input: register.input });
  assert.equal(result.type, 'result');
  return { child, receipt: result.value, ...eventOf(register) };
}

async function offlineOverlap(t: TestContext) {
  const f = await pair(t);
  const issuer = f.server();
  const url = await f.listen(issuer);
  await f.enable(url);
  const packet = await operator(url, f.token, f.request(f.a)) as SignedEvidence;
  importGrant(f, 0, packet);
  importGrant(f, 1, await historicalOverlap(f, packet));
  await closeServer(issuer);
  const sales = await Promise.all(f.terminals.map(r => checkout(r)));
  assert.equal((await snapshot(f)).counts.sales, 0);
  for (const register of f.terminals) {
    const before = localState(register);
    assert.deepEqual([before.sales, before.receipts, before.moves, before.spends, before.outbox[0].state], [1, 1, 1, 1, 'PENDING']);
  }
  assert.notEqual(sales[0].event.saleId, sales[1].event.saleId);
  assert.notEqual(sales[0].event.receiptId, sales[1].event.receiptId);
  assert.equal(sales[0].event.quota.sliceId, sales[1].event.quota.sliceId);
  return { f, sales };
}

test('M2-01 offline contenders converge under both commit orders and a live race', timeout, async t => {
  for (const first of [0, 1, 'race'] as const) await t.test(
    first === 'race' ? 'concurrent race' : `terminal ${first === 0 ? 'A' : 'B'} commits first`, async sub => {
    const { f, sales } = await offlineOverlap(sub);
    const firstVouchers = new Map<string, Voucher>();
    const observed: Array<{ bytes: Buffer; digest: string }> = [];
    const cloud = f.server({
      received: delivery => observed.push(delivery),
      async beforeResponse(voucher) {
        const { saleId } = JSON.parse(voucher.bytes.toString('utf8'));
        firstVouchers.set(saleId, voucher);
      },
    });
    const url = await f.listen(cloud);
    const sync = (i: number) => sales[i].child.send(f.terminals[i].sync(url)).then(result => {
      assert.equal(result.value, 'SYNCED');
    });
    if (first === 'race') await holdStock(f, () => [sync(0), sync(1)]);
    else {
      await sync(first);
      await sync(1 - first);
    }
    await closeServer(cloud);
    const before = await snapshot(f);
    const winner = before.decisions[0];
    const loser = before.decisions[1];
    if (first !== 'race') assert.equal(winner.sale_id, sales[first].event.saleId);
    assert.equal(winner.disposition, 'COMMITTED');
    assert.equal(loser.disposition, 'BACKORDER');
    assert.equal(loser.winner_sale_id, winner.sale_id);
    assert.equal(winner.rule, 'first-eligible-commit/v1');
    assert.ok(BigInt(loser.order_no) > BigInt(winner.order_no));
    assert.deepEqual(before.inventory, { on_hand: 0, rebuilt_on_hand: 0, encumbered: 0, in_transit: 0, available: 0 });
    assert.deepEqual(before.counts, { sales: 2, receipts: 2, outcomes: 2, claims: 2, shortfalls: 1, movements: 1, vouchers: 2 });
    assertCash(before.postings, sales.map(s => s.event.saleId));
    const { rows: receipts } = await f.db.fixture.query(`
      SELECT sale_id AS "saleId", receipt_id AS "receiptId", printable FROM omni.receipts WHERE tenant_id=$1
    `, [f.a.tenantId]);
    const reopenedPool = f.db.oneConnection();
    sub.after(() => reopenedPool.end());
    const replayUrl = await f.listen(createCloud(reopenedPool, [f.a, f.b], f.signer,
      { received: delivery => observed.push(delivery) }, f.options));
    for (const i of [0, 1, 1, 0]) {
      const { bytes, event } = sales[i];
      const response = await post(replayUrl, f.terminals[i].enrollment.token, bytes);
      const ack = verifyVoucher(response.status, response.bytes, response.headers, f.grantKeys, event, digest(bytes));
      assert.equal(ack.disposition, event.saleId === winner.sale_id ? 'COMMITTED' : 'BACKORDER');
      assert.equal(localState(f.terminals[i]).outbox[0].ack_id, ack.ackId);
      const original = firstVouchers.get(event.saleId)!;
      assert.deepEqual(response.bytes, original.bytes);
      assert.equal(response.headers.get('omni-signature'), original.signature);
      assert.equal(response.headers.get('omni-key-id'), original.keyId);
      assert.deepEqual(receipts.find(r => r.saleId === event.saleId), sales[i].receipt);
      assert.deepEqual(localState(f.terminals[i]).outbox[0].event_bytes, Uint8Array.from(bytes));
      assert.equal(localState(f.terminals[i]).outbox[0].state, 'SYNCED');
    }
    assert.equal(observed.length, 6);
    for (const delivery of observed) {
      const original = sales.find(s => s.event.saleId === parseEvent(delivery.bytes).saleId)!;
      assert.deepEqual(delivery.bytes, original.bytes);
      assert.equal(delivery.digest, digest(original.bytes));
    }
    assert.deepEqual(await snapshot(f), before);
    sub.diagnostic(`winner=${winner.sale_id} order=${winner.order_no}; backorder=${loser.sale_id} order=${loser.order_no}; one shelf unit, two receipts, Cash DR 4000, Revenue CR 4000`);
  });
});

test('M2-02 issuance is exclusive and expired, exhausted, and unauthorized grants fail closed', timeout, async t => {
  const f = await pair(t);
  const url = await f.listen(f.server());
  await f.enable(url);
  const requests = [f.request(f.a), f.request(f.b)];
  const responses = await holdStock(f, () => requests.map(request =>
    post(new URL('/v2/inventory', url).href, f.token, jsonBytes(request))));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const winner = (responses[0].status === 200 ? 0 : 1) as 0 | 1;
  const loser = (1 - winner) as 0 | 1;
  const signed = JSON.parse(responses[winner].bytes.toString('utf8')) as SignedEvidence;
  const grant = grantFrom(signed);
  assert.deepEqual(await operator(url, f.token, requests[winner]), signed);
  await operator(url, f.token, { ...requests[winner], quantity: 2 }, 409);
  assert.equal((await snapshot(f)).inventory.encumbered, 1);
  assert.throws(() => importGrant(f, loser, signed), /stock scope/);
  for (const patch of [
    { tenantId: f.foreign.tenantId }, { locationId: randomUUID() }, { positionId: randomUUID() },
    { sku: 'BAD-SKU' }, { generation: 2 },
  ]) assert.throws(() => importGrant(f, winner, signEvidence({ ...grant, ...patch }, f.signer)), /stock scope/);
  const attacker = generateKeyPairSync('ed25519');
  assert.throws(() => importGrant(f, winner, signEvidence(grant, { id: f.signer.id, key: attacker.privateKey })), /signature/);
  importGrant(f, winner, signed);
  const changed = signEvidence({ ...grant, expiresAt: new Date(Date.parse(grant.expiresAt) + 1000).toISOString() }, f.signer);
  assert.throws(() => importGrant(f, winner, changed), /Conflicting quota grant/);
  const wrongRegister = f.terminals[loser];
  await assert.rejects(wrongRegister.child().send({ action: 'checkout', input: wrongRegister.input }), /No usable offline quota/);
  assert.deepEqual(localState(wrongRegister), { sales: 0, receipts: 0, moves: 0, spends: 0, outbox: [] });
  const sale = await checkout(f.terminals[winner]);
  const copy = { ...sale.event, ...wrongRegister.scope, saleId: randomUUID(), receiptId: randomUUID(),
    line: { ...sale.event.line, id: randomUUID() } };
  assert.equal((await post(url, wrongRegister.enrollment.token, jsonBytes(copy))).status, 422);
  assert.equal((await post(url, f.terminals[winner].enrollment.token,
    jsonBytes({ ...sale.event, quota: { ...sale.event.quota, locationId: randomUUID() } }))).status, 422);
  assert.equal((await snapshot(f)).counts.sales, 0);
  importGrant(f, winner, signed);
  await assert.rejects(sale.child.send({
    action: 'checkout', input: { ...f.terminals[winner].input, requestId: randomUUID() },
  }), /No usable offline quota/);
  assert.equal(localState(f.terminals[winner]).spends, 1);
  assert.equal((await sale.child.send(f.terminals[winner].sync(url))).value, 'SYNCED');
  const attemptedDoubleSpend = { ...sale.event, sequence: 2, saleId: randomUUID(), receiptId: randomUUID(),
    line: { ...sale.event.line, id: randomUUID() } };
  assert.equal((await post(url, f.terminals[winner].enrollment.token, jsonBytes(attemptedDoubleSpend))).status, 422);
  assertCash((await snapshot(f)).postings, [sale.event.saleId]);

  const expired = await pair(t);
  const expiryUrl = await expired.listen(expired.server());
  await expired.enable(expiryUrl);
  const expiresAt = new Date(Date.now() + 2000).toISOString();
  const expiryRequest = expired.request(expired.a, 1, expiresAt);
  const packet = await operator(expiryUrl, expired.token, expiryRequest) as SignedEvidence;
  importGrant(expired, 0, packet);
  await delay(Math.max(0, Date.parse(expiresAt) - Date.now() + 20));
  await assert.rejects(expired.terminals[0].child().send({ action: 'checkout', input: expired.terminals[0].input }),
    /No usable offline quota/);
  assert.deepEqual(localState(expired.terminals[0]), { sales: 0, receipts: 0, moves: 0, spends: 0, outbox: [] });
  assert.deepEqual(await operator(expiryUrl, expired.token, expiryRequest), packet);
  await operator(expiryUrl, expired.token, expired.request(expired.b), 409);
  assert.deepEqual((await snapshot(expired)).inventory,
    { on_hand: 1, rebuilt_on_hand: 1, encumbered: 1, in_transit: 0, available: 0 });
});

test('M2-03 quota spend survives post-commit death and lost response and rolls back before commit', timeout, async t => {
  const f = await pair(t);
  const prepared = f.server();
  const bootstrap = await f.listen(prepared);
  await f.enable(bootstrap);
  importGrant(f, 0, await operator(bootstrap, f.token, f.request(f.a)));
  await closeServer(prepared);
  const r = f.terminals[0];
  const uncommitted = r.child();
  assert.equal((await uncommitted.send({ action: 'checkout', input: r.input, pause: 'before-commit' })).phase, 'before-commit');
  await uncommitted.kill();
  assert.deepEqual(localState(r), { sales: 0, receipts: 0, moves: 0, spends: 0, outbox: [] });

  const interrupted = r.child();
  assert.equal((await interrupted.send({ action: 'checkout', input: r.input, pause: 'after-commit' })).phase, 'after-commit');
  const firstLocal = localState(r);
  const { bytes, event } = eventOf(r);
  const original = local(r.path, db => db.prepare('SELECT sale_id AS saleId, receipt_id AS receiptId, printable FROM receipts').get());
  await interrupted.kill();
  const recovery = r.child();
  assert.deepEqual((await recovery.send({ action: 'recover', requestId: r.input.requestId })).value, { ...original });
  assert.deepEqual((await recovery.send({ action: 'checkout', input: r.input })).value, { ...original });
  assert.deepEqual(localState(r), firstLocal);

  const committed = latch<Voucher>();
  const drop = latch<void>();
  const destroyed = latch<boolean>();
  const received: Buffer[] = [];
  const vouchers: Voucher[] = [];
  const url = await f.listen(f.server({
    received: d => { received.push(d.bytes); },
    async beforeResponse(voucher, response) {
      vouchers.push(voucher);
      if (vouchers.length > 1) return;
      committed.resolve(voucher);
      await bounded(drop.promise, 'quota response drop release');
      const open = !response.headersSent && response.socket?.destroyed === false;
      response.destroy();
      destroyed.resolve(open);
    },
  }));
  const first = recovery.send(r.sync(url));
  void first.catch(() => {});
  let accepted;
  try {
    const voucher = await bounded(committed.promise, 'durable quota voucher');
    accepted = await snapshot(f);
    assert.equal(accepted.decisions[0].sale_id, event.saleId);
    assert.equal(accepted.counts.vouchers, 1);
    assert.equal(accepted.inventory.on_hand, 0);
    const { rows: [stored] } = await f.db.fixture.query(`
      SELECT o.body, v.signature FROM omni.vouchers v JOIN omni.outcomes o USING (tenant_id, sale_id)
      WHERE v.tenant_id=$1 AND v.sale_id=$2
    `, [event.tenantId, event.saleId]);
    assert.deepEqual(stored, { body: voucher.bytes, signature: voucher.signature });
    assert.equal(localState(r).outbox[0].state, 'IN_FLIGHT');
  } finally {
    drop.resolve();
  }
  assert.equal(await bounded(destroyed.promise, 'open response destruction'), true);
  assert.equal((await first).value, 'RETRY_WAIT');
  assert.equal((await recovery.send(r.sync(url))).value, 'SYNCED');
  assert.deepEqual(received, [bytes, bytes]);
  assert.deepEqual(vouchers[1], vouchers[0]);
  assert.deepEqual(await snapshot(f), accepted);
  await recovery.close();
  const reopened = r.child();
  assert.equal((await reopened.send(r.sync(url))).value, 'IDLE');
  assert.equal(localState(r).spends, 1);
  assert.equal(localState(r).outbox[0].state, 'SYNCED');
  assert.equal(localState(r).outbox[0].digest, digest(bytes));
});

function receiptFor(grant: Grant, slices: string[]): CustodyReceipt {
  assert.ok(grant.transfer);
  return {
    version: 1, kind: 'CUSTODY_RECEIPT', grantId: grant.grantId, positionId: grant.positionId,
    tenantId: grant.tenantId, terminalId: grant.terminalId, generation: grant.generation,
    transferId: grant.transfer.id, dispatchLegId: grant.transfer.dispatchLegId, legId: randomUUID(), slices,
  };
}

test('M2-04 partial custody settles under either order and a real race without duplicate handoff', timeout, async t => {
  for (const order of ['sale-first', 'receipt-first', 'race'] as const) await t.test(order, async sub => {
    const f = await pair(sub, 3);
    const url = await f.listen(f.server());
    await f.enable(url);
    const dispatch = { ...f.request(f.b, 2), action: 'dispatch', transferId: randomUUID(), dispatchLegId: randomUUID(),
      sourceLocationId: f.position.locationId };
    const packet = await operator(url, f.token, dispatch) as SignedEvidence;
    assert.deepEqual(await operator(url, f.token, dispatch), packet);
    assert.deepEqual((await snapshot(f)).inventory,
      { on_hand: 3, rebuilt_on_hand: 3, encumbered: 2, in_transit: 2, available: 1 });
    const grant = grantFrom(packet);
    const receipt = receiptFor(grant, [grant.slices[0]]);
    const proof = signEvidence(receipt, f.custodySigner);
    importGrant(f, 1, packet);
    const r = f.terminals[1];
    const child = r.child();
    await assert.rejects(child.send({ action: 'checkout', input: r.input }), /No usable offline quota/);
    assert.equal(localState(r).sales, 0);
    const unmatched = signEvidence({ ...receipt, dispatchLegId: randomUUID() }, f.custodySigner);
    assert.throws(() => withRegister(r, terminal => terminal.importCustody(unmatched, f.custodyKeys)), /match dispatch/);
    await operator(url, f.token, { action: 'file-custody', receipt: unmatched }, 422);
    withRegister(r, terminal => {
      terminal.importCustody(proof, f.custodyKeys);
      terminal.importCustody(proof, f.custodyKeys);
    });
    const sale = await checkout(r, child);
    assert.equal(sale.event.quota.sliceId, receipt.slices[0]);
    assert.deepEqual(sale.event.quota.custody, proof);
    const forged = signEvidence(receipt, f.signer);
    assert.equal((await post(url, r.enrollment.token,
      jsonBytes({ ...sale.event, quota: { ...sale.event.quota, custody: forged } }))).status, 422);
    const file = () => operator(url, f.token, { action: 'file-custody', receipt: proof });
    const sync = async () => (await child.send(r.sync(url))).value;
    if (order === 'sale-first') {
      assert.equal(await sync(), 'RETRY_WAIT');
      const staged = await snapshot(f);
      assert.deepEqual(staged.counts, { sales: 1, receipts: 1, outcomes: 0, claims: 1, shortfalls: 0, movements: 0, vouchers: 0 });
      assert.equal(staged.inventory.in_transit, 2);
      assertCash(staged.postings, [sale.event.saleId]);
      assert.equal(localState(r).outbox[0].ack_id, null);
      await file();
      // The receipt transaction wakes the sale, before any new terminal request.
      assert.equal((await snapshot(f)).decisions[0].sale_id, sale.event.saleId);
      assert.equal(await sync(), 'SYNCED');
    } else if (order === 'receipt-first') {
      await file();
      assert.deepEqual((await snapshot(f)).inventory,
        { on_hand: 3, rebuilt_on_hand: 3, encumbered: 2, in_transit: 1, available: 1 });
      assert.equal(await sync(), 'SYNCED');
    } else {
      const [status] = await holdStock(f, () => [sync(), file()]);
      assert.ok(status === 'RETRY_WAIT' || status === 'SYNCED');
      assert.equal((await snapshot(f)).counts.outcomes, 1);
      assert.equal(await sync(), status === 'RETRY_WAIT' ? 'SYNCED' : 'IDLE');
    }
    assert.deepEqual(await file(), { legId: receipt.legId });
    await operator(url, f.token, { action: 'file-custody',
      receipt: signEvidence({ ...receipt, legId: randomUUID() }, f.custodySigner) }, 409);
    const final = await snapshot(f);
    assert.deepEqual(final.counts, { sales: 1, receipts: 1, outcomes: 1, claims: 1, shortfalls: 0, movements: 1, vouchers: 1 });
    assert.deepEqual(final.inventory, { on_hand: 2, rebuilt_on_hand: 2, encumbered: 1, in_transit: 1, available: 1 });
    assertCash(final.postings, [sale.event.saleId]);
    const { rows } = await f.db.fixture.query('SELECT slice_id, leg_id FROM omni.custody_units WHERE tenant_id=$1', [f.a.tenantId]);
    assert.deepEqual(rows, [{ slice_id: grant.slices[0], leg_id: receipt.legId }]);
    await assert.rejects(child.send({ action: 'checkout', input: { ...r.input, requestId: randomUUID() } }), /No usable offline quota/);
    const replay = await post(url, r.enrollment.token, sale.bytes);
    assert.equal(verifyVoucher(replay.status, replay.bytes, replay.headers, f.grantKeys, sale.event, digest(sale.bytes)).disposition, 'COMMITTED');
    const ambiguous = signEvidence({ ...receipt, slices: [grant.slices[1]] }, f.custodySigner);
    assert.equal((await post(url, r.enrollment.token, jsonBytes({
      ...sale.event, sequence: 2, saleId: randomUUID(), receiptId: randomUUID(),
      line: { ...sale.event.line, id: randomUUID() },
      quota: { ...sale.event.quota, sliceId: grant.slices[1], custody: ambiguous },
    }))).status, 409);
    assert.deepEqual(await snapshot(f), final);
  });
});

test('M2-05 authorized shortfall fulfillment consumes a separately evidenced replacement once', timeout, async t => {
  const { f, sales } = await offlineOverlap(t);
  const url = await f.listen(f.server());
  const cli = async (action: { action: string }) => {
    const path = join(f.dir, `${action.action}.json`);
    await writeFile(path, jsonBytes(action));
    const { OMNI_TEST_ADMIN_URL: _admin, ...env } = process.env;
    const entry = fileURLToPath(new URL('../src/inventory-cli.ts', import.meta.url));
    const { stdout } = await execute(process.execPath, [entry, path], {
      env: { ...env, OMNI_INGEST_URL: url, OMNI_OPERATOR_TOKEN: f.token },
      timeout: 12_000, windowsHide: true,
    });
    return JSON.parse(stdout);
  };
  for (const [index, sale] of sales.entries()) assert.equal((await sale.child.send(f.terminals[index].sync(url))).value, 'SYNCED');
  const loser = sales[1];
  const inspect = { action: 'inspect-shortfall', saleId: loser.event.saleId };
  const resolution = { action: 'resolve-shortfall', saleId: loser.event.saleId,
    resolutionId: randomUUID(), replacementId: randomUUID() };
  await operator(url, f.a.token, resolution, 401);
  await operator(url, f.foreignToken, resolution, 404);
  await operator(url, f.token, { ...resolution, quantity: 2 }, 400);
  await operator(url, f.token, resolution, 409);
  const open = await cli(inspect);
  assert.equal(open.status, 'OPEN');
  assert.equal(open.winner_sale_id, sales[0].event.saleId);
  assert.equal(open.winner_grant_id, sales[0].event.quota.grantId);
  assert.equal(open.grant_id, loser.event.quota.grantId);
  assert.equal(open.receipt_id, loser.event.receiptId);
  assert.equal(open.quantity, 1);
  const original = await post(url, f.b.token, loser.bytes);
  const before = await snapshot(f);
  const replacement = { action: 'receive-replacement', positionId: f.position.positionId,
    replacementId: resolution.replacementId, provenance: 'Receiving manifest fixture entry 1' };
  await operator(url, f.token, { ...replacement, quantity: 2 }, 400);
  assert.deepEqual(await operator(url, f.token, replacement), { replacementId: replacement.replacementId });
  assert.deepEqual(await operator(url, f.token, replacement), { replacementId: replacement.replacementId });
  await operator(url, f.token, { ...replacement, replacementId: randomUUID() }, 409);
  await operator(url, f.token, f.request(f.a), 409);
  assert.deepEqual((await snapshot(f)).inventory,
    { on_hand: 1, rebuilt_on_hand: 1, encumbered: 1, in_transit: 0, available: 0 });
  const [resolved, replay] = await Promise.all([
    cli(resolution), operator(url, f.token, resolution),
  ]);
  assert.deepEqual(resolved, replay);
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolution_id, resolution.resolutionId);
  assert.equal(resolved.provenance, replacement.provenance);
  assert.equal(resolved.receipt_id, open.receipt_id);
  assert.equal(resolved.winner_sale_id, open.winner_sale_id);
  await operator(url, f.token, { ...resolution, resolutionId: randomUUID() }, 409);
  assert.deepEqual(await operator(url, f.token, inspect), resolved);
  assert.deepEqual(await snapshot(f), before);
  const { rows: [effects] } = await f.db.fixture.query(`
    SELECT (SELECT count(*)::int FROM omni.replacement_units WHERE tenant_id=$1) AS arrivals,
      (SELECT count(*)::int FROM omni.shortfall_resolutions WHERE tenant_id=$1) AS resolutions
  `, [f.a.tenantId]);
  assert.deepEqual(effects, { arrivals: 1, resolutions: 1 });
  const repeated = await post(url, f.b.token, loser.bytes);
  assert.deepEqual(repeated.bytes, original.bytes);
  assert.equal(repeated.headers.get('omni-signature'), original.headers.get('omni-signature'));
  t.diagnostic(`shortfall sale=${loser.event.saleId} receipt=${loser.event.receiptId} OPEN → RESOLVED by ${resolution.resolutionId}; one independently received and consumed unit; original BACKORDER voucher and cash unchanged`);
});

test('M2-06 populated v1 upgrade preserves bytes and vouchers, fences legacy sales and rebuilds stock', timeout, async t => {
  const db = await testDatabase();
  try {
    const f = await pair(t, 3, db);
    const legacy = f.server();
    const oldUrl = await f.listen(legacy);
    const [a, b] = f.terminals;
    const register = a.child();
    const stranded = b.child();
    const originalReceipt = (await register.send({ action: 'checkout', input: a.input })).value;
    await stranded.send({ action: 'checkout', input: b.input });
    const before = localState(a);
    const bytes = Buffer.from(before.outbox[0].event_bytes as Uint8Array);
    const event = parseEvent(bytes);
    assert.equal(event.version, 1);
    const original = await post(oldUrl, f.a.token, bytes);
    const legacyAck = verifyVoucher(original.status, original.bytes, original.headers, f.grantKeys, event, digest(bytes));
    await closeServer(legacy);
    await register.close();
    await stranded.close();

    // This isolated fixture contains real v1 checkout, cash and signed voucher data. Reconstruct the
    // v1 schema by removing only the empty additive M2 structures before exercising the forward runners.
    removeRetailLocalFixture(a.path);
    await removeRetailCloudFixture(db);
    const sqlite = new DatabaseSync(a.path);
    try {
      sqlite.exec(`
        BEGIN;
        DROP TABLE quota_spends; DROP TABLE custody_units; DROP TABLE custody_receipts;
        DROP TABLE quota_units; DROP TABLE quota_grants; DROP TABLE quota_position;
        PRAGMA user_version = 1;
        COMMIT;
      `);
    } finally { sqlite.close(); }
    await db.fixture.query(`
      DROP VIEW omni.quota_inventory;
      DROP TABLE omni.shortfall_resolutions, omni.replacement_units, omni.shortfalls, omni.quota_decisions,
        omni.quota_claims, omni.custody_units, omni.custody_receipts, omni.quota_grant_units, omni.quota_grants,
        omni.quota_slices, omni.stock_positions;
      DELETE FROM omni.migrations WHERE version=2;
    `);
    await db.upgrade();
    const { rows: versions } = await db.fixture.query('SELECT version FROM omni.migrations ORDER BY version');
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8].map(version => ({ version })));
    const url = await f.listen(f.server());
    const upgraded = a.child();
    assert.deepEqual((await upgraded.send({ action: 'recover', requestId: a.input.requestId })).value, originalReceipt);
    assert.equal(local(a.path, db => db.prepare('PRAGMA user_version').get()?.user_version), 6);
    assert.deepEqual(localState(a), before);
    assert.throws(() => withRegister(a, terminal => terminal.enableQuota(f.position)), /Drain/);
    assert.equal((await upgraded.send(a.sync(url))).value, 'SYNCED');
    assert.equal(localState(a).outbox[0].ack_id, legacyAck.ackId);
    await operator(url, f.token, { action: 'open-position', legacyDrained: false, storeId: f.a.storeId, ...f.position }, 400);
    await operator(url, f.token, { action: 'open-position', legacyDrained: true, storeId: f.a.storeId, ...f.position });
    withRegister(a, terminal => terminal.enableQuota(f.position));
    assert.throws(() => withRegister(b, terminal => terminal.enableQuota(f.position)), /Drain/);
    const packet = await operator(url, f.token, f.request(f.a)) as SignedEvidence;
    importGrant(f, 0, packet);
    const oldReplay = await post(url, f.a.token, bytes);
    assert.deepEqual(oldReplay.bytes, original.bytes);
    assert.equal(oldReplay.headers.get('omni-signature'), original.headers.get('omni-signature'));
    assert.equal(oldReplay.headers.get('omni-key-id'), original.headers.get('omni-key-id'));
    const blocked = localState(b).outbox[0].event_bytes as Uint8Array;
    assert.equal((await post(url, f.b.token, Buffer.from(blocked))).status, 422);
    assert.equal((await b.child().send(b.sync(url))).value, 'RETRY_WAIT');
    assert.equal((await snapshot(f)).inventory.available, 1);
    const quota = await checkout({ ...a, input: { ...a.input, requestId: randomUUID() } }, upgraded);
    assert.equal((await upgraded.send(a.sync(url))).value, 'SYNCED');
    const durable = await snapshot(f);
    assert.equal(durable.counts.sales, 2);
    assert.equal(durable.counts.movements, 2);
    assert.deepEqual(durable.inventory, { on_hand: 1, rebuilt_on_hand: 1, encumbered: 0, in_transit: 0, available: 1 });
    assert.equal(durable.decisions[0].sale_id, quota.event.saleId);
    assertCash(durable.postings, [event.saleId, quota.event.saleId]);

    const pool = db.oneConnection();
    try {
      const asTenant = (tenantId: string) => tenantTransaction(pool, tenantId, client => client.query(`
        SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM omni.quota_grants) AS grants,
          (SELECT count(*)::int FROM omni.quota_inventory) AS positions
      `));
      const own = (await asTenant(f.a.tenantId)).rows[0];
      assert.deepEqual(own, { pid: own.pid, grants: 1, positions: 1 });
      assert.deepEqual((await asTenant(f.foreign.tenantId)).rows[0], { pid: own.pid, grants: 0, positions: 0 });
      assert.equal((await pool.query('SELECT * FROM omni.quota_inventory')).rowCount, 0);
      for (const [claimed, code] of [[f.a.tenantId, '42501'], [f.foreign.tenantId, '23503']]) {
        await assert.rejects(tenantTransaction(pool, f.foreign.tenantId, client => client.query(
          'INSERT INTO omni.quota_slices VALUES ($1,$2,$3)', [claimed, f.position.positionId, randomUUID()],
        )), { code });
      }
    } finally { await pool.end(); }

    await db.fixture.query('UPDATE omni.stock SET on_hand=9 WHERE tenant_id=$1', [f.a.tenantId]);
    assert.equal((await snapshot(f)).inventory.rebuilt_on_hand, 1);
    await db.fixture.query(`
      UPDATE omni.stock s SET on_hand=i.rebuilt_on_hand FROM omni.quota_inventory i
      WHERE (i.tenant_id,i.store_id,i.sku)=(s.tenant_id,s.store_id,s.sku) AND s.tenant_id=$1
    `, [f.a.tenantId]);
    assert.deepEqual(await snapshot(f), durable);
  } finally {
    await db.close();
  }
});
