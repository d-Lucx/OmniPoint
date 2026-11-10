import { isLabel, isUuid, record } from './protocol.ts';
import { quantity } from './retail-money.ts';

export interface ReturnRequest {
  returnId: string;
  attemptId: string;
  shiftId: string;
  receiptId: string;
  lineId: string;
  quantity: number;
}
export interface ReturnReservation extends ReturnRequest {
  basisMinor: number;
  taxMinor: number;
  state: 'RESERVED' | 'PAYOUT_PENDING' | 'CONFIRMED' | 'RELEASED';
}

export function returnRequest(input: Record<string, unknown>): ReturnRequest {
  const { returnId, attemptId, shiftId, receiptId, lineId, quantity: units } = input;
  if (!isUuid(returnId) || !isUuid(attemptId) || !isUuid(shiftId) || !isUuid(receiptId) || !isUuid(lineId) ||
      !quantity(units)) throw new Error('Invalid return request');
  return { returnId, attemptId, shiftId, receiptId, lineId, quantity: units };
}
export function releaseFacts(input: unknown) {
  const { returnId, attemptId, evidence } = record(input);
  if (!isUuid(returnId) || !isUuid(attemptId) || !isLabel(evidence)) throw new Error('Verified nonexecution evidence required');
  return { returnId, attemptId, evidence };
}
