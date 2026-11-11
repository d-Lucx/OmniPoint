import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openArtifact } from '../src/authority.ts';
import { createCloud } from '../src/cloud.ts';
import { jsonBytes } from '../src/protocol.ts';
import { createRegisterServer } from '../src/register-server.ts';
import { bounded, local, seed, testDatabase, testResources } from './fixture.ts';
import { post, retailFixture, secret, stop } from './retail-fixture.ts';

test('M5 kitchen foundation resumes scoped tickets across display reload with cloud offline', async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const f = await retailFixture(t, db);
  await db.fixture.query('INSERT INTO omni.capability_profiles VALUES ($1,1,true,true,true)', [f.a.tenantId]);
  const terminal = f.terminal(0);
  const hot = randomBytes(32).toString('base64url');
  const cold = randomBytes(32).toString('base64url');
  const server = createRegisterServer(terminal.register, { drawerId: randomUUID(), cashierSecret: secret,
    kitchen: { [hot]: 'hot', [cold]: 'cold' } });
  const base = new URL('/', await f.listen(server)).href;
  const browser = await chromium.launch({ channel: process.env.OMNI_BROWSER_CHANNEL ??
    (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByLabel('Cashier secret').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Workflows' }).click();
  await page.getByRole('button', { name: 'Refresh capabilities' }).click();
  await page.getByText('Capability profile 1', { exact: false }).waitFor();
  await stop(f.original);
  await page.getByRole('button', { name: 'Refresh capabilities' }).click();
  await page.getByText('Capability profile 1 · Authority OFFLINE', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Seat guests' }).click();
  await page.getByRole('button', { name: 'Dispatch to kitchen' }).click();
  await page.getByText('toast · hot').waitFor();
  await page.getByLabel('Menu item').selectOption('salad');
  await page.getByRole('button', { name: 'Dispatch to kitchen' }).click();
  await page.getByText('salad · cold').waitFor();
  const display = await browser.newPage();
  await display.goto(new URL('/kitchen', base).href);
  const connect = async () => {
    await display.getByLabel('Station token').fill(hot);
    await display.getByRole('button', { name: 'Connect display' }).click();
  };
  await connect();
  await display.getByText('Seat 1 · toast · butter · QUEUED', { exact: false }).waitFor();
  assert.equal(await display.getByText('salad', { exact: false }).count(), 0);
  await display.getByRole('button', { name: 'Ready', exact: true }).click();
  await display.getByText('Seat 1 · toast · butter · READY').waitFor();
  await display.reload();
  await connect();
  await display.getByText('Seat 1 · toast · butter · READY').waitFor();
  assert.equal(await display.getByText('salad', { exact: false }).count(), 0);
  const stationPost = async (token: string, input: object) => fetch(new URL('/api/kitchen', base), {
    method: 'POST', headers: { origin: new URL(base).origin, 'content-type': 'application/json',
      authorization: 'Bearer ' + token }, body: JSON.stringify(input),
  });
  const rows = local(terminal.target.path, db => db.prepare('SELECT aggregate_id, operation_id FROM module_events ORDER BY cursor').all());
  const hostile = await stationPost(hot, { action: 'cancel', id: rows[0].aggregate_id,
    operationId: randomUUID(), revision: 4, ticketId: rows[2].operation_id });
  assert.equal(hostile.status, 409);
  assert.equal((await stationPost(f.a.token, { action: 'feed', cursor: 0 })).status, 401);
  assert.equal(rows.length, 4);
  assert.equal(local(terminal.target.path, db => db.prepare('SELECT count(*) AS n FROM retail_receipts').get()?.n), 0);
  await page.getByLabel('Start (UTC)').fill('2026-12-02T10:00');
  await page.getByRole('button', { name: 'Save appointment draft' }).click();
  await page.getByRole('button', { name: 'Confirm appointment' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Workflows' }).click();
  await page.getByRole('button', { name: 'Confirm appointment' }).waitFor();
  await f.listen(f.cloud(), Number(new URL(f.url).port));
  await page.getByRole('button', { name: 'Confirm appointment' }).click();
  await page.getByText('Appointment confirmed', { exact: true }).waitFor();
});

test('M5 scheduling foundation serializes shared resource, scopes profiles and preserves confirmed replay', async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const f = await testResources(t);
  const a = await seed(db);
  const b = await seed(db);
  await db.fixture.query('INSERT INTO omni.capability_profiles VALUES ($1,1,true,true,true)', [a.tenantId]);
  const url = new URL('/v5/modules', await f.listen(createCloud(db.runtime, [a, b], f.signer))).href;
  const keys = new Map([[f.signer.id, f.publicKey]]);
  const call = (token: string, input: object) => post(url, token, jsonBytes(input));
  const profile = await call(b.token, { action: 'profile' });
  assert.equal(openArtifact('module-v5', profile.json(), keys).data.profile &&
    (openArtifact('module-v5', profile.json(), keys).data.profile as { version: number }).version, 0);
  const input = { action: 'book', id: randomUUID(), version: 1, staff: 'alex', resource: 'bay',
    start: '2026-12-02T10:00:00.000Z', minutes: 30, timezone: 'UTC' };
  const other = { ...input, id: randomUUID(), staff: 'sam' };
  const responses = await Promise.all([call(a.token, input), call(a.token, other)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const winner = responses[0].status === 200 ? input : other;
  assert.equal((await call(b.token, winner)).status, 403);
  assert.equal((await call(a.token, { ...input, id: randomUUID(), start: '2026-12-02T10:30:00.000Z' })).status, 200);
  await db.fixture.query('INSERT INTO omni.capability_profiles VALUES ($1,2,true,false,false)', [a.tenantId]);
  const replay = await call(a.token, winner);
  assert.deepEqual(replay.bytes, responses.find(r => r.status === 200)?.bytes);
  assert.equal((await call(a.token, { ...input, id: randomUUID(), start: '2026-12-02T11:30:00.000Z' })).status, 403);
  assert.equal((await db.runtime.query('SELECT * FROM omni.service_appointments')).rowCount, 0);
  assert.equal((await db.fixture.query('SELECT * FROM omni.service_appointments')).rowCount, 2);
});
test('M5 admission foundation rejects excess background work while live and replay requests progress', async t => {
  const db = await testDatabase();
  t.after(() => db.close());
  const f = await testResources(t);
  const a = await seed(db);
  const b = await seed(db);
  const url = await f.listen(createCloud(db.runtime, [a, b], f.signer));
  const modules = new URL('/v5/modules', url).href;
  const aLocal = f.register(a);
  const bLocal = f.register(b);
  const original = aLocal.child();
  const live = bLocal.child();
  assert.ok((await original.send({ action: 'checkout', input: aLocal.input })).value);
  assert.ok((await live.send({ action: 'checkout', input: bLocal.input })).value);
  const bytes = (path: string) => local(path, db =>
    Buffer.from(db.prepare('SELECT event_bytes FROM outbox').get()?.event_bytes as Uint8Array));
  const previous = await post(url, a.token, bytes(aLocal.path));
  assert.equal(previous.status, 200);
  const lock = await db.fixture.connect();
  await lock.query('BEGIN');
  await lock.query('LOCK TABLE omni.capability_profiles IN ACCESS EXCLUSIVE MODE');
  const held = post(modules, a.token, jsonBytes({ action: 'profile' }));
  try {
    await bounded((async () => {
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        const waiting = await db.fixture.query("SELECT 1 FROM pg_locks WHERE relation='omni.capability_profiles'::regclass AND NOT granted");
        if (waiting.rowCount) return;
      }
      assert.fail('No background PostgreSQL lock waiter');
    })(), 'tenant A PostgreSQL lock waiter');
    const start = performance.now();
    const excess = await post(modules, a.token, jsonBytes({ action: 'profile' }));
    assert.equal(excess.status, 429);
    assert.equal(excess.headers.get('retry-after'), '1');
    const [sale, replay] = await Promise.all([
      post(url, b.token, bytes(bLocal.path)), post(url, a.token, bytes(aLocal.path)),
    ]);
    assert.equal(sale.status, 200);
    assert.deepEqual(replay.bytes, previous.bytes);
    assert.equal(replay.headers.get('omni-signature'), previous.headers.get('omni-signature'));
    t.diagnostic('one blocked background connection, one 429, tenant B live and tenant A replay finished in ' +
      Math.round(performance.now() - start) + ' ms');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    assert.equal((await held).status, 200);
  }
  assert.equal((await db.fixture.query('SELECT * FROM omni.sales')).rowCount, 2);
});
