import { createPublicKey } from 'node:crypto';
import { Terminal, VirtualPrinter } from '../src/terminal.ts';
import type { Checkout } from '../src/terminal.ts';

type Command =
  | { action: 'checkout'; input: Checkout; pause?: 'before-commit' | 'after-commit' }
  | { action: 'recover' | 'reprint'; requestId: string }
  | { action: 'sync'; url: string; token: string; keyId: string; publicPem: string; now?: number }
  | { action: 'close' };

const terminal = new Terminal(process.argv[2]);
const printer = new VirtualPrinter();
process.on('message', async (command: Command) => {
  try {
    let value: unknown;
    switch (command.action) {
      case 'checkout':
        value = await terminal.checkout(command.input, async phase => {
          if (phase !== command.pause) return;
          await new Promise<void>(() => process.send!({ type: 'barrier', phase }));
        });
        break;
      case 'recover':
        value = terminal.recover(command.requestId);
        break;
      case 'reprint':
        value = { receipt: terminal.reprint(command.requestId, printer), deliveries: printer.deliveries };
        break;
      case 'sync':
        value = await terminal.syncOnce({
          url: command.url, token: command.token,
          keys: new Map([[command.keyId, createPublicKey(command.publicPem)]]),
        }, command.now);
        break;
      case 'close':
        terminal.close();
        process.send!({ type: 'result' }, () => process.disconnect());
        return;
    }
    process.send!({ type: 'result', value });
  } catch (error) {
    process.send!({ type: 'error', message: error instanceof Error ? error.message : 'Unexpected terminal error' });
  }
});
process.send!({ type: 'ready' });
