import { sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { decode, isCounter, isIsoDate, isSignedEvidence, isSku, isUuid, jsonBytes, record } from './protocol.ts';
import type { Scope, SignedEvidence, SigningKey } from './protocol.ts';

export const maxQuotaUnits = 8;
export const maxGrantDurationMs = 7 * 24 * 60 * 60 * 1000;
export interface Position {
  positionId: string;
  locationId: string;
  sku: string;
}
type Destination = Pick<Scope, 'tenantId' | 'terminalId' | 'generation'>;
export interface Grant extends Destination, Position {
  version: 1;
  kind: 'GRANT';
  storeId: string;
  grantId: string;
  issuedAt: string;
  expiresAt: string;
  slices: string[];
  transfer: { id: string; dispatchLegId: string; sourceLocationId: string } | null;
}
export interface CustodyReceipt extends Destination {
  version: 1;
  kind: 'CUSTODY_RECEIPT';
  positionId: string;
  grantId: string;
  transferId: string;
  dispatchLegId: string;
  legId: string;
  slices: string[];
}

export function isPosition(value: Record<string, unknown>): value is Position & Record<string, unknown> {
  return isUuid(value.positionId) && isUuid(value.locationId) && isSku(value.sku);
}

export function sameDestination(a: Destination, b: Destination): boolean {
  return a.tenantId === b.tenantId && a.terminalId === b.terminalId && a.generation === b.generation;
}

function validSlices(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maxQuotaUnits &&
    value.every(isUuid) && new Set(value).size === value.length;
}

export function parseGrant(bytes: Buffer): Grant {
  const g = decode(bytes);
  if (g.version !== 1 || g.kind !== 'GRANT' || !isPosition(g) || !isUuid(g.tenantId) || !isUuid(g.storeId) ||
      !isUuid(g.terminalId) || !isCounter(g.generation) || !isUuid(g.grantId) || !validSlices(g.slices) ||
      !isIsoDate(g.issuedAt) || !isIsoDate(g.expiresAt) || g.issuedAt >= g.expiresAt ||
      Date.parse(g.expiresAt) - Date.parse(g.issuedAt) > maxGrantDurationMs) {
    throw new Error('Invalid quota grant');
  }
  if (g.transfer !== null) {
    const transfer = record(g.transfer);
    if (!isUuid(transfer.id) || !isUuid(transfer.dispatchLegId) || transfer.sourceLocationId !== g.locationId) {
      throw new Error('Invalid custody dispatch');
    }
  }
  return g as unknown as Grant;
}

export function parseCustody(bytes: Buffer): CustodyReceipt {
  const r = decode(bytes);
  if (r.version !== 1 || r.kind !== 'CUSTODY_RECEIPT' || !isUuid(r.tenantId) || !isUuid(r.positionId) ||
      !isUuid(r.terminalId) || !isCounter(r.generation) || !isUuid(r.grantId) || !isUuid(r.transferId) ||
      !isUuid(r.dispatchLegId) || !isUuid(r.legId) || r.legId === r.dispatchLegId || !validSlices(r.slices)) {
    throw new Error('Invalid custody receipt');
  }
  return r as unknown as CustodyReceipt;
}

export function receiptMatchesGrant(receipt: CustodyReceipt, grant: Grant): boolean {
  return sameDestination(receipt, grant) && receipt.grantId === grant.grantId && receipt.positionId === grant.positionId &&
    receipt.transferId === grant.transfer?.id && receipt.dispatchLegId === grant.transfer.dispatchLegId &&
    receipt.slices.every(slice => grant.slices.includes(slice));
}

type EvidenceKind = Grant['kind'] | CustodyReceipt['kind'];

function evidenceInput(kind: EvidenceKind, bytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`OmniPoint-Inventory-v1\n${kind}\n`), bytes]);
}

export function signEvidence(evidence: Grant | CustodyReceipt, signer: SigningKey): SignedEvidence {
  if (signer.key.type !== 'private' || signer.key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid inventory signer');
  const bytes = jsonBytes(evidence);
  return {
    body: bytes.toString('base64url'), keyId: signer.id,
    signature: sign(null, evidenceInput(evidence.kind, bytes), signer.key).toString('base64url'),
  };
}

export function verifyEvidence(packet: unknown, kind: EvidenceKind, keys: ReadonlyMap<string, KeyObject>): Buffer {
  if (!isSignedEvidence(packet)) throw new Error('Invalid inventory evidence envelope');
  const key = keys.get(packet.keyId);
  const bytes = Buffer.from(packet.body, 'base64url');
  if (key?.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || bytes.toString('base64url') !== packet.body ||
      !verify(null, evidenceInput(kind, bytes), key, Buffer.from(packet.signature, 'base64url'))) {
    throw new Error('Invalid inventory evidence signature');
  }
  return bytes;
}

export function storedEvidence(row: { body: Uint8Array; key_id: string; signature: string }): SignedEvidence {
  return { body: Buffer.from(row.body).toString('base64url'), keyId: row.key_id, signature: row.signature };
}
