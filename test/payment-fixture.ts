import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ServerResponse } from 'node:http';
import { signArtifact } from '../src/authority.ts';
import { fiscalPurpose } from '../src/fiscal-protocol.ts';
import type { Epoch } from '../src/fiscal-protocol.ts';
import { createDurableSigner, fiscalAdapter } from '../src/fiscal-signer.ts';
import { createSimulatedProvider, providerAdapter } from '../src/payment-provider.ts';
import type { Operation, PaymentRoute } from '../src/payment-protocol.ts';
import type { SignedEvidence } from '../src/protocol.ts';
import { jsonBytes } from '../src/protocol.ts';
import { SimulatedDevices } from '../src/retail-devices.ts';
import { local } from './fixture.ts';
import type { TestDatabase } from './fixture.ts';
import { retailFixture, stop } from './retail-fixture.ts';

export async function paymentFixture(t: TestContext, db: TestDatabase, idempotencyMs = 30_000) {
  const authority = generateKeyPairSync('ed25519');
  const root = { id: 'fixture-authority', key: authority.privateKey };
  const roots = new Map([[root.id, authority.publicKey]]);
  const provider = generateKeyPairSync('ed25519');
  const providerSigning = { id: 'fixture-provider', key: provider.privateKey };
  const providerKeys = new Map([[providerSigning.id, provider.publicKey]]);
  let route!: PaymentRoute;
  const f = await retailFixture(t, db, [3, 3, 3], (scope) => {
    route = {
      ...scope,
      providerId: 'fixture-provider',
      merchantId: 'fixture-merchant',
      readerId: 'fixture-reader',
    };
    return { routes: [route], providerKeys, fiscalRoots: roots };
  });
  await f.setup();
  const { providerId: _, merchantId: __, readerId: ___, ...scope } = route;
  const makeEpoch = (previousEpochId: string | null = null) => {
    const keys = generateKeyPairSync('ed25519');
    const epoch: Epoch = { ...scope, deviceId: randomUUID(), epochId: randomUUID(), series: 'FixtureSeries' };
    return {
      epoch,
      signer: { id: epoch.deviceId, key: keys.privateKey },
      publicKey: keys.publicKey,
      enrollment: signArtifact(
        fiscalPurpose.enrollment,
        { ...epoch, publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') },
        root,
      ),
      genesis: signArtifact(fiscalPurpose.genesis, { ...epoch, previousEpochId }, root),
    };
  };
  let device = makeEpoch();
  await f.op({ action: 'fiscal-enroll', enrollment: device.enrollment, genesis: device.genesis });
  const providerPath = join(f.dir, 'provider.sqlite');
  const signerPath = join(f.dir, 'fiscal.sqlite');
  const providerToken = 'fixture-provider-secret-' + randomUUID();
  const signerToken = 'fixture-fiscal-secret-' + randomUUID();
  type Observer = (path: string, result: unknown, response: ServerResponse) => Promise<void> | void;
  let providerAfter: Observer | undefined;
  let signerAfter: Observer | undefined;
  let blind = false;
  let decision: ((op: Operation) => 'CAPTURED' | 'DECLINED' | 'NOT_EXECUTED') | undefined;
  let clock: { lower: string; upper: string } | null = null;
  const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
  clock = { lower: iso(), upper: iso() };
  const makeGrant = (
    start = 1,
    end = 8,
    issuedAt = iso(-60_000),
    expiresAt = iso(600_000),
    epoch = device.epoch,
  ) =>
    signArtifact(
      fiscalPurpose.grant,
      { ...epoch, grantId: randomUUID(), start, end, issuedAt, expiresAt },
      root,
    );
  let grant: SignedEvidence | null = makeGrant();
  const makeProvider = () =>
    createSimulatedProvider(providerPath, providerToken, [route], providerSigning, {
      idempotencyMs,
      hideStatus: () => blind,
      outcome: (op) => decision?.(op) ?? 'CAPTURED',
      after: (...args) => providerAfter?.(...args),
    });
  const makeSigner = () =>
    createDurableSigner(signerPath, signerToken, {
      ...device,
      roots,
      clock: () => clock,
      after: (...args) => signerAfter?.(...args),
    });
  let providerService = makeProvider();
  let signerService = makeSigner();
  const providerUrl = await f.listen(providerService.server);
  const signerUrl = await f.listen(signerService.server);
  f.dispose(() => {
    providerService.close();
    signerService.close();
  });
  const adapter = providerAdapter({
    url: providerUrl,
    token: providerToken,
    route,
    keys: providerKeys,
    idempotencyMs,
  });
  const fiscal = () =>
    fiscalAdapter({
      url: signerUrl,
      token: signerToken,
      enrollment: device.enrollment,
      roots,
      grant: () => grant,
    });
  const terminal = (devices = new SimulatedDevices()) => f.terminal(0, devices, { adapter, fiscal: fiscal() });
  const cash = terminal();
  cash.connection.importGrant(await f.issue('M1-ITEM', 0, 3), f.keys);
  const shiftId = randomUUID();
  cash.register.openShift(shiftId, randomUUID(), 5000);
  cash.register.scan('210001');
  cash.connection.close();
  const paymentOptions = () => ({ adapter, fiscal: fiscal() });
  const serve = () => ({
    ...f.serve(0),
    payment: {
      provider: {
        url: providerUrl,
        token: providerToken,
        route,
        keyId: providerSigning.id,
        publicPem: provider.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        idempotencyMs,
      },
      signer: {
        url: signerUrl,
        token: signerToken,
        enrollment: device.enrollment,
        rootId: root.id,
        rootPem: authority.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        grant,
      },
    },
  });
  const cardBytes = (id: string) =>
    local(f.registers[0].path, (db) => {
      const row = db
        .prepare('SELECT event_bytes,digest,state,ack_id FROM retail_events WHERE event_id=?')
        .get(id);
      assert.ok(row);
      return {
        state: row.state,
        ack_id: row.ack_id,
        digest: row.digest,
        bytes: Buffer.from(row.event_bytes as Uint8Array),
      };
    });
  const evidence = (state: string) =>
    local(providerPath, (db) =>
      db
        .prepare('SELECT packet FROM provider_events WHERE state=? ORDER BY rowid')
        .all(state)
        .map((row) => JSON.parse(String(row.packet)) as SignedEvidence),
    );
  const pay = (id?: string) =>
    local(f.registers[0].path, (db) =>
      db
        .prepare(
          id
            ? 'SELECT * FROM payment_intents WHERE intent_id=?'
            : 'SELECT * FROM payment_intents ORDER BY rowid DESC LIMIT 1',
        )
        .get(...(id ? [id] : [])),
    );
  return {
    ...f,
    route,
    roots,
    root,
    providerSigning,
    providerKeys,
    providerPath,
    signerPath,
    providerUrl,
    providerToken,
    signerUrl,
    signerToken,
    shiftId,
    terminal,
    paymentOptions,
    serve,
    cardBytes,
    evidence,
    pay,
    makeEpoch,
    makeGrant,
    get device() {
      return device;
    },
    get grant() {
      return grant;
    },
    setGrant: (value: SignedEvidence | null) => {
      grant = value;
    },
    setClock: (value: typeof clock) => {
      clock = value;
    },
    setBlind: (value: boolean) => {
      blind = value;
    },
    setDecision: (value: typeof decision) => {
      decision = value;
    },
    providerMark: (attemptId: string, state: 'SETTLED' | 'REVERSED') => providerService.mark(attemptId, state),
    providerAfter: (fn: Observer) => {
      providerAfter = fn;
    },
    signerAfter: (fn: Observer) => {
      signerAfter = fn;
    },
    async restartProvider() {
      await stop(providerService.server);
      providerService.close();
      providerService = makeProvider();
      await f.listen(providerService.server, Number(new URL(providerUrl).port));
    },
    async replaceSigner(next: typeof device) {
      await stop(signerService.server);
      signerService.close();
      device = next;
      signerService = makeSigner();
      await f.listen(signerService.server, Number(new URL(signerUrl).port));
    },
  };
}

export function cardUrl(base: string) {
  return new URL('/v4/register', base).href;
}
export const bytesOf = (packet: SignedEvidence) => Buffer.from(packet.body, 'base64url');
export const packetData = (packet: SignedEvidence) => JSON.parse(bytesOf(packet).toString('utf8'));
export const signedBody = (packet: SignedEvidence) => jsonBytes(packet);
