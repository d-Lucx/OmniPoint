import type { KeyObject } from 'node:crypto';
import type { Pool } from 'pg';
import { isPosition } from './inventory-protocol.ts';
import { tenantTransaction } from './postgres.ts';
import { fileCustody, inspectShortfall, InventoryError, issueGrant, openPosition, receiveReplacement, resolveShortfall } from './quota-cloud.ts';
import { isCounter, isIsoDate, isSignedEvidence, isUuid } from './protocol.ts';
import type { SigningKey } from './protocol.ts';
import type { Supervisor } from './retail-protocol.ts';
import type { PaymentTrust } from './payment-cloud.ts';

export interface InventoryOperator { tenantId: string; token: string; actorId?: string }
export interface InventoryOptions {
  operators?: readonly InventoryOperator[];
  custodyKeys?: ReadonlyMap<string, KeyObject>;
  supervisors?: readonly Supervisor[];
  payments?: PaymentTrust;
}

export async function inventoryAction(
  pool: Pool, tenantId: string, input: Record<string, unknown>,
  signer: SigningKey, custodyKeys: ReadonlyMap<string, KeyObject>,
): Promise<unknown> {
  switch (input.action) {
    case 'open-position': {
      const { storeId, legacyDrained } = input;
      if (!isUuid(storeId) || legacyDrained !== true || !isPosition(input)) break;
      const { positionId, locationId, sku } = input;
      return tenantTransaction(pool, tenantId, db =>
        openPosition(db, { tenantId, storeId, sku }, { positionId, locationId, sku }));
    }
    case 'issue':
    case 'dispatch': {
      const { action, positionId, grantId, terminalId, generation, quantity, expiresAt,
        transferId, dispatchLegId, sourceLocationId } = input;
      if (!isUuid(positionId) || !isUuid(grantId) || !isUuid(terminalId) || !isCounter(generation) ||
          !isCounter(quantity) || !isIsoDate(expiresAt)) break;
      let transfer = null;
      if (action === 'dispatch') {
        if (!isUuid(transferId) || !isUuid(dispatchLegId) || !isUuid(sourceLocationId)) break;
        transfer = { id: transferId, dispatchLegId, sourceLocationId };
      }
      const request = { positionId, grantId, terminalId, generation, quantity, expiresAt, transfer };
      return tenantTransaction(pool, tenantId, db => issueGrant(db, tenantId, request, signer));
    }
    case 'file-custody': {
      const { receipt } = input;
      if (!isSignedEvidence(receipt)) break;
      return tenantTransaction(pool, tenantId, db => fileCustody(db, tenantId, receipt, custodyKeys));
    }
    case 'receive-replacement': {
      const { positionId, replacementId, provenance, quantity = 1 } = input;
      if (!isUuid(positionId) || !isUuid(replacementId) || typeof provenance !== 'string' ||
          quantity !== 1 ||
          provenance.length < 1 || provenance.length > 120 || provenance.trim() !== provenance ||
          /[\x00-\x1f\x7f]/.test(provenance)) break;
      return tenantTransaction(pool, tenantId, db => receiveReplacement(db, tenantId, positionId, replacementId, provenance));
    }
    case 'inspect-shortfall': {
      const { saleId } = input;
      if (!isUuid(saleId)) break;
      return tenantTransaction(pool, tenantId, db => inspectShortfall(db, tenantId, saleId));
    }
    case 'resolve-shortfall': {
      const { saleId, resolutionId, replacementId, quantity = 1 } = input;
      if (!isUuid(saleId) || !isUuid(resolutionId) || !isUuid(replacementId) || quantity !== 1) break;
      return tenantTransaction(pool, tenantId, db => resolveShortfall(db, tenantId, saleId, resolutionId, replacementId));
    }
  }
  throw new InventoryError('Invalid inventory operation', 400);
}
