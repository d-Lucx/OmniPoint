import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createCloud } from '../src/cloud.ts';
import { tenantTransaction } from '../src/postgres.ts';
import { digest, jsonBytes, maxEventBytes, parseEvent, printableReceipt, readBounded, signVoucher, verifyVoucher } from '../src/protocol.ts';
import type { Ack, Voucher } from '../src/protocol.ts';
import { bounded, latch, local, scenario, seed, testDatabase } from './fixture.ts';
import type { TestDatabase } from './fixture.ts';

let database: TestDatabase;
before(async () => {
  database = await testDatabase();
  const { rows: [version] } = await database.fixture.query('SHOW server_version');
  console.log(`Node ${process.version} / PostgreSQL ${version.server_version}`);
});
after(async () => { await database?.close(); });

const timeout = { timeout: 35_000 };

function localSnapshot(path: string) {
  return local(path, db => {
    const counts = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    return {
      sales: counts('sales'), receipts: counts('receipts'), lines: counts('sale_lines'),
      movements: db.prepare('SELECT line_id, delta FROM stock_movements').all().map(row => ({ ...row })),
      onHand: Number(db.prepare('SELECT on_hand FROM catalog').get()?.on_hand),
      sequence: Number(db.prepare('SELECT next_sequence FROM terminal').get()?.next_sequence),
      outbox: db.prepare('SELECT * FROM outbox').all().map(row => ({ ...row })),
      attempts: db.prepare('SELECT attempt, result FROM outbox_attempts ORDER BY attempt').all()
        .map(row => ({ ...row })),
      receipt: db.prepare('SELECT receipt_id AS receiptId, sale_id AS saleId, printable FROM receipts').get(),
    };
  });
}

async function cloudSnapshot(tenantId: string) {
  const { rows: [snapshot] } = await database.fixture.query(`
    SELECT
      (SELECT count(*)::int FROM omni.sales WHERE tenant_id = $1) AS sales,
      (SELECT count(*)::int FROM omni.sale_lines WHERE tenant_id = $1) AS lines,
      (SELECT count(*)::int FROM omni.journals WHERE tenant_id = $1) AS journals,
      (SELECT count(*)::int FROM omni.outcomes WHERE tenant_id = $1) AS outcomes,
      (SELECT on_hand FROM omni.stock WHERE tenant_id = $1) AS "onHand",
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('saleId', sale_id, 'receiptId', receipt_id,
         'printable', printable)), '[]') FROM omni.receipts WHERE tenant_id = $1) AS receipts,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('line_id', line_id, 'delta', delta)), '[]')
         FROM omni.stock_movements WHERE tenant_id = $1) AS movements,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('account', account, 'side', side,
         'amount', amount_minor) ORDER BY account), '[]') FROM omni.journal_lines WHERE tenant_id = $1) AS postings
  `, [tenantId]);
  const { rows: vouchers } = await database.fixture.query(`
    SELECT o.ack_id, o.body, v.key_id, v.signature FROM omni.vouchers v
    JOIN omni.outcomes o USING (tenant_id, sale_id) WHERE v.tenant_id = $1
  `, [tenantId]);
  return { ...snapshot, vouchers };
}

function assertOneSale(snapshot: Awaited<ReturnType<typeof cloudSnapshot>>) {
  assert.equal(snapshot.sales, 1);
  assert.equal(snapshot.lines, 1);
  assert.equal(snapshot.journals, 1);
  assert.equal(snapshot.outcomes, 1);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.movements.length, 1);
  assert.equal(snapshot.onHand, 2);
  assert.deepEqual(snapshot.postings, [
    { account: 'Cash', side: 'DR', amount: 2000 }, { account: 'Revenue', side: 'CR', amount: 2000 },
  ]);
}

test('M1-01 committed offline checkout survives terminal death and a lost cloud response', timeout, async t => {
  const f = await scenario(t, database);
  const crashed = f.child();
  const { type, phase } = await crashed.send({ action: 'checkout', input: f.input, pause: 'after-commit' });
  assert.deepEqual({ type, phase }, { type: 'barrier', phase: 'after-commit' });
  const beforeCrash = localSnapshot(f.path);
  assert.equal(beforeCrash.outbox[0].state, 'PENDING');
  const eventBytes = Buffer.from(beforeCrash.outbox[0].event_bytes as Uint8Array);
  const event = parseEvent(eventBytes);
  const receipt = { saleId: event.saleId, receiptId: event.receiptId, printable: printableReceipt(event) };
  assert.deepEqual({ ...beforeCrash.receipt }, receipt);
  assert.match(receipt.printable, /Total USD 20\.00/);
  await crashed.kill();

  const recovered = f.child();
  assert.deepEqual((await recovered.send({ action: 'recover', requestId: f.input.requestId })).value, receipt);
  assert.equal((await cloudSnapshot(f.scope.tenantId)).sales, 0);

  const deliveries: Array<{ bytes: Buffer; digest: string }> = [];
  const replies: Voucher[] = [];
  const durable = latch<Voucher>();
  const drop = latch<void>();
  const droppedOpenResponse = latch<boolean>();
  const url = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer, {
    received: ({ bytes, digest }) => { deliveries.push({ bytes, digest }); },
    async beforeResponse(voucher, response) {
      replies.push(voucher);
      if (replies.length !== 1) return;
      durable.resolve(voucher);
      await bounded(drop.promise, 'response drop release');
      const open = !response.headersSent && response.socket?.destroyed === false;
      response.destroy();
      droppedOpenResponse.resolve(open);
    },
  }));
  const first = recovered.send(f.sync(url));
  void first.catch(() => {});
  let committed: Awaited<ReturnType<typeof cloudSnapshot>>;
  try {
    const voucher = await bounded(durable.promise, 'first durable voucher');
    committed = await cloudSnapshot(f.scope.tenantId);
    assertOneSale(committed);
    assert.deepEqual(committed.receipts, [receipt]);
    assert.deepEqual(committed.movements, [{ line_id: event.line.id, delta: -1 }]);
    assert.equal(committed.vouchers.length, 1);
    assert.deepEqual(committed.vouchers[0].body, voucher.bytes);
    assert.equal(committed.vouchers[0].signature, voucher.signature);
    assert.equal(committed.vouchers[0].key_id, voucher.keyId);
    assert.equal(localSnapshot(f.path).outbox[0].state, 'IN_FLIGHT');
  } finally {
    drop.resolve();
  }
  assert.equal(await bounded(droppedOpenResponse.promise, 'destruction of open response'), true);
  assert.equal((await first).value, 'RETRY_WAIT');
  assert.deepEqual(localSnapshot(f.path).attempts, [{ attempt: 1, result: 'TRANSPORT_ERROR' }]);
  assert.equal((await recovered.send(f.sync(url))).value, 'SYNCED');
  assert.equal(deliveries.length, 2);
  assert.equal(replies.length, 2);
  for (const delivered of deliveries) {
    assert.deepEqual(delivered.bytes, eventBytes);
    assert.equal(delivered.digest, digest(eventBytes));
    assert.equal(delivered.digest, beforeCrash.outbox[0].digest);
  }
  assert.deepEqual(replies[1], replies[0]);
  assert.deepEqual(await cloudSnapshot(f.scope.tenantId), committed);
  await recovered.close();

  const reopened = f.child();
  assert.deepEqual((await reopened.send({ action: 'recover', requestId: f.input.requestId })).value, receipt);
  assert.equal((await reopened.send(f.sync(url))).value, 'IDLE');
  const persisted = localSnapshot(f.path);
  assert.deepEqual([persisted.sales, persisted.receipts, persisted.lines, persisted.onHand, persisted.sequence], [1, 1, 1, 2, 2]);
  assert.deepEqual(persisted.movements, [{ line_id: event.line.id, delta: -1 }]);
  assert.equal(persisted.outbox.length, 1);
  assert.equal(persisted.outbox[0].state, 'SYNCED');
  assert.equal(persisted.outbox[0].ack_id, committed.vouchers[0].ack_id);
  assert.deepEqual(persisted.attempts, [{ attempt: 1, result: 'TRANSPORT_ERROR' }, { attempt: 2, result: 'COMMITTED' }]);
  t.diagnostic(`sale=${event.saleId} receipt=${event.receiptId} sha256=${digest(eventBytes)} SQLite=${local(f.path,
    db => db.prepare('SELECT sqlite_version() AS version').get()?.version)}`);
  t.diagnostic('Outbox PENDING → IN_FLIGHT → RETRY_WAIT → SYNCED; both stocks 3 → 2; Cash DR 2000, Revenue CR 2000');
  await reopened.close();
});


async function checkout(f: Awaited<ReturnType<typeof scenario>>) {
  const child = f.child();
  const message = await child.send({ action: 'checkout', input: f.input });
  assert.equal(message.type, 'result');
  const row = localSnapshot(f.path).outbox[0];
  const bytes = Buffer.from(row.event_bytes as Uint8Array);
  return { child, bytes, event: parseEvent(bytes), receipt: message.value };
}

async function upload(url: string, token: string, bytes: Buffer) {
  const response = await fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: Uint8Array.from(bytes), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

function assertEmptyCloud(snapshot: Awaited<ReturnType<typeof cloudSnapshot>>) {
  assert.deepEqual(snapshot, {
    sales: 0, lines: 0, journals: 0, outcomes: 0, onHand: 3,
    receipts: [], movements: [], postings: [], vouchers: [],
  });
}

test('M1-02 killing before SQLite commit rolls back every checkout effect', timeout, async t => {
  const f = await scenario(t, database);
  const child = f.child();
  const message = await child.send({ action: 'checkout', input: f.input, pause: 'before-commit' });
  assert.equal(message.type, 'barrier');
  assert.equal(message.phase, 'before-commit');
  await child.kill();
  const restarted = f.child();
  assert.equal((await restarted.send({ action: 'recover', requestId: f.input.requestId })).value, undefined);
  assert.deepEqual(localSnapshot(f.path), {
    sales: 0, receipts: 0, lines: 0, movements: [], onHand: 3, sequence: 1,
    outbox: [], attempts: [], receipt: undefined,
  });
  const first = await restarted.send({ action: 'checkout', input: f.input });
  assert.equal(first.type, 'result');
  assert.deepEqual((await restarted.send({ action: 'checkout', input: f.input })).value, first.value);
  const committed = localSnapshot(f.path);
  assert.deepEqual([committed.sales, committed.receipts, committed.lines, committed.movements.length,
    committed.onHand, committed.sequence, committed.outbox.length], [1, 1, 1, 1, 2, 2, 1]);
  assert.equal(parseEvent(committed.outbox[0].event_bytes as Uint8Array).sequence, 1);
});

test('M1-03 a deferred PostgreSQL constraint fails at COMMIT and permits a fresh retry', timeout, async t => {
  const f = await scenario(t, database);
  const { child } = await checkout(f);
  const ddl = `
    CREATE FUNCTION omni.m1_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM omni.stock_movements WHERE tenant_id = NEW.tenant_id)
         OR (SELECT count(*) FROM omni.journal_lines WHERE tenant_id = NEW.tenant_id
             AND sale_id = NEW.sale_id) <> 2
         OR (SELECT on_hand FROM omni.stock WHERE tenant_id = NEW.tenant_id) <> 2
         OR NOT EXISTS (SELECT 1 FROM omni.receipts WHERE tenant_id = NEW.tenant_id AND sale_id = NEW.sale_id)
      THEN RAISE EXCEPTION 'deferred fault fired before all effects existed';
      END IF;
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'm1 deferred commit fault';
    END $$;
    CREATE CONSTRAINT TRIGGER m1_fail_commit AFTER INSERT ON omni.outcomes
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION omni.m1_fail_commit();
  `;
  const remove = () => database.fixture.query(`
    DROP TRIGGER IF EXISTS m1_fail_commit ON omni.outcomes;
    DROP FUNCTION IF EXISTS omni.m1_fail_commit();
  `);
  const failures: unknown[] = [];
  const responses: Voucher[] = [];
  let confirmed = 0;
  const url = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer, {
    failed: error => failures.push(error),
    async saleCommitted() { confirmed++; },
    async beforeResponse(voucher) { responses.push(voucher); },
  }));
  try {
    await database.fixture.query(ddl);
    assert.equal((await child.send(f.sync(url))).value, 'RETRY_WAIT');
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as { code: string }).code, '23514');
    assert.equal((failures[0] as Error).message, 'm1 deferred commit fault');
    assert.equal(confirmed, 0);
    assert.deepEqual(responses, []);
    assertEmptyCloud(await cloudSnapshot(f.scope.tenantId));
  } finally {
    await remove();
  }
  assert.equal((await child.send(f.sync(url))).value, 'SYNCED');
  assert.equal(confirmed, 1);
  assert.equal(responses.length, 1);
  assertOneSale(await cloudSnapshot(f.scope.tenantId));
});

async function waitForBlocked(fragment: string, expected: number) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const { rows: [row] } = await database.fixture.query(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1
    `, [`%${fragment}%`]);
    if (row.count >= expected) return;
    await delay(20);
  }
  assert.fail(`Expected ${expected} blocked PostgreSQL statement(s) matching ${fragment}`);
}

test('M1-04 competing replays and signers converge, while both identity conflicts leave one sale', timeout, async t => {
  const f = await scenario(t, database);
  const { bytes, event } = await checkout(f);
  const alternate = generateKeyPairSync('ed25519');
  const url = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer));
  const alternateId = 'fixture-racing-ed25519';
  const secondUrl = await f.listen(createCloud(database.runtime, [f.enrollment], { id: alternateId, key: alternate.privateKey }));
  const stockLock = await database.fixture.connect();
  const voucherLock = await database.fixture.connect();
  let first!: ReturnType<typeof upload>;
  let second!: ReturnType<typeof upload>;
  try {
    await stockLock.query('BEGIN');
    await voucherLock.query('BEGIN');
    await stockLock.query('SELECT 1 FROM omni.stock WHERE tenant_id = $1 FOR UPDATE', [f.scope.tenantId]);
    await voucherLock.query('LOCK TABLE omni.vouchers IN SHARE MODE');
    first = upload(url, f.enrollment.token, bytes);
    void first.catch(() => {});
    await waitForBlocked('UPDATE omni.stock SET', 1);
    second = upload(secondUrl, f.enrollment.token, bytes);
    void second.catch(() => {});
    await waitForBlocked('INSERT INTO omni.sales', 1);
    await stockLock.query('COMMIT');
    await waitForBlocked('INSERT INTO omni.vouchers', 2);
  } finally {
    try {
      await Promise.all([stockLock.query('ROLLBACK'), voucherLock.query('ROLLBACK')]);
    } finally {
      stockLock.release();
      voucherLock.release();
    }
  }
  const [winner, replay] = await Promise.all([first, second]);
  const keys = new Map([[f.signer.id, f.publicKey], [alternateId, alternate.publicKey]]);
  assert.deepEqual(replay.bytes, winner.bytes);
  assert.equal(replay.headers.get('omni-signature'), winner.headers.get('omni-signature'));
  assert.equal(replay.headers.get('omni-key-id'), winner.headers.get('omni-key-id'));
  for (const response of [winner, replay]) {
    assert.equal(verifyVoucher(response.status, response.bytes, response.headers, keys, event, digest(bytes)).disposition,
      'COMMITTED');
  }

  const changed = Buffer.concat([bytes, Buffer.from('\n')]);
  const sequenceOwner = { ...event, saleId: randomUUID(), receiptId: randomUUID(), line: { ...event.line, id: randomUUID() } };
  for (const [payload, request, disposition] of [
    [changed, event, 'SALE_ID_CONFLICT'],
    [jsonBytes(sequenceOwner), sequenceOwner, 'SEQUENCE_CONFLICT'],
  ] as const) {
    const response = await upload(url, f.enrollment.token, payload);
    assert.equal(response.status, 409);
    assert.equal(verifyVoucher(response.status, response.bytes, response.headers, keys, request, digest(payload)).disposition,
      disposition);
  }
  const snapshot = await cloudSnapshot(f.scope.tenantId);
  assertOneSale(snapshot);
  assert.equal(snapshot.vouchers.length, 1);
  assert.deepEqual(snapshot.vouchers[0].body, winner.bytes);
});

test('M1-05 invalid, mismatched, and forged ACKs leave the outbox actionable', timeout, async t => {
  const f = await scenario(t, database);
  const { child, bytes } = await checkout(f);
  const cloud = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer));
  const original = await upload(cloud, f.enrollment.token, bytes);
  assert.equal(original.status, 200);
  const ack = JSON.parse(original.bytes.toString('utf8')) as Ack;
  const header = (name: string) => {
    const value = original.headers.get(name);
    assert.ok(value);
    return value;
  };
  const canonical: Voucher = {
    status: 200, bytes: original.bytes, keyId: header('omni-key-id'), signature: header('omni-signature'),
  };
  const attacker = generateKeyPairSync('ed25519');
  const invalid = [
    { ...canonical, algorithm: 'rsa-pss' },
    { ...canonical, encoding: 'identity' },
    { ...canonical, keyId: 'unknown-key' },
    { ...canonical, signature: '' },
    signVoucher(200, canonical.bytes, { id: f.signer.id, key: attacker.privateKey }),
    { ...canonical, bytes: Buffer.concat([canonical.bytes, Buffer.from(' ')]) },
    { ...canonical, status: 202 },
    signVoucher(200, jsonBytes({ ...ack, saleId: randomUUID() }), f.signer),
    signVoucher(200, jsonBytes({ ...ack, tenantId: randomUUID() }), f.signer),
    signVoucher(200, jsonBytes({ ...ack, terminalId: randomUUID() }), f.signer),
    signVoucher(200, jsonBytes({ ...ack, generation: 2 }), f.signer),
    signVoucher(200, jsonBytes({ ...ack, sequence: 2 }), f.signer),
    signVoucher(200, jsonBytes({ ...ack, requestDigest: '0'.repeat(64) }), f.signer),
    signVoucher(200, jsonBytes({ ...ack, disposition: 'QUEUED' }), f.signer),
  ];
  const variants: Array<Voucher & { algorithm?: string; encoding?: string }> = [...invalid, canonical];
  const received: Buffer[] = [];
  const url = await f.listen(createServer(async (req, res) => {
    received.push(await readBounded(req, maxEventBytes));
    const variant = variants.shift();
    if (!variant) {
      res.writeHead(500).end();
      return;
    }
    if (variant.encoding) res.setHeader('content-encoding', variant.encoding);
    res.writeHead(variant.status, {
      'omni-algorithm': variant.algorithm ?? 'ed25519',
      'omni-key-id': variant.keyId, 'omni-signature': variant.signature,
    }).end(variant.bytes);
  }));
  for (let i = 0; i < invalid.length; i++) {
    assert.equal((await child.send(f.sync(url))).value, 'RETRY_WAIT', `invalid response ${i}`);
    const { outbox: [row] } = localSnapshot(f.path);
    assert.equal(row.ack_id, null);
    assert.equal(row.attempts, i + 1);
  }
  assert.equal((await child.send(f.sync(url))).value, 'SYNCED');
  const state = localSnapshot(f.path);
  assert.equal(state.outbox[0].ack_id, ack.ackId);
  assert.deepEqual(state.attempts.map(row => row.result), [
    ...invalid.map(() => 'ACK_REJECTED'), 'COMMITTED',
  ]);
  assert.equal(received.length, invalid.length + 1);
  for (const payload of received) assert.deepEqual(payload, bytes);
  assertOneSale(await cloudSnapshot(f.scope.tenantId));
});

test('M1-06 authentication, RLS, and tenant foreign keys hold across pooled backend reuse', timeout, async t => {
  const f = await scenario(t, database);
  const other = await seed(database, f.enrollment);
  const { bytes, event } = await checkout(f);
  const { token: otherToken, ...otherScope } = other;
  const otherEvent = { ...event, ...otherScope, saleId: randomUUID(), receiptId: randomUUID() };
  const otherBytes = jsonBytes(otherEvent);
  const pool = database.oneConnection();
  t.after(() => pool.end());
  const role = await pool.query(`
    SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
      pg_has_role(current_user, nspowner, 'MEMBER') AS owns_schema
    FROM pg_roles JOIN pg_namespace ON nspname = 'omni' WHERE rolname = current_user
  `);
  assert.deepEqual(role.rows, [{
    rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, owns_schema: false,
  }]);
  const url = await f.listen(createCloud(pool, [f.enrollment, other], f.signer));
  assert.equal((await upload(url, 'unknown-development-credential', bytes)).status, 401);
  assert.equal((await upload(url, f.enrollment.token, otherBytes)).status, 403);
  assert.equal((await upload(url, otherToken, bytes)).status, 403);
  assert.equal((await upload(url, f.enrollment.token, jsonBytes({ ...event, storeId: other.storeId }))).status, 403);
  assert.equal((await upload(url, f.enrollment.token, jsonBytes({ ...event, version: 2 }))).status, 400);
  assert.equal((await upload(url, f.enrollment.token, jsonBytes({ ...event, currency: 'EUR' }))).status, 400);
  assert.equal((await upload(url, f.enrollment.token, jsonBytes({ ...event, totalMinor: 1999 }))).status, 400);
  assert.equal((await upload(url, f.enrollment.token, Buffer.alloc(maxEventBytes + 1))).status, 413);
  assertEmptyCloud(await cloudSnapshot(f.scope.tenantId));
  assertEmptyCloud(await cloudSnapshot(other.tenantId));
  assert.equal((await upload(url, f.enrollment.token, bytes)).status, 200);

  const noScope = async () => (await pool.query(`
    SELECT pg_backend_pid() AS pid, nullif(current_setting('omni.tenant_id', true), '') AS context,
      (SELECT count(*)::int FROM omni.sales) AS sales
  `)).rows[0];
  const first = await noScope();
  assert.deepEqual(first, { pid: first.pid, context: null, sales: 0 });
  assert.equal((await upload(url, otherToken, otherBytes)).status, 200);

  for (const [scope, ownSaleId, foreignSaleId, foreignTenant] of [
    [f.scope, event.saleId, otherEvent.saleId, other.tenantId],
    [otherScope, otherEvent.saleId, event.saleId, f.scope.tenantId],
  ] as const) {
    await tenantTransaction(pool, scope.tenantId, async client => {
      const { rows } = await client.query('SELECT pg_backend_pid() AS pid, tenant_id, sale_id FROM omni.sales');
      assert.deepEqual(rows, [{ pid: first.pid, tenant_id: scope.tenantId, sale_id: ownSaleId }]);
      const forbidden = await client.query('UPDATE omni.stock SET on_hand = 0 WHERE tenant_id = $1 RETURNING on_hand',
        [foreignTenant]);
      assert.equal(forbidden.rowCount, 0);
    });
    await assert.rejects(tenantTransaction(pool, scope.tenantId, client => client.query(
      'INSERT INTO omni.receipts VALUES ($1,$2,$3,$4)', [foreignTenant, randomUUID(), foreignSaleId, 'hostile'],
    )), { code: '42501' });
    await assert.rejects(tenantTransaction(pool, scope.tenantId, client => client.query(
      'INSERT INTO omni.receipts VALUES ($1,$2,$3,$4)', [scope.tenantId, randomUUID(), foreignSaleId, 'hostile'],
    )), { code: '23503' });
    assert.deepEqual(await noScope(), first);
  }
  assertOneSale(await cloudSnapshot(f.scope.tenantId));
  assertOneSale(await cloudSnapshot(other.tenantId));
});

test('M1-07 recovery and repeated virtual deliveries preserve one receipt and its content', timeout, async t => {
  const f = await scenario(t, database);
  const { child, receipt } = await checkout(f);
  await child.close();
  const restarted = f.child();
  assert.deepEqual((await restarted.send({ action: 'recover', requestId: f.input.requestId })).value, receipt);
  const before = localSnapshot(f.path);
  for (const deliveries of [[receipt], [receipt, receipt]]) {
    assert.deepEqual((await restarted.send({ action: 'reprint', requestId: f.input.requestId })).value,
      { receipt, deliveries });
  }
  assert.deepEqual(localSnapshot(f.path), before);
  assert.equal(before.receipts, 1);
  assert.equal(before.outbox.length, 1);
});

test('replay completes ACK issuance after interruption between the two commits', timeout, async t => {
  const f = await scenario(t, database);
  const { child } = await checkout(f);
  const first = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer, {
    async saleCommitted() { throw new Error('Interrupted before voucher issuance'); },
  }));
  assert.equal((await child.send(f.sync(first))).value, 'RETRY_WAIT');
  const sale = await cloudSnapshot(f.scope.tenantId);
  assertOneSale(sale);
  assert.deepEqual(sale.vouchers, []);
  const { rows: [outcome] } = await database.fixture.query(
    'SELECT ack_id, body FROM omni.outcomes WHERE tenant_id = $1', [f.scope.tenantId],
  );
  const restarted = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer));
  assert.equal((await child.send(f.sync(restarted))).value, 'SYNCED');
  const final = await cloudSnapshot(f.scope.tenantId);
  assertOneSale(final);
  assert.equal(final.vouchers.length, 1);
  assert.deepEqual(final.vouchers[0].body, outcome.body);
  assert.equal(final.vouchers[0].ack_id, outcome.ack_id);
});

test('a dead sync worker is reclaimed after lease expiry and a signed conflict is held', timeout, async t => {
  const f = await scenario(t, database);
  const { child, bytes } = await checkout(f);
  const winner = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer));
  const changed = Buffer.concat([bytes, Buffer.from(' ')]);
  assert.equal((await upload(winner, f.enrollment.token, changed)).status, 200);

  const observed = latch<Voucher>();
  const release = latch<void>();
  const url = await f.listen(createCloud(database.runtime, [f.enrollment], f.signer, {
    async beforeResponse(voucher, response) {
      observed.resolve(voucher);
      await bounded(release.promise, 'dead worker response release');
      response.destroy();
    },
  }));
  const now = Date.now();
  const abandoned = child.send({ ...f.sync(url), now });
  void abandoned.catch(() => {});
  try {
    assert.equal((await bounded(observed.promise, 'worker HTTP barrier')).status, 409);
    assert.equal(localSnapshot(f.path).outbox[0].state, 'IN_FLIGHT');
    await child.kill();
    await assert.rejects(abandoned, /exited before replying/);
  } finally {
    release.resolve();
  }
  const replacement = f.child();
  assert.equal((await replacement.send({ ...f.sync(winner), now: now + 1 })).value, 'IDLE');
  const expires = Number(localSnapshot(f.path).outbox[0].lease_until);
  assert.equal((await replacement.send({ ...f.sync(winner), now: expires })).value, 'CONFLICT_HELD');
  const snapshot = localSnapshot(f.path);
  assert.deepEqual(snapshot.attempts, [{ attempt: 1, result: 'LEASE_EXPIRED' }, { attempt: 2, result: 'SALE_ID_CONFLICT' }]);
  assert.equal(snapshot.outbox[0].state, 'CONFLICT_HELD');
  await replacement.close();
  const reopened = f.child();
  assert.equal((await reopened.send(f.sync(winner))).value, 'IDLE');
  assertOneSale(await cloudSnapshot(f.scope.tenantId));
});
