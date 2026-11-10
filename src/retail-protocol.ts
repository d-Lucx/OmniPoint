import { sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { decode, digest, isCounter, isIsoDate, isLabel, isScope, isSku, isUuid, jsonBytes, record, readQuotaSpend } from './protocol.ts';
import type { QuotaSpend, Scope, SigningKey } from './protocol.ts';
import { blindTotal, money, priceLine, quantity, totals } from './retail-money.ts';
import type { Catalog, LineMoney, Quote, Variant } from './retail-money.ts';

export const retailBodyLimit = 65_536;
export interface Approval { actorId: string; signature: string }
export interface Supervisor { tenantId: string; storeId: string; actorId: string; publicKey: KeyObject }
export interface Adjustment { amount: number; reason: string; approval: Approval }
export interface RetailLine extends LineMoney {
  id: string;
  quote: Quote;
  quantity: number;
  discount: Adjustment | null;
  units: QuotaSpend[];
}
export interface RetailHeader extends Scope {
  version: 3;
  currency: 'USD';
  saleId: string;
  shiftId: string;
  sequence: number;
  occurredAt: string;
}
export type RetailSale = RetailHeader & LineMoney & {
  kind: 'SALE'; receiptId: string; lines: RetailLine[]; tenderMinor: number; changeMinor: number;
};
export type RetailCount = RetailHeader & {
  kind: 'CLOSE' | 'REVISION'; count: Record<string, number>; countedMinor: number; expectedMinor: number;
  covers: number; previousId: string | null; reason: string | null; approval: Approval | null;
};
export type RetailReturn = RetailHeader & {
  kind: 'RETURN'; returnId: string; attemptId: string; receiptId: string; amountMinor: number; approval: Approval;
};
export type RetailEvent = RetailSale | RetailCount | RetailReturn |
  (RetailHeader & { kind: 'OPEN'; drawerId: string; floatMinor: number }) |
  (RetailHeader & { kind: 'DROP'; destinationId: string; amountMinor: number; approval: Approval });

export function parseVariant(value: unknown): Variant {
  const v = record(value);
  if (!isSku(v.sku) || !isSku(v.parentId) || !isLabel(v.label) ||
      typeof v.barcode !== 'string' || !/^\d{4,18}$/.test(v.barcode) || !money(v.unitMinor, 1) ||
      !Number.isInteger(v.taxBps) || Number(v.taxBps) < 0 || Number(v.taxBps) > 10_000 ||
      (v.taxMode !== 'EXCLUSIVE' && v.taxMode !== 'INCLUSIVE')) throw new Error('Invalid variant');
  const { sku, parentId, label, barcode, unitMinor, taxMode } = v;
  return { sku, parentId, label, barcode, unitMinor, taxBps: Number(v.taxBps), taxMode };
}

export function parseCatalog(value: unknown): Catalog {
  const input = record(value);
  if (!isCounter(input.version) || !isCounter(input.taxVersion) || !Array.isArray(input.variants) ||
      input.variants.length < 1 || input.variants.length > 50) throw new Error('Invalid catalog version');
  const variants = input.variants.map(parseVariant);
  if (new Set(variants.map(v => v.sku)).size !== variants.length ||
      new Set(variants.map(v => v.barcode)).size !== variants.length) throw new Error('Duplicate SKU or barcode');
  return { version: input.version, taxVersion: input.taxVersion, variants };
}

export function parseApproval(value: unknown): Approval {
  const a = record(value);
  if (!isUuid(a.actorId) || typeof a.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(a.signature)) {
    throw new Error('Invalid supervisor approval');
  }
  return { actorId: a.actorId, signature: a.signature };
}

function approvalInput(scope: Scope, actorId: string, action: string, facts: unknown): Buffer {
  return jsonBytes(['OmniPoint-Supervisor-v1', scope.tenantId, scope.storeId, scope.terminalId, scope.generation,
    scope.cashierId, actorId, action, digest(jsonBytes(facts))]);
}

export function approve(scope: Scope, actorId: string, action: string, facts: unknown, signer: SigningKey): Approval {
  if (signer.key.asymmetricKeyType !== 'ed25519' || signer.key.type !== 'private') throw new Error('Invalid supervisor key');
  return { actorId, signature: sign(null, approvalInput(scope, actorId, action, facts), signer.key).toString('base64url') };
}

export function verifyApproval(scope: Scope, approval: Approval, action: string, facts: unknown, supervisors: readonly Supervisor[]) {
  const key = supervisors.find(s => s.tenantId === scope.tenantId && s.storeId === scope.storeId &&
    s.actorId === approval.actorId)?.publicKey;
  if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, approvalInput(scope, approval.actorId, action, facts), key, Buffer.from(approval.signature, 'base64url'))) {
    throw new Error('Supervisor approval rejected');
  }
}

export const discountFacts = (shiftId: string, id: string, quote: Quote, units: number, amount: number, reason: string) =>
  [shiftId, id, quote, units, amount, reason];
export const dropFacts = (e: { shiftId: string; saleId: string; destinationId: string; amountMinor: number }) =>
  [e.shiftId, e.saleId, e.destinationId, e.amountMinor];
export const revisionFacts = (e: RetailCount) => [e.shiftId, e.saleId, e.previousId, e.count, e.reason];
export const payoutFacts = (e: { shiftId: string; returnId: string; attemptId: string; amountMinor: number }) =>
  [e.shiftId, e.returnId, e.attemptId, e.amountMinor];

function parseLine(value: unknown): RetailLine {
  const line = record(value);
  const q = record(line.quote);
  if (!isUuid(line.id) || !isCounter(q.catalogVersion) || !isCounter(q.taxVersion) ||
      !quantity(line.quantity) || !Array.isArray(line.units) || line.units.length !== line.quantity) throw new Error('Invalid retail line');
  const quote = { ...parseVariant(q), catalogVersion: q.catalogVersion, taxVersion: q.taxVersion };
  const units = line.units.map(readQuotaSpend);
  let discount: Adjustment | null = null;
  if (line.discount !== null) {
    const d = record(line.discount);
    if (!money(d.amount, 1) || !isLabel(d.reason)) throw new Error('Invalid discount');
    discount = { amount: d.amount, reason: d.reason, approval: parseApproval(d.approval) };
  }
  const amounts = priceLine(quote, line.quantity, discount?.amount ?? 0);
  if (line.basisMinor !== amounts.basisMinor || line.taxMinor !== amounts.taxMinor ||
      line.totalMinor !== amounts.totalMinor) throw new Error('Invalid retail line totals');
  return { id: line.id, quote, quantity: line.quantity, discount, units, ...amounts };
}

export function parseRetail(bytes: Buffer): RetailEvent {
  if (bytes.length > retailBodyLimit) throw new Error('Retail event too large');
  const e = decode(bytes);
  if (!isScope(e) || e.version !== 3 || e.currency !== 'USD' || !isUuid(e.saleId) || !isUuid(e.shiftId) ||
      !isCounter(e.sequence) || !isIsoDate(e.occurredAt)) throw new Error('Invalid retail event identity');
  switch (e.kind) {
    case 'OPEN':
      if (e.sequence !== 1 || !isUuid(e.drawerId) || !money(e.floatMinor)) throw new Error('Invalid shift opening');
      break;
    case 'SALE': {
      if (!isUuid(e.receiptId) || !Array.isArray(e.lines) || e.lines.length < 1 || e.lines.length > 8) throw new Error('Invalid retail basket');
      const lines = e.lines.map(parseLine);
      const slices = lines.flatMap(line => line.units.map(unit => unit.sliceId));
      if (new Set(lines.map(line => line.id)).size !== lines.length || new Set(slices).size !== slices.length) {
        throw new Error('Duplicate basket identity');
      }
      const sum = totals(lines);
      if (!money(e.tenderMinor, sum.totalMinor) || e.changeMinor !== e.tenderMinor - sum.totalMinor ||
          e.basisMinor !== sum.basisMinor || e.taxMinor !== sum.taxMinor || e.totalMinor !== sum.totalMinor) {
        throw new Error('Invalid retail sale totals or tender');
      }
      e.lines = lines;
      break;
    }
    case 'DROP':
      if (!isUuid(e.destinationId) || !money(e.amountMinor, 1)) throw new Error('Invalid drawer drop');
      parseApproval(e.approval);
      break;
    case 'RETURN':
      if (!isUuid(e.returnId) || !isUuid(e.attemptId) || !isUuid(e.receiptId) || !money(e.amountMinor, 1)) throw new Error('Invalid payout');
      parseApproval(e.approval);
      break;
    case 'CLOSE':
    case 'REVISION':
      if (e.countedMinor !== blindTotal(record(e.count)) || !money(e.expectedMinor) || e.covers !== e.sequence - 1) {
        throw new Error('Invalid blind count');
      }
      if (e.kind === 'REVISION') {
        if (!isUuid(e.previousId) || !isLabel(e.reason)) throw new Error('Invalid close revision');
        parseApproval(e.approval);
      } else if (e.previousId !== null || e.reason !== null || e.approval !== null) throw new Error('Invalid close lineage');
      break;
    default:
      throw new Error('Unknown retail event');
  }
  return e as unknown as RetailEvent;
}

export function salePrintable(event: RetailSale): string {
  const amount = (minor: number) => (minor / 100).toFixed(2);
  return ['OmniPoint Retail', `Receipt ${event.receiptId}`, event.occurredAt,
    ...event.lines.map(line => `${line.quantity} x ${line.quote.label} [${line.quote.sku}]  ${amount(line.totalMinor)}`),
    `Tax USD ${amount(event.taxMinor)}`, `Total USD ${amount(event.totalMinor)}`,
    `Cash ${amount(event.tenderMinor)}   Change ${amount(event.changeMinor)}`].join('\n');
}
