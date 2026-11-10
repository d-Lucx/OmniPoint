import { sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { decode, isSignedEvidence, jsonBytes } from './protocol.ts';
import type { SignedEvidence, SigningKey } from './protocol.ts';

function input(purpose: string, bytes: Buffer) {
  return Buffer.concat([Buffer.from(`OmniPoint/4/${purpose}\n`), bytes]);
}

export function signArtifact(purpose: string, value: unknown, signer: SigningKey): SignedEvidence {
  if (signer.key.type !== 'private' || signer.key.asymmetricKeyType !== 'ed25519')
    throw new Error('Signing key rejected');
  const bytes = jsonBytes(value);
  return {
    body: bytes.toString('base64url'),
    keyId: signer.id,
    signature: sign(null, input(purpose, bytes), signer.key).toString('base64url'),
  };
}

export function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== fields.length || fields.some((key) => !Object.hasOwn(data, key))) {
    throw new Error('Unexpected fields');
  }
  return data;
}

export function openArtifact(purpose: string, packet: unknown, keys: ReadonlyMap<string, KeyObject>) {
  exact(packet, ['body', 'keyId', 'signature']);
  if (!isSignedEvidence(packet)) throw new Error('Invalid signed evidence');
  const bytes = Buffer.from(packet.body, 'base64url');
  const key = keys.get(packet.keyId);
  if (
    bytes.toString('base64url') !== packet.body ||
    key?.type !== 'public' ||
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, input(purpose, bytes), key, Buffer.from(packet.signature, 'base64url'))
  )
    throw new Error('Evidence signature rejected');
  return { bytes, data: decode(bytes) };
}
