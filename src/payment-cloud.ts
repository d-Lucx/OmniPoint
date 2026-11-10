import type { KeyObject } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { exact, openArtifact } from './authority.ts';
import { deviceKey, fiscalPurpose, readEnrollment, readIntent, sameEpoch } from './fiscal-protocol.ts';
import { parseOperation, paymentReason, providerFact, sameRoute } from './payment-protocol.ts';
import type { Operation, PaymentRoute } from './payment-protocol.ts';
import { tenantTransaction } from './postgres.ts';
import { digest, isUuid, jsonBytes, sameScope } from './protocol.ts';
import type { Scope, SignedEvidence } from './protocol.ts';
import { InventoryError } from './quota-cloud.ts';
import type { RetailSale, Supervisor } from './retail-protocol.ts';
import { requireApproval } from './retail-returns-cloud.ts';

export interface PaymentTrust {
  routes: readonly PaymentRoute[];
  providerKeys: ReadonlyMap<string, KeyObject>;
  fiscalRoots: ReadonlyMap<string, KeyObject>;
}
type Case = {
  capture_attempt: string;
  amount_minor: number;
  basket_digest: string;
  state: string;
  refund_attempt: string | null;
  refund_reservation: Buffer | null;
  sale_id: string | null;
};
type Evidence = ReturnType<typeof providerFact>;

export async function inspectPayment(pool: Pool, tenantId: string, input: Record<string, unknown>) {
  const { intentId } = input;
  if (!isUuid(intentId)) throw new InventoryError('INVALID_PAYMENT_INTENT', 400);
  return tenantTransaction(pool, tenantId, async (db) => {
    const {
      rows: [result],
    } = await db.query(
      `SELECT intent_id,state,amount_minor,capture_attempt,refund_attempt,sale_id
      FROM omni.payment_cases WHERE tenant_id=$1 AND intent_id=$2`,
      [tenantId, intentId],
    );
    if (!result) throw new InventoryError('PAYMENT_CASE_UNKNOWN', 404);
    return result;
  });
}

export function verifiedPayment(scope: Scope, packet: unknown, trust: PaymentTrust) {
  try {
    const result = providerFact(packet, trust.providerKeys);
    if (
      (packet as SignedEvidence).keyId !== result.fact.operation.providerId ||
      !sameScope(scope, result.fact.operation) ||
      !trust.routes.some((route) => sameRoute(route, result.fact.operation))
    ) {
      throw new Error('Provider scope rejected');
    }
    return result;
  } catch {
    throw new InventoryError('PAYMENT_EVIDENCE_REJECTED', 422);
  }
}

async function posting(
  db: PoolClient,
  op: Operation,
  effect: string,
  entries: readonly (readonly [string, number])[],
) {
  for (const [account, amount] of entries)
    if (amount !== 0)
      await db.query('INSERT INTO omni.payment_postings VALUES($1,$2,$3,$4,$5)', [
        op.tenantId,
        op.intentId,
        effect,
        account,
        amount,
      ]);
}

async function storeEvidence(db: PoolClient, evidence: Evidence, packet: unknown) {
  const { operation: op, eventId, state } = evidence.fact;
  const hash = digest(evidence.bytes);
  await db.query(
    `INSERT INTO omni.payment_provider_events VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(tenant_id,event_id) DO NOTHING`,
    [op.tenantId, eventId, op.intentId, op.attemptId, state, hash, evidence.bytes, JSON.stringify(packet)],
  );
  const {
    rows: [prior],
  } = await db.query<{ digest: string }>(
    'SELECT digest FROM omni.payment_provider_events WHERE tenant_id=$1 AND event_id=$2',
    [op.tenantId, eventId],
  );
  if (prior.digest !== hash) throw new InventoryError('PROVIDER_EVENT_CONFLICT', 409);
}

export async function captured(db: PoolClient, proof: Evidence, packet: unknown): Promise<Case> {
  const { operation: op, state } = proof.fact;
  if (op.kind !== 'CAPTURE' || state !== 'CAPTURED') throw new InventoryError('CAPTURE_REQUIRED', 422);
  const fresh = await db.query(
    `INSERT INTO omni.payment_cases
    (tenant_id,intent_id,store_id,terminal_id,generation,capture_attempt,amount_minor,basket_digest,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CAPTURED') ON CONFLICT(tenant_id,intent_id) DO NOTHING RETURNING intent_id`,
    [
      op.tenantId,
      op.intentId,
      op.storeId,
      op.terminalId,
      op.generation,
      op.attemptId,
      op.amountMinor,
      op.basketDigest,
    ],
  );
  const {
    rows: [prior],
  } = await db.query<Case>(
    'SELECT * FROM omni.payment_cases WHERE tenant_id=$1 AND intent_id=$2 FOR NO KEY UPDATE',
    [op.tenantId, op.intentId],
  );
  if (
    prior.capture_attempt !== op.attemptId ||
    prior.amount_minor !== op.amountMinor ||
    prior.basket_digest !== op.basketDigest
  ) {
    throw new InventoryError('CAPTURE_CASE_CONFLICT', 409);
  }
  await storeEvidence(db, proof, packet);
  if (fresh.rowCount)
    await posting(db, op, 'CAPTURE', [
      ['CardClearing', op.amountMinor],
      ['CapturedFunds', -op.amountMinor],
    ]);
  return prior;
}

export async function applyPayment(db: PoolClient, proof: Evidence, sale: RetailSale) {
  const op = proof.fact.operation;
  const claimed = await db.query(
    `UPDATE omni.payment_cases SET state='APPLIED',sale_id=$2
    WHERE tenant_id=$1 AND intent_id=$2 AND state='CAPTURED' RETURNING intent_id`,
    [op.tenantId, op.intentId],
  );
  if (!claimed.rowCount) throw new InventoryError('CAPTURE_ALREADY_CLAIMED', 409);
  await posting(db, op, 'APPLY', [
    ['CapturedFunds', op.amountMinor],
    ['Revenue', -sale.basisMinor],
    ['SalesTax', -sale.taxMinor],
  ]);
}

async function abandonment(
  db: PoolClient,
  scope: Scope,
  packet: unknown,
  capture: Evidence,
  trust: PaymentTrust,
) {
  try {
    const raw = exact(packet, ['body', 'keyId', 'signature']);
    if (typeof raw.body !== 'string') throw new Error();
    const hint = readIntent(JSON.parse(Buffer.from(raw.body, 'base64url').toString('utf8')));
    const {
      rows: [row],
    } = await db.query('SELECT enrollment FROM omni.fiscal_epochs WHERE tenant_id=$1 AND epoch_id=$2', [
      scope.tenantId,
      hint.epochId,
    ]);
    if (!row) throw new Error();
    const enrolled = readEnrollment(row.enrollment, trust.fiscalRoots);
    const intent = readIntent(
      openArtifact(fiscalPurpose.abandonment, packet, new Map([[enrolled.deviceId, deviceKey(enrolled)]])).data,
    );
    if (
      !sameEpoch(intent, enrolled) ||
      !sameScope(intent, scope) ||
      intent.saleId !== capture.fact.operation.intentId ||
      intent.saleDigest !== capture.fact.operation.basketDigest ||
      intent.captureDigest !== digest(capture.bytes)
    )
      throw new Error();
  } catch {
    throw new InventoryError('FISCAL_ABANDONMENT_REQUIRED', 409);
  }
}

export async function paymentAction(
  pool: Pool,
  scope: Scope,
  input: Record<string, unknown>,
  trust: PaymentTrust,
  supervisors: readonly Supervisor[],
) {
  const payload =
    input.action === 'capture'
      ? exact(input.payload, ['capture'])
      : input.action === 'refund'
        ? exact(input.payload, ['capture', 'refund'])
        : exact(input.payload, ['capture', 'abandonment', 'facts', 'approval']);
  const capture = verifiedPayment(scope, payload.capture, trust);
  const op = capture.fact.operation;
  return tenantTransaction(pool, scope.tenantId, async (db) => {
    const current = await captured(db, capture, payload.capture);
    if (input.action === 'capture') return { intentId: op.intentId, state: current.state };
    if (input.action === 'reserve-refund') {
      const facts = exact(payload.facts, ['operation', 'reason']);
      const refund = parseOperation(facts.operation);
      if (
        !paymentReason(facts.reason) ||
        refund.kind !== 'REFUND' ||
        refund.originalAttemptId !== op.attemptId ||
        !sameRoute(op, refund) ||
        refund.intentId !== op.intentId ||
        refund.basketDigest !== op.basketDigest ||
        refund.amountMinor !== op.amountMinor
      )
        throw new InventoryError('REFUND_LINEAGE_REJECTED', 422);
      requireApproval(
        scope,
        payload.approval,
        'refund-capture',
        { operation: refund, reason: facts.reason },
        supervisors,
      );
      await abandonment(db, scope, payload.abandonment, capture, trust);
      const reservation = jsonBytes({
        operation: refund,
        reason: facts.reason,
        approval: payload.approval,
        abandonment: payload.abandonment,
      });
      if (
        current.state === 'REFUND_RESERVED' &&
        current.refund_attempt === refund.attemptId &&
        current.refund_reservation?.equals(reservation)
      ) {
        return { intentId: op.intentId, state: current.state };
      }
      if (current.state !== 'CAPTURED') throw new InventoryError('CAPTURE_ALREADY_CLAIMED', 409);
      await db.query(
        `UPDATE omni.payment_cases SET state='REFUND_RESERVED',refund_attempt=$3,refund_reservation=$4
        WHERE tenant_id=$1 AND intent_id=$2 AND state='CAPTURED'`,
        [op.tenantId, op.intentId, refund.attemptId, reservation],
      );
      return { intentId: op.intentId, state: 'REFUND_RESERVED' };
    }
    if (input.action !== 'refund') throw new InventoryError('UNKNOWN_PAYMENT_ACTION', 400);
    const refund = verifiedPayment(scope, payload.refund, trust);
    const r = refund.fact.operation;
    if (
      refund.fact.state !== 'REFUNDED' ||
      r.kind !== 'REFUND' ||
      r.originalAttemptId !== op.attemptId ||
      r.attemptId !== current.refund_attempt ||
      r.intentId !== op.intentId ||
      r.basketDigest !== op.basketDigest ||
      r.amountMinor !== op.amountMinor ||
      !sameRoute(op, r) ||
      !['REFUND_RESERVED', 'REFUNDED'].includes(current.state)
    ) {
      throw new InventoryError('REFUND_EVIDENCE_REJECTED', 409);
    }
    await storeEvidence(db, refund, payload.refund);
    if (current.state === 'REFUND_RESERVED') {
      await db.query(
        "UPDATE omni.payment_cases SET state='REFUNDED' WHERE tenant_id=$1 AND intent_id=$2 AND state='REFUND_RESERVED'",
        [op.tenantId, op.intentId],
      );
      await posting(db, op, 'REFUND', [
        ['CapturedFunds', op.amountMinor],
        ['CardClearing', -op.amountMinor],
      ]);
    }
    return { intentId: op.intentId, state: 'REFUNDED' };
  });
}
