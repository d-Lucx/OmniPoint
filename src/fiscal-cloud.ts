import type { KeyObject } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { exact } from './authority.ts';
import { cardPrintable, parseCard } from './card-event.ts';
import {
  covers,
  deviceKey,
  readEnrollment,
  readFiscalReceipt,
  readGenesis,
  readGrant,
  sameEpoch,
} from './fiscal-protocol.ts';
import { applyPayment, captured, verifiedPayment } from './payment-cloud.ts';
import type { PaymentTrust } from './payment-cloud.ts';
import { tenantTransaction } from './postgres.ts';
import { digest, isUuid, jsonBytes, sameScope } from './protocol.ts';
import type { Scope, SigningKey } from './protocol.ts';
import { InventoryError } from './quota-cloud.ts';
import { admitRetail, voucherRetail } from './retail-cloud.ts';
import type { Supervisor } from './retail-protocol.ts';

type Anchor = {
  enrollment: unknown;
  head_sequence: number;
  head_digest: string | null;
  retired_by: string | null;
  generation: number;
  store_id: string;
};
type Entry = {
  status: string;
  reason: string | null;
  event_digest: string;
  body: Buffer;
  sequence: number;
  receipt_digest: string;
};

function lock(db: PoolClient, tenantId: string, terminalId: string) {
  return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 71422401))', [
    tenantId + '/' + terminalId,
  ]);
}

async function anchor(db: PoolClient, tenantId: string, epochId: string): Promise<Anchor> {
  const {
    rows: [row],
  } = await db.query<Anchor>('SELECT * FROM omni.fiscal_epochs WHERE tenant_id=$1 AND epoch_id=$2', [
    tenantId,
    epochId,
  ]);
  if (!row) throw new InventoryError('FISCAL_EPOCH_UNKNOWN', 422);
  return row;
}

export async function fiscalOperator(
  pool: Pool,
  tenantId: string,
  input: Record<string, unknown>,
  trust: PaymentTrust,
) {
  if (input.action === 'fiscal-inspect' && isUuid(input.epochId)) {
    const epochId = input.epochId;
    return tenantTransaction(pool, tenantId, async (db) => {
      const row = await anchor(db, tenantId, epochId);
      const { rows } = await db.query(
        `SELECT sequence,receipt_digest,event_id,status,reason FROM omni.fiscal_observations
        WHERE tenant_id=$1 AND epoch_id=$2 ORDER BY sequence LIMIT 100`,
        [tenantId, epochId],
      );
      return {
        sequence: row.head_sequence,
        digest: row.head_digest,
        retiredBy: row.retired_by,
        observations: rows,
      };
    });
  }
  if (input.action !== 'fiscal-enroll') throw new InventoryError('UNKNOWN_FISCAL_ACTION', 400);
  const enrolled = readEnrollment(input.enrollment, trust.fiscalRoots);
  const genesis = readGenesis(input.genesis, trust.fiscalRoots);
  if (enrolled.tenantId !== tenantId || !sameEpoch(enrolled, genesis))
    throw new InventoryError('FISCAL_ENROLLMENT_REJECTED', 403);
  return tenantTransaction(pool, tenantId, async (db) => {
    await lock(db, tenantId, enrolled.terminalId);
    const prior = await db.query('SELECT 1 FROM omni.fiscal_epochs WHERE tenant_id=$1 AND epoch_id=$2', [
      tenantId,
      enrolled.epochId,
    ]);
    if (prior.rowCount) {
      const identical = await db.query(
        'SELECT 1 FROM omni.fiscal_epochs WHERE tenant_id=$1 AND epoch_id=$2 AND enrollment=$3 AND genesis=$4',
        [tenantId, enrolled.epochId, JSON.stringify(input.enrollment), JSON.stringify(input.genesis)],
      );
      if (!identical.rowCount) throw new InventoryError('FISCAL_ENROLLMENT_CONFLICT', 409);
      return { epochId: enrolled.epochId };
    }
    const {
      rows: [active],
    } = await db.query<Anchor & { epoch_id: string }>(
      'SELECT * FROM omni.fiscal_epochs WHERE tenant_id=$1 AND terminal_id=$2 AND retired_by IS NULL',
      [tenantId, enrolled.terminalId],
    );
    if (
      (active?.epoch_id ?? null) !== genesis.previousEpochId ||
      (active && (active.generation > enrolled.generation || active.store_id !== enrolled.storeId))
    ) {
      throw new InventoryError('REPLACEMENT_GENESIS_REQUIRED', 409);
    }
    if (active)
      await db.query(
        'UPDATE omni.fiscal_epochs SET retired_by=$3 WHERE tenant_id=$1 AND epoch_id=$2 AND retired_by IS NULL',
        [tenantId, active.epoch_id, enrolled.epochId],
      );
    await db.query(
      `INSERT INTO omni.fiscal_epochs(tenant_id,epoch_id,store_id,terminal_id,generation,enrollment,genesis)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        tenantId,
        enrolled.epochId,
        enrolled.storeId,
        enrolled.terminalId,
        enrolled.generation,
        JSON.stringify(input.enrollment),
        JSON.stringify(input.genesis),
      ],
    );
    return { epochId: enrolled.epochId };
  });
}

function verifyCard(bytes: Buffer, scope: Scope, a: Anchor, trust: PaymentTrust) {
  const { envelope, sale, saleBytes } = parseCard(bytes);
  const enrolled = readEnrollment(a.enrollment, trust.fiscalRoots);
  const signed = readFiscalReceipt(envelope.proof, new Map([[enrolled.deviceId, deviceKey(enrolled)]]));
  const receipt = signed.receipt;
  const grant = readGrant(envelope.grant, trust.fiscalRoots);
  const capture = verifiedPayment(scope, envelope.capture, trust);
  const op = capture.fact.operation;
  if (
    !sameScope(sale, scope) ||
    !sameScope(receipt, scope) ||
    !sameEpoch(receipt, enrolled) ||
    receipt.saleId !== sale.saleId ||
    receipt.receiptId !== sale.receiptId ||
    receipt.saleDigest !== digest(saleBytes) ||
    receipt.captureDigest !== digest(capture.bytes) ||
    capture.fact.state !== 'CAPTURED' ||
    op.intentId !== sale.saleId ||
    op.amountMinor !== sale.totalMinor ||
    op.basketDigest !== receipt.saleDigest ||
    receipt.grantId !== grant.grantId ||
    !covers(grant, receipt, receipt.lower, receipt.upper)
  )
    throw new InventoryError('FISCAL_RECEIPT_BINDING_REJECTED', 422);
  return { sale, receipt, grant, capture, envelope, receiptDigest: digest(signed.bytes) };
}

export async function ingestCard(
  pool: Pool,
  scope: Scope,
  bytes: Buffer,
  signer: SigningKey,
  trust: PaymentTrust,
  custodyKeys: ReadonlyMap<string, KeyObject>,
  supervisors: readonly Supervisor[],
) {
  const decoded = parseCard(bytes);
  if (!sameScope(decoded.sale, scope)) throw new InventoryError('FISCAL_SCOPE_REJECTED', 403);
  const hint = exact(JSON.parse(Buffer.from(decoded.envelope.proof.body, 'base64url').toString('utf8')), [
    'tenantId',
    'storeId',
    'terminalId',
    'generation',
    'cashierId',
    'deviceId',
    'epochId',
    'series',
    'saleId',
    'receiptId',
    'sequence',
    'predecessor',
    'saleDigest',
    'captureDigest',
    'grantId',
    'lower',
    'upper',
  ]);
  if (!isUuid(hint.epochId)) throw new InventoryError('FISCAL_EPOCH_UNKNOWN', 422);
  const epochId = hint.epochId;
  const tenantId = scope.tenantId;
  const staged = await tenantTransaction(pool, tenantId, async (db) => {
    await lock(db, tenantId, scope.terminalId);
    const a = await anchor(db, tenantId, epochId);
    const verified = verifyCard(bytes, scope, a, trust);
    const { receipt, receiptDigest, grant, envelope } = verified;
    const hash = digest(bytes);
    const keys = [tenantId, epochId, receipt.sequence];
    const {
      rows: [existing],
    } = await db.query<Entry>(
      `SELECT * FROM omni.fiscal_observations
      WHERE tenant_id=$1 AND epoch_id=$2 AND sequence=$3 AND receipt_digest=$4`,
      [...keys, receiptDigest],
    );
    if (existing) {
      if (existing.event_digest !== hash) throw new InventoryError('FISCAL_EVENT_BYTES_CONFLICT', 409);
      return verified;
    }
    const {
      rows: [occupied],
    } = await db.query<Entry>(
      `SELECT * FROM omni.fiscal_observations
      WHERE tenant_id=$1 AND epoch_id=$2 AND sequence=$3 AND status IN ('PENDING','APPLIED')`,
      keys,
    );
    const status = a.retired_by ? 'LATE' : occupied || receipt.sequence <= a.head_sequence ? 'FORK' : 'PENDING';
    const reason = status === 'LATE' ? 'FISCAL_RETIRED' : status === 'FORK' ? 'FISCAL_FORK' : 'FISCAL_GAP';
    await db.query('INSERT INTO omni.fiscal_observations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      ...keys,
      receiptDigest,
      receipt.saleId,
      hash,
      bytes,
      status,
      reason,
    ]);
    const grantHash = digest(Buffer.from(envelope.grant.body, 'base64url'));
    await db.query('INSERT INTO omni.fiscal_grants VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [
      tenantId,
      grant.grantId,
      epochId,
      JSON.stringify(envelope.grant),
      grantHash,
    ]);
    const {
      rows: [prior],
    } = await db.query<{ digest: string }>(
      'SELECT digest FROM omni.fiscal_grants WHERE tenant_id=$1 AND grant_id=$2',
      [tenantId, grant.grantId],
    );
    if (prior.digest !== grantHash) throw new InventoryError('FISCAL_GRANT_CONFLICT', 409);
    if (status === 'PENDING') await captured(db, verified.capture, envelope.capture);
    return verified;
  });
  // Each promotion releases its stock locks before considering the next basket. The pending row
  // is a durable wake-up that can also be resumed by a successor or predecessor retry.
  for (let i = 0; i < 100; i++) {
    const advanced = await tenantTransaction(pool, tenantId, async (db) => {
      await lock(db, tenantId, scope.terminalId);
      const a = await anchor(db, tenantId, epochId);
      if (a.retired_by) return false;
      const {
        rows: [next],
      } = await db.query<Entry>(
        `SELECT * FROM omni.fiscal_observations
        WHERE tenant_id=$1 AND epoch_id=$2 AND sequence=$3 AND status='PENDING'`,
        [tenantId, epochId, a.head_sequence + 1],
      );
      if (!next) return false;
      const current = verifyCard(next.body, scope, a, trust);
      const keys = [tenantId, epochId, next.sequence, next.receipt_digest];
      const setStatus = (status: string, reason: string | null) =>
        db.query(
          `UPDATE omni.fiscal_observations SET status=$5,reason=$6
        WHERE tenant_id=$1 AND epoch_id=$2 AND sequence=$3 AND receipt_digest=$4`,
          [...keys, status, reason],
        );
      if (current.receipt.predecessor !== a.head_digest) {
        await setStatus('FORK', 'FISCAL_FORK');
        return false;
      }
      const funds = await captured(db, current.capture, current.envelope.capture);
      if (funds.state !== 'CAPTURED') {
        await setStatus('PENDING', 'FISCAL_DEPENDENCY_HELD');
        return false;
      }
      const result = await admitRetail(db, current.sale, next.body, custodyKeys, supervisors, {
        printable: cardPrintable(current.sale, current.receipt),
        apply: (conn) => applyPayment(conn, current.capture, current.sale),
      });
      if (!('body' in result)) {
        await setStatus('PENDING', 'FISCAL_DEPENDENCY_HELD');
        return false;
      }
      await setStatus('APPLIED', null);
      const changed = await db.query(
        `UPDATE omni.fiscal_epochs SET head_sequence=$3,head_digest=$4
        WHERE tenant_id=$1 AND epoch_id=$2 AND head_sequence=$5 AND retired_by IS NULL`,
        [tenantId, epochId, next.sequence, next.receipt_digest, a.head_sequence],
      );
      if (changed.rowCount !== 1) throw new Error('Fiscal head changed');
      return true;
    });
    if (!advanced) break;
  }
  const final = await tenantTransaction(pool, tenantId, async (db) => {
    const {
      rows: [row],
    } = await db.query<{
      status: string;
      reason: string | null;
      ack: Buffer | null;
      retired_by: string | null;
    }>(
      `
      SELECT o.status,o.reason,e.ack,f.retired_by FROM omni.fiscal_observations o JOIN omni.fiscal_epochs f USING(tenant_id,epoch_id)
      LEFT JOIN omni.retail_events e ON e.tenant_id=o.tenant_id AND e.event_id=o.event_id AND e.digest=o.event_digest
      WHERE o.tenant_id=$1 AND o.epoch_id=$2 AND o.sequence=$3 AND o.receipt_digest=$4`,
      [tenantId, epochId, staged.receipt.sequence, staged.receiptDigest],
    );
    return row.status === 'APPLIED' && row.ack
      ? { body: row.ack }
      : { hold: row.retired_by ? 'FISCAL_RETIRED' : (row.reason ?? 'FISCAL_GAP') };
  });
  return voucherRetail(pool, { ...staged.sale, version: 4 }, bytes, signer, final);
}
