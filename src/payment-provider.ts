import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { signArtifact } from './authority.ts';
import { fixtureRequest, fixtureServer } from './fixture-http.ts';
import { parseOperation, providerFact, providerPurpose, sameOperation, sameRoute } from './payment-protocol.ts';
import type { Operation, PaymentRoute, ProviderFact, ProviderState } from './payment-protocol.ts';
import type { SigningKey, SignedEvidence } from './protocol.ts';
import type { KeyObject } from 'node:crypto';

export interface PaymentAdapter {
  route: PaymentRoute;
  idempotencyMs: number;
  execute(operation: Operation): Promise<SignedEvidence>;
  status(operation: Operation): Promise<SignedEvidence>;
  verify(packet: unknown): ReturnType<typeof providerFact>;
}
export function providerAdapter(config: {
  url: string;
  token: string;
  route: PaymentRoute;
  keys: ReadonlyMap<string, KeyObject>;
  idempotencyMs: number;
}): PaymentAdapter {
  function verify(packet: unknown) {
    const result = providerFact(packet, config.keys);
    if ((packet as SignedEvidence).keyId !== config.route.providerId)
      throw new Error('Provider signing identity rejected');
    return result;
  }
  async function request(path: string, operation: Operation) {
    const packet = await fixtureRequest(config, path, operation);
    const { fact } = verify(packet);
    if (!sameOperation(fact.operation, operation)) throw new Error('Provider evidence binding rejected');
    return packet as SignedEvidence;
  }
  return {
    route: config.route,
    idempotencyMs: config.idempotencyMs,
    execute: (op) => request('/execute', op),
    status: (op) => request('/status', op),
    verify,
  };
}

export function createSimulatedProvider(
  path: string,
  token: string,
  routes: readonly PaymentRoute[],
  signer: SigningKey,
  options: {
    idempotencyMs: number;
    hideStatus?: () => boolean;
    outcome?: (operation: Operation) => 'CAPTURED' | 'DECLINED' | 'NOT_EXECUTED';
    after?: Parameters<typeof fixtureServer>[2];
  },
) {
  if (!routes.length || routes.some((route) => route.providerId !== signer.id))
    throw new Error('Provider signing enrollment rejected');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS provider_events(event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, state TEXT NOT NULL,
      operation TEXT NOT NULL, packet TEXT NOT NULL, occurred_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS provider_attempt ON provider_events(attempt_id, state);
    CREATE UNIQUE INDEX IF NOT EXISTS provider_effect ON provider_events(attempt_id,state);
  `);
  function make(op: Operation, state: ProviderState, reference: string | null): ProviderFact {
    return { operation: op, eventId: randomUUID(), state, reference, occurredAt: new Date().toISOString() };
  }
  function save(f: ProviderFact) {
    const packet = signArtifact(providerPurpose, f, signer);
    db.prepare('INSERT INTO provider_events VALUES(?,?,?,?,?,?)').run(
      f.eventId,
      f.operation.attemptId,
      f.state,
      JSON.stringify(f.operation),
      JSON.stringify(packet),
      f.occurredAt,
    );
    return packet;
  }
  const server = fixtureServer(
    token,
    (route, input) => {
      const op = parseOperation(input);
      if (!routes.some((entry) => sameRoute(entry, op))) throw new Error('Unenrolled provider route');
      const load = () =>
        db
          .prepare('SELECT * FROM provider_events WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1')
          .get(op.attemptId);
      if (route === '/status') {
        const last = load();
        if (!last || options.hideStatus?.())
          return signArtifact(providerPurpose, make(op, 'UNKNOWN', null), signer);
        if (!sameOperation(JSON.parse(String(last.operation)), op))
          throw new Error('Payment operation conflict');
        if (last.state === 'SETTLED') {
          const capture = db
            .prepare("SELECT packet FROM provider_events WHERE attempt_id=? AND state='CAPTURED'")
            .get(op.attemptId)!;
          return JSON.parse(String(capture.packet));
        }
        return JSON.parse(String(last.packet));
      }
      if (route !== '/execute') throw new Error('Unsupported provider operation');
      db.exec('BEGIN IMMEDIATE');
      try {
        const last = load();
        if (last) {
          if (
            !sameOperation(JSON.parse(String(last.operation)), op) ||
            options.idempotencyMs <= 0 ||
            Date.now() - Date.parse(op.preparedAt) > options.idempotencyMs
          )
            throw new Error('Attempt replay rejected');
          db.exec('COMMIT');
          return JSON.parse(String(last.packet));
        }
        let packet: SignedEvidence;
        if (op.kind === 'CAPTURE') {
          const state = options.outcome?.(op) ?? 'CAPTURED';
          const reference = state === 'CAPTURED' ? randomUUID() : null;
          if (reference) save(make(op, 'AUTHORIZED', reference));
          packet = save(make(op, state, reference));
        } else {
          const capture = db
            .prepare("SELECT operation FROM provider_events WHERE attempt_id=? AND state='CAPTURED'")
            .get(op.originalAttemptId);
          const original = capture && parseOperation(JSON.parse(String(capture.operation)));
          if (
            !original ||
            !sameRoute(original, op) ||
            original.intentId !== op.intentId ||
            original.basketDigest !== op.basketDigest ||
            original.amountMinor !== op.amountMinor ||
            db
              .prepare(
                "SELECT 1 FROM provider_events WHERE state='REFUNDED' AND json_extract(operation,'$.originalAttemptId')=?",
              )
              .get(op.originalAttemptId)
          ) {
            throw new Error('Refund lineage rejected');
          }
          packet = save(make(op, 'REFUNDED', randomUUID()));
        }
        db.exec('COMMIT');
        return packet;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    options.after,
  );
  return {
    server,
    close: () => db.close(),
    mark(attemptId: string, state: 'SETTLED' | 'REVERSED') {
      const captured = db
        .prepare("SELECT packet FROM provider_events WHERE attempt_id=? AND state='CAPTURED'")
        .get(attemptId);
      if (!captured) throw new Error('Capture required');
      const original = JSON.parse(
        Buffer.from((JSON.parse(String(captured.packet)) as SignedEvidence).body, 'base64url').toString('utf8'),
      ) as ProviderFact;
      const prior = db
        .prepare('SELECT packet FROM provider_events WHERE attempt_id=? AND state=?')
        .get(attemptId, state);
      return prior
        ? (JSON.parse(String(prior.packet)) as SignedEvidence)
        : save(make(original.operation, state, original.reference));
    },
  };
}
