import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { devItem, devScope } from './development.ts';
import { Terminal, VirtualPrinter } from './terminal.ts';

const [path, command, requestId, cash, sku] = process.argv.slice(2);
if (!path || !command) {
  throw new Error('Usage: terminal <sqlite-path> <init-demo|init-enrolled|enable-quota|import-grant|import-custody|checkout|recover|reprint|sync> [file-or-request-id] [cash-minor] [sku]');
}
function readJson(file: string) {
  if (!file) throw new Error('JSON file required');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function trustKeys(file: string | undefined, id: string | undefined) {
  if (!file || !id) throw new Error('Trusted public key file and key ID required');
  return new Map([[id, createPublicKey(readFileSync(file))]]);
}
const terminal = new Terminal(path);
try {
  if (command === 'init-demo') {
    terminal.initialize(devScope, devItem);
  } else if (command === 'init-enrolled') {
    terminal.initialize(readJson(requestId), { ...devItem, onHand: 0 });
  } else if (command === 'enable-quota') {
    terminal.enableQuota(readJson(requestId));
  } else if (command === 'import-grant') {
    terminal.importGrant(readJson(requestId), trustKeys(process.env.OMNI_PUBLIC_KEY_FILE, process.env.OMNI_KEY_ID));
  } else if (command === 'import-custody') {
    terminal.importCustody(readJson(requestId),
      trustKeys(process.env.OMNI_CUSTODY_PUBLIC_KEY_FILE, process.env.OMNI_CUSTODY_KEY_ID));
  } else if (command === 'checkout') {
    const receipt = await terminal.checkout({ requestId, cashierId: process.env.OMNI_CASHIER_ID ?? devScope.cashierId,
      sku: sku ?? devItem.sku, cashMinor: Number(cash) });
    console.log(JSON.stringify(receipt));
  } else if (command === 'recover') {
    const receipt = terminal.recover(requestId);
    console.log(receipt ? JSON.stringify(receipt) : 'Receipt not found');
  } else if (command === 'reprint') {
    const printer = new VirtualPrinter();
    terminal.reprint(requestId, printer);
    console.log(printer.deliveries[0].printable);
  } else if (command === 'sync') {
    const { OMNI_INGEST_URL, OMNI_TERMINAL_TOKEN, OMNI_PUBLIC_KEY_FILE, OMNI_KEY_ID } = process.env;
    if (!OMNI_INGEST_URL || !OMNI_TERMINAL_TOKEN || !OMNI_PUBLIC_KEY_FILE || !OMNI_KEY_ID) {
      throw new Error('Set OMNI_INGEST_URL, OMNI_TERMINAL_TOKEN, OMNI_PUBLIC_KEY_FILE and OMNI_KEY_ID');
    }
    console.log(await terminal.syncOnce({
      url: OMNI_INGEST_URL, token: OMNI_TERMINAL_TOKEN, keys: trustKeys(OMNI_PUBLIC_KEY_FILE, OMNI_KEY_ID),
    }));
  } else {
    throw new Error('Unknown terminal command');
  }
} finally {
  terminal.close();
}
