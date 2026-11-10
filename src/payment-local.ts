import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { exact } from './authority.ts';
import { cardPrintable } from './card-event.ts';
import type { CardEvent } from './card-event.ts';
import { sameEpoch } from './fiscal-protocol.ts';
import type { FiscalIntent } from './fiscal-protocol.ts';
import type { FiscalResult, FiscalSigner } from './fiscal-signer.ts';
import type { PaymentAdapter } from './payment-provider.ts';
import { parseOperation, paymentReason, sameOperation, sameRoute } from './payment-protocol.ts';
import type { Operation } from './payment-protocol.ts';
import { digest, isUuid, jsonBytes, sameScope } from './protocol.ts';
import type { Scope, SignedEvidence } from './protocol.ts';
import { parseRetail } from './retail-protocol.ts';
import type { Approval, RetailSale } from './retail-protocol.ts';

export interface PaymentOptions {
  adapter: PaymentAdapter;
  fiscal: FiscalSigner;
}
type Intent = {
  intent_id: string;
  sale: Uint8Array;
  state: string;
  attempt_id: string;
  capture: string | null;
  refund: string | null;
  fiscal_intent: string | null;
  refund_approval: string | null;
  reason: string | null;
  reported: number;
};
type Hooks = {
  build(id: string): RetailSale;
  finalize(sale: RetailSale, bytes: Buffer, printable: string, result: FiscalResult): void;
  receipt(id: string): unknown;
  approval(pin: unknown, action: string, facts: unknown): Approval;
  funds(action: string, payload: unknown): Promise<void>;
};

export class PaymentRegister {
  private readonly db: DatabaseSync;
  private readonly options: PaymentOptions;
  private readonly hooks: Hooks;
  constructor(db: DatabaseSync, scope: Scope, options: PaymentOptions, hooks: Hooks) {
    if (!sameScope(scope, options.adapter.route) || !sameScope(scope, options.fiscal.epoch))
      throw new Error('Payment enrollment mismatch');
    this.db = db;
    this.options = options;
    this.hooks = hooks;
  }
  private write<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private find(id: unknown) {
    if (!isUuid(id)) throw new Error('Payment intent UUID required');
    const row = this.db.prepare('SELECT * FROM payment_intents WHERE intent_id=?').get(id) as
      | Intent
      | undefined;
    if (!row) throw new Error('Unknown payment intent');
    return row;
  }
  private operation(attemptId: string): Operation {
    const row = this.db.prepare('SELECT operation FROM payment_attempts WHERE attempt_id=?').get(attemptId);
    if (!row) throw new Error('Unknown payment attempt');
    return parseOperation(JSON.parse(String(row.operation)));
  }
  private newOperation(
    intentId: string,
    sale: Buffer,
    amountMinor: number,
    originalAttemptId: string | null = null,
  ): Operation {
    return parseOperation({
      ...this.options.adapter.route,
      intentId,
      attemptId: randomUUID(),
      kind: originalAttemptId ? 'REFUND' : 'CAPTURE',
      originalAttemptId,
      currency: 'USD',
      amountMinor,
      basketDigest: digest(sale),
      preparedAt: new Date().toISOString(),
    });
  }
  private addAttempt(
    op: Operation,
    previous: string | null = null,
    reason: string | null = null,
    approval: Approval | null = null,
  ) {
    this.db
      .prepare(
        'INSERT INTO payment_attempts(attempt_id,intent_id,operation,previous_attempt,reason,approval) VALUES(?,?,?,?,?,?)',
      )
      .run(
        op.attemptId,
        op.intentId,
        JSON.stringify(op),
        previous,
        reason,
        approval ? JSON.stringify(approval) : null,
      );
  }
  async start(id: unknown) {
    if (!isUuid(id)) throw new Error('Payment intent UUID required');
    const created = this.write(() => {
      if (this.db.prepare('SELECT 1 FROM payment_intents WHERE intent_id=?').get(id)) return false;
      const sale = this.hooks.build(id);
      const bytes = jsonBytes(sale);
      const op = this.newOperation(id, bytes, sale.totalMinor);
      this.db
        .prepare(
          "INSERT INTO payment_intents(intent_id,shift_id,sale,state,attempt_id) VALUES(?,?,?,'PREPARED',?)",
        )
        .run(id, sale.shiftId, bytes, op.attemptId);
      this.addAttempt(op);
      return true;
    });
    return created ? this.dispatch(id, false) : this.recover(id);
  }
  private async dispatch(id: string, retry: boolean) {
    const op = this.write(() => {
      const row = this.find(id);
      const prepared = row.state === 'PREPARED' || row.state === 'REFUND_PREPARED';
      if (!prepared && !(retry && ['MAY_HAVE_SENT', 'REFUND_PENDING'].includes(row.state))) return;
      const op = this.operation(row.attempt_id);
      const now = Date.now();
      if (
        retry &&
        (!this.options.adapter.idempotencyMs ||
          now - Date.parse(op.preparedAt) > this.options.adapter.idempotencyMs)
      )
        return;
      const claimed = this.db
        .prepare(
          `UPDATE payment_attempts SET sent_at=coalesce(sent_at,?),lease_until=?
        WHERE attempt_id=? AND (lease_until IS NULL OR lease_until<=?)`,
        )
        .run(now, now + 4500, op.attemptId, now);
      if (!claimed.changes) return;
      this.db
        .prepare('UPDATE payment_intents SET state=?,reason=NULL WHERE intent_id=?')
        .run(op.kind === 'CAPTURE' ? 'MAY_HAVE_SENT' : 'REFUND_PENDING', id);
      return op;
    });
    if (!op) return this.result(id);
    let packet: SignedEvidence;
    try {
      packet = await this.options.adapter.execute(op);
    } catch {
      this.db
        .prepare(
          "UPDATE payment_intents SET reason='PROVIDER_OUTCOME_UNKNOWN' WHERE intent_id=? AND state IN ('MAY_HAVE_SENT','REFUND_PENDING')",
        )
        .run(id);
      return this.result(id);
    }
    this.record(packet, true);
    return this.finish(id);
  }
  private record(packet: unknown, authoritative: boolean) {
    const { fact, bytes } = this.options.adapter.verify(packet);
    if (
      !sameRoute(fact.operation, this.options.adapter.route) ||
      !sameOperation(fact.operation, this.operation(fact.operation.attemptId))
    )
      throw new Error('Provider evidence binding rejected');
    const op = fact.operation;
    return this.write(() => {
      const existing = this.db
        .prepare('SELECT digest FROM payment_evidence WHERE event_id=?')
        .get(fact.eventId);
      const hash = digest(bytes);
      if (existing && existing.digest !== hash) {
        this.db.prepare('INSERT OR IGNORE INTO payment_incidents VALUES(?,?)').run(fact.eventId, hash);
        this.db
          .prepare("UPDATE payment_intents SET reason='PROVIDER_EVIDENCE_CONFLICT' WHERE intent_id=?")
          .run(op.intentId);
        return false;
      }
      this.db
        .prepare('INSERT OR IGNORE INTO payment_evidence VALUES(?,?,?,?,?)')
        .run(fact.eventId, op.attemptId, hash, fact.state, JSON.stringify(packet));
      if (!authoritative) return true;
      const row = this.find(op.intentId);
      if (row.attempt_id !== op.attemptId) {
        if (fact.state === 'CAPTURED')
          this.db
            .prepare("UPDATE payment_intents SET reason='LATE_CAPTURE_ON_SUPERSEDED_ATTEMPT' WHERE intent_id=?")
            .run(op.intentId);
        return false;
      }
      if (['PROVIDER_EVIDENCE_CONFLICT', 'LATE_CAPTURE_ON_SUPERSEDED_ATTEMPT'].includes(row.reason ?? ''))
        return false;
      if (op.kind === 'CAPTURE' && row.state === 'MAY_HAVE_SENT') {
        if (fact.state === 'CAPTURED')
          this.db
            .prepare("UPDATE payment_intents SET state='CAPTURED',capture=?,reason=NULL WHERE intent_id=?")
            .run(JSON.stringify(packet), op.intentId);
        else if (fact.state === 'DECLINED' || fact.state === 'NOT_EXECUTED')
          this.db
            .prepare("UPDATE payment_intents SET state='DECLINED',reason=? WHERE intent_id=?")
            .run(fact.state, op.intentId);
      } else if (op.kind === 'REFUND' && row.state === 'REFUND_PENDING' && fact.state === 'REFUNDED') {
        this.db
          .prepare(
            "UPDATE payment_intents SET state='REFUNDED',refund=?,reported=0,reason=NULL WHERE intent_id=?",
          )
          .run(JSON.stringify(packet), op.intentId);
      }
      if (fact.state === 'UNKNOWN' || fact.state === 'AUTHORIZED' || fact.state === 'REVERSED') {
        this.db
          .prepare(
            "UPDATE payment_intents SET reason=? WHERE intent_id=? AND state IN ('MAY_HAVE_SENT','REFUND_PENDING')",
          )
          .run(fact.state === 'REVERSED' ? 'PROVIDER_REVERSAL_HELD' : 'PROVIDER_OUTCOME_UNKNOWN', op.intentId);
      }
      return true;
    });
  }
  async webhook(packet: unknown) {
    // An accepted delivery records evidence. Financial transitions use authenticated status.
    const { fact } = this.options.adapter.verify(packet);
    if (
      this.record(packet, false) &&
      ['MAY_HAVE_SENT', 'REFUND_PENDING'].includes(this.find(fact.operation.intentId).state)
    ) {
      await this.recover(fact.operation.intentId);
    }
  }
  async recover(id: unknown, retry = false) {
    const row = this.find(id);
    if (row.state === 'PREPARED') return this.dispatch(row.intent_id, false);
    if (row.state === 'REFUND_PREPARED') return this.dispatchRefund(row);
    if (row.state === 'MAY_HAVE_SENT' || row.state === 'REFUND_PENDING') {
      const op = this.operation(row.attempt_id);
      let packet;
      try {
        packet = await this.options.adapter.status(op);
      } catch {
        return this.result(row.intent_id);
      }
      const { fact } = this.options.adapter.verify(packet);
      if (!this.record(packet, true)) return this.result(row.intent_id);
      if (retry && fact.state === 'UNKNOWN') return this.dispatch(row.intent_id, true);
    }
    return this.finish(row.intent_id);
  }
  async replace(id: unknown, reason: unknown, pin: unknown) {
    if (!paymentReason(reason)) throw new Error('Replacement reason code required');
    const approval = this.hooks.approval(pin, 'replace-payment', [id, reason]);
    const row = this.write(() => {
      const prior = this.find(id);
      if (prior.state !== 'DECLINED' || prior.capture) throw new Error('Definitive nonexecution required');
      if (
        this.db
          .prepare("SELECT 1 FROM payment_intents WHERE state NOT IN ('DECLINED','FINALIZED','REFUNDED')")
          .get()
      ) {
        throw new Error('Another payment is unresolved');
      }
      const sale = parseRetail(Buffer.from(prior.sale)) as RetailSale;
      // The original basket is reusable only while it still owns its original open shift and exact quote.
      const current = parseRetail(jsonBytes(this.hooks.build(prior.intent_id))) as RetailSale;
      if (
        current.shiftId !== sale.shiftId ||
        current.sequence !== sale.sequence ||
        !jsonBytes(current.lines).equals(jsonBytes(sale.lines))
      )
        throw new Error('Original basket is no longer available');
      const op = this.newOperation(prior.intent_id, Buffer.from(prior.sale), sale.totalMinor);
      this.addAttempt(op, prior.attempt_id, reason, approval);
      this.db
        .prepare("UPDATE payment_intents SET state='PREPARED',attempt_id=?,reason=NULL WHERE intent_id=?")
        .run(op.attemptId, prior.intent_id);
      return prior;
    });
    return this.dispatch(row.intent_id, false);
  }
  async refund(id: unknown, reason: unknown, pin: unknown) {
    if (!paymentReason(reason)) throw new Error('Refund reason code required');
    const row = this.write(() => {
      const current = this.find(id);
      if (current.state !== 'CAPTURED' || !current.capture || current.reason?.startsWith('PROVIDER_'))
        throw new Error('Captured funds are already claimed');
      const capture = this.options.adapter.verify(JSON.parse(current.capture)).fact.operation;
      const op = this.newOperation(
        current.intent_id,
        Buffer.from(current.sale),
        capture.amountMinor,
        capture.attemptId,
      );
      const facts = { operation: op, reason };
      const approval = this.hooks.approval(pin, 'refund-capture', facts);
      this.addAttempt(op, capture.attemptId, reason, approval);
      this.db
        .prepare(
          "UPDATE payment_intents SET state='REFUND_PREPARED',attempt_id=?,refund_approval=? WHERE intent_id=?",
        )
        .run(op.attemptId, JSON.stringify({ facts, approval }), current.intent_id);
      return this.find(id);
    });
    return this.dispatchRefund(row);
  }
  private async dispatchRefund(row: Intent) {
    if (!row.fiscal_intent) throw new Error('Fiscal intent required before refund');
    const abandonment = await this.options.fiscal.abandon(JSON.parse(row.fiscal_intent));
    await this.hooks.funds('reserve-refund', {
      capture: JSON.parse(row.capture!),
      abandonment,
      ...JSON.parse(row.refund_approval!),
    });
    return this.dispatch(row.intent_id, false);
  }
  private result(id: string) {
    const row = this.find(id);
    return {
      intentId: id,
      state: row.state,
      reason: row.reason,
      receipt: row.state === 'FINALIZED' ? this.hooks.receipt(id) : null,
    };
  }
  private async report(row: Intent) {
    if (!row.capture || row.reported) return;
    const body = row.refund
      ? { capture: JSON.parse(row.capture), refund: JSON.parse(row.refund) }
      : { capture: JSON.parse(row.capture) };
    try {
      await this.hooks.funds(row.refund ? 'refund' : 'capture', body);
      this.db
        .prepare('UPDATE payment_intents SET reported=1 WHERE intent_id=? AND state=?')
        .run(row.intent_id, row.state);
    } catch {
      /* Captured funds evidence remains locally recoverable when the cloud is unavailable. */
    }
  }
  async syncFunds() {
    const row = this.db
      .prepare('SELECT * FROM payment_intents WHERE capture IS NOT NULL AND reported=0 ORDER BY rowid LIMIT 1')
      .get() as Intent | undefined;
    if (!row) return false;
    await this.report(row);
    return true;
  }
  private async finish(id: string) {
    let row = this.find(id);
    if (row.reason === 'PROVIDER_EVIDENCE_CONFLICT' || row.reason === 'LATE_CAPTURE_ON_SUPERSEDED_ATTEMPT')
      return this.result(id);
    if (!['CAPTURED', 'SIGNING'].includes(row.state)) {
      if (row.state === 'REFUNDED') await this.report(row);
      return this.result(id);
    }
    if (row.state === 'CAPTURED') {
      const claimed = this.db
        .prepare("UPDATE payment_intents SET state='SIGNING' WHERE intent_id=? AND state='CAPTURED'")
        .run(id);
      if (!claimed.changes) return this.result(id);
    }
    row = this.find(id);
    const saleBytes = Buffer.from(row.sale);
    const sale = parseRetail(saleBytes) as RetailSale;
    const capture = JSON.parse(row.capture!) as SignedEvidence;
    let intent: FiscalIntent;
    let signed: FiscalResult | null;
    try {
      if (row.fiscal_intent) intent = JSON.parse(row.fiscal_intent);
      else {
        const head = await this.options.fiscal.head();
        if (!sameEpoch(head, this.options.fiscal.epoch)) throw new Error('Fiscal epoch changed');
        intent = {
          ...this.options.fiscal.epoch,
          saleId: id,
          receiptId: sale.receiptId,
          sequence: head.sequence + 1,
          predecessor: head.digest,
          saleDigest: digest(saleBytes),
          captureDigest: digest(Buffer.from(capture.body, 'base64url')),
        };
        this.db
          .prepare(
            "UPDATE payment_intents SET fiscal_intent=? WHERE intent_id=? AND state='SIGNING' AND fiscal_intent IS NULL",
          )
          .run(JSON.stringify(intent), id);
        intent = JSON.parse(this.find(id).fiscal_intent!);
      }
      signed = await this.options.fiscal.sign(intent, saleBytes);
    } catch {
      this.db
        .prepare(
          "UPDATE payment_intents SET reason='SIGNER_OUTCOME_UNKNOWN' WHERE intent_id=? AND state='SIGNING'",
        )
        .run(id);
      await this.report(this.find(id));
      return this.result(id);
    }
    if (!signed) {
      this.db
        .prepare(
          "UPDATE payment_intents SET state='CAPTURED',reason='FISCAL_GRANT_REQUIRED' WHERE intent_id=? AND state='SIGNING'",
        )
        .run(id);
      await this.report(this.find(id));
      return this.result(id);
    }
    const final: CardEvent = {
      version: 4,
      saleBody: saleBytes.toString('base64url'),
      capture,
      proof: signed.proof,
      grant: signed.grant,
    };
    this.write(() => {
      const current = this.find(id);
      if (current.state === 'FINALIZED') return;
      if (current.state !== 'SIGNING' || current.reason === 'PROVIDER_EVIDENCE_CONFLICT')
        throw new Error('Captured funds are held');
      this.hooks.finalize(sale, jsonBytes(final), cardPrintable(sale, intent), signed);
      this.db
        .prepare('INSERT INTO fiscal_local_receipts VALUES(?,?,?)')
        .run(id, JSON.stringify(signed.proof), JSON.stringify(signed.grant));
      this.db
        .prepare(
          "UPDATE payment_intents SET state='FINALIZED',reason=NULL WHERE intent_id=? AND state='SIGNING'",
        )
        .run(id);
    });
    return this.result(id);
  }
}

export function webhookPacket(bytes: Buffer, headers: import('node:http').IncomingHttpHeaders) {
  return exact(
    { body: bytes.toString('base64url'), keyId: headers['omni-key-id'], signature: headers['omni-signature'] },
    ['body', 'keyId', 'signature'],
  );
}
