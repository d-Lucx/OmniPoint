import { createHash, randomUUID, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const maxEventBytes = 8192;
export const maxAckBytes = 4096;
export const currency = 'USD';

export interface Scope {
  tenantId: string;
  storeId: string;
  terminalId: string;
  generation: number;
  cashierId: string;
}

interface SaleFacts extends Scope {
  saleId: string;
  receiptId: string;
  sequence: number;
  occurredAt: string;
  currency: 'USD';
  line: { id: string; sku: string; label: string; quantity: 1; unitMinor: number; stockDelta: -1 };
  taxMinor: 0;
  totalMinor: number;
  tender: { method: 'CASH'; cashMinor: number; changeMinor: 0 };
}

export interface SignedEvidence { body: string; keyId: string; signature: string }
export interface QuotaSpend {
  positionId: string;
  locationId: string;
  grantId: string;
  grantDigest: string;
  sliceId: string;
  custody?: SignedEvidence;
}
export type QuotaSale = SaleFacts & { version: 2; quota: QuotaSpend };
export type SaleEvent = (SaleFacts & { version: 1 }) | QuotaSale;
export type Conflict = 'SALE_ID_CONFLICT' | 'SEQUENCE_CONFLICT';
export type FinalDisposition = 'COMMITTED' | 'BACKORDER';
export type Disposition = FinalDisposition | Conflict;
export type VoucherEvent = Pick<SaleEvent, 'tenantId' | 'terminalId' | 'generation' | 'sequence' | 'saleId'> & {
  version: 1 | 2 | 3;
};
export interface Ack {
  version: 1 | 2 | 3;
  ackId: string;
  tenantId: string;
  terminalId: string;
  generation: number;
  sequence: number;
  saleId: string;
  requestDigest: string;
  disposition: Disposition;
}

export function readQuotaSpend(value: unknown): QuotaSpend {
  const q = record(value);
  if (!isUuid(q.positionId) || !isUuid(q.locationId) || !isUuid(q.grantId) ||
      !isUuid(q.sliceId) || !isDigest(q.grantDigest) ||
      (q.custody !== undefined && !isSignedEvidence(q.custody))) throw new Error('Invalid quota spend');
  const { positionId, locationId, grantId, sliceId, grantDigest, custody } = q;
  return { positionId, locationId, grantId, sliceId, grantDigest, ...(custody ? { custody } : {}) };
}
export interface Voucher {
  status: number;
  bytes: Buffer;
  keyId: string;
  signature: string;
}
export interface SigningKey {
  id: string;
  key: KeyObject;
}

export const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function trustedEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('HTTPS required outside loopback development');
  }
  return url;
}
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const isSku = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z0-9-]{1,32}$/.test(value);
export const isMinor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000_000;
export const isLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);

export function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

export function decode(bytes: Uint8Array): Record<string, unknown> {
  return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isSignedEvidence(value: unknown): value is SignedEvidence {
  if (!value || typeof value !== 'object') return false;
  const packet = value as Record<string, unknown>;
  return typeof packet.body === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(packet.body) &&
    typeof packet.keyId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(packet.keyId) &&
    typeof packet.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(packet.signature);
}

export function isScope(scope: Record<string, unknown>): scope is Scope & Record<string, unknown> {
  return isUuid(scope.tenantId) && isUuid(scope.storeId) && isUuid(scope.terminalId) &&
    isCounter(scope.generation) && isUuid(scope.cashierId);
}

export function parseEvent(bytes: Uint8Array): SaleEvent {
  if (bytes.length > maxEventBytes) throw new Error('Event too large');
  const e = decode(bytes);
  const line = record(e.line);
  const tender = record(e.tender);
  if (!isScope(e) || (e.version !== 1 && e.version !== 2) || !isUuid(e.saleId) || !isUuid(e.receiptId) ||
      !isCounter(e.sequence) || !isIsoDate(e.occurredAt) ||
      e.currency !== currency || !isUuid(line.id) || !isSku(line.sku) || !isLabel(line.label) ||
      line.quantity !== 1 || line.stockDelta !== -1 || !isMinor(line.unitMinor) ||
      e.taxMinor !== 0 || e.totalMinor !== line.unitMinor ||
      tender.method !== 'CASH' || tender.cashMinor !== e.totalMinor || tender.changeMinor !== 0) {
    throw new Error('Invalid sale event');
  }
  if (e.version === 2) {
    readQuotaSpend(e.quota);
  } else if (e.quota !== undefined) {
    throw new Error('Quota spend requires v2');
  }
  return e as unknown as SaleEvent;
}

export function sameScope(e: Scope, enrolled: Scope): boolean {
  return e.tenantId === enrolled.tenantId && e.storeId === enrolled.storeId &&
    e.terminalId === enrolled.terminalId && e.generation === enrolled.generation &&
    e.cashierId === enrolled.cashierId;
}

export function printableReceipt(event: SaleEvent): string {
  const money = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
  return [
    'OmniPoint', `Receipt ${event.receiptId}`, event.occurredAt,
    `1 x ${event.line.label} (${event.line.sku})`,
    `Total ${event.currency} ${money(event.totalMinor)}`,
    `Cash ${money(event.tender.cashMinor)}   Tax 0.00   Change 0.00`,
  ].join('\n');
}

export function ackBody(e: VoucherEvent, requestDigest: string, disposition: Disposition): Ack {
  return {
    version: e.version, ackId: randomUUID(), tenantId: e.tenantId, terminalId: e.terminalId,
    generation: e.generation, sequence: e.sequence, saleId: e.saleId, requestDigest, disposition,
  };
}

function signedInput(status: number, bytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`OmniPoint-Ack-v1\n${status}\n`), bytes]);
}

export function signVoucher(status: number, bytes: Buffer, signer: SigningKey): Voucher {
  if (signer.key.type !== 'private' || signer.key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Expected Ed25519 signing key');
  }
  return { status, bytes, keyId: signer.id, signature: sign(null, signedInput(status, bytes), signer.key).toString('base64url') };
}

export function verifySignedResponse(status: number, bytes: Buffer, headers: Headers, keys: ReadonlyMap<string, KeyObject>): void {
  const key = keys.get(headers.get('omni-key-id') ?? '');
  const signature = headers.get('omni-signature') ?? '';
  if (bytes.length > maxAckBytes || headers.get('omni-algorithm') !== 'ed25519' ||
      key?.type !== 'public' || key.asymmetricKeyType !== 'ed25519' ||
      !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      !verify(null, signedInput(status, bytes), key, Buffer.from(signature, 'base64url'))) {
    throw new Error('Invalid acknowledgment signature');
  }
}

export function verifyVoucher(
  status: number, bytes: Buffer, headers: Headers, keys: ReadonlyMap<string, KeyObject>,
  event: VoucherEvent, requestDigest: string,
): Ack {
  verifySignedResponse(status, bytes, headers, keys);
  const ack = decode(bytes);
  const validDisposition = (status === 200 && (ack.disposition === 'COMMITTED' ||
    (event.version !== 1 && ack.disposition === 'BACKORDER'))) ||
    (status === 409 && (ack.disposition === 'SALE_ID_CONFLICT' || ack.disposition === 'SEQUENCE_CONFLICT'));
  if (!validDisposition || ack.version !== event.version || !isUuid(ack.ackId) ||
      ack.tenantId !== event.tenantId || ack.terminalId !== event.terminalId ||
      ack.generation !== event.generation || ack.sequence !== event.sequence ||
      ack.saleId !== event.saleId || ack.requestDigest !== requestDigest) {
    throw new Error('Invalid acknowledgment binding');
  }
  return ack as unknown as Ack;
}

export async function readBounded(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
