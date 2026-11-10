import type { KeyObject } from 'node:crypto';
import { exact, openArtifact } from './authority.ts';
import { isScope, isUuid, isDigest, isIsoDate, sameScope } from './protocol.ts';
import type { Scope } from './protocol.ts';
import { money } from './retail-money.ts';

export const providerPurpose = 'provider-fact';
export const paymentReason = (value: unknown): value is string =>
  typeof value === 'string' &&
  ['PROVIDER_DECLINED', 'VERIFIED_NONEXECUTION', 'FISCAL_UNAVAILABLE', 'OPERATOR_CANCELLED'].includes(value);
export type PaymentRoute = Scope & { providerId: string; merchantId: string; readerId: string };
export type Operation = PaymentRoute & {
  intentId: string;
  attemptId: string;
  kind: 'CAPTURE' | 'REFUND';
  originalAttemptId: string | null;
  currency: 'USD';
  amountMinor: number;
  basketDigest: string;
  preparedAt: string;
};
export type ProviderState =
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'SETTLED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'DECLINED'
  | 'NOT_EXECUTED'
  | 'UNKNOWN';
export interface ProviderFact {
  operation: Operation;
  eventId: string;
  state: ProviderState;
  reference: string | null;
  occurredAt: string;
}
export const scopeKeys = ['tenantId', 'storeId', 'terminalId', 'generation', 'cashierId'] as const;
const routeKeys = [...scopeKeys, 'providerId', 'merchantId', 'readerId'];
export const opaque = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(value);

export function parseOperation(value: unknown): Operation {
  const x = exact(value, [
    ...routeKeys,
    'intentId',
    'attemptId',
    'kind',
    'originalAttemptId',
    'currency',
    'amountMinor',
    'basketDigest',
    'preparedAt',
  ]);
  if (
    !isScope(x) ||
    !opaque(x.providerId) ||
    !opaque(x.merchantId) ||
    !opaque(x.readerId) ||
    !isUuid(x.intentId) ||
    !isUuid(x.attemptId) ||
    !isDigest(x.basketDigest) ||
    !isIsoDate(x.preparedAt) ||
    x.currency !== 'USD' ||
    !money(x.amountMinor, 1) ||
    (x.kind === 'CAPTURE' ? x.originalAttemptId !== null : x.kind !== 'REFUND' || !isUuid(x.originalAttemptId))
  ) {
    throw new Error('Payment operation rejected');
  }
  return x as unknown as Operation;
}

export function sameRoute(a: PaymentRoute, b: PaymentRoute): boolean {
  return (
    sameScope(a, b) &&
    a.providerId === b.providerId &&
    a.merchantId === b.merchantId &&
    a.readerId === b.readerId
  );
}

export function sameOperation(a: Operation, b: Operation): boolean {
  return (
    sameRoute(a, b) &&
    a.intentId === b.intentId &&
    a.attemptId === b.attemptId &&
    a.kind === b.kind &&
    a.originalAttemptId === b.originalAttemptId &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.basketDigest === b.basketDigest &&
    a.preparedAt === b.preparedAt
  );
}

export function providerFact(packet: unknown, keys: ReadonlyMap<string, KeyObject>) {
  const { bytes, data } = openArtifact(providerPurpose, packet, keys);
  const f = exact(data, ['operation', 'eventId', 'state', 'reference', 'occurredAt']);
  const operation = parseOperation(f.operation);
  if (
    !isUuid(f.eventId) ||
    !isIsoDate(f.occurredAt) ||
    typeof f.state !== 'string' ||
    ![
      'AUTHORIZED',
      'CAPTURED',
      'SETTLED',
      'REFUNDED',
      'REVERSED',
      'DECLINED',
      'NOT_EXECUTED',
      'UNKNOWN',
    ].includes(f.state) ||
    (f.reference !== null && !isUuid(f.reference)) ||
    (['CAPTURED', 'SETTLED', 'REFUNDED', 'REVERSED', 'AUTHORIZED'].includes(f.state) && !f.reference) ||
    (operation.kind === 'REFUND' && ['CAPTURED', 'SETTLED', 'AUTHORIZED'].includes(f.state)) ||
    (operation.kind === 'CAPTURE' && f.state === 'REFUNDED')
  )
    throw new Error('Provider fact rejected');
  return { bytes, fact: { ...f, operation } as unknown as ProviderFact };
}
