import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decode, digest, jsonBytes, readBounded } from './protocol.ts';
import type { RetailRegister } from './retail-local.ts';
import { exact } from './authority.ts';
import { webhookPacket } from './payment-local.ts';

const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmniPoint Retail Register</title><link rel="stylesheet" href="/register.css"><script defer src="/register.js"></script></head>
<body><div id="app"></div></body></html>`;

export interface RegisterServerOptions {
  cashierSecret: string;
  drawerId: string;
  bundle?: Uint8Array;
  checkoutBoundary?: (phase: 'before-commit' | 'after-commit') => Promise<void>;
  kitchen?: Readonly<Record<string, 'hot' | 'cold'>>;
}

export function createRegisterServer(register: RetailRegister, options: RegisterServerOptions): Server {
  if (options.cashierSecret.length < 12 || options.cashierSecret.length > 128) {
    throw new Error('Use a distinct cashier secret of 12 to 128 characters');
  }
  const secret = Buffer.from(digest(Buffer.from(options.cashierSecret)), 'hex');
  const bundle = options.bundle ?? readFileSync(new URL('../dist/register.js', import.meta.url));
  const css = readFileSync(new URL('ui/register.css', import.meta.url));
  const sessions = new Map<string, number>();
  const kitchen = Object.entries(options.kitchen ?? {}).map(([token, station]) => {
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token) || token === options.cashierSecret ||
        (station !== 'hot' && station !== 'cold')) throw new Error('Invalid station enrollment');
    return { token: Buffer.from(digest(Buffer.from(token)), 'hex'), station };
  });
  let sequence = Promise.resolve();

  async function execute(input: Record<string, unknown>) {
    switch (input.action) {
      case 'module-state': return register.modules.state();
      case 'module-refresh': return register.modules.refresh();
      case 'module-diagnostics': return register.modules.diagnostics();
      case 'seat-table': return register.modules.seat(input.id, input.operationId, input.table, input.seats);
      case 'dispatch-ticket': return register.modules.dispatch(input.id, input.operationId, input.revision,
        input.seat, input.sku, input.modifier);
      case 'split-checks': return register.modules.split(input.id,input.operationId,input.revision,input.split);
      case 'work-intake': return register.modules.intake(input.id,input.operationId,input.booking,input.technician);
      case 'work-estimate': return register.modules.estimate(input.id,input.operationId,input.revision,input.sku);
      case 'work-authorize': return register.authorizeEstimate(input);
      case 'work-start': return register.modules.startWork(input.id,input.operationId,input.revision);
      case 'module-tender': {
        const receipt = register.moduleTender(input);
        await register.dispatchEvent(receipt.eventId);
        return receipt;
      }
      case 'appointment-draft': return register.modules.draft(input.id, input.operationId, input.staff, input.start, input.minutes);
      case 'appointment-book': return register.modules.book(input.id, input.operationId);
      case 'state': return;
      case 'storage': return register.storageStatus();
      case 'open': return register.openShift(input.id, options.drawerId, input.floatMinor);
      case 'scan': return register.scan(input.code);
      case 'add': return register.scan(input.sku, true);
      case 'quantity': return register.setQuantity(input.id, input.quantity);
      case 'discount': return register.discount(input.id, input.amount, input.reason, input.pin);
      case 'checkout': {
        const receipt = await register.checkout(input.id, input.tenderMinor, options.checkoutBoundary);
        await register.dispatchEvent(receipt.eventId);
        return receipt;
      }
      case 'card-start':
      case 'card-recover':
      case 'card-retry':
      case 'card-refund':
      case 'card-replace': {
        if(!register.payment) throw new Error('Card reader is unavailable');
        exact(input,input.action==='card-refund'||input.action==='card-replace'?['action','id','reason','pin']:['action','id']);
        const payment=register.payment;
        const result=input.action==='card-start'?await payment.start(input.id):
          input.action==='card-refund'?await payment.refund(input.id,input.reason,input.pin):
          input.action==='card-replace'?await payment.replace(input.id,input.reason,input.pin):
          await payment.recover(input.id,input.action==='card-retry');
        if(result.state==='FINALIZED') await register.dispatchEvent(result.intentId);
        return result;
      }
      case 'receipt': return register.receipt(input.id);
      case 'reprint': return register.reprint(input.id, input.commandId);
      case 'drop':
        register.drop(input.id, input.destinationId, input.amount, input.pin);
        if (typeof input.id === 'string') await register.dispatchEvent(input.id);
        return;
      case 'close': return register.close(input.id, input.count);
      case 'revise': return register.close(input.id, input.count, { previousId: input.previousId, reason: input.reason, pin: input.pin });
      case 'reserve-return': return register.reserveReturn(input, input.pin);
      case 'begin-payout': {
        const payout = await register.beginPayout(input.id);
        await register.dispatch(payout.attemptId);
        return payout;
      }
      case 'confirm-payout': {
        const receipt = register.confirmPayout(input.id, input.pin);
        if (receipt) await register.dispatchEvent(receipt.eventId);
        return receipt;
      }
      case 'release-return': return register.releaseReturn(input.id, input.evidence, input.pin);
      case 'sync': return register.syncOnce();
      case 'dispatch': return register.dispatch();
      case 'check-device': return register.checkDevice(input.id, input.evidence, input.pin);
      default: throw new Error('Unknown register action');
    }
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    const address = server.address() as AddressInfo;
    const host = `127.0.0.1:${address.port}`;
    if (address.address !== '127.0.0.1' || req.headers.host !== host) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET') {
      if (req.url === '/' || req.url === '/kitchen') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(shell);
      else if (req.url === '/register.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle);
      else if (req.url === '/register.css') res.writeHead(200, { 'content-type': 'text/css' }).end(css);
      else res.writeHead(404).end();
      return;
    }
    if(req.method==='POST'&&req.url==='/api/provider-webhook'&&register.payment) {
      if(req.headers['content-type']!=='application/json'||req.headers['content-encoding']) {
        res.writeHead(415).end();
        return;
      }
      try {
        const bytes=await readBounded(req.iterator({destroyOnReturn:false}),3072);
        await register.payment.webhook(webhookPacket(bytes,req.headers));
        res.writeHead(202).end();
      } catch { res.writeHead(422).end(); }
      return;
    }
    if (req.method !== 'POST' || (req.url !== '/api/register' && req.url !== '/api/kitchen')) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.origin !== `http://${host}` || req.headers['content-type'] !== 'application/json' ||
        req.headers['content-encoding'] || Number(req.headers['content-length']) > 8192) {
      res.writeHead(403, { connection: 'close' }).end();
      return;
    }
    let input;
    try { input = decode(await readBounded(req.iterator({ destroyOnReturn: false }), 8192)); }
    catch { res.writeHead(400, { connection: 'close' }).end(); return; }
    if (req.url === '/api/kitchen') {
      const token = /^Bearer ([A-Za-z0-9_-]{24,128})$/.exec(req.headers.authorization ?? '')?.[1];
      const hash = token && Buffer.from(digest(Buffer.from(token)), 'hex');
      const enrollment = hash && kitchen.find(entry => timingSafeEqual(entry.token, hash));
      if (!enrollment) { res.writeHead(401).end(); return; }
      try {
        const { station } = enrollment;
        let data: unknown;
        if (input.action === 'feed') {
          exact(input, ['action','cursor']);
          data = register.modules.kitchenFeed(station, input.cursor);
        } else {
          exact(input, ['action','id','operationId','revision','ticketId']);
          if (input.action !== 'ready' && input.action !== 'cancel') throw new Error('Unknown station action');
          data = register.modules.kitchenUpdate(input.id, input.operationId, input.revision,
            input.ticketId, station, input.action === 'ready' ? 'READY' : 'CANCELLED');
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(jsonBytes(data));
      } catch {
        res.writeHead(409, { 'content-type': 'application/json' }).end(jsonBytes({ error: 'Station action held' }));
      }
      return;
    }
    if (input.action === 'login') {
      if (typeof input.secret !== 'string' || input.secret.length > 128 ||
          !timingSafeEqual(secret, Buffer.from(digest(Buffer.from(input.secret)), 'hex'))) {
        res.writeHead(401).end();
        return;
      }
      const now = Date.now();
      for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
      if (sessions.size >= 32) { res.writeHead(429).end(); return; }
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, now + 8 * 60 * 60 * 1000);
      res.setHeader('set-cookie', `omni_register=${id}; HttpOnly; SameSite=Strict; Path=/api/register`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const id = /(?:^|; )omni_register=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (!id || (sessions.get(id) ?? 0) <= Date.now()) {
      res.writeHead(401).end();
      return;
    }
    if (input.action === 'logout') {
      sessions.delete(id);
      res.setHeader('set-cookie', 'omni_register=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/api/register');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const request = sequence.then(async () => {
      try {
        const data = await execute(input);
        res.writeHead(200, { 'content-type': 'application/json' }).end(jsonBytes({ data: data ?? null, state: register.state() }));
      } catch (error) {
        const message = error instanceof Error && !('code' in error) ? error.message : 'Register operation held';
        res.writeHead(409, { 'content-type': 'application/json' }).end(jsonBytes({ error: message, state: register.state() }));
      }
    });
    sequence = request.catch(() => { if (!res.destroyed) res.destroy(); });
  });
  return server;
}
