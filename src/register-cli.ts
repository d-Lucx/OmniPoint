import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRegisterServer } from './register-server.ts';
import { SimulatedDevices } from './retail-devices.ts';
import { Terminal } from './terminal.ts';
import type { Scope } from './protocol.ts';
import type { Position } from './inventory-protocol.ts';
import { jsonFile,terminalPayments } from './payment-config.ts';
import type { TerminalPayments } from './payment-config.ts';

const [dbPath, configuration] = process.argv.slice(2);
if (!dbPath || !configuration) throw new Error('Usage: register <database.sqlite> <local-register.json>');
const config = JSON.parse(readFileSync(configuration, 'utf8')) as {
  scope: Scope; drawerId: string; catalog: unknown; positions: Position[];
  supervisor: { actorId: string; privateKeyFile: string };
};
const { OMNI_CASHIER_SECRET, OMNI_SUPERVISOR_PIN, OMNI_INGEST_URL, OMNI_TERMINAL_TOKEN, OMNI_PUBLIC_KEY_FILE,
  OMNI_KEY_ID, OMNI_REGISTER_PORT,OMNI_PAYMENT_FILE,OMNI_PROVIDER_TOKEN,OMNI_FISCAL_TOKEN } = process.env;
if (!OMNI_CASHIER_SECRET || !OMNI_SUPERVISOR_PIN) throw new Error('Set cashier and supervisor credentials');
const cloud = OMNI_INGEST_URL && OMNI_TERMINAL_TOKEN && OMNI_PUBLIC_KEY_FILE && OMNI_KEY_ID ?
  { url: OMNI_INGEST_URL, token: OMNI_TERMINAL_TOKEN,
    keys: new Map([[OMNI_KEY_ID, createPublicKey(readFileSync(OMNI_PUBLIC_KEY_FILE))]]) } : undefined;
const terminal = new Terminal(dbPath);
terminal.initialize(config.scope, { sku: 'M1-ITEM', label: 'Legacy demo item', unitMinor: 2000, onHand: 0 });
const register = terminal.retail({
  devices: new SimulatedDevices(), cloud,
  payment:OMNI_PAYMENT_FILE&&OMNI_PROVIDER_TOKEN&&OMNI_FISCAL_TOKEN?
    terminalPayments(jsonFile<TerminalPayments>(OMNI_PAYMENT_FILE),OMNI_PROVIDER_TOKEN,OMNI_FISCAL_TOKEN):undefined,
  supervisor: { actorId: config.supervisor.actorId, pin: OMNI_SUPERVISOR_PIN,
    signer: { id: 'local-supervisor', key: createPrivateKey(readFileSync(config.supervisor.privateKeyFile)) } },
});
register.installCatalog(config.catalog, config.positions);
const server = createRegisterServer(register, { drawerId: config.drawerId, cashierSecret: OMNI_CASHIER_SECRET });
server.listen(Number(OMNI_REGISTER_PORT ?? 4317), '127.0.0.1', () => {
  console.log('OmniPoint register listening on http://127.0.0.1:' + (server.address() as { port: number }).port);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => terminal.close()));
