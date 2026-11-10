import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { signEvidence } from '../src/inventory-protocol.ts';
import type { Position } from '../src/inventory-protocol.ts';
import { tenantTransaction } from '../src/postgres.ts';
import { digest, jsonBytes, parseEvent, verifyVoucher } from '../src/protocol.ts';
import { SimulatedDevices } from '../src/retail-devices.ts';
import type { RetailRegister } from '../src/retail-local.ts';
import type { RetailSale } from '../src/retail-protocol.ts';
import { Terminal } from '../src/terminal.ts';
import { bounded, latch, local, scenario, testDatabase } from './fixture.ts';
import type { TestDatabase } from './fixture.ts';
import { catalog, grants, pin, post, removeRetailCloudFixture, removeRetailLocalFixture,
  retailFixture, retailUrl, saved, secret, stop } from './retail-fixture.ts';
import { createCloud } from '../src/cloud.ts';

let db: TestDatabase;
before(async () => { db = await testDatabase(); });
after(async () => { await db?.close(); });
const timeout = { timeout: 70_000 };
type Fixture = Awaited<ReturnType<typeof retailFixture>>;

async function login(page: Page) {
  await page.getByLabel('Cashier secret').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Cash shift' }).waitFor();
}

async function notice(page: Page, text: string) {
  await page.locator('.notice').getByText(text, { exact: true }).waitFor();
}

async function open(register: RetailRegister, opening = 5000) {
  const id = randomUUID();
  register.openShift(id, randomUUID(), opening);
  return id;
}

async function sync(register: RetailRegister, count = 1) {
  for (let i = 0; i < count; i++) assert.equal(await register.syncOnce(), 'SYNCED');
}

async function postings(f: Fixture, eventId: string) {
  return (await db.fixture.query(`
    SELECT account,signed_minor FROM omni.retail_postings WHERE tenant_id=$1 AND event_id=$2 ORDER BY account
  `, [f.a.tenantId, eventId])).rows;
}

async function stock(f: Fixture, sku = 'M1-ITEM') {
  return (await db.fixture.query(`
    SELECT on_hand,rebuilt_on_hand,encumbered,in_transit,available
    FROM omni.quota_inventory WHERE tenant_id=$1 AND sku=$2
  `, [f.a.tenantId, sku])).rows[0];
}

test('M3-01 browser checkout offline, forced terminal restart, dropped final voucher and exact replay', timeout, async t => {
  const f = await retailFixture(t, db);
  await f.setup();
  const register = f.terminal(0);
  register.connection.importGrant(await f.issue('M1-ITEM', 0), f.keys);
  register.connection.close();
  await stop(f.original);
  const serve = { ...f.serve(0), pause: true };
  const child = f.child(0);
  const port = Number((await child.send(serve)).value);
  const origin = `http://127.0.0.1:${port}`;
  const raw = (originHeader?: string) => fetch(origin + '/api/register', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(originHeader ? { origin: originHeader } : {}) },
    body: '{"action":"state"}' });
  assert.equal((await raw('https://foreign.example')).status, 403);
  assert.equal((await raw(origin)).status, 401);

  const channel = process.env.OMNI_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
  const browser = await chromium.launch({ channel, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(origin);
  await login(page);
  await page.getByRole('button', { name: 'Open shift' }).click();
  await page.getByText('Shift open', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Sync next' }).click();
  await notice(page, 'RETRY_WAIT');
  await page.getByText('Cloud OFFLINE', { exact: false }).waitFor();

  const search = page.getByLabel('Catalog search');
  await search.fill('210001');
  await search.press('Enter');
  await page.getByText('Cart is empty').waitFor();
  await search.fill('');
  await page.getByRole('button', { name: 'Add M1-ITEM' }).click();
  await page.getByRole('combobox', { name: 'Quantity for M1-ITEM' }).selectOption('0');
  await page.getByText('Cart is empty').waitFor();
  const scanner = page.getByLabel('Barcode scanner');
  await scanner.fill('!bad-scan');
  await scanner.press('Enter');
  await notice(page, 'Malformed scan or SKU');
  await scanner.fill('');
  await scanner.focus();
  await page.keyboard.type('210001');
  await page.keyboard.press('Enter');
  await notice(page, 'Item added');
  await page.getByRole('combobox', { name: 'Quantity for M1-ITEM' }).waitFor();
  await page.getByLabel('Cash tender in cents').fill('500');
  const pause = child.waitMessage();
  await page.getByRole('button', { name: 'Finalize cash sale' }).click();
  assert.equal((await pause).phase, 'after-commit');
  const path = register.target.path;
  const checkout = saved(path);
  assert.equal(checkout.event.kind, 'SALE');
  const event = checkout.event as RetailSale;
  const localReceipt = local(path, local => local.prepare('SELECT receipt_id,printable FROM retail_receipts').get());
  assert.equal(localReceipt?.receipt_id, event.receiptId);
  assert.deepEqual(local(path, local => local.prepare("SELECT signed_minor FROM retail_cash WHERE kind='SALE'").all()
    .map(row => ({ ...row }))), [{ signed_minor: 220 }]);
  assert.deepEqual(local(path, local => local.prepare('SELECT state FROM retail_devices ORDER BY rowid').all().map(r => r.state)),
    ['UNSENT', 'UNSENT']);
  assert.equal((await db.fixture.query('SELECT 1 FROM omni.retail_events WHERE tenant_id=$1', [f.a.tenantId])).rowCount, 0);
  await child.kill();

  const durable = latch<void>();
  const deliveries: Buffer[] = [];
  const vouchers: Array<{ signature: string; bytes: Buffer }> = [];
  const cloud = f.cloud({
    retailReceived(incoming, bytes) { if (incoming.kind === 'SALE') deliveries.push(bytes); },
    async beforeResponse(voucher, response) {
      const ack = JSON.parse(voucher.bytes.toString('utf8'));
      if (ack.saleId !== event.saleId) return;
      vouchers.push(voucher);
      if (vouchers.length !== 1) return;
      const { rows: [stored] } = await db.fixture.query(`
        SELECT e.ack,v.signature FROM omni.retail_events e JOIN omni.retail_vouchers v USING (tenant_id,event_id)
        WHERE e.tenant_id=$1 AND e.event_id=$2
      `, [f.a.tenantId, event.saleId]);
      assert.deepEqual(stored, { ack: voucher.bytes, signature: voucher.signature });
      assert.equal(response.headersSent, false);
      assert.equal(response.socket?.destroyed, false);
      response.destroy();
      durable.resolve();
    },
  });
  await f.listen(cloud, Number(new URL(f.url).port));
  const restarted = f.child(0);
  await restarted.send({ ...serve, port, pause: false });
  await page.reload();
  await login(page);
  await page.getByRole('button', { name: 'Recover last checkout' }).click();
  await notice(page, 'Original receipt loaded');
  assert.equal(await page.getByLabel('Printable receipt').textContent(), localReceipt?.printable);
  await page.getByRole('button', { name: 'Sync next' }).click();
  await notice(page, 'SYNCED');
  await page.getByRole('button', { name: 'Sync next' }).click();
  await bounded(durable.promise, 'durable retail voucher');
  await notice(page, 'RETRY_WAIT');
  await page.getByRole('button', { name: 'Sync next' }).click();
  await notice(page, 'SYNCED');
  await page.getByRole('button', { name: 'Diagnostics' }).click();
  await page.getByText('fulfilled 1 · backordered 0', { exact: false }).waitFor();
  assert.deepEqual(deliveries, [checkout.bytes, checkout.bytes]);
  assert.deepEqual(vouchers[0], vouchers[1]);
  const cloudReceipt = await db.fixture.query('SELECT receipt_id,printable FROM omni.retail_receipts WHERE tenant_id=$1', [f.a.tenantId]);
  assert.deepEqual(cloudReceipt.rows, [{ ...localReceipt }]);
  assert.deepEqual(await postings(f, event.saleId), [{ account: 'Cash', signed_minor: 220 },
    { account: 'Revenue', signed_minor: -210 }, { account: 'SalesTax', signed_minor: -10 }]);
  assert.equal((await stock(f)).on_hand, 2);
  await restarted.close();
  const persisted = saved(path, event.saleId);
  assert.equal(persisted.row.state, 'SYNCED');
  assert.equal(persisted.row.attempts, 2);
  assert.deepEqual(persisted.bytes, checkout.bytes);
  assert.equal(persisted.row.ack_id, JSON.parse(vouchers[0].bytes.toString('utf8')).ackId);
  t.diagnostic(`original receipt=${event.receiptId}; sale SHA-256=${digest(checkout.bytes)}; $2.20 cash and one quota unit; ACK survived reopen`);
});

test('M3-02 immutable cart quote, half-even tax, discount and mixed durable line outcomes', timeout, async t => {
  const f = await retailFixture(t, db, [1, 3, 3]);
  await f.setup();
  const a = f.terminal(0);
  const b = f.terminal(1);
  const direct = await f.issue('M1-ITEM', 0);
  a.connection.importGrant(direct, f.keys);
  b.connection.importGrant(await f.overlap(direct), f.keys);
  b.connection.importGrant(await f.issue('M3-RED', 1, 2), f.keys);
  b.connection.importGrant(await f.issue('M3-TEA', 1), f.keys);
  await open(a.register);
  await open(b.register);
  a.register.scan('210001');
  b.register.scan('210001');
  const next = { ...catalog, version: 2, taxVersion: 2,
    variants: catalog.variants.map(item => item.sku === 'M1-ITEM' ? { ...item, unitMinor: 250, taxBps: 800 } : item) };
  await f.op({ action: 'retail-catalog', storeId: f.a.storeId, catalog: next });
  b.register.installCatalog(next, f.positions);
  assert.equal(b.register.state().cart[0].quote.unitMinor, 210);
  assert.equal(b.register.state().cart[0].taxMinor, 10);
  const red = b.register.scan('210002');
  b.register.setQuantity(red, 3);
  await assert.rejects(b.register.checkout(randomUUID(), 5000), /No usable offline quota/);
  assert.equal(local(b.target.path, local => local.prepare('SELECT count(*) AS n FROM retail_spends').get()?.n), 0);
  b.register.setQuantity(red, 2);
  b.register.scan('M3-TEA', true);
  assert.throws(() => b.register.discount(red, 100, 'Retail promotion', 'incorrect'), /Supervisor/);
  b.register.discount(red, 100, 'Retail promotion', pin);
  await assert.rejects(b.register.checkout(randomUUID(), 10), /Insufficient/);
  assert.equal(local(b.target.path, local => local.prepare('SELECT count(*) AS n FROM retail_receipts').get()?.n), 0);
  await a.register.checkout(randomUUID(), 300);
  await sync(a.register, 2);
  const receipt = await b.register.checkout(randomUUID(), 3000);
  const sale = saved(b.target.path, receipt.eventId);
  assert.equal(sale.event.kind, 'SALE');
  assert.deepEqual([sale.event.totalMinor, sale.event.taxMinor, sale.event.changeMinor], [2620, 201, 380]);
  await sync(b.register);
  const tampered = jsonBytes({ ...sale.event, lines: sale.event.lines.map((line, i) =>
    i ? line : { ...line, quote: { ...line.quote, catalogVersion: 99 } }) });
  assert.equal((await post(retailUrl(f.url), f.b.token, tampered)).status, 422);
  await sync(b.register);
  const signed = JSON.parse(Buffer.from(saved(b.target.path).row.ack as Uint8Array).toString('utf8'));
  assert.equal(signed.disposition, 'BACKORDER');
  assert.deepEqual(signed.lines.map((line: { fulfilled: number; backordered: number }) => [line.fulfilled, line.backordered]),
    [[0, 1], [2, 0], [1, 0]]);
  assert.deepEqual(await postings(f, receipt.eventId), [{ account: 'Cash', signed_minor: 2620 },
    { account: 'Revenue', signed_minor: -2419 }, { account: 'SalesTax', signed_minor: -201 }]);
  const before = await Promise.all(catalog.variants.map(item => stock(f, item.sku)));
  assert.deepEqual(before.map(s => s.on_hand), [0, 1, 2]);
  const first = await post(retailUrl(f.url), f.b.token, sale.bytes);
  const replay = await post(retailUrl(f.url), f.b.token, sale.bytes);
  assert.deepEqual(first.bytes, replay.bytes);
  assert.equal(first.headers.get('omni-signature'), replay.headers.get('omni-signature'));
  assert.deepEqual(await Promise.all(catalog.variants.map(item => stock(f, item.sku))), before);
  const { rows } = await db.fixture.query('SELECT line_id,quantity FROM omni.retail_shortfalls WHERE tenant_id=$1', [f.a.tenantId]);
  assert.deepEqual(rows, [{ line_id: sale.event.lines[0].id, quantity: 1 }]);
});

function returnInput(receiptId: string, lineId: string) {
  return { receiptId, lineId, returnId: randomUUID(), attemptId: randomUUID(), quantity: 1 };
}

test('M3-03 partial cash returns, last-unit contention, payout recovery and independent restock', timeout, async t => {
  const f = await retailFixture(t, db);
  await f.setup();
  let a = f.terminal(0);
  const b = f.terminal(1);
  a.connection.importGrant(await f.issue('M1-ITEM', 0, 2), f.keys);
  const shiftA = await open(a.register);
  await open(b.register);
  a.register.scan('210001');
  a.register.scan('210001');
  const original = await a.register.checkout(randomUUID(), 500);
  const lineId = original.lines![0].id;
  const first = returnInput(original.receiptId, lineId);
  await assert.rejects(a.register.reserveReturn(first, pin), /has not synchronized/);
  await sync(a.register, 2);
  await sync(b.register);
  await assert.rejects(a.register.reserveReturn(first, 'bad'), /Supervisor/);
  const wrong = await post(new URL('/v3/returns', f.url).href, f.a.token,
    jsonBytes({ action: 'reserve', payload: { request: { ...first, shiftId: shiftA }, approval: { actorId: randomUUID(), signature: 'A'.repeat(86) } } }));
  assert.equal(wrong.status, 403);
  const firstQuote = await a.register.reserveReturn(first, pin);
  assert.equal(firstQuote.reservation.basisMinor, 210);
  assert.equal(firstQuote.reservation.taxMinor, 10);
  a.connection.close();
  const payoutProcess = f.child(0);
  const port = Number((await payoutProcess.send(f.serve(0))).value);
  const origin = `http://127.0.0.1:${port}`;
  const call = (body: object, cookie = '') => fetch(origin + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body),
  });
  const session = await call({ action: 'login', secret });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const payout = await call({ action: 'begin-payout', id: first.returnId }, cookie);
  assert.equal(payout.status, 200);
  assert.equal((await payout.json()).data.amountMinor, 220);
  await payoutProcess.kill();
  a = f.terminal(0);
  await assert.rejects(a.register.beginPayout(first.returnId), /held for reconciliation/);
  assert.throws(() => a.register.confirmPayout(first.returnId, 'incorrect'), /Supervisor/);
  const refund1 = a.register.confirmPayout(first.returnId, pin)!;
  assert.deepEqual(a.register.confirmPayout(first.returnId, pin), refund1);
  await sync(a.register);
  assert.equal((await stock(f)).on_hand, 1);

  const contenders = [returnInput(original.receiptId, lineId), returnInput(original.receiptId, lineId)];
  const registers = [a.register, b.register];
  const lock = await db.fixture.connect();
  let pending: ReturnType<typeof Promise.allSettled>;
  try {
    await lock.query('BEGIN');
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 71422301))", [f.a.tenantId + '/' + lineId]);
    pending = Promise.allSettled(registers.map((register, i) => register.reserveReturn(contenders[i], pin)));
    const cutoff = Date.now() + 3500;
    let blocked = 0;
    while (Date.now() < cutoff) {
      const { rows: [row] } = await db.fixture.query(`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'
      `);
      blocked = row.n;
      if (blocked === 2) break;
      await delay(20);
    }
    assert.equal(blocked, 2);
  } finally {
    try { await lock.query('ROLLBACK'); } finally { lock.release(); }
  }
  const race = await pending!;
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  const winner = race.findIndex(r => r.status === 'fulfilled');
  const loser = 1 - winner;
  const denial = race[loser] as PromiseRejectedResult;
  assert.match(String(denial.reason), /RETURN_CAPACITY_HELD_OR_EXHAUSTED/);
  assert.equal((await registers[winner].beginPayout(contenders[winner].returnId)).amountMinor, 221);
  await assert.rejects(registers[winner].releaseReturn(contenders[winner].returnId, '', pin), /nonexecution/i);
  await registers[winner].releaseReturn(contenders[winner].returnId, 'Witness verified cash never left drawer', pin);
  const secondQuote = await registers[loser].reserveReturn(contenders[loser], pin);
  assert.equal(secondQuote.reservation.taxMinor, 11);
  await registers[loser].beginPayout(contenders[loser].returnId);
  const refund2 = registers[loser].confirmPayout(contenders[loser].returnId, pin)!;
  await sync(registers[loser]);
  for (const [receipt, tax] of [[refund1, 10], [refund2, 11]] as const) {
    assert.equal(receipt.originalReceiptId, original.receiptId);
    assert.deepEqual(await postings(f, receipt.eventId), [{ account: 'Cash', signed_minor: -(210 + tax) },
      { account: 'Revenue', signed_minor: 210 }, { account: 'SalesTax', signed_minor: tax }]);
  }
  await assert.rejects(a.register.reserveReturn(returnInput(original.receiptId, lineId), pin), /CAPACITY/);
  assert.equal((await stock(f)).on_hand, 1);
  const inspected = { action: 'retail-restock', returnId: refund1.eventId, evidenceId: randomUUID(),
    disposition: 'SELLABLE', provenance: 'Verified inspection and shelf custody 1' };
  await f.op(inspected);
  await f.op(inspected);
  await f.op({ ...inspected, evidenceId: randomUUID() }, 409);
  await f.op({ ...inspected, returnId: refund2.eventId, evidenceId: randomUUID(),
    disposition: 'QUARANTINED', provenance: 'Damaged and isolated' });
  assert.deepEqual(await stock(f), { on_hand: 2, rebuilt_on_hand: 2, encumbered: 0, in_transit: 0, available: 2 });
});

test('M3-04 blind close covers opening, net cash, refund and drop and applies only the revised variance delta', timeout, async t => {
  const f = await retailFixture(t, db);
  await f.setup();
  const a = f.terminal(0);
  a.connection.importGrant(await f.issue('M1-ITEM', 0), f.keys);
  const shiftId = await open(a.register);
  a.register.scan('210001');
  const sale = await a.register.checkout(randomUUID(), 500);
  await sync(a.register, 2);
  const refund = returnInput(sale.receiptId, sale.lines![0].id);
  await a.register.reserveReturn(refund, pin);
  await a.register.beginPayout(refund.returnId);
  assert.throws(() => a.register.close(randomUUID(), {}), /outstanding refund/);
  a.register.confirmPayout(refund.returnId, pin);
  const destination = randomUUID();
  a.register.drop(randomUUID(), destination, 500, pin);
  assert.equal(a.register.state().close, null);
  assert.equal('expectedMinor' in a.register.state(), false);
  const closeId = randomUUID();
  const count = { '2000': 2, '100': 4 };
  const close = a.register.close(closeId, count)!;
  assert.deepEqual([close.counted_minor, close.expected_minor, close.variance_minor, close.covered_no], [4400, 4500, -100, 4]);
  assert.deepEqual(a.register.close(closeId, count), close);
  const closeEvent = saved(a.target.path, closeId);
  const early = await post(retailUrl(f.url), f.a.token, closeEvent.bytes);
  assert.equal(early.status, 202);
  assert.equal(early.json().reason, 'SHIFT_SEQUENCE_GAP');
  assert.equal((await db.fixture.query('SELECT 1 FROM omni.retail_closes WHERE tenant_id=$1', [f.a.tenantId])).rowCount, 0);
  await sync(a.register, 3);
  const revised = { '2000': 2, '500': 1 };
  const revisionId = randomUUID();
  assert.throws(() => a.register.close(revisionId, revised, { previousId: closeId, reason: 'Witness recount', pin: 'bad' }), /Supervisor/);
  const revision = a.register.close(revisionId, revised, { previousId: closeId, reason: 'Witness recount', pin })!;
  assert.deepEqual([revision.variance_minor, revision.delta_minor], [0, 100]);
  await sync(a.register);
  assert.equal((await post(retailUrl(f.url), f.a.token, saved(a.target.path, revisionId).bytes)).status, 200);
  const { rows: cash } = await db.fixture.query(`
    SELECT c.kind,c.signed_minor,c.destination_id FROM omni.retail_cash c JOIN omni.retail_events e USING(tenant_id,event_id)
    WHERE c.tenant_id=$1 AND c.shift_id=$2 ORDER BY e.source_no
  `, [f.a.tenantId, shiftId]);
  assert.deepEqual(cash, [
    { kind: 'OPEN', signed_minor: 5000, destination_id: null }, { kind: 'SALE', signed_minor: 220, destination_id: null },
    { kind: 'RETURN', signed_minor: -220, destination_id: null }, { kind: 'DROP', signed_minor: -500, destination_id: destination },
  ]);
  const { rows: closes } = await db.fixture.query(`
    SELECT event_id,previous_id,covered_no,variance_minor,delta_minor FROM omni.retail_closes WHERE tenant_id=$1 ORDER BY covered_no
  `, [f.a.tenantId]);
  assert.deepEqual(closes, [
    { event_id: closeId, previous_id: null, covered_no: 4, variance_minor: -100, delta_minor: -100 },
    { event_id: revisionId, previous_id: closeId, covered_no: 5, variance_minor: 0, delta_minor: 100 },
  ]);
});

test('M3-05 manual SKU and device faults preserve stable commands and reprint the same receipt', timeout, async t => {
  const f = await retailFixture(t, db);
  await f.setup();
  const devices = new SimulatedDevices();
  const a = f.terminal(0, devices);
  a.connection.importGrant(await f.issue('M1-ITEM', 0), f.keys);
  await open(a.register);
  assert.throws(() => a.register.scan('!bad'), /Malformed/);
  assert.throws(() => a.register.scan('000000'), /Unknown/);
  a.register.scan('M1-ITEM', true);
  const sale = await a.register.checkout(randomUUID(), 500);
  assert.equal(devices.calls.length, 0);
  assert.equal(saved(a.target.path, sale.eventId).event.kind, 'SALE');
  devices.modes.set('PRINTER', 'PAPER_OUT');
  devices.modes.set('DRAWER', 'DELAYED');
  await a.register.dispatchEvent(sale.eventId);
  assert.deepEqual(devices.calls.map(c => c.kind), ['PRINTER', 'DRAWER']);
  const original = a.register.state().devices;
  assert.deepEqual(original.map(d => [d.kind, d.state, d.detail]),
    [['DRAWER', 'UNCERTAIN', 'TIMEOUT'], ['PRINTER', 'FAILED', 'PAPER_OUT']]);
  await a.register.dispatchEvent(sale.eventId);
  assert.equal(devices.calls.length, 2);
  devices.modes.set('PRINTER', 'DISCONNECTED');
  const disconnected = randomUUID();
  assert.deepEqual(await a.register.reprint(sale.receiptId, disconnected), sale);
  assert.equal(a.register.state().devices.find(d => d.command_id === disconnected)?.detail, 'DISCONNECTED');
  await a.register.reprint(sale.receiptId, disconnected);
  assert.equal(devices.calls.length, 3);
  devices.modes.set('PRINTER', 'OK');
  const successful = randomUUID();
  await a.register.reprint(sale.receiptId, successful);
  assert.deepEqual(devices.calls.at(-1), { id: successful, kind: 'PRINTER', payload: sale.printable });
  assert.equal(devices.calls.filter(c => c.kind === 'DRAWER').length, 1);
  const drawer = String(original.find(d => d.kind === 'DRAWER')?.command_id);
  assert.equal(devices.finishDelayed(drawer), true);
  assert.equal(a.register.state().devices.find(d => d.command_id === drawer)?.state, 'UNCERTAIN');
  assert.throws(() => a.register.checkDevice(drawer, 'Manual drawer verified', 'bad'), /Supervisor/);
  a.register.checkDevice(drawer, 'Manual drawer verified', pin);
  a.connection.close();
  const reopened = f.terminal(0);
  assert.equal(reopened.register.state().devices.find(d => d.command_id === drawer)?.state, 'CHECKED');
  assert.deepEqual({ ...local(a.target.path, db => db.prepare('SELECT detail,check_evidence FROM retail_devices WHERE command_id=?').get(drawer)) },
    { detail: 'TIMEOUT', check_evidence: 'Manual drawer verified' });
  assert.deepEqual(reopened.register.receipt(sale.eventId), sale);
  assert.deepEqual(local(a.target.path, local => {
    const n = (table: string) => local.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
    return [n('retail_receipts'), n('retail_spends'), n('retail_cash')];
  }), [1, 1, 2]);
});

test('M3-06 late custody reattributes a count, leaves an outstanding grant fenced, and applies evidenced deltas once', timeout, async t => {
  const f = await retailFixture(t, db);
  await f.setup();
  const position = f.positions[0];
  await f.issue('M1-ITEM', 1);
  const dispatched = await f.issue('M1-ITEM', 0, 1, { action: 'dispatch', transferId: randomUUID(),
    dispatchLegId: randomUUID(), sourceLocationId: position.locationId });
  const grant = grants(dispatched);
  const proof = signEvidence({ version: 1, kind: 'CUSTODY_RECEIPT', tenantId: f.a.tenantId, terminalId: f.a.terminalId,
    generation: f.a.generation, positionId: position.positionId, grantId: grant.grantId, transferId: grant.transfer!.id,
    dispatchLegId: grant.transfer!.dispatchLegId, legId: randomUUID(), slices: grant.slices, observedAt: new Date().toISOString(),
  }, f.custodySigner);
  const a = f.terminal(0);
  a.connection.importGrant(dispatched, f.keys);
  a.connection.importCustody(proof, f.custodyKeys);
  await open(a.register);
  a.register.scan('210001');
  const sale = await a.register.checkout(randomUUID(), 300);
  await sync(a.register);
  assert.equal(await a.register.syncOnce(), 'RETRY_WAIT');
  assert.equal(saved(a.target.path, sale.eventId).row.result, 'CUSTODY_RECEIPT_MISSING');
  assert.deepEqual(await postings(f, sale.eventId), []);
  const countId = randomUUID();
  const counted = await f.op({ action: 'retail-count', positionId: position.positionId, countId, observed: 3, witness: 'Cycle count witness' });
  assert.equal(counted.actor_id, f.actorId);
  assert.equal(counted.open_slices.length, 2);
  assert.equal((await f.op({ action: 'retail-inspect-count', countId })).status, 'CUSTODY_HELD');
  const decide = { action: 'retail-decide-count', countId, decisionId: randomUUID(), previousId: null,
    evidence: 'Verify receiving leg at observation cutoff' };
  await f.op(decide, 409);
  await f.op({ action: 'file-custody', receipt: proof });
  await f.op({ action: 'file-custody', receipt: proof });
  const decision = await f.op(decide);
  assert.equal(decision.corrected_book, 3);
  assert.equal(decision.delta, 0);
  assert.deepEqual(await f.op(decide), decision);
  assert.deepEqual(await stock(f), { on_hand: 3, rebuilt_on_hand: 3, encumbered: 2, in_transit: 0, available: 1 });
  await sync(a.register);
  assert.equal((await stock(f)).encumbered, 1);
  assert.equal((await stock(f)).on_hand, 2);

  const found = { action: 'retail-found', positionId: position.positionId, evidenceId: randomUUID(), quantity: 1,
    provenance: 'Found unit with verified receiving tag' };
  assert.equal((await f.op(found)).delta, 1);
  assert.equal((await f.op(found)).delta, 1);
  const revisedCount = randomUUID();
  await f.op({ action: 'retail-count', positionId: position.positionId, countId: revisedCount, observed: 4, witness: 'Second witnessed count' });
  const approved = { ...decide, countId: revisedCount, decisionId: randomUUID(), evidence: 'Supported positive count difference' };
  assert.equal((await f.op(approved)).delta, 1);
  const revision = { ...approved, decisionId: randomUUID(), previousId: approved.decisionId, observed: 3,
    evidence: 'Corrected duplicate count of tagged unit' };
  assert.equal((await f.op(revision)).delta, -1);
  assert.equal((await f.op(revision)).delta, -1);
  assert.deepEqual(await stock(f), { on_hand: 3, rebuilt_on_hand: 3, encumbered: 1, in_transit: 0, available: 2 });
});

test('M3-07 populated v1/v2 upgrade retains exact bytes and vouchers, and retail tables respect tenant isolation', timeout, async t => {
  const isolated = await testDatabase();
  try {
    const f = await scenario(t, isolated);
    const actorId = randomUUID();
    const token = 'fixture-inventory-operator-auth-' + randomUUID();
    const start = () => createCloud(isolated.runtime, [f.enrollment], f.signer, undefined,
      { operators: [{ tenantId: f.scope.tenantId, actorId, token }] });
    const cloud = start();
    let url = await f.listen(cloud);
    const op = async (body: object) => {
      const response = await post(new URL('/v2/inventory', url).href, token, jsonBytes(body));
      assert.equal(response.status, 200);
      return response.json();
    };
    const makeLegacy = async (input: typeof f.input, cutover?: Position) => {
      const child = f.child();
      const receipt = (await child.send({ action: 'checkout', input })).value;
      const bytes = local(f.path, local => Buffer.from(local.prepare(`
        SELECT event_bytes FROM outbox JOIN sales USING(sale_id) WHERE request_id=?
      `).get(input.requestId)?.event_bytes as Uint8Array));
      if (cutover) {
        const localTerminal = new Terminal(f.path);
        try {
          const register = localTerminal.retail({ devices: new SimulatedDevices(), supervisor: { pin, actorId, signer: f.signer } });
          assert.throws(() => register.installCatalog(catalog, [cutover]), /Drain the legacy outbox/);
        } finally { localTerminal.close(); }
      }
      assert.equal((await child.send(f.sync(url))).value, 'SYNCED');
      await child.close();
      return { receipt, bytes };
    };
    const v1 = await makeLegacy(f.input);
    assert.equal(parseEvent(v1.bytes).version, 1);
    const position = { positionId: randomUUID(), locationId: randomUUID(), sku: f.input.sku };
    await op({ action: 'open-position', storeId: f.scope.storeId, legacyDrained: true, ...position });
    const packet = await op({ action: 'issue', positionId: position.positionId, grantId: randomUUID(),
      terminalId: f.scope.terminalId, generation: f.scope.generation, quantity: 1,
      expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const connection = new Terminal(f.path);
    try {
      connection.enableQuota(position);
      connection.importGrant(packet, new Map([[f.signer.id, f.publicKey]]));
    } finally { connection.close(); }
    const v2 = await makeLegacy({ ...f.input, requestId: randomUUID() }, position);
    assert.equal(parseEvent(v2.bytes).version, 2);
    const legacyRows = () => local(f.path, local => local.prepare(`
      SELECT event_bytes,digest,state,ack_id,receipt_id,printable FROM outbox JOIN receipts USING(sale_id) ORDER BY sale_id
    `).all());
    const before = legacyRows();
    const vouchers = await Promise.all([v1, v2].map(sale => post(url, f.enrollment.token, sale.bytes)));
    await stop(cloud);
    removeRetailLocalFixture(f.path);
    await removeRetailCloudFixture(isolated);
    assert.equal(local(f.path, db => db.prepare('PRAGMA user_version').get()?.user_version), 2);
    await isolated.upgrade();
    const reopened = new Terminal(f.path);
    reopened.close();
    assert.equal(local(f.path, db => db.prepare('PRAGMA user_version').get()?.user_version), 4);
    assert.deepEqual(legacyRows(), before);
    url = await f.listen(start());
    await op({ action: 'retail-enable', legacyDrained: true, positionId: position.positionId });
    for (const [index, sale] of [v1, v2].entries()) {
      const replay = await post(url, f.enrollment.token, sale.bytes);
      assert.equal(verifyVoucher(replay.status, replay.bytes, replay.headers, new Map([[f.signer.id, f.publicKey]]),
        parseEvent(sale.bytes), digest(sale.bytes)).disposition, 'COMMITTED');
      assert.deepEqual(replay.bytes, vouchers[index].bytes);
      assert.equal(replay.headers.get('omni-signature'), vouchers[index].headers.get('omni-signature'));
      const event = parseEvent(sale.bytes);
      const forgedNew = { ...event, sequence: 3, saleId: randomUUID(), receiptId: randomUUID(), line: { ...event.line, id: randomUUID() } };
      assert.equal((await post(url, f.enrollment.token, jsonBytes(forgedNew))).status, 422);
    }
    await op({ action: 'retail-catalog', storeId: f.scope.storeId, catalog });
    const upgraded = new Terminal(f.path);
    try {
      const keys = new Map([[f.signer.id, f.publicKey]]);
      const register = upgraded.retail({ devices: new SimulatedDevices(), supervisor: { pin, actorId, signer: f.signer },
        cloud: { url, token: f.enrollment.token, keys } });
      register.installCatalog(catalog, [position]);
      const shiftId = await open(register);
      await sync(register);
      register.scan('210001');
      await assert.rejects(register.checkout(randomUUID(), 300), /No usable offline quota/);
      const old = parseEvent(v2.bytes);
      assert.equal(old.version, 2);
      const forgedRetail: RetailSale = {
        ...f.scope, version: 3, currency: 'USD', kind: 'SALE', shiftId, saleId: randomUUID(),
        receiptId: randomUUID(), sequence: 2, occurredAt: new Date().toISOString(),
        lines: [{ id: randomUUID(), quote: { ...catalog.variants[0], catalogVersion: 1, taxVersion: 1 },
          quantity: 1, discount: null, units: [old.quota], basisMinor: 210, taxMinor: 10, totalMinor: 220 }],
        basisMinor: 210, taxMinor: 10, totalMinor: 220, tenderMinor: 300, changeMinor: 80,
      };
      assert.equal((await post(retailUrl(url), f.enrollment.token, jsonBytes(forgedRetail))).status, 422);
      const retailGrant = await op({ action: 'issue', positionId: position.positionId, grantId: randomUUID(),
        terminalId: f.scope.terminalId, generation: f.scope.generation, quantity: 1,
        expiresAt: new Date(Date.now() + 600_000).toISOString() });
      assert.equal(grants(retailGrant).retail, true);
      upgraded.importGrant(retailGrant, keys);
      await register.checkout(randomUUID(), 300);
      await sync(register);
    } finally { upgraded.close(); }
    const pool = isolated.oneConnection();
    try {
      const tenant = f.scope.tenantId;
      const own = await tenantTransaction(pool, tenant, db => db.query('SELECT pg_backend_pid() AS pid,position_id FROM omni.retail_positions'));
      assert.equal(own.rows[0].position_id, position.positionId);
      const foreign = randomUUID();
      const other = await tenantTransaction(pool, foreign, db => db.query(`
        SELECT pg_backend_pid() AS pid,(SELECT count(*)::int FROM omni.retail_positions) AS n
      `));
      assert.deepEqual(other.rows, [{ pid: own.rows[0].pid, n: 0 }]);
      await assert.rejects(tenantTransaction(pool, tenant, db => db.query('UPDATE omni.retail_positions SET position_id=position_id')),
        { code: '42501' });
      await assert.rejects(tenantTransaction(pool, foreign, db => db.query('INSERT INTO omni.retail_positions VALUES ($1,$2)',
        [tenant, position.positionId])), { code: '42501' });
      assert.equal((await pool.query('SELECT * FROM omni.retail_positions')).rowCount, 0);
    } finally { await pool.end(); }
    assert.deepEqual(legacyRows(), before);
  } finally { await isolated.close(); }
});
