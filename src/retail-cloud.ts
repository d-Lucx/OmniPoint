import type { KeyObject } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { tenantTransaction } from './postgres.ts';
import { checkQuotaEvidence, decrementStock, InventoryError, lockStock, salePosition } from './quota-cloud.ts';
import { ackBody, digest, jsonBytes, signVoucher } from './protocol.ts';
import type { Conflict, Scope, SigningKey, Voucher } from './protocol.ts';
import { money } from './retail-money.ts';
import { discountFacts, dropFacts, parseCatalog, revisionFacts, salePrintable } from './retail-protocol.ts';
import type { RetailCount, RetailEvent, RetailSale, Supervisor } from './retail-protocol.ts';
import { expectedDrawer, requireApproval, retailShift, verifyPayout } from './retail-returns-cloud.ts';
import { moduleAccrual, modulePrintable, paymentLines, serviceFacts } from './module-sale.ts';
import type { ModuleSale } from './module-sale.ts';
import { ledgerWriter } from './period-close.ts';

type LineOutcome = { lineId: string; fulfilled: number; backordered: number };
type Allocation = { winner: string; fulfilled: boolean };
type SalePlan = { results: LineOutcome[]; allocations: Map<string, Allocation> };
type Admission = { body: Buffer } | { conflict: Conflict } | { hold: string };
type CardApplication = { printable:string; apply: (db:PoolClient)=>Promise<void> };
interface Stored { digest: string; ack: Buffer }
interface VoucherRow { key_id: string; signature: string }
type Shift = NonNullable<Awaited<ReturnType<typeof retailShift>>>;

async function loadStored(db: PoolClient, e: RetailEvent, hash: string): Promise<Admission | undefined> {
  const { rows: [prior] } = await db.query<Stored>(
    'SELECT digest,ack FROM omni.retail_events WHERE tenant_id=$1 AND event_id=$2', [e.tenantId, e.saleId],
  );
  if (prior) return prior.digest === hash ? { body: prior.ack } : { conflict: 'SALE_ID_CONFLICT' };
}

async function planSale(
  db: PoolClient, e: RetailSale, custodyKeys: ReadonlyMap<string, KeyObject>, supervisors: readonly Supervisor[],
  priorShortfalls: ReadonlySet<string> = new Set(),
): Promise<SalePlan | undefined> {
  const positions = new Map<string, Awaited<ReturnType<typeof salePosition>>>();
  for (const sku of [...new Set(e.lines.filter(line => line.units.length).map(line => line.quote.sku))].sort()) {
    const key = { tenantId: e.tenantId, storeId: e.storeId, sku };
    await lockStock(db, key);
    const position = await salePosition(db, key);
    const enabled = position && await db.query('SELECT 1 FROM omni.retail_positions WHERE tenant_id=$1 AND position_id=$2',
      [e.tenantId, position.positionId]);
    if (!enabled || !enabled.rowCount) throw new InventoryError('RETAIL_POSITION_REQUIRED');
    positions.set(sku, position);
  }
  const allocations = new Map<string, Allocation>();
  const results: LineOutcome[] = [];
  let custodyPending = false;
  for (const line of e.lines) {
    if (line.quote.sku === 'LABOR' && !line.units.length) {
      results.push({ lineId: line.id, fulfilled: 1, backordered: 0 });
      continue;
    }
    const { rows: [manifest] } = await db.query<{ body: Buffer }>(
      'SELECT body FROM omni.retail_catalogs WHERE tenant_id=$1 AND store_id=$2 AND version=$3',
      [e.tenantId, e.storeId, line.quote.catalogVersion],
    );
    if (!manifest) throw new InventoryError('CATALOG_VERSION_UNKNOWN');
    const catalog = parseCatalog(JSON.parse(manifest.body.toString('utf8')));
    const variant = catalog.variants.find(v => v.sku === line.quote.sku);
    if (!variant || !jsonBytes({ ...variant, catalogVersion: catalog.version, taxVersion: catalog.taxVersion }).equals(jsonBytes(line.quote))) {
      throw new InventoryError('CATALOG_QUOTE_MISMATCH');
    }
    if (line.discount) requireApproval(e, line.discount.approval, 'discount',
      discountFacts(e.shiftId, line.id, line.quote, line.quantity, line.discount.amount, line.discount.reason), supervisors);
    let fulfilled = !line.units.length && !priorShortfalls.has(line.id) ? 1 : 0;
    for (const unit of line.units) {
      const args = [e.tenantId, unit.positionId, unit.sliceId];
      const evidence = await checkQuotaEvidence(db, e, unit, line.quote.sku, positions.get(line.quote.sku), custodyKeys, true);
      custodyPending ||= !evidence.ready;
      const { rows } = await db.query<{ line_id: string; grant_id: string; fulfilled: boolean }>(`
        SELECT line_id,grant_id,fulfilled FROM omni.retail_allocations WHERE tenant_id=$1 AND position_id=$2 AND slice_id=$3
      `, args);
      if (rows.some(row => row.grant_id === unit.grantId)) throw new InventoryError('GRANT_SLICE_ALREADY_CLAIMED', 422);
      const winner = rows.find(row => row.fulfilled);
      if (!winner) fulfilled++;
      allocations.set(unit.sliceId, { winner: winner?.line_id ?? line.id, fulfilled: !winner });
    }
    results.push({ lineId: line.id, fulfilled, backordered: line.quantity - fulfilled });
  }
  return custodyPending ? undefined : { results, allocations };
}

async function cash(db: PoolClient, e: RetailEvent, amount: number, destination: string | null = null) {
  const expected = await expectedDrawer(db, e.tenantId, e.shiftId);
  if (!money(expected + amount)) throw new InventoryError('DRAWER_BALANCE_OUTSIDE_FIXTURE_BOUNDS');
  await db.query('INSERT INTO omni.retail_cash VALUES ($1,$2,$3,$4,$5,$6)',
    [e.tenantId, e.saleId, e.shiftId, e.kind, amount, destination]);
}

async function postMoney(db: PoolClient, e: RetailEvent, basis: number, tax: number, direction: 1 | -1, tip = 0) {
  for (const [account, minor] of [['Cash', basis + tax + tip], ['Revenue', -basis], ['SalesTax', -tax], ['TipsPayable', -tip]] as const) {
    if (minor !== 0) await db.query('INSERT INTO omni.retail_postings VALUES ($1,$2,$3,$4)',
      [e.tenantId, e.saleId, account, minor * direction]);
  }
}

async function writeSale(db: PoolClient, e: RetailSale, plan: SalePlan, card?:CardApplication, module?: ModuleSale) {
  await db.query('INSERT INTO omni.retail_receipts VALUES ($1,$2,$3,NULL,$4)',
    [e.tenantId, e.receiptId, e.saleId, module ? modulePrintable(module) : card?.printable ?? salePrintable(e)]);
  for (const [index, line] of e.lines.entries()) {
    const position = line.units[0]?.positionId ?? null;
    await db.query('INSERT INTO omni.retail_lines VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [e.tenantId, line.id, e.saleId, position, line.quote.sku, line.quantity, line.basisMinor, line.taxMinor, JSON.stringify(line)]);
    for (const unit of line.units) {
      const award = plan.allocations.get(unit.sliceId)!;
      await db.query(`
        INSERT INTO omni.retail_allocations (tenant_id,position_id,grant_id,slice_id,line_id,fulfilled,winner_line_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [e.tenantId, position, unit.grantId, unit.sliceId, line.id, award.fulfilled, award.winner]);
      if (award.fulfilled) await decrementStock(db, { tenantId: e.tenantId, storeId: e.storeId, sku: line.quote.sku });
    }
    if (line.units.length && plan.results[index].backordered) await db.query('INSERT INTO omni.retail_shortfalls VALUES ($1,$2,$3)',
      [e.tenantId, line.id, plan.results[index].backordered]);
  }
  if(card) await card.apply(db);
  else {
    await cash(db, e, e.tenderMinor - e.changeMinor);
    await postMoney(db, e, e.basisMinor, e.taxMinor, 1, module?.tip);
  }
}

async function validateModule(db: PoolClient, event: ModuleSale, supervisors: readonly Supervisor[]) {
  const { plan, sale, check, before, paid, tip, tipBefore, claims } = event;
  const { tenantId, storeId, terminalId, generation, cashierId } = sale;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 5002))', [tenantId + ':' + plan.id]);
  const profile = await db.query<{ hospitality: boolean; services: boolean }>(
    'SELECT hospitality,services FROM omni.capability_profiles WHERE tenant_id=$1 AND version=$2', [tenantId, plan.profile],
  );
  if (!profile.rows[0]?.[plan.workflow.kind]) throw new InventoryError('MODULE_PROFILE_NOT_AUTHORIZED', 403);
  const pool = await db.query<{tips: string}>(`SELECT coalesce(sum((m.facts->>'tip')::integer),0) AS tips
    FROM omni.module_tenders m JOIN omni.retail_events e USING (tenant_id,event_id)
    WHERE e.tenant_id=$1 AND e.shift_id=$2`, [tenantId,sale.shiftId]);
  if (Number(pool.rows[0].tips) !== tipBefore) throw new InventoryError('TIP_POOL_CUT_MISMATCH',409);
  if (plan.workflow.kind === 'services') {
    const work = plan.workflow;
    requireApproval(sale, work.approval, 'service-estimate', serviceFacts(plan, work), supervisors);
    if (work.booking) {
      const booking = await db.query(`SELECT 1 FROM omni.service_appointments
        WHERE tenant_id=$1 AND booking_id=$2 AND store_id=$3 AND staff=$4`,
      [tenantId, work.booking, storeId, work.technician]);
      if (!booking.rowCount) throw new InventoryError('SERVICE_BOOKING_REQUIRED', 422);
    }
  }
  const hash = digest(jsonBytes([storeId,terminalId,generation,cashierId,plan]));
  const { rows } = await db.query<{ check_no: number; paid_minor: number; plan_digest: string;
    facts: { claimed: string[]; stock?: {source:string; lineId:string; backordered:number}[] } }>(`SELECT check_no,paid_minor,plan_digest,facts FROM omni.module_tenders
    WHERE tenant_id=$1 AND aggregate_id=$2`, [tenantId, plan.id]);
  if (rows.some(row => row.plan_digest !== hash) ||
      rows.filter(row => row.check_no === check).reduce((sum,row) => sum + row.paid_minor, 0) !== before)
    throw new InventoryError('MODULE_CHECK_CONFLICT', 409);
  const prior = new Set(rows.flatMap(row => row.facts.claimed));
  const lines = paymentLines(plan, check, before, paid);
  const expected = lines.filter(line => line.source.item !== 'labor' && !prior.has(line.source.id));
  if (expected.length !== claims.length || expected.some(line => !claims.some(claim => claim.source === line.source.id)))
    throw new InventoryError('MODULE_PHYSICAL_CLAIM_REQUIRED', 422);
  const owners = new Map(rows.flatMap(row => row.facts.stock ?? []).map(stock => [stock.source,stock]));
  const priorShortfalls = new Set(lines.flatMap((line,index) =>
    owners.get(line.source.id)?.backordered ? [sale.lines[index].id] : []));
  return { hash, priorShortfalls, stock: lines.flatMap((line,index) =>
    sale.lines[index].units.length ? [{source:line.source.id,lineId:sale.lines[index].id,index}] : []),
  facts: { tip, claimed: claims.map(claim => claim.source),
    allocations: lines.map(({ source, ...line },index) => ({
      source:source.id, ...line, stockLine:owners.get(source.id)?.lineId ?? (sale.lines[index].units.length ? sale.lines[index].id : null),
    })), ...moduleAccrual(event) } };
}

async function writeCount(db: PoolClient, e: RetailCount, supervisors: readonly Supervisor[]) {
  if (e.expectedMinor !== await expectedDrawer(db, e.tenantId, e.shiftId)) throw new InventoryError('CLOSE_CASH_CUT_MISMATCH', 409);
  const pending = await db.query(`
    SELECT 1 FROM omni.retail_refunds WHERE tenant_id=$1 AND shift_id=$2 AND state IN ('RESERVED','PAYOUT_PENDING')
  `, [e.tenantId, e.shiftId]);
  if (pending.rowCount) throw new InventoryError('PENDING_PAYOUT_BLOCKS_CLOSE', 409);
  const { rows: [previous] } = await db.query<{ event_id: string; variance_minor: number }>(`
    SELECT event_id,variance_minor FROM omni.retail_closes WHERE tenant_id=$1 AND shift_id=$2 ORDER BY covered_no DESC LIMIT 1
  `, [e.tenantId, e.shiftId]);
  if (e.kind === 'REVISION') {
    requireApproval(e, e.approval, 'revision', revisionFacts(e), supervisors);
    if (!previous || previous.event_id !== e.previousId) throw new InventoryError('CLOSE_LINEAGE_CONFLICT', 409);
  }
  const variance = e.countedMinor - e.expectedMinor;
  await db.query('INSERT INTO omni.retail_closes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [e.tenantId, e.saleId, e.shiftId, e.previousId, e.covers, e.countedMinor, e.expectedMinor, variance,
      variance - (previous?.variance_minor ?? 0)]);
}

export async function admitRetail(
  db: PoolClient, e: RetailEvent, bytes: Buffer, custodyKeys: ReadonlyMap<string, KeyObject>, supervisors: readonly Supervisor[],
  card?:CardApplication,
  module?:ModuleSale,
): Promise<Admission> {
  await ledgerWriter(db,e.tenantId);
  const hash = digest(bytes);
    const known = await loadStored(db, e, hash);
    if (known) return known;
    if (e.kind === 'OPEN') {
      if (e.saleId !== e.shiftId) throw new InventoryError('SHIFT_OPEN_ID_MISMATCH');
      await db.query(`
        INSERT INTO omni.retail_shifts (tenant_id,shift_id,store_id,terminal_id,generation,cashier_id,drawer_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,shift_id) DO NOTHING
      `, [e.tenantId, e.shiftId, e.storeId, e.terminalId, e.generation, e.cashierId, e.drawerId]);
    }
    const shift: Shift | undefined = await retailShift(db, e, e.shiftId);
    if (!shift) return { hold: 'SHIFT_OPEN_MISSING' };
    const recheck = await loadStored(db, e, hash);
    if (recheck) return recheck;
    if (e.sequence <= shift.source_no) return { conflict: 'SEQUENCE_CONFLICT' };
    if (e.sequence !== shift.source_no + 1) return { hold: 'SHIFT_SEQUENCE_GAP' };
    if (shift.closed !== (e.kind === 'REVISION')) throw new InventoryError('SHIFT_STATE_REJECTED', 409);
    const moduleRecord = module && await validateModule(db, module, supervisors);
    const plan = e.kind === 'SALE' ? await planSale(db, e, custodyKeys, supervisors, moduleRecord?.priorShortfalls) : undefined;
    if (e.kind === 'SALE' && !plan) return { hold: 'CUSTODY_RECEIPT_MISSING' };
    const refund = e.kind === 'RETURN' ? await verifyPayout(db, e, supervisors) : undefined;
    if (e.kind === 'DROP') {
      if (e.destinationId === shift.drawer_id) throw new InventoryError('INVALID_DRAWER_DROP');
      requireApproval(e, e.approval, 'drop', dropFacts(e), supervisors);
      const pending = await db.query("SELECT 1 FROM omni.retail_refunds WHERE tenant_id=$1 AND shift_id=$2 AND state='PAYOUT_PENDING'",
        [e.tenantId, e.shiftId]);
      if (pending.rowCount) throw new InventoryError('PENDING_PAYOUT_BLOCKS_DROP', 409);
    }
    const ack = ackBody(module ? {...e,version:5} : card ? {...e,version:4} : e, hash,
      plan?.results.some(line => line.backordered) ? 'BACKORDER' : 'COMMITTED');
    const body = jsonBytes(plan ? { ...ack, lines: plan.results } : ack);
    await db.query('INSERT INTO omni.retail_events VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [e.tenantId, e.saleId, e.shiftId, e.sequence, e.kind, bytes, hash, body]);
    switch (e.kind) {
      case 'OPEN': await cash(db, e, e.floatMinor); break;
      case 'SALE':
        await writeSale(db, e, plan!, card, module);
        if (module && moduleRecord) await db.query('INSERT INTO omni.module_tenders VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [e.tenantId,e.saleId,module.plan.id,module.check,module.before,module.paid,moduleRecord.hash,
            JSON.stringify({...moduleRecord.facts,stock:moduleRecord.stock.map(({index,...row}) =>
              ({...row,backordered:plan!.results[index].backordered}))})]);
        break;
      case 'DROP': await cash(db, e, -e.amountMinor, e.destinationId); break;
      case 'RETURN': {
        await db.query('INSERT INTO omni.retail_receipts VALUES ($1,$2,$3,$4,$5)',
          [e.tenantId, e.receiptId, e.saleId, refund!.receiptId,
            `OmniPoint Refund\nReceipt ${e.receiptId}\nOriginal ${refund!.receiptId}\nCash USD ${(e.amountMinor / 100).toFixed(2)}`]);
        await cash(db, e, -e.amountMinor);
        await postMoney(db, e, refund!.basisMinor, refund!.taxMinor, -1);
        await db.query("UPDATE omni.retail_refunds SET state='CONFIRMED',payout_event_id=$2 WHERE tenant_id=$1 AND return_id=$2",
          [e.tenantId, e.returnId]);
        break;
      }
      case 'CLOSE':
      case 'REVISION': await writeCount(db, e, supervisors); break;
    }
    await db.query('UPDATE omni.retail_shifts SET source_no=$3,closed=$4 WHERE tenant_id=$1 AND shift_id=$2',
      [e.tenantId, e.shiftId, e.sequence, e.kind === 'CLOSE' || e.kind === 'REVISION']);
    return { body };
}

export async function ingestModule(
  pool: Pool, event: ModuleSale, bytes: Buffer, signer: SigningKey,
  custodyKeys: ReadonlyMap<string, KeyObject>, supervisors: readonly Supervisor[],
) {
  const { sale } = event;
  const result = await tenantTransaction(pool, sale.tenantId,
    db => admitRetail(db, sale, bytes, custodyKeys, supervisors, undefined, event));
  return voucherRetail(pool, {...sale, version:5}, bytes, signer, result);
}

export async function ingestRetail(
  pool: Pool, event: RetailEvent, bytes: Buffer, signer: SigningKey,
  custodyKeys: ReadonlyMap<string, KeyObject>, supervisors: readonly Supervisor[],
): Promise<Voucher | { hold: string }> {
  const result = await tenantTransaction(pool,event.tenantId,db=>admitRetail(db,event,bytes,custodyKeys,supervisors));
  return voucherRetail(pool,event,bytes,signer,result);
}

export async function voucherRetail(
  pool:Pool,event:import('./protocol.ts').VoucherEvent,bytes:Buffer,signer:SigningKey,result:Admission,
): Promise<Voucher|{hold:string}> {
  if ('hold' in result) return result;
  if ('conflict' in result) return signVoucher(409, jsonBytes(ackBody(event, digest(bytes), result.conflict)), signer);
  return tenantTransaction(pool, event.tenantId, async db => {
    const key = [event.tenantId, event.saleId];
    const lookup = () => db.query<VoucherRow>('SELECT key_id,signature FROM omni.retail_vouchers WHERE tenant_id=$1 AND event_id=$2', key);
    let stored = (await lookup()).rows[0];
    if (!stored) {
      const voucher = signVoucher(200, result.body, signer);
      await db.query('INSERT INTO omni.retail_vouchers VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [...key, voucher.keyId, voucher.signature]);
      stored = (await lookup()).rows[0];
    }
    return { status: 200, bytes: result.body, keyId: stored.key_id, signature: stored.signature };
  });
}
