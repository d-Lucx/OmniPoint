import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { signArtifact } from './authority.ts';
import { createDurableSigner } from './fiscal-signer.ts';
import { createSimulatedProvider } from './payment-provider.ts';
import type { PaymentRoute } from './payment-protocol.ts';
import { jsonFile, publicKeys } from './payment-config.ts';
import type { PublicKeys } from './payment-config.ts';
import type { SignedEvidence } from './protocol.ts';

const [mode, configPath, ...args] = process.argv.slice(2);
if (!configPath) throw new Error('Use provider|signer with a configuration file, or sign with a facts file');
if (mode === 'sign') {
  const [purpose, id, file] = args;
  if (!['fiscal-enrollment', 'fiscal-genesis', 'fiscal-grant'].includes(purpose) || !id || !file)
    throw new Error('Select a fiscal authority purpose and key');
  console.log(
    JSON.stringify(
      signArtifact(purpose, jsonFile(configPath), { id, key: createPrivateKey(readFileSync(file)) }),
    ),
  );
} else {
  const config = jsonFile<{
    database: string;
    port: number;
    keyId: string;
    privateKey: string;
    routes?: PaymentRoute[];
    idempotencyMs?: number;
    enrollment?: string;
    genesis?: string;
    roots?: PublicKeys;
  }>(configPath);
  const token = mode === 'provider' ? process.env.OMNI_PROVIDER_TOKEN : process.env.OMNI_FISCAL_TOKEN;
  if (!token || token.length < 24 || !config.database || !Number.isInteger(config.port))
    throw new Error('Set fixture token, database and port');
  const signer = { id: config.keyId, key: createPrivateKey(readFileSync(config.privateKey)) };
  let service;
  if (mode === 'provider' && config.routes?.length) {
    service = createSimulatedProvider(config.database, token, config.routes, signer, {
      idempotencyMs: config.idempotencyMs ?? 0,
    });
  } else if (mode === 'signer' && config.enrollment && config.genesis && config.roots) {
    service = createDurableSigner(config.database, token, {
      signer,
      enrollment: jsonFile<SignedEvidence>(config.enrollment),
      genesis: jsonFile<SignedEvidence>(config.genesis),
      roots: publicKeys(config.roots),
      clock: () => {
        const now = new Date().toISOString();
        return { lower: now, upper: now };
      },
    });
  } else throw new Error('Invalid fixture configuration');
  const { server, close } = service;
  server.listen(config.port, '127.0.0.1', () => console.log(`Fixture listening on 127.0.0.1:${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      server.close(close);
      server.closeAllConnections();
    });
}
