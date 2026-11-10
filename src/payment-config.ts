import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fiscalAdapter } from './fiscal-signer.ts';
import { providerAdapter } from './payment-provider.ts';
import type { PaymentRoute } from './payment-protocol.ts';
import type { SignedEvidence } from './protocol.ts';

export type PublicKeys = Array<{ id: string; file: string }>;
export const jsonFile = <T = unknown>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export const publicKeys = (files: PublicKeys) =>
  new Map(files.map(({ id, file }) => [id, createPublicKey(readFileSync(file))]));
export interface TerminalPayments {
  provider: { url: string; route: PaymentRoute; keys: PublicKeys; idempotencyMs: number };
  fiscal: { url: string; enrollment: string; roots: PublicKeys; grant: string };
}
export function terminalPayments(config: TerminalPayments, providerToken: string, fiscalToken: string) {
  return {
    adapter: providerAdapter({
      ...config.provider,
      token: providerToken,
      keys: publicKeys(config.provider.keys),
    }),
    fiscal: fiscalAdapter({
      url: config.fiscal.url,
      token: fiscalToken,
      enrollment: jsonFile<SignedEvidence>(config.fiscal.enrollment),
      roots: publicKeys(config.fiscal.roots),
      grant: () => {
        try {
          return jsonFile<SignedEvidence>(config.fiscal.grant);
        } catch {
          return null;
        }
      },
    }),
  };
}
export function cloudPayments(path: string) {
  const config = jsonFile<{ routes: PaymentRoute[]; providerKeys: PublicKeys; fiscalRoots: PublicKeys }>(path);
  return {
    routes: config.routes,
    providerKeys: publicKeys(config.providerKeys),
    fiscalRoots: publicKeys(config.fiscalRoots),
  };
}
