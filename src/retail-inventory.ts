import type { Pool, PoolClient } from 'pg';
import { parseCustody, parseGrant } from './inventory-protocol.ts';
import { tenantTransaction } from './postgres.ts';
import { InventoryError, lockPosition } from './quota-cloud.ts';
import { isLabel, isUuid, jsonBytes } from './protocol.ts';
import { parseCatalog } from './retail-protocol.ts';

type Position = Awaited<ReturnType<typeof lockPosition>>;
type Slice = { grant_id: string; slice_id: string; transfer_id: string | null; body: Buffer; received: boolean };
type Count = { position_id: string; cutoff: Date; observed: number; actor_id: string; witness: string;
  book_on_hand: number; movement_cut: string; open_slices: Array<{ grantId: string; sliceId: string; inTransit: boolean; expiresAt: string }> };
type Decision = { decision_id: string; count_id: string; previous_id: string | null; actor_id: string; observed: number;
  corrected_book: number; delta: number; evidence: string };

async function activePosition(db: PoolClient, tenantId: string, id: string): Promise<Position> {
  const position = await lockPosition(db, tenantId, id);
  const enabled = await db.query('SELECT 1 FROM omni.retail_positions WHERE tenant_id=$1 AND position_id=$2', [tenantId, id]);
  if (!enabled.rowCount) throw new InventoryError('RETAIL_POSITION_REQUIRED', 409);
  return position;
}

async function inventory(db: PoolClient, p: Position) {
  const { rows: [stock] } = await db.query<{ on_hand: number; encumbered: number }>(
    'SELECT on_hand,encumbered FROM omni.quota_inventory WHERE tenant_id=$1 AND position_id=$2', [p.tenantId, p.positionId],
  );
  return stock;
}

async function change(
  db: PoolClient, p: Position, id: string, kind: string, delta: number, provenance: string, returnId: string | null = null,
) {
  const inserted = await db.query(`
    INSERT INTO omni.retail_stock_changes VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (tenant_id,evidence_id) DO NOTHING RETURNING evidence_id
  `, [p.tenantId, id, p.positionId, kind, delta, provenance, returnId]);
  if (!inserted.rowCount) {
    const identical = await db.query(`
      SELECT 1 FROM omni.retail_stock_changes WHERE tenant_id=$1 AND evidence_id=$2 AND position_id=$3
        AND kind=$4 AND delta=$5 AND provenance=$6 AND return_id IS NOT DISTINCT FROM $7
    `, [p.tenantId, id, p.positionId, kind, delta, provenance, returnId]);
    if (!identical.rowCount) throw new InventoryError('STOCK_EVIDENCE_CONFLICT', 409);
  } else if (delta) {
    const stock = await inventory(db, p);
    if (stock.on_hand + delta < stock.encumbered) throw new InventoryError('ADJUSTMENT_WOULD_RELEASE_ENCUMBRANCE', 409);
    await db.query('UPDATE omni.stock SET on_hand=on_hand+$4 WHERE tenant_id=$1 AND store_id=$2 AND sku=$3',
      [p.tenantId, p.storeId, p.sku, delta]);
  }
  return { evidenceId: id, delta };
}

async function movementCut(db: PoolClient, p: Position, ignoreCount?: string): Promise<string> {
  const { rows: [cut] } = await db.query(`
    SELECT
      (SELECT count(*) FROM omni.quota_decisions WHERE tenant_id=$1 AND position_id=$2 AND disposition='COMMITTED') AS legacy,
      (SELECT count(*) FROM omni.retail_allocations WHERE tenant_id=$1 AND position_id=$2 AND fulfilled) AS sold,
      (SELECT count(*) FROM omni.replacement_units WHERE tenant_id=$1 AND position_id=$2) AS replacement,
      (SELECT count(*) FROM omni.shortfall_resolutions r JOIN omni.replacement_units u USING (tenant_id,replacement_id)
        WHERE u.tenant_id=$1 AND u.position_id=$2) AS resolution,
      (SELECT count(*) FROM omni.retail_stock_changes c WHERE c.tenant_id=$1 AND c.position_id=$2 AND NOT EXISTS (
        SELECT 1 FROM omni.retail_count_decisions d WHERE d.tenant_id=c.tenant_id
          AND d.count_id=$3 AND d.decision_id=c.evidence_id
      )) AS adjustment
  `, [p.tenantId, p.positionId, ignoreCount ?? null]);
  return JSON.stringify(cut);
}

async function getCount(db: PoolClient, tenantId: string, id: string) {
  const { rows: [count] } = await db.query<Count>('SELECT * FROM omni.retail_counts WHERE tenant_id=$1 AND count_id=$2', [tenantId, id]);
  if (!count) throw new InventoryError('COUNT_UNKNOWN', 404);
  return count;
}

async function observeCount(db: PoolClient, p: Position, countId: string, observed: number, actorId: string, witness: string) {
  const old = await db.query<Count>('SELECT * FROM omni.retail_counts WHERE tenant_id=$1 AND count_id=$2', [p.tenantId, countId]);
  if (old.rows[0]) {
    const count = old.rows[0];
    if (count.observed !== observed || count.witness !== witness || count.actor_id !== actorId || count.position_id !== p.positionId) {
      throw new InventoryError('COUNT_IDENTITY_CONFLICT', 409);
    }
    return count;
  }
  const { rows } = await db.query<Slice>(`
    SELECT u.grant_id,u.slice_id,g.transfer_id,g.body,c.slice_id IS NOT NULL AS received
    FROM omni.quota_grant_units u JOIN omni.quota_grants g USING (tenant_id,position_id,grant_id)
    LEFT JOIN omni.custody_units c USING (tenant_id,position_id,grant_id,slice_id)
    WHERE u.tenant_id=$1 AND u.position_id=$2 AND NOT EXISTS (
      SELECT 1 FROM omni.retail_allocations a WHERE (a.tenant_id,a.position_id,a.slice_id)=(u.tenant_id,u.position_id,u.slice_id) AND a.fulfilled
    ) AND NOT EXISTS (
      SELECT 1 FROM omni.quota_decisions d WHERE (d.tenant_id,d.position_id,d.slice_id)=(u.tenant_id,u.position_id,u.slice_id) AND d.disposition='COMMITTED'
    )
    ORDER BY u.slice_id,u.grant_id LIMIT 101
  `, [p.tenantId, p.positionId]);
  if (rows.length > 100) throw new InventoryError('COUNT_SCOPE_EXCEEDS_FIXTURE_LIMIT');
  const slices = rows.map(row => ({ grantId: row.grant_id, sliceId: row.slice_id,
    inTransit: Boolean(row.transfer_id && !row.received), expiresAt: parseGrant(row.body).expiresAt }));
  const stock = await inventory(db, p);
  const cut = await movementCut(db, p);
  const { rows: [count] } = await db.query<Count>(`
    INSERT INTO omni.retail_counts VALUES ($1,$2,$3,clock_timestamp(),$4,$5,$6,$7,$8,$9) RETURNING *
  `, [p.tenantId, countId, p.positionId, observed, actorId, witness, stock.on_hand, cut, JSON.stringify(slices)]);
  return count;
}

async function inspectCount(db: PoolClient, tenantId: string, countId: string) {
  const count = await getCount(db, tenantId, countId);
  const { rows } = await db.query<Decision>(`
    SELECT * FROM omni.retail_count_decisions WHERE tenant_id=$1 AND count_id=$2 ORDER BY recorded_no
  `, [tenantId, countId]);
  return { count, decisions: rows, status: rows.length ? 'RECONCILED' : count.open_slices.some(s => s.inTransit) ? 'CUSTODY_HELD' : 'OBSERVED' };
}

async function decideCount(
  db: PoolClient, tenantId: string, countId: string, decisionId: string, previousId: string | null,
  revised: number | undefined, actorId: string, evidence: string,
) {
  const count = await getCount(db, tenantId, countId);
  const position = await activePosition(db, tenantId, count.position_id);
  const { decisions } = await inspectCount(db, tenantId, countId);
  const observed = revised ?? count.observed;
  const same = decisions.find(d => d.decision_id === decisionId);
  if (same) {
    if (same.previous_id !== previousId || same.observed !== observed || same.actor_id !== actorId || same.evidence !== evidence) {
      throw new InventoryError('COUNT_DECISION_CONFLICT', 409);
    }
    return same;
  }
  const prior = decisions.at(-1);
  if ((prior?.decision_id ?? null) !== previousId) throw new InventoryError('COUNT_LINEAGE_CONFLICT', 409);
  const transitAtCut = new Set<string>();
  for (const slice of count.open_slices.filter(s => s.inTransit)) {
    const { rows: [receipt] } = await db.query<{ body: Buffer }>(`
      SELECT r.body FROM omni.custody_units u JOIN omni.custody_receipts r USING (tenant_id,position_id,grant_id,leg_id)
      WHERE u.tenant_id=$1 AND u.position_id=$2 AND u.grant_id=$3 AND u.slice_id=$4
    `, [tenantId, position.positionId, slice.grantId, slice.sliceId]);
    const happened = receipt && parseCustody(receipt.body).observedAt;
    if (!happened) throw new InventoryError('CUSTODY_EVIDENCE_REQUIRED_AT_CUT', 409);
    if (Date.parse(happened) > count.cutoff.getTime()) transitAtCut.add(slice.sliceId);
  }
  const book = count.book_on_hand - transitAtCut.size;
  const supported = observed - book;
  const delta = supported - decisions.reduce((sum, d) => sum + d.delta, 0);
  if (delta && await movementCut(db, position, countId) !== count.movement_cut) throw new InventoryError('BOOK_CUT_CHANGED', 409);
  if (supported < 0 && count.open_slices.length) throw new InventoryError('POSSIBLE_OFFLINE_SPEND_BLOCKS_SHRINK', 409);
  const { rows: [decision] } = await db.query<Decision>(`
    INSERT INTO omni.retail_count_decisions
      (tenant_id,decision_id,count_id,previous_id,actor_id,observed,corrected_book,delta,evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `, [tenantId, decisionId, countId, previousId, actorId, observed, book, delta, evidence]);
  if (delta) await change(db, position, decisionId, 'COUNT', delta, evidence);
  return decision;
}

export async function retailInventoryAction(pool: Pool, tenantId: string, actorId: string | undefined, input: Record<string, unknown>) {
  if (!actorId) throw new InventoryError('RETAIL_OPERATOR_REQUIRED', 403);
  return tenantTransaction(pool, tenantId, async db => {
    const { action, storeId, positionId, countId, decisionId, previousId, observed, witness, evidenceId, provenance,
      returnId, disposition, evidence } = input;
    switch (action) {
      case 'retail-catalog': {
        if (!isUuid(storeId)) break;
        let catalog;
        try { catalog = parseCatalog(input.catalog); } catch { throw new InventoryError('INVALID_CATALOG', 400); }
        const body = jsonBytes(catalog);
        await db.query('INSERT INTO omni.retail_catalogs VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [tenantId, catalog.version, storeId, body]);
        const prior = await db.query('SELECT 1 FROM omni.retail_catalogs WHERE tenant_id=$1 AND version=$2 AND store_id=$3 AND body=$4',
          [tenantId, catalog.version, storeId, body]);
        if (!prior.rowCount) throw new InventoryError('CATALOG_VERSION_CONFLICT', 409);
        return { version: catalog.version };
      }
      case 'retail-enable': {
        if (!isUuid(positionId) || input.legacyDrained !== true) break;
        const p = await lockPosition(db, tenantId, positionId);
        const current = await db.query('SELECT 1 FROM omni.retail_positions WHERE tenant_id=$1 AND position_id=$2', [tenantId, positionId]);
        if (current.rowCount) return { positionId };
        if ((await inventory(db, p)).encumbered) throw new InventoryError('DRAIN_LEGACY_RESERVATIONS_FIRST', 409);
        await db.query('INSERT INTO omni.retail_positions VALUES ($1,$2)', [tenantId, positionId]);
        return { positionId };
      }
      case 'retail-count':
        if (!isUuid(positionId) || !isUuid(countId) || !units(observed) || !isLabel(witness)) break;
        return observeCount(db, await activePosition(db, tenantId, positionId), countId, observed, actorId, witness);
      case 'retail-inspect-count':
        if (!isUuid(countId)) break;
        return inspectCount(db, tenantId, countId);
      case 'retail-decide-count':
        if (!isUuid(countId) || !isUuid(decisionId) || (previousId !== null && !isUuid(previousId)) ||
            (previousId === null ? observed !== undefined : !units(observed)) || !isLabel(evidence)) break;
        return decideCount(db, tenantId, countId, decisionId, previousId, observed as number | undefined, actorId, evidence);
      case 'retail-found':
        if (!isUuid(positionId) || !isUuid(evidenceId) || !isLabel(provenance) || !units(input.quantity) || !input.quantity) break;
        return change(db, await activePosition(db, tenantId, positionId), evidenceId, 'FOUND', input.quantity, provenance);
      case 'retail-restock': {
        if (!isUuid(returnId) || !isUuid(evidenceId) || !isLabel(provenance) ||
            (disposition !== 'SELLABLE' && disposition !== 'QUARANTINED')) break;
        const { rows: [returned] } = await db.query<{ position_id: string; quantity: number }>(`
          SELECT l.position_id,cardinality(r.ordinals) AS quantity FROM omni.retail_refunds r JOIN omni.retail_lines l USING (tenant_id,line_id)
          WHERE r.tenant_id=$1 AND r.return_id=$2 AND r.state='CONFIRMED'
        `, [tenantId, returnId]);
        if (!returned) throw new InventoryError('CONFIRMED_RETURN_REQUIRED', 409);
        return change(db, await activePosition(db, tenantId, returned.position_id), evidenceId, disposition,
          disposition === 'SELLABLE' ? returned.quantity : 0, provenance, returnId);
      }
    }
    throw new InventoryError('INVALID_RETAIL_INVENTORY_ACTION', 400);
  });
}

function units(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000;
}
