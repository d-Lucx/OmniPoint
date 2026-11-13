// Disposable, loopback-only review fixture. No deployment data or provider accounts.
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { testDatabase } from './fixture.ts';
import { retailFixture, secret, pin } from './retail-fixture.ts';
import { createRegisterServer } from '../src/register-server.ts';

const cleanup: Array<() => unknown> = [];
const context = { after(work: () => unknown) { cleanup.push(work); } } as unknown as TestContext;
const db = await testDatabase();
const f = await retailFixture(context, db, [32, 32, 32]);
await f.setup();
await db.fixture.query('INSERT INTO omni.capability_profiles VALUES($1,1,true,true,true)', [f.a.tenantId]);
const terminal = f.terminal(0);
for (const item of ['M1-ITEM', 'M3-RED', 'M3-TEA'])
  terminal.connection.importGrant(await f.issue(item, 0, 8), f.keys);
await terminal.register.modules.refresh();
const server = createRegisterServer(terminal.register, { cashierSecret: secret,
  drawerId: crypto.randomUUID(), kitchen: { 'fixture-hot-station-token-123456': 'hot' } });
await f.listen(server, 4318);
console.log(`Disposable UI review: http://127.0.0.1:4318 · cashier ${secret} · supervisor ${pin}`);
const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  if (line.trim() !== 'exit') return;
  for (const work of cleanup.reverse()) await work();
  await db.close();
  process.exit(0);
});
