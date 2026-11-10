import { createPrivateKey, createPublicKey } from 'node:crypto';
import { Terminal } from '../src/terminal.ts';
import { SimulatedDevices } from '../src/retail-devices.ts';
import { createRegisterServer } from '../src/register-server.ts';
import { providerAdapter } from '../src/payment-provider.ts';
import { fiscalAdapter } from '../src/fiscal-signer.ts';
import type { PaymentRoute } from '../src/payment-protocol.ts';
import type { SignedEvidence } from '../src/protocol.ts';

const terminal = new Terminal(process.argv[2]);
let server: ReturnType<typeof createRegisterServer> | undefined;
interface Serve {
  action: 'serve'; port: number; pause?: boolean; drawerId: string; secret: string; pin: string; actorId: string;
  supervisorPem: string; cloudUrl: string; token: string; publicPem: string; keyId: string;
  payment?:{provider:{url:string;token:string;route:PaymentRoute;publicPem:string;keyId:string;idempotencyMs:number};
    signer:{url:string;token:string;enrollment:SignedEvidence;rootPem:string;rootId:string;grant:SignedEvidence|null}};
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
    const p=command.payment;
    const payment=p&&{
      adapter:providerAdapter({url:p.provider.url,token:p.provider.token,route:p.provider.route,idempotencyMs:p.provider.idempotencyMs,
        keys:new Map([[p.provider.keyId,createPublicKey(p.provider.publicPem)]])}),
      fiscal:fiscalAdapter({url:p.signer.url,token:p.signer.token,enrollment:p.signer.enrollment,
        roots:new Map([[p.signer.rootId,createPublicKey(p.signer.rootPem)]]),grant:()=>p.signer.grant}),
    };
    const register = terminal.retail({
      payment,
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
