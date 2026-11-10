import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { tenantTransaction } from './postgres.ts';
import {
  ackBody, digest, isScope, jsonBytes, maxEventBytes, parseEvent, printableReceipt,
  readBounded, sameScope, signVoucher,
} from './protocol.ts';
import type { Disposition, SaleEvent, Scope, SigningKey, Voucher } from './protocol.ts';

export interface Enrollment extends Scope { token: string }
interface StoredVoucher { body: Buffer; key_id: string; signature: string }
type Claim = { body: Buffer } | { conflict: Exclude<Disposition, 'COMMITTED'> };
type Delivery = { bytes: Buffer; digest: string; event: SaleEvent };

interface CloudObservers {
  received?: (delivery: Delivery) => void;
  saleCommitted?: (delivery: Delivery) => Promise<void>;
  beforeResponse?: (voucher: Voucher, response: ServerResponse) => Promise<void>;
  failed?: (error: unknown) => void;
}

function pgConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' &&
    'constraint' in error && error.constraint === 'sales_terminal_sequence';
}

async function claimSale(pool: Pool, delivery: Delivery): Promise<Claim> {
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
      const { rows: [winner] } = await db.query<{ request_digest: string; body: Buffer }>(`
        SELECT s.request_digest, o.body FROM omni.sales s JOIN omni.outcomes o USING (tenant_id, sale_id)
        WHERE s.tenant_id = $1 AND s.sale_id = $2
      `, [tenantId, saleId]);
      if (winner) {
        return winner.request_digest === requestDigest ? { body: winner.body } : { conflict: 'SALE_ID_CONFLICT' };
      }
      const sequenceOwner = await db.query(`
        SELECT sale_id FROM omni.sales WHERE tenant_id = $1 AND terminal_id = $2
          AND terminal_generation = $3 AND local_sequence_no = $4
      `, [tenantId, terminalId, generation, sequence]);
      if (sequenceOwner.rowCount === 1) return { conflict: 'SEQUENCE_CONFLICT' };
      throw new Error('Missing committed claim');
    }

    const stock = await db.query(`
      UPDATE omni.stock SET on_hand = on_hand - 1
      WHERE tenant_id = $1 AND store_id = $2 AND sku = $3 AND on_hand >= 1 RETURNING on_hand
    `, [tenantId, storeId, e.line.sku]);
    if (stock.rowCount !== 1) throw new Error('Stock unavailable');
    await db.query('INSERT INTO omni.receipts VALUES ($1,$2,$3,$4)',
      [tenantId, e.receiptId, saleId, printableReceipt(e)]);
    await db.query('INSERT INTO omni.sale_lines VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [tenantId, e.line.id, saleId, storeId, e.line.sku, e.line.label, e.line.quantity, e.line.unitMinor]);
    await db.query('INSERT INTO omni.stock_movements VALUES ($1,$2,$3)', [tenantId, e.line.id, e.line.stockDelta]);
    await db.query('INSERT INTO omni.journals VALUES ($1,$2,$3,$4)', [tenantId, saleId, e.currency, e.totalMinor]);
    await db.query(`
      INSERT INTO omni.journal_lines VALUES ($1,$2,'Cash','DR',$3), ($1,$2,'Revenue','CR',$3)
    `, [tenantId, saleId, e.totalMinor]);
    const ack = ackBody(e, requestDigest, 'COMMITTED');
    const body = jsonBytes(ack);
    await db.query('INSERT INTO omni.outcomes VALUES ($1,$2,$3,$4)', [tenantId, saleId, ack.ackId, body]);
    return { body };
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
) {
  const enrolled = new Map<string, Scope>();
  for (const { token, ...scope } of enrollments) {
    if (!isScope(scope) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(token) || enrolled.has(token)) {
      throw new Error('Invalid terminal enrollment');
    }
    enrolled.set(token, scope);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(signer.id) ||
      signer.key.type !== 'private' || signer.key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Invalid signing key');
  }
  return createServer({ requestTimeout: 8000, headersTimeout: 5000 }, async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/sales') {
      response.writeHead(404, { connection: 'close' }).end();
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{24,128})$/.exec(request.headers.authorization ?? '')?.[1];
    const scope = token && enrolled.get(token);
    if (!scope) {
      response.writeHead(401, { connection: 'close' }).end();
      return;
    }
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) {
      response.writeHead(415, { connection: 'close' }).end();
      return;
    }
    if (Number(request.headers['content-length']) > maxEventBytes) {
      response.writeHead(413, { connection: 'close' }).end();
      return;
    }
    let delivery: Delivery;
    try {
      const bytes = await readBounded(request.iterator({ destroyOnReturn: false }), maxEventBytes);
      const requestDigest = digest(bytes);
      delivery = { bytes, digest: requestDigest, event: parseEvent(bytes) };
    } catch {
      response.writeHead(400, { connection: 'close' }).end();
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
      const claim = await claimSale(pool, delivery);
      let voucher: Voucher;
      if ('conflict' in claim) {
        voucher = signVoucher(409, jsonBytes(ackBody(delivery.event, delivery.digest, claim.conflict)), signer);
      } else {
        await observers?.saleCommitted?.(delivery);
        voucher = await issueVoucher(pool, delivery.event, claim.body, signer);
      }
      await observers?.beforeResponse?.(voucher, response);
      if (!response.destroyed) {
        response.writeHead(voucher.status, {
          'content-type': 'application/json', 'content-length': voucher.bytes.length,
          'omni-key-id': voucher.keyId, 'omni-algorithm': 'ed25519', 'omni-signature': voucher.signature,
        }).end(voucher.bytes);
      }
    } catch (error) {
      observers?.failed?.(error);
      if (!response.destroyed) response.writeHead(503).end();
    }
  });
}
