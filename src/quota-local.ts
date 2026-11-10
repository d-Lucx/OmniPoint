import type { KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isPosition, parseCustody, parseGrant, receiptMatchesGrant, sameDestination, storedEvidence, verifyEvidence } from './inventory-protocol.ts';
import type { Position } from './inventory-protocol.ts';
import { digest } from './protocol.ts';
import type { QuotaSpend, Scope, SignedEvidence } from './protocol.ts';

export function enableQuota(db: DatabaseSync, position: Position): void {
  if (!isPosition({ ...position }) || !db.prepare('SELECT 1 FROM terminal').get()) {
    throw new Error('Invalid quota enrollment');
  }
  const old = db.prepare('SELECT position_id, location_id FROM quota_position WHERE sku = ?').get(position.sku);
  if (old) {
    if (old.position_id !== position.positionId || old.location_id !== position.locationId) throw new Error('Quota position conflict');
    return;
  }
  if (db.prepare("SELECT 1 FROM outbox WHERE state <> 'SYNCED' LIMIT 1").get()) {
    throw new Error('Drain the existing outbox before quota cutover');
  }
  db.prepare('INSERT INTO quota_position VALUES (?, ?, ?)').run(position.sku, position.positionId, position.locationId);
}

export function importGrant(db: DatabaseSync, scope: Scope, packet: SignedEvidence, keys: ReadonlyMap<string, KeyObject>): void {
  const bytes = verifyEvidence(packet, 'GRANT', keys);
  const grant = parseGrant(bytes);
  const position = db.prepare('SELECT position_id, location_id FROM quota_position WHERE sku = ?').get(grant.sku);
  if (!sameDestination(grant, scope) || grant.storeId !== scope.storeId ||
      position?.position_id !== grant.positionId || position.location_id !== grant.locationId) {
    throw new Error('Grant does not match terminal and stock scope');
  }
  const hash = digest(bytes);
  const prior = db.prepare('SELECT digest FROM quota_grants WHERE grant_id = ?').get(grant.grantId);
  if (prior) {
    if (prior.digest !== hash) throw new Error('Conflicting quota grant');
    return;
  }
  db.prepare('INSERT INTO quota_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(grant.grantId, grant.positionId, bytes, hash, packet.keyId, packet.signature,
      grant.issuedAt, grant.expiresAt, grant.transfer?.id ?? null);
  const unit = db.prepare('INSERT INTO quota_units VALUES (?, ?)');
  for (const slice of grant.slices) unit.run(grant.grantId, slice);
}

export function importReceipt(db: DatabaseSync, packet: SignedEvidence, keys: ReadonlyMap<string, KeyObject>): void {
  const bytes = verifyEvidence(packet, 'CUSTODY_RECEIPT', keys);
  const receipt = parseCustody(bytes);
  const row = db.prepare('SELECT body FROM quota_grants WHERE grant_id = ?').get(receipt.grantId);
  if (!row || !receiptMatchesGrant(receipt, parseGrant(Buffer.from(row.body as Uint8Array)))) {
    throw new Error('Custody receipt does not match dispatch');
  }
  const prior = db.prepare('SELECT body FROM custody_receipts WHERE leg_id = ?').get(receipt.legId);
  if (prior) {
    if (digest(prior.body as Uint8Array) !== digest(bytes)) throw new Error('Conflicting custody leg');
    return;
  }
  db.prepare('INSERT INTO custody_receipts VALUES (?, ?, ?, ?, ?)')
    .run(receipt.legId, receipt.grantId, bytes, packet.keyId, packet.signature);
  const unit = db.prepare('INSERT INTO custody_units VALUES (?, ?, ?)');
  for (const slice of receipt.slices) unit.run(receipt.grantId, slice, receipt.legId);
}

export function availableQuota(
  db: DatabaseSync, sku: string, occurredAt: string, excluded: string[] = [], retail = false,
): QuotaSpend | undefined {
  const position = db.prepare('SELECT position_id, location_id FROM quota_position WHERE sku = ?').get(sku);
  if (!position) return undefined;
  const row = db.prepare(`
    SELECT g.grant_id, g.digest, u.slice_id, c.body, c.key_id, c.signature
    FROM quota_grants g JOIN quota_units u USING (grant_id)
    LEFT JOIN custody_units cu USING (grant_id, slice_id)
    LEFT JOIN custody_receipts c USING (grant_id, leg_id)
    WHERE g.position_id = ? AND g.issued_at <= ? AND g.expires_at > ?
      AND coalesce(json_extract(CAST(g.body AS TEXT), '$.retail'),0) = ?
      AND (g.transfer_id IS NULL OR c.leg_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM quota_spends spent WHERE spent.slice_id = u.slice_id)
      AND NOT EXISTS (SELECT 1 FROM retail_spends spent WHERE spent.slice_id = u.slice_id)
      AND u.slice_id NOT IN (SELECT value FROM json_each(?))
    ORDER BY g.expires_at, g.grant_id, u.slice_id LIMIT 1
  `).get(position.position_id, occurredAt, occurredAt, Number(retail), JSON.stringify(excluded)) as {
    grant_id: string; digest: string; slice_id: string; body: Uint8Array | null; key_id: string; signature: string;
  } | undefined;
  if (!row) throw new Error('No usable offline quota');
  return {
    positionId: String(position.position_id), locationId: String(position.location_id),
    grantId: row.grant_id, grantDigest: row.digest, sliceId: row.slice_id,
    ...(row.body ? { custody: storedEvidence({ ...row, body: row.body }) } : {}),
  };
}
