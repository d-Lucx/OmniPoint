import { exact } from './authority.ts';
import { decode, isSignedEvidence } from './protocol.ts';
import type { SignedEvidence } from './protocol.ts';
import { parseRetail, salePrintable } from './retail-protocol.ts';
import type { RetailSale } from './retail-protocol.ts';
import type { FiscalReceipt } from './fiscal-protocol.ts';

export const cardBodyLimit = 98_304;
export interface CardEvent {
  version: 4;
  saleBody: string;
  capture: SignedEvidence;
  proof: SignedEvidence;
  grant: SignedEvidence;
}

export function parseCard(bytes: Buffer) {
  if (bytes.length > cardBodyLimit) throw new Error('Card event too large');
  const e = exact(decode(bytes), ['version', 'saleBody', 'capture', 'proof', 'grant']);
  if (
    e.version !== 4 ||
    typeof e.saleBody !== 'string' ||
    !isSignedEvidence(e.capture) ||
    !isSignedEvidence(e.proof) ||
    !isSignedEvidence(e.grant)
  )
    throw new Error('Invalid card event');
  const saleBytes = Buffer.from(e.saleBody, 'base64url');
  const sale = parseRetail(saleBytes);
  if (
    saleBytes.toString('base64url') !== e.saleBody ||
    sale.kind !== 'SALE' ||
    sale.changeMinor !== 0 ||
    sale.tenderMinor !== sale.totalMinor
  )
    throw new Error('Invalid card sale');
  return { envelope: e as unknown as CardEvent, sale, saleBytes };
}

export function cardPrintable(
  sale: RetailSale,
  receipt: Pick<FiscalReceipt, 'series' | 'sequence' | 'epochId'>,
) {
  return (
    salePrintable(sale).split('\n').slice(0, -1).join('\n') +
    `\nCard USD ${(sale.totalMinor / 100).toFixed(2)}\nFiscal ${receipt.series}/${receipt.sequence}  Epoch ${receipt.epochId}`
  );
}
