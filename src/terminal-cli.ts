import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { devItem, devScope } from './development.ts';
import { Terminal, VirtualPrinter } from './terminal.ts';

const [path, command, requestId, cash, sku] = process.argv.slice(2);
if (!path || !command) throw new Error('Usage: terminal <sqlite-path> <init-demo|checkout|recover|reprint|sync> [request-id] [cash-minor] [sku]');
const terminal = new Terminal(path);
try {
  if (command === 'init-demo') {
    terminal.initialize(devScope, devItem);
  } else if (command === 'checkout') {
    const receipt = await terminal.checkout({ requestId, cashierId: devScope.cashierId,
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
    const key = createPublicKey(readFileSync(OMNI_PUBLIC_KEY_FILE));
    console.log(await terminal.syncOnce({
      url: OMNI_INGEST_URL, token: OMNI_TERMINAL_TOKEN, keys: new Map([[OMNI_KEY_ID, key]]),
    }));
  } else {
    throw new Error('Unknown terminal command');
  }
} finally {
  terminal.close();
}
