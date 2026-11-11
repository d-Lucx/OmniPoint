import type { Pool, PoolClient } from 'pg';
import { tenantTransaction } from './postgres.ts';
import { InventoryError } from './quota-cloud.ts';
import { isUuid, record } from './protocol.ts';
import type { Scope } from './protocol.ts';
import { allocateUnit } from './retail-money.ts';
import { parseApproval, payoutFacts, verifyApproval } from './retail-protocol.ts';
import type { RetailReturn, Supervisor } from './retail-protocol.ts';
import { releaseFacts, returnRequest } from './retail-return.ts';
import type { ReturnRequest, ReturnReservation } from './retail-return.ts';

type Shift = {
  store_id: string; terminal_id: string; generation: number; cashier_id: string; drawer_id: string; closed: boolean; source_no: number;
};
type Refund = {
  shift_id: string; terminal_id: string; generation: number; store_id: string; line_id: string; attempt_id: string;
  body: ReturnRequest; basis_minor: number; tax_minor: number; state: ReturnReservation['state']; release_evidence: string | null;
};

export async function retailShift(db: PoolClient, scope: Scope, shiftId: string): Promise<Shift | undefined> {
  const { rows: [shift] } = await db.query<Shift>(
    'SELECT * FROM omni.retail_shifts WHERE tenant_id=$1 AND shift_id=$2 FOR NO KEY UPDATE',
    [scope.tenantId, shiftId],
  );
  if (shift && (shift.store_id !== scope.storeId || shift.terminal_id !== scope.terminalId ||
      shift.generation !== scope.generation || shift.cashier_id !== scope.cashierId)) {
    throw new InventoryError('SHIFT_SCOPE_REJECTED', 403);
  }
  return shift;
}

export async function expectedDrawer(db: PoolClient, tenantId: string, shiftId: string): Promise<number> {
  const { rows: [row] } = await db.query<{ amount: string }>(
    'SELECT coalesce(sum(signed_minor),0) AS amount FROM omni.retail_cash WHERE tenant_id=$1 AND shift_id=$2',
    [tenantId, shiftId],
  );
  return Number(row.amount);
}

export function requireApproval(scope: Scope, value: unknown, action: string, facts: unknown, supervisors: readonly Supervisor[]) {
  try {
    verifyApproval(scope, parseApproval(value), action, facts, supervisors);
  } catch {
    throw new InventoryError('SUPERVISOR_AUTHORIZATION_REQUIRED', 403);
  }
}

// Acquire the shift first, then the original line for every reservation, release, and confirmation.
async function lockLine(db: PoolClient, tenantId: string, lineId: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 71422301))", [tenantId + '/' + lineId]);
}

async function getRefund(db: PoolClient, scope: Scope, id: string): Promise<Refund | undefined> {
  const { rows: [row] } = await db.query<Refund>(
    'SELECT * FROM omni.retail_refunds WHERE tenant_id=$1 AND return_id=$2', [scope.tenantId, id],
  );
  if (row && (row.terminal_id !== scope.terminalId || row.generation !== scope.generation || row.store_id !== scope.storeId)) {
    throw new InventoryError('RETURN_SCOPE_REJECTED', 403);
  }
  return row;
}

function publicRefund(row: Refund): ReturnReservation {
  return { ...row.body, basisMinor: row.basis_minor, taxMinor: row.tax_minor, state: row.state };
}

async function reserve(db: PoolClient, scope: Scope, input: Record<string, unknown>, supervisors: readonly Supervisor[]) {
  let request: ReturnRequest;
  try { request = returnRequest(record(input.request)); } catch { throw new InventoryError('INVALID_RETURN_REQUEST', 400); }
  requireApproval(scope, input.approval, 'reserve-return', request, supervisors);
  const shift = await retailShift(db, scope, request.shiftId);
  if (!shift || shift.closed) throw new InventoryError('OPEN_SYNCED_SHIFT_REQUIRED', 409);
  await lockLine(db, scope.tenantId, request.lineId);
  const prior = await getRefund(db, scope, request.returnId);
  if (prior) {
    if (Object.entries(request).some(([key, value]) => prior.body[key as keyof ReturnRequest] !== value)) {
      throw new InventoryError('RETURN_IDENTITY_CONFLICT', 409);
    }
    return publicRefund(prior);
  }
  const { rows: [original] } = await db.query<{ quantity: number; basis_minor: number; tax_minor: number; held: boolean }>(`
    SELECT l.quantity,l.basis_minor,l.tax_minor,
      EXISTS (SELECT 1 FROM omni.retail_shortfalls f WHERE (f.tenant_id,f.line_id)=(l.tenant_id,l.line_id)) AS held
    FROM omni.retail_lines l JOIN omni.retail_receipts r USING (tenant_id,event_id)
    JOIN omni.retail_events e USING (tenant_id,event_id)
    JOIN omni.retail_shifts s USING (tenant_id,shift_id)
    JOIN omni.retail_vouchers v USING (tenant_id,event_id)
    WHERE l.tenant_id=$1 AND l.line_id=$2 AND r.receipt_id=$3 AND s.store_id=$4 AND e.kind='SALE'
      AND NOT EXISTS (SELECT 1 FROM omni.module_tenders m WHERE (m.tenant_id,m.event_id)=(e.tenant_id,e.event_id))
  `, [scope.tenantId, request.lineId, request.receiptId, scope.storeId]);
  if (!original) throw new InventoryError('ORIGINAL_RECEIPT_NOT_SYNCED_OR_IN_SCOPE', 409);
  const card = await db.query(`
    SELECT 1 FROM omni.retail_lines l JOIN omni.payment_cases c ON c.tenant_id=l.tenant_id AND c.sale_id=l.event_id
    WHERE l.tenant_id=$1 AND l.line_id=$2
  `, [scope.tenantId,request.lineId]);
  if(card.rowCount) throw new InventoryError('CARD_RECEIPT_REQUIRES_CARD_REFUND_RAIL',409);
  if (original.held) throw new InventoryError('ORIGINAL_LINE_BACKORDER_HELD', 409);
  const { rows: reserved } = await db.query<{ ordinals: number[] }>(`
    SELECT ordinals FROM omni.retail_refunds WHERE tenant_id=$1 AND line_id=$2 AND state <> 'RELEASED'
  `, [scope.tenantId, request.lineId]);
  const used = new Set(reserved.flatMap(r => r.ordinals));
  const ordinals = Array.from({ length: original.quantity }, (_, i) => i).filter(i => !used.has(i)).slice(0, request.quantity);
  if (ordinals.length !== request.quantity) throw new InventoryError('RETURN_CAPACITY_HELD_OR_EXHAUSTED', 409);
  const amounts = ordinals.map(i => allocateUnit(original.basis_minor, original.tax_minor, original.quantity, i));
  const basis = amounts.reduce((n, amount) => n + amount.basis, 0);
  const tax = amounts.reduce((n, amount) => n + amount.tax, 0);
  const { rows: [row] } = await db.query<Refund>(`
    INSERT INTO omni.retail_refunds (tenant_id,return_id,attempt_id,line_id,shift_id,store_id,terminal_id,generation,
      original_receipt_id,body,ordinals,basis_minor,tax_minor,state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'RESERVED') RETURNING *
  `, [scope.tenantId, request.returnId, request.attemptId, request.lineId, request.shiftId, scope.storeId, scope.terminalId,
    scope.generation, request.receiptId, JSON.stringify(request), ordinals, basis, tax]);
  return publicRefund(row);
}

export async function returnAction(pool: Pool, scope: Scope, input: Record<string, unknown>, supervisors: readonly Supervisor[]) {
  const payload = record(input.payload);
  return tenantTransaction(pool, scope.tenantId, async db => {
    if (input.action === 'reserve') return reserve(db, scope, payload, supervisors);
    const { returnId, attemptId } = payload;
    if (!isUuid(returnId) || !isUuid(attemptId) || (input.action !== 'begin' && input.action !== 'release')) {
      throw new InventoryError('INVALID_RETURN_ACTION', 400);
    }
    const initial = await getRefund(db, scope, returnId);
    if (!initial || initial.attempt_id !== attemptId) throw new InventoryError('RETURN_UNKNOWN', 404);
    const shift = await retailShift(db, scope, initial.shift_id);
    if (!shift || shift.closed) throw new InventoryError('OPEN_SYNCED_SHIFT_REQUIRED', 409);
    await lockLine(db, scope.tenantId, initial.line_id);
    const refund = (await getRefund(db, scope, returnId))!;
    if (input.action === 'begin') {
      if (refund.state !== 'RESERVED') throw new InventoryError('PAYOUT_ALREADY_STARTED_OR_HELD', 409);
      const pending = await db.query("SELECT 1 FROM omni.retail_refunds WHERE tenant_id=$1 AND shift_id=$2 AND state='PAYOUT_PENDING'",
        [scope.tenantId, refund.shift_id]);
      if (pending.rowCount || await expectedDrawer(db, scope.tenantId, refund.shift_id) < refund.basis_minor + refund.tax_minor) {
        throw new InventoryError('DRAWER_CASH_UNAVAILABLE_OR_HELD', 409);
      }
      await db.query("UPDATE omni.retail_refunds SET state='PAYOUT_PENDING' WHERE tenant_id=$1 AND return_id=$2",
        [scope.tenantId, returnId]);
      return publicRefund({ ...refund, state: 'PAYOUT_PENDING' });
    }
    let facts;
    try { facts = releaseFacts(payload); } catch { throw new InventoryError('NONEXECUTION_EVIDENCE_REQUIRED', 422); }
    requireApproval(scope, payload.approval, 'release-return', facts, supervisors);
    if (refund.state === 'CONFIRMED' || (refund.state === 'RELEASED' && refund.release_evidence !== facts.evidence)) {
      throw new InventoryError('RETURN_RELEASE_CONFLICT', 409);
    }
    await db.query("UPDATE omni.retail_refunds SET state='RELEASED',release_evidence=$3 WHERE tenant_id=$1 AND return_id=$2",
      [scope.tenantId, returnId, facts.evidence]);
    return publicRefund({ ...refund, state: 'RELEASED' });
  });
}

export async function verifyPayout(db: PoolClient, e: RetailReturn, supervisors: readonly Supervisor[]) {
  requireApproval(e, e.approval, 'confirm-payout', payoutFacts(e), supervisors);
  const initial = await getRefund(db, e, e.returnId);
  if (!initial) throw new InventoryError('REFUND_RESERVATION_REQUIRED', 409);
  await lockLine(db, e.tenantId, initial.line_id);
  const refund = (await getRefund(db, e, e.returnId))!;
  if (e.saleId !== e.returnId || refund.state !== 'PAYOUT_PENDING' || refund.attempt_id !== e.attemptId ||
      refund.shift_id !== e.shiftId || e.amountMinor !== refund.basis_minor + refund.tax_minor) {
    throw new InventoryError('PAYOUT_RECONCILIATION_REQUIRED', 409);
  }
  return publicRefund(refund);
}
