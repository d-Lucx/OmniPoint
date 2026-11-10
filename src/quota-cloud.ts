import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  maxGrantDurationMs, maxQuotaUnits, parseCustody, parseGrant, receiptMatchesGrant, sameDestination,
  signEvidence, storedEvidence, verifyEvidence,
} from './inventory-protocol.ts';
import type { Grant, Position } from './inventory-protocol.ts';
import { ackBody, digest, jsonBytes, parseEvent } from './protocol.ts';
import type { FinalDisposition, QuotaSale, QuotaSpend, SaleEvent, Scope, SignedEvidence, SigningKey } from './protocol.ts';

export class InventoryError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

export interface StockKey { tenantId: string; storeId: string; sku: string }
type StockPosition = StockKey & Position;
type StoredGrant = { body: Buffer; key_id: string; signature: string };
export interface IssueRequest {
  positionId: string;
  grantId: string;
  terminalId: string;
  generation: number;
  quantity: number;
  expiresAt: string;
  transfer: Grant['transfer'];
}

// All stock writers take this row lock before reading any capacity or custody projection.
export async function lockStock(db: PoolClient, key: StockKey): Promise<number> {
  const { rows: [row] } = await db.query<{ on_hand: number }>(`
    SELECT on_hand FROM omni.stock WHERE tenant_id = $1 AND store_id = $2 AND sku = $3 FOR NO KEY UPDATE
  `, [key.tenantId, key.storeId, key.sku]);
  if (!row) throw new InventoryError('Unknown stock');
  return row.on_hand;
}

export async function salePosition(db: PoolClient, key: StockKey): Promise<Position | undefined> {
  const { rows: [position] } = await db.query<Position>(`
    SELECT position_id AS "positionId", location_id AS "locationId", sku FROM omni.stock_positions
    WHERE tenant_id = $1 AND store_id = $2 AND sku = $3
  `, [key.tenantId, key.storeId, key.sku]);
  return position;
}

export async function lockPosition(db: PoolClient, tenantId: string, positionId: string): Promise<StockPosition> {
  const { rows: [position] } = await db.query<StockPosition>(`
    SELECT tenant_id AS "tenantId", store_id AS "storeId", position_id AS "positionId",
      location_id AS "locationId", sku FROM omni.stock_positions WHERE tenant_id = $1 AND position_id = $2
  `, [tenantId, positionId]);
  if (!position) throw new InventoryError('Unknown stock position', 404);
  await lockStock(db, position);
  return position;
}

export async function openPosition(db: PoolClient, key: StockKey, position: Position): Promise<Position> {
  const opening = await lockStock(db, key);
  const previous = await salePosition(db, key);
  if (previous) {
    if (previous.positionId !== position.positionId || previous.locationId !== position.locationId) {
      throw new InventoryError('Stock position already enabled', 409);
    }
    return previous;
  }
  await db.query('INSERT INTO omni.stock_positions VALUES ($1,$2,$3,$4,$5,$6)',
    [key.tenantId, position.positionId, key.storeId, key.sku, position.locationId, opening]);
  return position;
}

async function getGrant(db: PoolClient, tenantId: string, grantId: string): Promise<StoredGrant | undefined> {
  return (await db.query<StoredGrant>(
    'SELECT body, key_id, signature FROM omni.quota_grants WHERE tenant_id = $1 AND grant_id = $2',
    [tenantId, grantId],
  )).rows[0];
}

export async function issueGrant(
  db: PoolClient, tenantId: string, request: IssueRequest, signer: SigningKey,
): Promise<SignedEvidence> {
  const position = await lockPosition(db, tenantId, request.positionId);
  const { grantId, terminalId, generation, quantity, expiresAt, transfer } = request;
  const prior = await getGrant(db, tenantId, grantId);
  if (prior) {
    const old = parseGrant(prior.body);
    if (old.positionId !== position.positionId || old.terminalId !== terminalId || old.generation !== generation ||
        old.slices.length !== quantity || old.expiresAt !== expiresAt ||
        old.transfer?.id !== transfer?.id || old.transfer?.dispatchLegId !== transfer?.dispatchLegId ||
        old.transfer?.sourceLocationId !== transfer?.sourceLocationId) {
      throw new InventoryError('Grant identity conflict', 409);
    }
    return storedEvidence(prior);
  }

  const now = Date.now();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuotaUnits ||
      Date.parse(expiresAt) <= now || Date.parse(expiresAt) - now > maxGrantDurationMs ||
      (transfer && transfer.sourceLocationId !== position.locationId)) {
    throw new InventoryError('Invalid quota quantity, expiry, or dispatch source');
  }
  const enrolled = await db.query(`
    SELECT 1 FROM omni.terminals WHERE tenant_id = $1 AND store_id = $2 AND terminal_id = $3 AND terminal_generation = $4
  `, [tenantId, position.storeId, terminalId, generation]);
  if (!enrolled.rowCount) throw new InventoryError('Destination terminal is outside the stock scope');

  const { rows: [inventory] } = await db.query<{ available: number }>(
    'SELECT available FROM omni.quota_inventory WHERE tenant_id = $1 AND position_id = $2',
    [tenantId, position.positionId],
  );
  if (inventory.available < quantity) throw new InventoryError('Insufficient unencumbered inventory', 409);
  const retail = await db.query('SELECT 1 FROM omni.retail_positions WHERE tenant_id=$1 AND position_id=$2',
    [tenantId, position.positionId]);
  const grant: Grant = {
    version: 1, kind: 'GRANT', ...position, grantId, terminalId, generation, expiresAt, transfer,
    issuedAt: new Date(now).toISOString(), slices: Array.from({ length: quantity }, () => randomUUID()),
    ...(retail.rowCount ? { retail: true } : {}),
  };
  const packet = signEvidence(grant, signer);
  await db.query(`
    INSERT INTO omni.quota_grants (tenant_id, grant_id, position_id, store_id, terminal_id, generation,
      body, key_id, signature, transfer_id, dispatch_leg_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [tenantId, grantId, position.positionId, position.storeId, terminalId, generation,
    Buffer.from(packet.body, 'base64url'), packet.keyId, packet.signature, transfer?.id ?? null, transfer?.dispatchLegId ?? null]);
  for (const slice of grant.slices) {
    await db.query('INSERT INTO omni.quota_slices VALUES ($1,$2,$3)', [tenantId, position.positionId, slice]);
    await db.query('INSERT INTO omni.quota_grant_units VALUES ($1,$2,$3,$4)', [tenantId, position.positionId, grantId, slice]);
  }
  return packet;
}

function verifiedReceipt(packet: SignedEvidence, keys: ReadonlyMap<string, KeyObject>) {
  try {
    const bytes = verifyEvidence(packet, 'CUSTODY_RECEIPT', keys);
    return { bytes, receipt: parseCustody(bytes) };
  } catch {
    throw new InventoryError('Invalid custody evidence');
  }
}

export async function checkQuotaEvidence(
  db: PoolClient, e: Scope & { occurredAt: string }, q: QuotaSpend, sku: string, position: Position | undefined,
  custodyKeys: ReadonlyMap<string, KeyObject>, retail = false,
) {
  if (q.positionId !== position?.positionId || q.locationId !== position.locationId) {
    throw new InventoryError('Quota stock position mismatch');
  }
  const row = await getGrant(db, e.tenantId, q.grantId);
  if (!row || digest(row.body) !== q.grantDigest) throw new InventoryError('Unknown quota grant or digest mismatch');
  const grant = parseGrant(row.body);
  if (Boolean(grant.retail) !== retail || !sameDestination(grant, e) || grant.storeId !== e.storeId || grant.sku !== sku ||
      grant.positionId !== q.positionId || grant.locationId !== q.locationId || !grant.slices.includes(q.sliceId) ||
      e.occurredAt < grant.issuedAt || e.occurredAt >= grant.expiresAt || Date.parse(e.occurredAt) > Date.now() + 60_000) {
    throw new InventoryError('Invalid or out-of-scope quota spend');
  }
  let legId: string | null = null;
  let custodyDigest: string | null = null;
  let ready = true;
  if (grant.transfer) {
    if (!q.custody) throw new InventoryError('Receiving-side evidence required');
    const { bytes, receipt } = verifiedReceipt(q.custody, custodyKeys);
    if (!receiptMatchesGrant(receipt, grant) || !receipt.slices.includes(q.sliceId)) {
      throw new InventoryError('Custody evidence does not cover the claimed slice');
    }
    legId = receipt.legId;
    custodyDigest = digest(bytes);
    const priorLeg = await db.query(`
      SELECT 1 FROM omni.custody_receipts WHERE tenant_id = $1 AND leg_id = $2 AND body <> $3
      UNION ALL
      SELECT 1 FROM omni.quota_claims WHERE tenant_id = $1 AND custody_leg_id = $2 AND custody_digest <> $4
    `, [e.tenantId, legId, bytes, custodyDigest]);
    if (priorLeg.rowCount) throw new InventoryError('Custody leg identity conflict', 409);
    const { rows: [filed] } = await db.query<{ leg_id: string; body: Buffer }>(`
      SELECT u.leg_id, r.body FROM omni.custody_units u JOIN omni.custody_receipts r
        USING (tenant_id, position_id, grant_id, leg_id)
      WHERE u.tenant_id = $1 AND u.position_id = $2 AND u.grant_id = $3 AND u.slice_id = $4
    `, [e.tenantId, q.positionId, q.grantId, q.sliceId]);
    if (filed && (filed.leg_id !== legId || digest(filed.body) !== custodyDigest)) {
      throw new InventoryError('Conflicting filed custody evidence', 409);
    }
    ready = Boolean(filed);
  } else if (q.custody) {
    throw new InventoryError('Unexpected custody evidence');
  }
  return { ready, legId, custodyDigest };
}

export async function admitQuota(
  db: PoolClient, e: QuotaSale, position: Position | undefined, eventBytes: Buffer,
  custodyKeys: ReadonlyMap<string, KeyObject>,
): Promise<boolean> {
  const q = e.quota;
  const retail = await db.query('SELECT 1 FROM omni.retail_positions WHERE tenant_id=$1 AND position_id=$2',
    [e.tenantId, q.positionId]);
  if (retail.rowCount) throw new InventoryError('Retail protocol required for new sales at this position');
  const { ready, legId, custodyDigest } = await checkQuotaEvidence(db, e, q, e.line.sku, position, custodyKeys);
  const claim = await db.query(`
    INSERT INTO omni.quota_claims (tenant_id, sale_id, position_id, grant_id, slice_id, event_bytes, custody_leg_id, custody_digest)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (tenant_id, position_id, grant_id, slice_id) DO NOTHING RETURNING sale_id
  `, [e.tenantId, e.saleId, q.positionId, q.grantId, q.sliceId, eventBytes, legId, custodyDigest]);
  if (!claim.rowCount) throw new InventoryError('Grant slice already claimed by this terminal', 422);
  return ready;
}

export async function saveOutcome(db: PoolClient, event: SaleEvent, requestDigest: string, disposition: FinalDisposition) {
  const ack = ackBody(event, requestDigest, disposition);
  const body = jsonBytes(ack);
  await db.query('INSERT INTO omni.outcomes VALUES ($1,$2,$3,$4)', [event.tenantId, event.saleId, ack.ackId, body]);
  return body;
}

export async function decrementStock(db: PoolClient, key: StockKey): Promise<void> {
  const stock = await db.query(`
    UPDATE omni.stock SET on_hand = on_hand - 1
    WHERE tenant_id = $1 AND store_id = $2 AND sku = $3 AND on_hand >= 1 RETURNING on_hand
  `, [key.tenantId, key.storeId, key.sku]);
  if (!stock.rowCount) throw new InventoryError('Stock unavailable', 409);
}

// Invoked with the stock anchor held and with the receipt, line and cash journal present.
export async function settleQuota(db: PoolClient, e: QuotaSale, requestDigest: string): Promise<Buffer> {
  const { tenantId, saleId, quota: q } = e;
  const { rows: [winner] } = await db.query<{ sale_id: string }>(`
    SELECT sale_id FROM omni.quota_decisions WHERE tenant_id = $1 AND position_id = $2 AND slice_id = $3
      AND disposition = 'COMMITTED'
  `, [tenantId, q.positionId, q.sliceId]);
  const disposition = winner ? 'BACKORDER' : 'COMMITTED';
  await db.query(`
    INSERT INTO omni.quota_decisions (tenant_id, sale_id, position_id, slice_id, disposition, winner_sale_id)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [tenantId, saleId, q.positionId, q.sliceId, disposition, winner?.sale_id ?? saleId]);
  if (winner) {
    await db.query('INSERT INTO omni.shortfalls VALUES ($1,$2,$3,$4,1)', [tenantId, saleId, q.positionId, e.receiptId]);
  } else {
    await decrementStock(db, { tenantId, storeId: e.storeId, sku: e.line.sku });
    await db.query('INSERT INTO omni.stock_movements VALUES ($1,$2,$3)', [tenantId, e.line.id, e.line.stockDelta]);
  }
  return saveOutcome(db, e, requestDigest, disposition);
}

export async function fileCustody(
  db: PoolClient, tenantId: string, packet: SignedEvidence, custodyKeys: ReadonlyMap<string, KeyObject>,
) {
  const { bytes, receipt } = verifiedReceipt(packet, custodyKeys);
  if (receipt.tenantId !== tenantId) throw new InventoryError('Receipt is outside operator scope', 403);
  await lockPosition(db, tenantId, receipt.positionId);
  const grant = await getGrant(db, tenantId, receipt.grantId);
  if (!grant) throw new InventoryError('Receipt has no matching dispatch');
  const dispatch = parseGrant(grant.body);
  if (!receiptMatchesGrant(receipt, dispatch) || (receipt.observedAt &&
      (receipt.observedAt < dispatch.issuedAt || Date.parse(receipt.observedAt) > Date.now()))) {
    throw new InventoryError('Receipt has no matching dispatch');
  }
  const { positionId, grantId, legId, slices } = receipt;
  const hash = digest(bytes);
  const { rows: [prior] } = await db.query<{ body: Buffer }>(
    'SELECT body FROM omni.custody_receipts WHERE tenant_id = $1 AND leg_id = $2', [tenantId, legId],
  );
  if (prior) {
    if (digest(prior.body) !== hash) throw new InventoryError('Custody leg identity conflict', 409);
    return { legId };
  }
  const conflicting = await db.query(`
    SELECT 1 FROM omni.quota_claims WHERE tenant_id = $1 AND (
      (custody_leg_id = $5 AND custody_digest <> $6)
      OR (position_id = $2 AND grant_id = $3 AND slice_id = ANY($4::uuid[])
        AND (custody_leg_id <> $5 OR custody_digest <> $6))
    )
  `, [tenantId, positionId, grantId, slices, legId, hash]);
  if (conflicting.rowCount) throw new InventoryError('Custody evidence conflicts with a staged claim', 409);
  await db.query('INSERT INTO omni.custody_receipts VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [tenantId, legId, positionId, grantId, bytes, packet.keyId, packet.signature]);
  for (const slice of slices) {
    const filed = await db.query(`
      INSERT INTO omni.custody_units VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING RETURNING leg_id
    `, [tenantId, positionId, grantId, slice, legId]);
    if (!filed.rowCount) throw new InventoryError('Custody slice already received', 409);
  }
  const { rows: pending } = await db.query<{ event_bytes: Buffer }>(`
    SELECT c.event_bytes FROM omni.quota_claims c LEFT JOIN omni.outcomes o USING (tenant_id, sale_id)
    WHERE c.tenant_id = $1 AND c.position_id = $2 AND c.grant_id = $3
      AND c.custody_leg_id = $4 AND c.custody_digest = $5 AND o.sale_id IS NULL
    ORDER BY c.admission_no
  `, [tenantId, positionId, grantId, legId, hash]);
  for (const { event_bytes } of pending) {
    const event = parseEvent(event_bytes);
    if (event.version !== 2) throw new Error('Invalid staged quota sale');
    await settleQuota(db, event, digest(event_bytes));
  }
  return { legId };
}

export async function receiveReplacement(
  db: PoolClient, tenantId: string, positionId: string, replacementId: string, provenance: string,
) {
  const position = await lockPosition(db, tenantId, positionId);
  const inserted = await db.query(`
    INSERT INTO omni.replacement_units VALUES ($1,$2,$3,$4)
    ON CONFLICT (tenant_id, replacement_id) DO NOTHING RETURNING replacement_id
  `, [tenantId, replacementId, positionId, provenance]);
  if (inserted.rowCount) {
    await db.query('UPDATE omni.stock SET on_hand = on_hand + 1 WHERE tenant_id = $1 AND store_id = $2 AND sku = $3',
      [tenantId, position.storeId, position.sku]);
  } else {
    const prior = await db.query(`
      SELECT 1 FROM omni.replacement_units WHERE tenant_id = $1 AND replacement_id = $2 AND position_id = $3 AND provenance = $4
    `, [tenantId, replacementId, positionId, provenance]);
    if (!prior.rowCount) throw new InventoryError('Replacement identity conflict', 409);
  }
  return { replacementId };
}

export async function inspectShortfall(db: PoolClient, tenantId: string, saleId: string) {
  const { rows: [row] } = await db.query<{ position_id: string } & Record<string, unknown>>(`
    SELECT s.sale_id, s.receipt_id, s.quantity, d.position_id, d.slice_id, c.grant_id,
      d.winner_sale_id, wc.grant_id AS winner_grant_id, d.rule, d.order_no, w.order_no AS winner_order_no,
      CASE WHEN r.resolution_id IS NULL THEN 'OPEN' ELSE 'RESOLVED' END AS status,
      r.resolution_id, r.replacement_id, u.provenance
    FROM omni.shortfalls s JOIN omni.quota_decisions d USING (tenant_id, sale_id)
    JOIN omni.quota_claims c USING (tenant_id, sale_id)
    JOIN omni.quota_decisions w ON w.tenant_id = d.tenant_id AND w.sale_id = d.winner_sale_id
    JOIN omni.quota_claims wc ON wc.tenant_id = w.tenant_id AND wc.sale_id = w.sale_id
    LEFT JOIN omni.shortfall_resolutions r ON r.tenant_id = s.tenant_id AND r.sale_id = s.sale_id
    LEFT JOIN omni.replacement_units u ON u.tenant_id = r.tenant_id AND u.replacement_id = r.replacement_id
    WHERE s.tenant_id = $1 AND s.sale_id = $2
  `, [tenantId, saleId]);
  if (!row) throw new InventoryError('Unknown shortfall', 404);
  return row;
}

export async function resolveShortfall(
  db: PoolClient, tenantId: string, saleId: string, resolutionId: string, replacementId: string,
) {
  const original = await inspectShortfall(db, tenantId, saleId);
  const position = await lockPosition(db, tenantId, original.position_id);
  const current = await inspectShortfall(db, tenantId, saleId);
  if (current.status === 'RESOLVED') {
    if (current.resolution_id !== resolutionId || current.replacement_id !== replacementId) {
      throw new InventoryError('Shortfall already resolved', 409);
    }
    return current;
  }
  const replacement = await db.query(`
    SELECT 1 FROM omni.replacement_units WHERE tenant_id = $1 AND replacement_id = $2 AND position_id = $3
  `, [tenantId, replacementId, position.positionId]);
  if (!replacement.rowCount) throw new InventoryError('Independent replacement evidence required', 409);
  await db.query('INSERT INTO omni.shortfall_resolutions VALUES ($1,$2,$3,$4,$5)',
    [tenantId, resolutionId, position.positionId, saleId, replacementId]);
  await decrementStock(db, position);
  return inspectShortfall(db, tenantId, saleId);
}
