import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { parseCard } from '../src/card-event.ts';
import { signArtifact } from '../src/authority.ts';
import { fiscalPurpose } from '../src/fiscal-protocol.ts';
import { providerPurpose } from '../src/payment-protocol.ts';
import { tenantTransaction } from '../src/postgres.ts';
import { digest, jsonBytes } from '../src/protocol.ts';
import type { SignedEvidence } from '../src/protocol.ts';
import { RetailRegister } from '../src/retail-local.ts';
import { SimulatedDevices } from '../src/retail-devices.ts';
import { bounded, latch, local, testDatabase } from './fixture.ts';
import type { TestDatabase } from './fixture.ts';
import { bytesOf, cardUrl, packetData, paymentFixture } from './payment-fixture.ts';
import {
  pin,
  post,
  removePaymentCloudFixture,
  removePaymentLocalFixture,
  retailFixture,
  secret,
  stop,
} from './retail-fixture.ts';

let db: TestDatabase;
before(async () => {
  db = await testDatabase();
});
after(async () => {
  await db?.close();
});
const timeout = { timeout: 80_000 };

test(
  'M4-01 browser recovery after provider commit, process death and lost cloud voucher',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db);
    const committed = latch<void>();
    const release = latch<void>();
    f.providerAfter(async (path, _result, response) => {
      if (path !== '/execute') return;
      committed.resolve();
      await bounded(release.promise, 'provider response release');
      response.destroy();
    });
    const child = f.child(0);
    const port = Number((await child.send(f.serve())).value);
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({
      channel: process.env.OMNI_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const login = async () => {
      await page.getByLabel('Cashier secret').fill(secret);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('heading', { name: 'Cash shift' }).waitFor();
    };
    await page.goto(origin);
    await login();
    await page.getByRole('button', { name: 'Charge card reader' }).click();
    let id: string;
    try {
      await bounded(committed.promise, 'provider capture commit');
      const pending = f.pay()!;
      id = String(pending.intent_id);
      assert.equal(pending.state, 'MAY_HAVE_SENT');
      assert.equal(f.evidence('CAPTURED').length, 1);
      assert.equal(f.evidence('AUTHORIZED').length, 1);
      assert.equal(
        local(f.registers[0].path, (db) => db.prepare('SELECT count(*) AS n FROM retail_receipts').get()?.n),
        0,
      );
      await child.kill();
    } finally {
      release.resolve();
    }
    f.providerAfter(() => {});
    await f.restartProvider();
    const bytes: Buffer[] = [];
    const vouchers: Array<{ bytes: Buffer; signature: string }> = [];
    await stop(f.original);
    const cloud = f.cloud({
      cardReceived: (value) => bytes.push(value),
      async beforeResponse(voucher, response) {
        if (JSON.parse(voucher.bytes.toString('utf8')).version !== 4) return;
        vouchers.push(voucher);
        if (vouchers.length !== 1) return;
        const {
          rows: [row],
        } = await db.fixture.query(
          `SELECT v.signature,e.ack FROM omni.retail_vouchers v
        JOIN omni.retail_events e USING(tenant_id,event_id) WHERE v.tenant_id=$1 AND v.event_id=$2`,
          [f.a.tenantId, id],
        );
        assert.deepEqual(row, { signature: voucher.signature, ack: voucher.bytes });
        assert.equal(response.headersSent, false);
        assert.equal(response.socket?.destroyed, false);
        response.destroy();
      },
    });
    await f.listen(cloud, Number(new URL(f.url).port));
    const restarted = f.child(0);
    await restarted.send({ ...f.serve(), port });
    await page.reload();
    await login();
    await page.getByText('MAY_HAVE_SENT', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Check payment', exact: true }).click();
    await page.getByText('FINALIZED', { exact: true }).first().waitFor();
    const stored = f.cardBytes(id!);
    const parsed = parseCard(stored.bytes);
    assert.equal(parsed.sale.totalMinor, 220);
    const printable = await page.getByLabel('Printable receipt').textContent();
    assert.match(printable ?? '', /Card USD 2.20/);
    assert.match(printable ?? '', /Fiscal FixtureSeries\/1/);
    const sync = async (status: string) => {
      await page.getByRole('button', { name: 'Sync next' }).click();
      await page.locator('.notice').getByText(status, { exact: true }).waitFor();
    };
    await sync('SYNCED');
    await sync('RETRY_WAIT');
    await sync('SYNCED');
    await restarted.close();
    const durable = f.cardBytes(id!);
    assert.equal(durable.state, 'SYNCED');
    assert.equal(durable.ack_id, JSON.parse(vouchers[0].bytes.toString('utf8')).ackId);
    assert.deepEqual(bytes, [stored.bytes, stored.bytes]);
    assert.deepEqual(vouchers[0], vouchers[1]);
    assert.equal(f.evidence('CAPTURED').length, 1);
    assert.equal(
      local(f.signerPath, (db) => db.prepare('SELECT count(*) AS n FROM device_receipts').get()?.n),
      1,
    );
    const { rows: posts } = await db.fixture.query(
      'SELECT effect,account,signed_minor FROM omni.payment_postings WHERE tenant_id=$1 ORDER BY effect,account',
      [f.a.tenantId],
    );
    assert.deepEqual(posts, [
      { effect: 'APPLY', account: 'CapturedFunds', signed_minor: 220 },
      { effect: 'APPLY', account: 'Revenue', signed_minor: -210 },
      { effect: 'APPLY', account: 'SalesTax', signed_minor: -10 },
      { effect: 'CAPTURE', account: 'CapturedFunds', signed_minor: -220 },
      { effect: 'CAPTURE', account: 'CardClearing', signed_minor: 220 },
    ]);
    const {
      rows: [counts],
    } = await db.fixture.query(
      `SELECT
    (SELECT count(*)::int FROM omni.retail_receipts WHERE tenant_id=$1) AS receipts,
    (SELECT count(*)::int FROM omni.retail_allocations WHERE tenant_id=$1 AND fulfilled) AS units,
    (SELECT count(*)::int FROM omni.retail_cash WHERE tenant_id=$1 AND kind='SALE') AS sale_cash,
    (SELECT count(*)::int FROM omni.payment_cases WHERE tenant_id=$1 AND state='APPLIED') AS applied`,
      [f.a.tenantId],
    );
    assert.deepEqual(counts, { receipts: 1, units: 1, sale_cash: 0, applied: 1 });
    assert.equal(
      local(
        f.registers[0].path,
        (db) => db.prepare("SELECT count(*) AS n FROM retail_devices WHERE kind='DRAWER'").get()?.n,
      ),
      0,
    );
    assert.equal(
      local(f.registers[0].path, (db) => db.prepare('SELECT count(*) AS n FROM retail_spends').get()?.n),
      1,
    );
    assert.equal(
      local(f.registers[0].path, (db) => db.prepare('SELECT printable FROM retail_receipts').get()?.printable),
      printable,
    );
    const reopened = f.terminal();
    await assert.rejects(
      reopened.register.reserveReturn(
        {
          returnId: randomUUID(),
          attemptId: randomUUID(),
          receiptId: parsed.sale.receiptId,
          lineId: parsed.sale.lines[0].id,
          quantity: 1,
        },
        pin,
      ),
      /CARD_RECEIPT_REQUIRES_CARD_REFUND_RAIL/,
    );
    t.diagnostic(
      `sale=${id!} receipt=${parsed.sale.receiptId} sha256=${digest(stored.bytes)}; one capture 220; one quota unit; zero drawer or Cash effect`,
    );
  },
);

async function registerHttp(f: Awaited<ReturnType<typeof paymentFixture>>) {
  const child = f.child(0, true);
  const port = Number((await child.send(f.serve())).value);
  const origin = `http://127.0.0.1:${port}`;
  const call = (body: object, cookie = '') =>
    fetch(origin + '/api/register', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const login = await call({ action: 'login', secret });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  return { child, origin, call: (body: object) => call(body, cookie) };
}

test(
  'M4-02 holds unknown non-idempotent attempts, reconciles duplicate evidence and links a replacement after decline',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db, 0);
    const a = f.terminal();
    const pay = a.register.payment!;
    let calls = 0;
    f.providerAfter((path, _result, response) => {
      if (path === '/execute' && ++calls === 1) response.destroy();
    });
    const id = randomUUID();
    assert.equal((await pay.start(id)).state, 'MAY_HAVE_SENT');
    f.setBlind(true);
    assert.equal((await pay.recover(id, true)).state, 'MAY_HAVE_SENT');
    const captured = f.evidence('CAPTURED')[0];
    const auth = f.evidence('AUTHORIZED')[0];
    await pay.webhook(auth);
    await pay.webhook(captured);
    await pay.webhook(captured);
    assert.equal(f.pay(id)?.state, 'MAY_HAVE_SENT');
    assert.equal(calls, 1);
    assert.throws(() => a.register.scan('210001'), /owns this basket/);
    await assert.rejects(pay.webhook({ ...captured, signature: 'A'.repeat(86) }), /signature/);
    const fact = packetData(captured);
    for (const operation of [
      { ...fact.operation, amountMinor: 221 },
      { ...fact.operation, tenantId: randomUUID() },
    ]) {
      await assert.rejects(
        pay.webhook(signArtifact(providerPurpose, { ...fact, operation }, f.providerSigning)),
        /binding/,
      );
    }
    const settlement = f.providerMark(fact.operation.attemptId, 'SETTLED');
    assert.equal(packetData(settlement).state, 'SETTLED');
    f.setBlind(false);
    await Promise.all([pay.recover(id), pay.webhook(captured), pay.webhook(auth), pay.webhook(settlement)]);
    assert.equal(f.pay(id)?.state, 'FINALIZED');
    const reversal = f.providerMark(fact.operation.attemptId, 'REVERSED');
    await pay.webhook(reversal);
    assert.equal(f.evidence('REVERSED').length, 1);
    assert.equal(f.pay(id)?.state, 'FINALIZED');
    const original = f.cardBytes(id).bytes;
    const conflict = signArtifact(
      providerPurpose,
      { ...fact, occurredAt: new Date(Date.parse(fact.occurredAt) + 1).toISOString() },
      f.providerSigning,
    );
    await pay.webhook(conflict);
    assert.equal(f.pay(id)?.reason, 'PROVIDER_EVIDENCE_CONFLICT');
    assert.deepEqual(f.cardBytes(id).bytes, original);
    assert.equal(
      local(a.target.path, (db) => db.prepare('SELECT count(*) AS n FROM payment_incidents').get()?.n),
      1,
    );
    assert.equal(f.evidence('CAPTURED').length, 1);
    a.register.scan('210001');
    f.setDecision(() => 'DECLINED');
    const decline = randomUUID();
    assert.equal((await pay.start(decline)).state, 'DECLINED');
    await assert.rejects(pay.start(randomUUID()), /owns this basket/);
    await assert.rejects(pay.replace(decline, 'PROVIDER_DECLINED', 'bad'), /Supervisor/);
    f.setDecision(undefined);
    assert.equal((await pay.replace(decline, 'PROVIDER_DECLINED', pin)).state, 'FINALIZED');
    const attempts = local(a.target.path, (db) =>
      db
        .prepare(
          'SELECT attempt_id,previous_attempt,reason,operation FROM payment_attempts WHERE intent_id=? ORDER BY rowid',
        )
        .all(decline),
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].previous_attempt, attempts[0].attempt_id);
    assert.equal(attempts[1].reason, 'PROVIDER_DECLINED');
    assert.equal(
      JSON.parse(String(attempts[0].operation)).basketDigest,
      JSON.parse(String(attempts[1].operation)).basketDigest,
    );
  },
);

test(
  'M4-02 idempotent replay queries status and sends the same original attempt inside the window',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db);
    const a = f.terminal();
    let calls = 0;
    let queried = false;
    f.providerAfter((path, _result, response) => {
      if (path === '/status') queried = true;
      if (path === '/execute' && ++calls === 1) response.destroy();
    });
    const id = randomUUID();
    assert.equal((await a.register.payment!.start(id)).state, 'MAY_HAVE_SENT');
    f.setBlind(true);
    const worker = new DatabaseSync(a.target.path);
    worker.prepare('UPDATE payment_attempts SET lease_until=0').run();
    worker.close();
    assert.equal((await a.register.payment!.recover(id, true)).state, 'FINALIZED');
    assert.ok(queried);
    assert.equal(calls, 2);
    assert.equal(f.evidence('CAPTURED').length, 1);
    assert.equal(
      local(a.target.path, (db) => db.prepare('SELECT count(*) AS n FROM payment_attempts').get()?.n),
      1,
    );
  },
);

test(
  'M4-03 expired fiscal authority holds capture and a lost refund response is recovered once',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db);
    f.setGrant(null);
    let a = f.terminal();
    const id = randomUUID();
    assert.equal((await a.register.payment!.start(id)).state, 'CAPTURED');
    assert.equal(f.pay(id)?.reason, 'FISCAL_GRANT_REQUIRED');
    const {
      rows: [open],
    } = await db.fixture.query(
      'SELECT state,amount_minor FROM omni.payment_cases WHERE tenant_id=$1 AND intent_id=$2',
      [f.a.tenantId, id],
    );
    assert.deepEqual(open, { state: 'CAPTURED', amount_minor: 220 });
    await assert.rejects(a.register.payment!.refund(id, 'FISCAL_UNAVAILABLE', 'bad'), /Supervisor/);
    const providerCommit = latch<void>();
    const release = latch<void>();
    f.providerAfter(async (path, result, response) => {
      if (path !== '/execute' || packetData(result as SignedEvidence).state !== 'REFUNDED') return;
      providerCommit.resolve();
      await bounded(release.promise, 'refund response release');
      response.destroy();
    });
    const refund = a.register.payment!.refund(id, 'FISCAL_UNAVAILABLE', pin);
    void refund.catch(() => {});
    try {
      await bounded(providerCommit.promise, 'durable provider refund');
      assert.equal(f.pay(id)?.state, 'REFUND_PENDING');
      assert.equal(f.evidence('REFUNDED').length, 1);
      const held = await db.fixture.query(
        'SELECT state FROM omni.payment_cases WHERE tenant_id=$1 AND intent_id=$2',
        [f.a.tenantId, id],
      );
      assert.equal(held.rows[0].state, 'REFUND_RESERVED');
      f.setGrant(f.makeGrant());
      f.setBlind(true);
      assert.equal((await a.register.payment!.recover(id)).state, 'REFUND_PENDING');
      f.setBlind(false);
      assert.equal(
        local(f.signerPath, (db) => db.prepare('SELECT count(*) AS n FROM device_receipts').get()?.n),
        0,
      );
      assert.equal(
        local(f.signerPath, (db) => db.prepare('SELECT count(*) AS n FROM device_abandoned').get()?.n),
        1,
      );
    } finally {
      release.resolve();
    }
    assert.equal((await refund).state, 'REFUND_PENDING');
    a.connection.close();
    await f.restartProvider();
    a = f.terminal();
    const results = await Promise.all([a.register.payment!.recover(id), a.register.payment!.recover(id)]);
    assert.ok(results.some((result) => result.state === 'REFUNDED'));
    assert.equal(f.evidence('CAPTURED').length, 1);
    assert.equal(f.evidence('REFUNDED').length, 1);
    assert.equal(
      packetData(f.evidence('REFUNDED')[0]).operation.originalAttemptId,
      packetData(f.evidence('CAPTURED')[0]).operation.attemptId,
    );
    const { rows } = await db.fixture.query(
      'SELECT account,sum(signed_minor)::int AS balance FROM omni.payment_postings WHERE tenant_id=$1 GROUP BY account ORDER BY account',
      [f.a.tenantId],
    );
    assert.deepEqual(rows, [
      { account: 'CapturedFunds', balance: 0 },
      { account: 'CardClearing', balance: 0 },
    ]);
    assert.equal(
      local(
        a.target.path,
        (db) => db.prepare('SELECT sum(signed_minor) AS amount FROM retail_cash').get()?.amount,
      ),
      5000,
    );
    assert.equal(
      local(a.target.path, (db) => db.prepare('SELECT count(*) AS n FROM retail_receipts').get()?.n),
      0,
    );
    assert.equal(
      local(a.target.path, (db) => db.prepare('SELECT count(*) AS n FROM retail_devices').get()?.n),
      0,
    );
    await assert.rejects(a.register.payment!.refund(id, 'FISCAL_UNAVAILABLE', pin), /already claimed/);
  },
);

test(
  'M4-04 signer commits before POS death and recovers exact bytes through expired authority',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db);
    const now = Date.now();
    const iso = (offset: number) => new Date(now + offset).toISOString();
    const first = f.makeGrant(1, 1, iso(-1000), iso(1000));
    f.setGrant(first);
    f.setClock({ lower: iso(0), upper: iso(0) });
    const atSigner = latch<void>();
    const release = latch<void>();
    f.signerAfter(async (path, result, response) => {
      if (path !== '/sign' || !(result as { proof?: unknown }).proof) return;
      atSigner.resolve();
      await bounded(release.promise, 'signer release');
      response.destroy();
    });
    const terminal = await registerHttp(f);
    const id = randomUUID();
    const pending = terminal.call({ action: 'card-start', id });
    void pending.catch(() => {});
    try {
      await bounded(atSigner.promise, 'signer atomic commit');
      assert.equal(f.pay(id)?.state, 'SIGNING');
      assert.equal(
        local(f.registers[0].path, (db) => db.prepare('SELECT count(*) AS n FROM retail_receipts').get()?.n),
        0,
      );
      await terminal.child.kill();
    } finally {
      release.resolve();
    }
    f.signerAfter(() => {});
    const original = local(f.signerPath, (db) =>
      String(db.prepare('SELECT result FROM device_receipts').get()?.result),
    );
    f.setClock({ lower: iso(2000), upper: iso(2000) });
    await f.replaceSigner(f.device);
    const a = f.terminal();
    assert.equal((await a.register.payment!.recover(id)).state, 'FINALIZED');
    assert.deepEqual(parseCard(f.cardBytes(id).bytes).envelope.proof, JSON.parse(original).proof);
    assert.equal(
      local(f.signerPath, (db) => db.prepare('SELECT sequence FROM device_head').get()?.sequence),
      1,
    );
    a.register.scan('210001');
    const second = randomUUID();
    f.setClock({ lower: iso(0), upper: iso(0) });
    assert.equal((await a.register.payment!.start(second)).state, 'CAPTURED'); // exhausted before expiry
    f.setGrant(f.makeGrant(2, 2, iso(-1000), iso(1000)));
    for (const clock of [
      null,
      { lower: iso(-2), upper: iso(-1) },
      { lower: iso(999), upper: iso(1000) },
      { lower: iso(1500), upper: iso(1600) },
    ]) {
      f.setClock(clock);
      assert.equal((await a.register.payment!.recover(second)).state, 'CAPTURED');
    }
    f.setClock({ lower: iso(500), upper: iso(500) });
    for (const epoch of [
      { ...f.device.epoch, deviceId: randomUUID() },
      { ...f.device.epoch, generation: 2 },
      { ...f.device.epoch, tenantId: randomUUID() },
    ]) {
      f.setGrant(f.makeGrant(2, 2, iso(-1000), iso(1000), epoch));
      assert.equal((await a.register.payment!.recover(second)).state, 'CAPTURED');
    }
    const replacement = f.makeGrant(2, 2, iso(-1000), iso(3000));
    assert.notEqual(packetData(first).grantId, packetData(replacement).grantId);
    f.setGrant(replacement);
    assert.equal((await a.register.payment!.recover(second)).state, 'FINALIZED');
    assert.equal(
      local(f.signerPath, (db) => db.prepare('SELECT count(*) AS n FROM device_receipts').get()?.n),
      2,
    );
    assert.equal(f.evidence('CAPTURED').length, 2);
  },
);

test(
  'M4-05 durable fiscal gaps promote in order, retain forks and fence replacement genesis',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db);
    const a = f.terminal();
    assert.equal(await a.register.syncOnce(), 'SYNCED');
    const [first, second, late] = Array.from({ length: 3 }, () => randomUUID());
    for (const [i, id] of [first, second, late].entries()) {
      if (i) a.register.scan('210001');
      assert.equal((await a.register.payment!.start(id)).state, 'FINALIZED');
    }
    const one = f.cardBytes(first).bytes;
    const two = f.cardBytes(second).bytes;
    const url = cardUrl(f.url);
    const epochId = f.device.epoch.epochId;
    const successor = await post(url, f.a.token, two);
    assert.equal(successor.status, 202);
    assert.equal(successor.json().reason, 'FISCAL_GAP');
    const staged = await f.op({ action: 'fiscal-inspect', epochId });
    assert.equal(staged.sequence, 0);
    assert.deepEqual(
      staged.observations.map((x: { sequence: number; status: string }) => [x.sequence, x.status]),
      [[2, 'PENDING']],
    );
    const [predecessor, race] = await Promise.all([post(url, f.a.token, one), post(url, f.a.token, two)]);
    assert.equal(predecessor.status, 200);
    assert.ok([200, 202].includes(race.status));
    const replay = await post(url, f.a.token, two);
    assert.equal(replay.status, 200);
    assert.equal((await f.op({ action: 'fiscal-inspect', epochId })).sequence, 2);
    const parsed = parseCard(one);
    const value = packetData(parsed.envelope.proof);
    const fork = signArtifact(
      fiscalPurpose.receipt,
      { ...value, lower: new Date(Date.parse(value.lower) - 1).toISOString() },
      f.device.signer,
    );
    const forkResult = await post(url, f.a.token, jsonBytes({ ...parsed.envelope, proof: fork }));
    assert.equal(forkResult.status, 202);
    assert.equal(forkResult.json().reason, 'FISCAL_FORK');
    const next = f.makeEpoch(epochId);
    await f.op(
      {
        action: 'fiscal-enroll',
        enrollment: next.enrollment,
        genesis: signArtifact(fiscalPurpose.genesis, { ...next.epoch, previousEpochId: null }, f.root),
      },
      409,
    );
    await f.op({ action: 'fiscal-enroll', enrollment: next.enrollment, genesis: next.genesis });
    await f.replaceSigner(next);
    const old = await post(url, f.a.token, f.cardBytes(late).bytes);
    assert.equal(old.status, 202);
    assert.equal(old.json().reason, 'FISCAL_RETIRED');
    const retired = await f.op({ action: 'fiscal-inspect', epochId });
    assert.equal(retired.sequence, 2);
    assert.equal(retired.retiredBy, next.epoch.epochId);
    assert.ok(retired.observations.some((x: { status: string }) => x.status === 'FORK'));
    assert.ok(retired.observations.some((x: { status: string }) => x.status === 'LATE'));
    assert.equal((await f.op({ action: 'fiscal-inspect', epochId: next.epoch.epochId })).sequence, 0);
    assert.deepEqual((await post(url, f.a.token, one)).bytes, predecessor.bytes);
    const {
      rows: [counts],
    } = await db.fixture.query(
      `SELECT count(*)::int AS n FROM omni.retail_allocations WHERE tenant_id=$1 AND fulfilled`,
      [f.a.tenantId],
    );
    assert.equal(counts.n, 2);
  },
);

test(
  'M4-06 SQLITE_FULL rolls back only the terminal write, preserving one capture and signed receipt',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db);
    let drop = true;
    f.signerAfter((path, result, response) => {
      if (path === '/sign' && drop && (result as { proof?: unknown }).proof) {
        drop = false;
        response.destroy();
      }
    });
    let a = f.terminal();
    const id = randomUUID();
    assert.equal((await a.register.payment!.start(id)).state, 'SIGNING');
    assert.equal(f.evidence('CAPTURED').length, 1);
    const signed = local(f.signerPath, (db) =>
      String(db.prepare('SELECT result FROM device_receipts').get()?.result),
    );
    const path = a.target.path;
    const original = local(path, (db) =>
      db.prepare('SELECT event_id,event_bytes,digest FROM retail_events').all(),
    );
    a.connection.close();
    const full = new DatabaseSync(path);
    try {
      full.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE full_probe(payload BLOB);
      CREATE TRIGGER force_full AFTER INSERT ON retail_receipts
      BEGIN INSERT INTO full_probe VALUES(zeroblob(4194304)); END;`);
      const pages = Number(full.prepare('PRAGMA page_count').get()?.page_count);
      assert.equal(full.prepare(`PRAGMA max_page_count=${pages}`).get()?.max_page_count, pages);
      const register = new RetailRegister(full, a.target.scope, {
        devices: new SimulatedDevices(),
        payment: f.paymentOptions(),
        supervisor: {
          actorId: f.actorId,
          pin,
          signer: { id: 'fixture-supervisor', key: f.supervisor.privateKey },
        },
      });
      await assert.rejects(
        register.payment!.recover(id),
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === 13,
      );
      assert.equal(full.isTransaction, false);
      assert.equal(register.storageStatus().maxPages, pages);
      assert.equal(full.prepare('SELECT count(*) AS n FROM retail_receipts').get()?.n, 0);
      assert.equal(full.prepare('SELECT count(*) AS n FROM retail_spends').get()?.n, 0);
      assert.equal(full.prepare('SELECT count(*) AS n FROM fiscal_local_receipts').get()?.n, 0);
      assert.deepEqual(full.prepare('SELECT event_id,event_bytes,digest FROM retail_events').all(), original);
      assert.equal(f.pay(id)?.state, 'SIGNING');
      full.exec('DROP TRIGGER force_full; DROP TABLE full_probe;');
    } finally {
      full.close();
    }
    a = f.terminal();
    assert.equal((await a.register.payment!.recover(id)).state, 'FINALIZED');
    const event = f.cardBytes(id);
    assert.deepEqual(parseCard(event.bytes).envelope.proof, JSON.parse(signed).proof);
    assert.equal(f.evidence('CAPTURED').length, 1);
    assert.equal(
      local(f.signerPath, (db) => db.prepare('SELECT count(*) AS n FROM device_receipts').get()?.n),
      1,
    );
    assert.equal(await a.register.syncOnce(), 'SYNCED');
    assert.equal(await a.register.syncOnce(), 'SYNCED');
    assert.deepEqual(f.cardBytes(id).bytes, event.bytes);
    t.diagnostic(
      'SQLite returned result code 13 with a page-limit fault during the receipt INSERT; reopened WAL database recovered the original signer proof.',
    );
  },
);

test(
  'M4-07 boundary rejects synthetic card data, wrong fiscal keys and pooled cross-tenant access',
  timeout,
  async (t) => {
    const f = await paymentFixture(t, db);
    const register = await registerHttp(f);
    const canaries = {
      pan: '9999999999999987',
      trackData: 'CANARY_TRACK_DATA',
      pinBlock: 'CANARY_PIN_BLOCK',
      verificationCode: 'CANARY_CVV_DATA',
      readerSecret: 'CANARY_READER_SECRET',
    };
    const rejected = await register.call({ action: 'card-start', id: randomUUID(), ...canaries });
    assert.equal(rejected.status, 409);
    const error = await rejected.text();
    const id = randomUUID();
    assert.equal((await register.call({ action: 'card-start', id })).status, 200);
    const capture = f.evidence('CAPTURED')[0];
    const fact = packetData(capture);
    const hostile = await post(
      new URL('/execute', f.providerUrl).href,
      f.providerToken,
      jsonBytes({ ...fact.operation, ...canaries }),
    );
    assert.equal(hostile.status, 422);
    const notify = async (packet: SignedEvidence, body: Buffer = bytesOf(packet)) =>
      fetch(register.origin + '/api/provider-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'omni-key-id': packet.keyId,
          'omni-signature': packet.signature,
        },
        body: Uint8Array.from(body),
      });
    assert.equal((await notify(capture)).status, 202);
    assert.equal((await notify(capture, jsonBytes({ ...fact, ...canaries }))).status, 422);
    const malicious = signArtifact(providerPurpose, { ...fact, ...canaries }, f.providerSigning);
    assert.equal((await notify(malicious)).status, 422);
    const state = await (await register.call({ action: 'state' })).text();
    assert.match(state, /FINALIZED/);
    assert.ok(!state.includes(f.providerToken));
    assert.ok(!state.includes(f.signerToken));
    assert.equal((await register.call({ action: 'sync' })).status, 200);
    assert.equal((await register.call({ action: 'sync' })).status, 200);
    await register.child.close();
    const current = f.cardBytes(id);
    const card = parseCard(current.bytes);
    const forged = signArtifact(fiscalPurpose.receipt, packetData(card.envelope.proof), f.root);
    assert.equal(
      (await post(cardUrl(f.url), f.a.token, jsonBytes({ ...card.envelope, proof: forged }))).status,
      422,
    );
    assert.equal((await post(cardUrl(f.url), f.b.token, current.bytes)).status, 403);
    assert.equal(f.evidence('CAPTURED').length, 1);
    const { rows } = await db.fixture.query(
      `SELECT to_json(e) AS body FROM omni.retail_events e WHERE tenant_id=$1
    UNION ALL SELECT to_json(p) AS body FROM omni.payment_provider_events p WHERE tenant_id=$1
    UNION ALL SELECT to_json(o) AS body FROM omni.fiscal_observations o WHERE tenant_id=$1`,
      [f.a.tenantId],
    );
    const output = [
      state,
      error,
      register.child.output,
      hostile.bytes.toString('utf8'),
      current.bytes.toString('utf8'),
      JSON.stringify(rows),
    ];
    output.push(
      card.saleBytes.toString('utf8'),
      ...[card.envelope.capture, card.envelope.proof, card.envelope.grant].map((packet) =>
        bytesOf(packet).toString('utf8'),
      ),
    );
    for (const file of [f.registers[0].path, f.providerPath, f.signerPath]) {
      for (const candidate of [file, file + '-wal'])
        if (existsSync(candidate)) output.push(readFileSync(candidate).toString('latin1'));
    }
    for (const value of Object.values(canaries))
      for (const data of output) {
        assert.ok(
          !data.includes(value) && !data.includes(Buffer.from(value).toString('hex')),
          'Synthetic secret reached a public or durable surface',
        );
      }
    const pool = db.oneConnection();
    try {
      const own = await tenantTransaction(pool, f.a.tenantId, (c) =>
        c.query('SELECT pg_backend_pid() AS pid,state FROM omni.payment_cases'),
      );
      assert.equal(own.rows[0].state, 'APPLIED');
      const other = await tenantTransaction(pool, randomUUID(), (c) =>
        c.query(`SELECT pg_backend_pid() AS pid,
      (SELECT count(*)::int FROM omni.payment_cases) AS n,(SELECT count(*)::int FROM omni.fiscal_observations) AS receipts`),
      );
      assert.deepEqual(other.rows, [{ pid: own.rows[0].pid, n: 0, receipts: 0 }]);
      await assert.rejects(
        tenantTransaction(pool, f.a.tenantId, (c) =>
          c.query('UPDATE omni.payment_provider_events SET digest=digest'),
        ),
        { code: '42501' },
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  'M4-07 forward migration preserves populated v3 receipts, events, digests and original vouchers',
  timeout,
  async (t) => {
    const isolated = await testDatabase();
    try {
      const f = await retailFixture(t, isolated);
      await f.setup();
      const a = f.terminal(0);
      a.connection.importGrant(await f.issue('M1-ITEM', 0), f.keys);
      a.register.openShift(randomUUID(), randomUUID(), 5000);
      a.register.scan('210001');
      const sale = await a.register.checkout(randomUUID(), 300);
      assert.equal(await a.register.syncOnce(), 'SYNCED');
      assert.equal(await a.register.syncOnce(), 'SYNCED');
      const snapshot = () =>
        local(
          a.target.path,
          (db) =>
            db
              .prepare(
                `SELECT e.event_bytes,e.digest,e.ack,e.ack_id,r.printable
      FROM retail_events e JOIN retail_receipts r USING(event_id) WHERE e.event_id=?`,
              )
              .get(sale.eventId)!,
        );
      const original = snapshot();
      const endpoint = new URL('/v3/register', f.url).href;
      const bytes = Buffer.from(original.event_bytes as Uint8Array);
      const voucher = await post(endpoint, f.a.token, bytes);
      assert.equal(voucher.status, 200);
      await stop(f.original);
      a.connection.close();
      removePaymentLocalFixture(a.target.path);
      await removePaymentCloudFixture(isolated);
      assert.equal(
        local(a.target.path, (db) => db.prepare('PRAGMA user_version').get()?.user_version),
        3,
      );
      await isolated.upgrade();
      const upgraded = f.terminal(0);
      assert.equal(
        local(a.target.path, (db) => db.prepare('PRAGMA user_version').get()?.user_version),
        6,
      );
      assert.deepEqual(snapshot(), original);
      assert.equal(upgraded.register.receipt(sale.receiptId)?.printable, sale.printable);
      await f.listen(f.cloud(), Number(new URL(f.url).port));
      const replay = await post(endpoint, f.a.token, bytes);
      assert.deepEqual(replay.bytes, voucher.bytes);
      assert.equal(replay.headers.get('omni-signature'), voucher.headers.get('omni-signature'));
    } finally {
      await isolated.close();
    }
  },
);
