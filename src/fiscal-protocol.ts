import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { exact, openArtifact } from './authority.ts';
import { opaque, scopeKeys } from './payment-protocol.ts';
import { isCounter, isDigest, isIsoDate, isScope, isUuid, sameScope } from './protocol.ts';
import type { Scope } from './protocol.ts';

export type Epoch = Scope & { deviceId: string; epochId: string; series: string };
export type DeviceEnrollment = Epoch & { publicKey: string };
export type Genesis = Epoch & { previousEpochId: string | null };
export type FiscalGrant = Epoch & {
  grantId: string;
  start: number;
  end: number;
  issuedAt: string;
  expiresAt: string;
};
export type FiscalHead = Epoch & { sequence: number; digest: string | null };
export type FiscalIntent = Epoch & {
  saleId: string;
  receiptId: string;
  sequence: number;
  predecessor: string | null;
  saleDigest: string;
  captureDigest: string;
};
export type FiscalReceipt = FiscalIntent & { grantId: string; lower: string; upper: string };

export const fiscalPurpose = {
  enrollment: 'fiscal-enrollment',
  genesis: 'fiscal-genesis',
  grant: 'fiscal-grant',
  receipt: 'fiscal-receipt',
  head: 'fiscal-head',
  hold: 'fiscal-hold',
  abandonment: 'fiscal-abandonment',
} as const;
const epochFields = [...scopeKeys, 'deviceId', 'epochId', 'series'];
const intentFields = [
  ...epochFields,
  'saleId',
  'receiptId',
  'sequence',
  'predecessor',
  'saleDigest',
  'captureDigest',
];
export function sameEpoch(a: Epoch, b: Epoch): boolean {
  return sameScope(a, b) && a.deviceId === b.deviceId && a.epochId === b.epochId && a.series === b.series;
}
function epoch(x: Record<string, unknown>): x is Epoch & Record<string, unknown> {
  return isScope(x) && isUuid(x.deviceId) && isUuid(x.epochId) && opaque(x.series);
}
export function deviceKey(enrolled: DeviceEnrollment): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(enrolled.publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Fiscal key rejected');
  return key;
}
export function readEnrollment(packet: unknown, keys: ReadonlyMap<string, KeyObject>): DeviceEnrollment {
  const x = exact(openArtifact(fiscalPurpose.enrollment, packet, keys).data, [...epochFields, 'publicKey']);
  if (!epoch(x) || typeof x.publicKey !== 'string' || !/^[A-Za-z0-9_-]{50,80}$/.test(x.publicKey))
    throw new Error('Fiscal enrollment rejected');
  const value = { ...x, publicKey: x.publicKey };
  deviceKey(value);
  return value;
}
export function readGenesis(packet: unknown, keys: ReadonlyMap<string, KeyObject>): Genesis {
  const x = exact(openArtifact(fiscalPurpose.genesis, packet, keys).data, [...epochFields, 'previousEpochId']);
  if (
    !epoch(x) ||
    (x.previousEpochId !== null && (!isUuid(x.previousEpochId) || x.previousEpochId === x.epochId))
  ) {
    throw new Error('Fiscal genesis rejected');
  }
  return x as unknown as Genesis;
}
export function readGrant(packet: unknown, keys: ReadonlyMap<string, KeyObject>): FiscalGrant {
  const x = exact(openArtifact(fiscalPurpose.grant, packet, keys).data, [
    ...epochFields,
    'grantId',
    'start',
    'end',
    'issuedAt',
    'expiresAt',
  ]);
  if (
    !epoch(x) ||
    !isUuid(x.grantId) ||
    !isCounter(x.start) ||
    !isCounter(x.end) ||
    x.end < x.start ||
    x.end - x.start >= 100 ||
    !isIsoDate(x.issuedAt) ||
    !isIsoDate(x.expiresAt) ||
    x.issuedAt >= x.expiresAt ||
    Date.parse(x.expiresAt) - Date.parse(x.issuedAt) > 86_400_000
  )
    throw new Error('Fiscal grant rejected');
  return x as unknown as FiscalGrant;
}
export function readHead(packet: unknown, keys: ReadonlyMap<string, KeyObject>): FiscalHead {
  const x = exact(openArtifact(fiscalPurpose.head, packet, keys).data, [...epochFields, 'sequence', 'digest']);
  if (!epoch(x) || (x.sequence === 0 ? x.digest !== null : !isCounter(x.sequence) || !isDigest(x.digest)))
    throw new Error('Fiscal head rejected');
  return x as unknown as FiscalHead;
}
export function readIntent(value: unknown): FiscalIntent {
  const x = exact(value, intentFields);
  if (
    !epoch(x) ||
    !isUuid(x.saleId) ||
    !isUuid(x.receiptId) ||
    !isCounter(x.sequence) ||
    (x.sequence === 1 ? x.predecessor !== null : !isDigest(x.predecessor)) ||
    !isDigest(x.saleDigest) ||
    !isDigest(x.captureDigest)
  )
    throw new Error('Fiscal intent rejected');
  return x as unknown as FiscalIntent;
}
export function readFiscalReceipt(packet: unknown, keys: ReadonlyMap<string, KeyObject>) {
  const { bytes, data } = openArtifact(fiscalPurpose.receipt, packet, keys);
  const x = exact(data, [...intentFields, 'grantId', 'lower', 'upper']);
  const { grantId, lower, upper, ...fields } = x;
  if (!isUuid(grantId) || !isIsoDate(lower) || !isIsoDate(upper) || lower > upper)
    throw new Error('Fiscal receipt time rejected');
  return { bytes, receipt: { ...readIntent(fields), grantId, lower, upper } };
}
export function covers(grant: FiscalGrant, target: FiscalIntent, lower: string, upper: string): boolean {
  return (
    sameEpoch(grant, target) &&
    target.sequence >= grant.start &&
    target.sequence <= grant.end &&
    isIsoDate(lower) &&
    isIsoDate(upper) &&
    lower <= upper &&
    lower >= grant.issuedAt &&
    upper < grant.expiresAt
  );
}
