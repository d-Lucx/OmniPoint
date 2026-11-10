import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { createCloud } from '../src/cloud.ts';
import { parseGrant, signEvidence } from '../src/inventory-protocol.ts';
import type { Position } from '../src/inventory-protocol.ts';
import { digest, jsonBytes } from '../src/protocol.ts';
import type { SignedEvidence } from '../src/protocol.ts';
import { SimulatedDevices } from '../src/retail-devices.ts';
import type { Catalog } from '../src/retail-money.ts';
import { parseRetail } from '../src/retail-protocol.ts';
import { Terminal } from '../src/terminal.ts';
import type { PaymentTrust } from '../src/payment-cloud.ts';
import type { PaymentOptions } from '../src/payment-local.ts';
import type { Scope } from '../src/protocol.ts';
import { local, seed, testResources } from './fixture.ts';
import type { TestDatabase } from './fixture.ts';

export const catalog: Catalog = { version: 1, taxVersion: 1, variants: [
  { sku: 'M1-ITEM', parentId: 'MUG', label: 'Blue mug', barcode: '210001', unitMinor: 210, taxBps: 500, taxMode: 'EXCLUSIVE' },
  { sku: 'M3-RED', parentId: 'MUG', label: 'Red mug', barcode: '210002', unitMinor: 1100, taxBps: 1000, taxMode: 'INCLUSIVE' },
  { sku: 'M3-TEA', parentId: 'TEA', label: 'Tea bag', barcode: '210003', unitMinor: 300, taxBps: 0, taxMode: 'EXCLUSIVE' },
] };
export const pin = 'fixture-supervisor-pin';
export const secret = 'fixture-cashier-secret';

export async function post(url: string, token: string, body: Buffer) {
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: Uint8Array.from(body) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, headers: response.headers,
    json: () => bytes.length ? JSON.parse(bytes.toString('utf8')) : null };
}
export function retailUrl(base: string) { return new URL('/v3/register', base).href; }
export function grants(packet: SignedEvidence) { return parseGrant(Buffer.from(packet.body, 'base64url')); }

export async function stop(server: ReturnType<typeof createCloud>) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function retailFixture(t: TestContext, db: TestDatabase, counts = [3, 3, 3], payments?: (scope:Scope)=>PaymentTrust) {
  const resources = await testResources(t);
  const a = await seed(db);
  const b = { ...a, terminalId: randomUUID(), token: randomBytes(32).toString('base64url') };
  await db.fixture.query('INSERT INTO omni.terminals VALUES ($1,$2,$3,$4)', [b.tenantId, b.storeId, b.terminalId, b.generation]);
  await db.fixture.query('UPDATE omni.stock SET on_hand=$2 WHERE tenant_id=$1', [a.tenantId, counts[0]]);
  for (const [i, item] of catalog.variants.entries()) {
    if (i) await db.fixture.query('INSERT INTO omni.stock VALUES ($1,$2,$3,$4)', [a.tenantId, a.storeId, item.sku, counts[i]]);
  }
  const registers = [resources.register(a), resources.register(b)] as const;
  const positions: Position[] = catalog.variants.map(item => ({ sku: item.sku, positionId: randomUUID(), locationId: randomUUID() }));
  const supervisor = generateKeyPairSync('ed25519');
  const actorId = randomUUID();
  const operatorToken = randomBytes(32).toString('base64url');
  const custody = generateKeyPairSync('ed25519');
  const custodySigner = { id: 'retail-custody', key: custody.privateKey };
  const custodyKeys = new Map([[custodySigner.id, custody.publicKey]]);
  const keys = new Map([[resources.signer.id, resources.publicKey]]);
  const opts = {
    operators: [{ tenantId: a.tenantId, token: operatorToken, actorId }],
    supervisors: [{ tenantId: a.tenantId, storeId: a.storeId, actorId, publicKey: supervisor.publicKey }],
    custodyKeys,
    payments:payments?.(registers[0].scope),
  };
  const cloud = (observers?: Parameters<typeof createCloud>[3]) => createCloud(db.runtime, [a, b], resources.signer, observers, opts);
  const original = cloud();
  const url = await resources.listen(original);
  const op = async (input: object, expected = 200) => {
    const result = await post(new URL('/v2/inventory', url).href, operatorToken, jsonBytes(input));
    assert.equal(result.status, expected, JSON.stringify(input));
    return result.json();
  };
  const issue = async (sku: string, index: 0 | 1, quantity = 1, extra: object = {}) => {
    const register = registers[index];
    const position = positions.find(p => p.sku === sku)!;
    return await op({ action: 'issue', positionId: position.positionId, terminalId: register.scope.terminalId,
      generation: register.scope.generation, grantId: randomUUID(), quantity,
      expiresAt: new Date(Date.now() + 60_000 * 10).toISOString(), ...extra }) as SignedEvidence;
  };
  const overlap = async (packet: SignedEvidence) => {
    const grant = { ...grants(packet), grantId: randomUUID(), terminalId: b.terminalId };
    const signed = signEvidence(grant, resources.signer);
    // Historical overlap fixture. Normal issuance never maps two grants to this canonical slice.
    await db.fixture.query(`
      INSERT INTO omni.quota_grants(tenant_id,grant_id,position_id,store_id,terminal_id,generation,body,key_id,signature)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [b.tenantId, grant.grantId, grant.positionId, b.storeId, b.terminalId, b.generation,
      Buffer.from(signed.body, 'base64url'), signed.keyId, signed.signature]);
    await db.fixture.query('INSERT INTO omni.quota_grant_units VALUES ($1,$2,$3,$4)',
      [b.tenantId, grant.positionId, grant.grantId, grant.slices[0]]);
    return signed;
  };
  const installed = new Set<number>();
  const terminal = (index: 0 | 1, devices = new SimulatedDevices(), payment?:PaymentOptions) => {
    const target = registers[index];
    const connection = new Terminal(target.path);
    resources.dispose(() => { try { connection.close(); } catch {} });
    const register = connection.retail({ supervisor: { pin, actorId, signer: { id: 'fixture-supervisor', key: supervisor.privateKey } },
      devices, payment, deviceTimeoutMs: 20, cloud: { url, token: target.enrollment.token, keys } });
    if (!installed.has(index)) { register.installCatalog(catalog, positions); installed.add(index); }
    return { connection, register, target, devices };
  };
  const setup = async () => {
    await op({ action: 'retail-catalog', storeId: a.storeId, catalog });
    for (const position of positions) {
      await op({ action: 'open-position', storeId: a.storeId, legacyDrained: true, ...position });
      await op({ action: 'retail-enable', positionId: position.positionId, legacyDrained: true });
    }
  };
  const child = (index: 0 | 1, captureOutput=false) => resources.spawn(registers[index].path, 'retail-child.ts',captureOutput);
  const serve = (index: 0 | 1) => ({
    action: 'serve', port: 0, drawerId: randomUUID(), secret, pin, actorId,
    supervisorPem: supervisor.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cloudUrl: url, token: registers[index].enrollment.token, keyId: resources.signer.id, publicPem: resources.publicPem,
  });
  return { ...resources, a, b, opts, original, url, op, issue, overlap, terminal, setup, positions,
    keys, custodySigner, custodyKeys, cloud, actorId, supervisor, child, serve, registers, operatorToken };
}

export function saved(path: string, id?: string) {
  return local(path, db => {
    const row = id ? db.prepare('SELECT * FROM retail_events WHERE event_id=?').get(id) :
      db.prepare('SELECT * FROM retail_events ORDER BY rowid DESC LIMIT 1').get();
    assert.ok(row);
    const bytes = Buffer.from(row.event_bytes as Uint8Array);
    assert.equal(row.digest, digest(bytes));
    return { row, bytes, event: parseRetail(bytes) };
  });
}

export function removeRetailLocalFixture(path: string) {
  removePaymentLocalFixture(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`BEGIN; DROP TABLE retail_refunds; DROP TABLE retail_devices; DROP TABLE retail_closes;
      DROP TABLE retail_spends; DROP TABLE retail_cash; DROP TABLE retail_receipts; DROP TABLE retail_attempts;
      DROP TABLE retail_events; DROP TABLE retail_cart_lines; DROP TABLE retail_shifts;
      DROP TABLE retail_positions; DROP TABLE retail_catalogs; PRAGMA user_version=2; COMMIT;`);
  } finally { db.close(); }
}

export async function removeRetailCloudFixture(db: TestDatabase) {
  await removePaymentCloudFixture(db);
  await db.fixture.query(`
    DROP VIEW omni.quota_inventory;
    ALTER VIEW omni.quota_inventory_v2 RENAME TO quota_inventory;
    DROP TABLE omni.retail_count_decisions,omni.retail_counts,omni.retail_stock_changes,omni.retail_refunds,
      omni.retail_closes,omni.retail_postings,omni.retail_cash,omni.retail_shortfalls,omni.retail_allocations,
      omni.retail_lines,omni.retail_receipts,omni.retail_vouchers,omni.retail_events,omni.retail_shifts,
      omni.retail_positions,omni.retail_catalogs;
    DELETE FROM omni.migrations WHERE version=3;
  `);
}

export function removePaymentLocalFixture(path:string) {
  const db=new DatabaseSync(path);
  try {
    db.exec(`BEGIN; DROP TABLE fiscal_local_receipts; DROP TABLE payment_incidents; DROP TABLE payment_evidence;
      DROP TABLE payment_attempts; DROP TABLE payment_intents; PRAGMA user_version=3; COMMIT;`);
  } finally { db.close(); }
}

export async function removePaymentCloudFixture(db:TestDatabase) {
  await db.fixture.query(`DROP TABLE omni.fiscal_observations,omni.fiscal_grants,omni.fiscal_epochs,
    omni.payment_postings,omni.payment_provider_events,omni.payment_cases;
    DELETE FROM omni.migrations WHERE version=4;`);
}
