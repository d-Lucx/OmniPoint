import { createPrivateKey, createPublicKey } from 'node:crypto';
import { Terminal } from '../src/terminal.ts';
import { SimulatedDevices } from '../src/retail-devices.ts';
import { createRegisterServer } from '../src/register-server.ts';

const terminal = new Terminal(process.argv[2]);
let server: ReturnType<typeof createRegisterServer> | undefined;
interface Serve {
  action: 'serve'; port: number; pause?: boolean; drawerId: string; secret: string; pin: string; actorId: string;
  supervisorPem: string; cloudUrl: string; token: string; publicPem: string; keyId: string;
}
process.on('message', (command: Serve | { action: 'close' }) => {
  if (command.action === 'close') {
    const finish = () => {
      terminal.close();
      process.send!({ type: 'result' }, () => process.disconnect());
    };
    if (server) { server.close(finish); server.closeAllConnections(); }
    else finish();
    return;
  }
  try {
    const register = terminal.retail({
      devices: new SimulatedDevices(), supervisor: { actorId: command.actorId, pin: command.pin,
        signer: { id: 'fixture-supervisor', key: createPrivateKey(command.supervisorPem) } },
      cloud: { url: command.cloudUrl, token: command.token, keys: new Map([[command.keyId, createPublicKey(command.publicPem)]]) },
    });
    server = createRegisterServer(register, {
      cashierSecret: command.secret, drawerId: command.drawerId,
      checkoutBoundary: command.pause ? async phase => {
        if (phase === 'after-commit') await new Promise<void>(() => process.send!({ type: 'barrier', phase }));
      } : undefined,
    });
    server.listen(command.port, '127.0.0.1', () => process.send!({ type: 'result', value: (server!.address() as { port: number }).port }));
  } catch (error) {
    process.send!({ type: 'error', message: error instanceof Error ? error.message : 'Retail child error' });
  }
});
process.send!({ type: 'ready' });
