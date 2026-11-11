import { createServer } from 'node:http';
import type { KeyObject } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { inventoryAction } from './inventory-api.ts';
import type { InventoryOptions } from './inventory-api.ts';
import { ingestModule, ingestRetail } from './retail-cloud.ts';
import { parseModuleSale } from './module-sale.ts';
import { retailInventoryAction } from './retail-inventory.ts';
import { parseRetail, retailBodyLimit } from './retail-protocol.ts';
import type { RetailEvent } from './retail-protocol.ts';
import { cardBodyLimit,parseCard } from './card-event.ts';
import { fiscalOperator,ingestCard } from './fiscal-cloud.ts';
import { inspectPayment,paymentAction } from './payment-cloud.ts';
import { returnAction } from './retail-returns-cloud.ts';
import { FleetAdmission, ModuleError, moduleAction } from './module-cloud.ts';
import { signArtifact } from './authority.ts';
import { governanceAction, isSealedPeriodError, retainLatePosting } from './governance-api.ts';
import { ledgerWriter } from './period-close.ts';
import { validateTreasuryTrust } from './treasury-protocol.ts';
import { tenantTransaction } from './postgres.ts';
import { admitQuota, decrementStock, InventoryError, lockStock, salePosition, saveOutcome, settleQuota } from './quota-cloud.ts';
import {
  ackBody, decode, digest, isScope, isUuid, jsonBytes, maxEventBytes, parseEvent, printableReceipt,
  readBounded, sameScope, signVoucher,
} from './protocol.ts';
import type { Conflict, SaleEvent, Scope, SigningKey, Voucher } from './protocol.ts';

export interface Enrollment extends Scope { token: string }
interface StoredVoucher { body: Buffer; key_id: string; signature: string }
type Claim = { body: Buffer } | { conflict: Conflict } | { staged: true };
type Delivery = { bytes: Buffer; digest: string; event: SaleEvent };

interface CloudObservers {
  moduleWork?: (db: PoolClient, scope: Scope, action: unknown) => Promise<void>;
  cardReceived?: (bytes:Buffer)=>void;
  retailReceived?: (event: RetailEvent, bytes: Buffer) => void;
  received?: (delivery: Delivery) => void;
  saleCommitted?: (delivery: Delivery) => Promise<void>;
  beforeResponse?: (voucher: Voucher, response: ServerResponse) => Promise<void>;
  failed?: (error: unknown) => void;
}

function sendVoucher(response: ServerResponse, voucher: Voucher) {
  if (!response.destroyed) response.writeHead(voucher.status, {
    'content-type': 'application/json', 'content-length': voucher.bytes.length,
    'omni-key-id': voucher.keyId, 'omni-algorithm': 'ed25519', 'omni-signature': voucher.signature,
  }).end(voucher.bytes);
}

function pgConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' &&
    'constraint' in error && error.constraint === 'sales_terminal_sequence';
}

async function claimSale(pool: Pool, delivery: Delivery, custodyKeys: ReadonlyMap<string, KeyObject>): Promise<Claim> {
  const { event: e, digest: requestDigest } = delivery;
  const { tenantId, saleId, storeId, terminalId, generation, sequence } = e;
  return tenantTransaction(pool, tenantId, async db => {
    await db.query('SAVEPOINT claim_sale');
    let inserted = false;
    try {
      const result = await db.query(`
        INSERT INTO omni.sales (tenant_id, sale_id, store_id, terminal_id, terminal_generation,
          local_sequence_no, cashier_id, request_digest, currency, total_minor, cash_minor, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (tenant_id, sale_id) DO NOTHING RETURNING sale_id
      `, [tenantId, saleId, storeId, terminalId, generation, sequence, e.cashierId, requestDigest,
        e.currency, e.totalMinor, e.tender.cashMinor, e.occurredAt]);
      inserted = result.rowCount === 1;
    } catch (error) {
      if (!pgConflict(error)) throw error;
      await db.query('ROLLBACK TO SAVEPOINT claim_sale');
    }
    await db.query('RELEASE SAVEPOINT claim_sale');
    if (!inserted) {
      // The insert may have waited for a transaction invisible to its original snapshot.
      const { rows: [winner] } = await db.query<{ request_digest: string; body: Buffer | null }>(`
        SELECT s.request_digest, o.body FROM omni.sales s LEFT JOIN omni.outcomes o USING (tenant_id, sale_id)
        WHERE s.tenant_id = $1 AND s.sale_id = $2
      `, [tenantId, saleId]);
      if (winner) {
        if (winner.request_digest !== requestDigest) return { conflict: 'SALE_ID_CONFLICT' };
        return winner.body ? { body: winner.body } : { staged: true };
      }
      const sequenceOwner = await db.query(`
        SELECT sale_id FROM omni.sales WHERE tenant_id = $1 AND terminal_id = $2
          AND terminal_generation = $3 AND local_sequence_no = $4
      `, [tenantId, terminalId, generation, sequence]);
      if (sequenceOwner.rowCount === 1) return { conflict: 'SEQUENCE_CONFLICT' };
      throw new Error('Missing committed claim');
    }

    await ledgerWriter(db,tenantId);
    const stock = { tenantId, storeId, sku: e.line.sku };
    await lockStock(db, stock);
    const position = await salePosition(db, stock);
    if (e.version === 1 && position) throw new InventoryError('Quota is required for new sales at this position');
    const ready = e.version === 2 && await admitQuota(db, e, position, delivery.bytes, custodyKeys);
    await db.query('INSERT INTO omni.receipts VALUES ($1,$2,$3,$4)',
      [tenantId, e.receiptId, saleId, printableReceipt(e)]);
    await db.query('INSERT INTO omni.sale_lines VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [tenantId, e.line.id, saleId, storeId, e.line.sku, e.line.label, e.line.quantity, e.line.unitMinor]);
    await db.query('INSERT INTO omni.journals VALUES ($1,$2,$3,$4)', [tenantId, saleId, e.currency, e.totalMinor]);
    await db.query(`
      INSERT INTO omni.journal_lines VALUES ($1,$2,'Cash','DR',$3), ($1,$2,'Revenue','CR',$3)
    `, [tenantId, saleId, e.totalMinor]);
    if (e.version === 2) return ready ? { body: await settleQuota(db, e, requestDigest) } : { staged: true };
    await decrementStock(db, stock);
    await db.query('INSERT INTO omni.stock_movements VALUES ($1,$2,$3)', [tenantId, e.line.id, e.line.stockDelta]);
    return { body: await saveOutcome(db, e, requestDigest, 'COMMITTED') };
  });
}

async function issueVoucher(pool: Pool, event: SaleEvent, body: Buffer, signer: SigningKey): Promise<Voucher> {
  const params = [event.tenantId, event.saleId];
  const status = 200;
  return tenantTransaction(pool, event.tenantId, async db => {
    const lookup = () => db.query<StoredVoucher>(`
      SELECT o.body, v.key_id, v.signature FROM omni.vouchers v
      JOIN omni.outcomes o USING (tenant_id, sale_id)
      WHERE v.tenant_id = $1 AND v.sale_id = $2
    `, params);
    let stored = (await lookup()).rows[0];
    if (!stored) {
      const candidate = signVoucher(status, body, signer);
      await db.query(`
        INSERT INTO omni.vouchers VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id, sale_id) DO NOTHING
      `, [...params, candidate.keyId, candidate.signature]);
      stored = (await lookup()).rows[0];
      if (!stored) throw new Error('Missing persisted voucher');
    }
    return { status, bytes: stored.body, keyId: stored.key_id, signature: stored.signature };
  });
}

export function createCloud(
  pool: Pool, enrollments: readonly Enrollment[], signer: SigningKey, observers?: CloudObservers,
  inventory: InventoryOptions = {},
) {
  if (inventory.treasury) validateTreasuryTrust(inventory.treasury);
  async function holdLate(response:ServerResponse, tenant:string, path:string, bytes:Buffer) {
    try {
      await retainLatePosting(pool,tenant,path,bytes);
      if (!response.destroyed) response.writeHead(202,{'content-type':'application/json'})
        .end(jsonBytes({reason:'PERIOD_SEALED'}));
    } catch {
      if (!response.destroyed) response.writeHead(503).end();
    }
  }
  const enrolled = new Map<string, Scope>();
  for (const { token, ...scope } of enrollments) {
    if (!isScope(scope) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(token) || enrolled.has(token)) {
      throw new Error('Invalid terminal enrollment');
    }
    enrolled.set(token, scope);
  }
  const operators = new Map<string, { tenantId: string; actorId?: string; governance?: true }>();
  for (const { token, tenantId, actorId, governance } of inventory.operators ?? []) {
    if (!isUuid(tenantId) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(token) ||
        enrolled.has(token) || operators.has(token) || (actorId !== undefined && !isUuid(actorId)) ||
        (governance !== undefined && (governance !== true || !actorId))) {
      throw new Error('Invalid inventory operator enrollment');
    }
    operators.set(token, { tenantId, actorId, governance });
  }
  const custodyKeys = inventory.custodyKeys ?? new Map<string, KeyObject>();
  const fleet = pool.options.max >= 5 ? new FleetAdmission(pool.options.max) : undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(signer.id) ||
      signer.key.type !== 'private' || signer.key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Invalid signing key');
  }
  return createServer({ requestTimeout: 8000, headersTimeout: 5000 }, async (request, response) => {
    const governanceRoute = request.url === '/v6/governance';
    const operatorRoute = request.url === '/v2/inventory' || governanceRoute;
    const retail = request.url === '/v3/register';
    const refunds = request.url === '/v3/returns';
    const card = request.url === '/v4/register';
    const funds = request.url === '/v4/funds';
    const modules = request.url === '/v5/modules';
    const moduleSale = request.url === '/v5/register';
    if (request.method !== 'POST' || (!operatorRoute && !retail && !refunds && !card && !funds && !modules && !moduleSale && request.url !== '/v1/sales')) {
      response.writeHead(404, { connection: 'close' }).end();
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{24,128})$/.exec(request.headers.authorization ?? '')?.[1];
    const scope = token && enrolled.get(token);
    const operator = token && operators.get(token);
    if (!(operatorRoute ? operator : scope)) {
      response.writeHead(401, { connection: 'close' }).end();
      return;
    }
    if (governanceRoute && (!operator || !operator.governance || !inventory.governanceSigner)) {
      response.writeHead(403, {connection:'close'}).end();
      return;
    }
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) {
      response.writeHead(415, { connection: 'close' }).end();
      return;
    }
    const limit = card?cardBodyLimit:retail||moduleSale||governanceRoute?retailBodyLimit:maxEventBytes;
    if (Number(request.headers['content-length']) > limit) {
      response.writeHead(413, { connection: 'close' }).end();
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBounded(request.iterator({ destroyOnReturn: false }), limit);
    } catch {
      response.writeHead(400, { connection: 'close' }).end();
      return;
    }
    if (operatorRoute && operator) {
      let input: Record<string, unknown>;
      try {
        input = decode(bytes);
      } catch {
        response.writeHead(400).end();
        return;
      }
      try {
        const result = governanceRoute ?
          await governanceAction(pool,operator.tenantId,operator.actorId!,input,inventory.governanceSigner!,inventory.treasury) :
          input.action==='payment-inspect'&&inventory.payments&&operator.actorId ?
          await inspectPayment(pool,operator.tenantId,input) :
          typeof input.action==='string'&&input.action.startsWith('fiscal-')&&inventory.payments&&operator.actorId ?
          await fiscalOperator(pool,operator.tenantId,input,inventory.payments) :
          typeof input.action === 'string' && input.action.startsWith('retail-') ?
          await retailInventoryAction(pool, operator.tenantId, operator.actorId, input) :
          await inventoryAction(pool, operator.tenantId, input, signer, custodyKeys);
        response.writeHead(200, { 'content-type': 'application/json' }).end(jsonBytes(result));
      } catch (error) {
        if (governanceRoute) observers?.failed?.(error);
        const status = isSealedPeriodError(error) ? 409 : error instanceof InventoryError ? error.status :
          (typeof error === 'object' && error && 'code' in error && error.code === '23505' ? 409 : 503);
        response.writeHead(status).end();
      }
      return;
    }
    if (!scope) {
      response.writeHead(401).end();
      return;
    }
    if (modules) {
      try {
        const input = decode(bytes);
        if (!fleet) throw new ModuleError(503, 'MODULE_CAPACITY_UNAVAILABLE');
        const result = input.action === 'diagnostics' && Object.keys(input).length === 1 ?
          { purpose: 'MODULE_DIAGNOSTICS', scope, ...fleet.inspect(scope.tenantId) } :
          await fleet.run(scope.tenantId, input.action === 'book' ? 'booking' : 'background',
            () => moduleAction(pool, scope, input, observers?.moduleWork));
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(jsonBytes(signArtifact('module-v5', result, signer)));
      } catch (error) {
        const status = error instanceof ModuleError ? error.status : 'code' in Object(error) ? 503 : 422;
        if (status === 429) response.setHeader('retry-after', '1');
        response.writeHead(status, { 'content-type': 'application/json' })
          .end(jsonBytes({ reason: error instanceof ModuleError ? error.message : 'MODULE_REQUEST_HELD' }));
      }
      return;
    }
    if (moduleSale) {
      try {
        const event = parseModuleSale(bytes);
        if (!sameScope(event.sale,scope)) throw new ModuleError(403,'MODULE_SCOPE_REJECTED');
        if (!fleet) throw new ModuleError(503,'MODULE_CAPACITY_UNAVAILABLE');
        const result = await fleet.run(scope.tenantId, 'settlement', () =>
          ingestModule(pool,event,bytes,signer,custodyKeys,inventory.supervisors ?? []));
        if ('hold' in result) response.writeHead(202, {'content-type':'application/json'}).end(jsonBytes({reason:result.hold}));
        else {
          await observers?.beforeResponse?.(result,response);
          sendVoucher(response,result);
        }
      } catch (error) {
        observers?.failed?.(error);
        if (isSealedPeriodError(error)) {
          await holdLate(response,scope.tenantId,request.url!,bytes);
          return;
        }
        const status = error instanceof ModuleError || error instanceof InventoryError ? error.status : 'code' in Object(error) ? 503 : 422;
        if (!response.destroyed) {
          if (status === 429) response.setHeader('retry-after','1');
          response.writeHead(status, {'content-type':'application/json'}).end(jsonBytes({
            reason: error instanceof ModuleError || error instanceof InventoryError ? error.message : 'MODULE_TENDER_HELD',
          }));
        }
      }
      return;
    }
    if(card||funds) {
      if(!inventory.payments) { response.writeHead(404).end(); return; }
      try {
        if(funds) {
          const result=await paymentAction(pool,scope,decode(bytes),inventory.payments,inventory.supervisors??[]);
          sendVoucher(response,signVoucher(200,jsonBytes(result),signer));
        } else {
          parseCard(bytes);
          observers?.cardReceived?.(bytes);
          const result=await ingestCard(pool,scope,bytes,signer,inventory.payments,custodyKeys,inventory.supervisors??[]);
          if('hold' in result) response.writeHead(202,{'content-type':'application/json'}).end(jsonBytes({reason:result.hold}));
          else { await observers?.beforeResponse?.(result,response); sendVoucher(response,result); }
        }
      } catch(error) {
        observers?.failed?.(error);
        if (isSealedPeriodError(error)) {
          await holdLate(response,scope.tenantId,request.url!,bytes);
          return;
        }
        const status=error instanceof InventoryError?error.status:
          typeof error==='object'&&error&&'code' in error?503:422;
        if(!response.destroyed) response.writeHead(status,{'content-type':'application/json'})
          .end(jsonBytes({reason:error instanceof InventoryError?error.message:'PAYMENT_OR_FISCAL_REQUEST_HELD'}));
      }
      return;
    }
    if (retail || refunds) {
      let input: RetailEvent | Record<string, unknown>;
      try {
        input = retail ? parseRetail(bytes) : decode(bytes);
      } catch {
        response.writeHead(400).end();
        return;
      }
      try {
        if (refunds) {
          const result = await returnAction(pool, scope, input as Record<string, unknown>, inventory.supervisors ?? []);
          sendVoucher(response, signVoucher(200, jsonBytes(result), signer));
          return;
        }
        const event = input as RetailEvent;
        if (!sameScope(event, scope)) {
          response.writeHead(403).end();
          return;
        }
        const authenticated = { ...event, ...scope };
        observers?.retailReceived?.(authenticated, bytes);
        const result = await ingestRetail(pool, authenticated, bytes, signer, custodyKeys, inventory.supervisors ?? []);
        if ('hold' in result) {
          response.writeHead(202, { 'content-type': 'application/json' }).end(jsonBytes({ reason: result.hold }));
        } else {
          await observers?.beforeResponse?.(result, response);
          sendVoucher(response, result);
        }
      } catch (error) {
        observers?.failed?.(error);
        if (isSealedPeriodError(error)) {
          await holdLate(response,scope.tenantId,request.url!,bytes);
          return;
        }
        const status = error instanceof InventoryError ? error.status :
          (typeof error === 'object' && error && 'code' in error && error.code === '23505' ? 409 : 503);
        if (!response.destroyed) response.writeHead(status, { 'content-type': 'application/json' })
          .end(jsonBytes({ reason: error instanceof InventoryError ? error.message : 'RETAIL_REQUEST_HELD' }));
      }
      return;
    }
    let delivery: Delivery;
    try {
      const requestDigest = digest(bytes);
      delivery = { bytes, digest: requestDigest, event: parseEvent(bytes) };
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!sameScope(delivery.event, scope)) {
      response.writeHead(403).end();
      return;
    }
    // Use the authenticated enrollment for all scope-sensitive operations.
    delivery.event = { ...delivery.event, ...scope };
    try {
      observers?.received?.(delivery);
      const claim = await claimSale(pool, delivery, custodyKeys);
      if ('staged' in claim) {
        response.writeHead(202).end();
        return;
      }
      let voucher: Voucher;
      if ('conflict' in claim) {
        voucher = signVoucher(409, jsonBytes(ackBody(delivery.event, delivery.digest, claim.conflict)), signer);
      } else {
        await observers?.saleCommitted?.(delivery);
        voucher = await issueVoucher(pool, delivery.event, claim.body, signer);
      }
      await observers?.beforeResponse?.(voucher, response);
      sendVoucher(response, voucher);
    } catch (error) {
      observers?.failed?.(error);
      if (isSealedPeriodError(error)) {
        await holdLate(response,scope.tenantId,request.url!,bytes);
        return;
      }
      if (!response.destroyed) response.writeHead(error instanceof InventoryError ? error.status : 503).end();
    }
  });
}
