import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { devItem } from '../src/development.ts';
import type { Enrollment } from '../src/cloud.ts';
import { identifier, migrate, poolFor } from '../src/postgres.ts';
import { Terminal } from '../src/terminal.ts';

function fixtureUrl(): URL {
  const raw = process.env.OMNI_TEST_ADMIN_URL;
  if (process.env.OMNI_TEST_DISPOSABLE !== '1' || !raw) {
    throw new Error('Set OMNI_TEST_DISPOSABLE=1 and OMNI_TEST_ADMIN_URL for a disposable loopback omnipoint_test service');
  }
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port || url.pathname !== '/omnipoint_test' || !url.username || !url.password || url.search || url.hash) {
    throw new Error('Refusing database setup outside a disposable loopback omnipoint_test service');
  }
  return url;
}

export async function testDatabase() {
  const url = fixtureUrl();
  const prefix = `omni_m1_${randomBytes(8).toString('hex')}`;
  const names = { database: prefix, owner: `${prefix}_owner`, runtime: `${prefix}_app` };
  const admin = poolFor(url.href);
  const created: string[] = [];
  const cleanup = async () => {
    try {
      if (created.includes(names.database)) await admin.query(`DROP DATABASE ${identifier(names.database)} WITH (FORCE)`);
      for (const role of [names.runtime, names.owner]) {
        if (created.includes(role)) await admin.query(`DROP ROLE ${identifier(role)}`);
      }
    } finally {
      await admin.end();
    }
  };
  const runtimeUrl = new URL(url);
  const migrationUrl = new URL(url);
  try {
    for (const [role, target] of [[names.owner, migrationUrl], [names.runtime, runtimeUrl]] as const) {
      const password = randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE ${identifier(role)} LOGIN PASSWORD '${password}'`);
      created.push(role);
      target.username = role;
      target.password = password;
      target.pathname = `/${names.database}`;
    }
    await admin.query(`CREATE DATABASE ${identifier(names.database)} OWNER ${identifier(names.owner)} TEMPLATE template0`);
    created.push(names.database);
    const dbUrl = new URL(url);
    dbUrl.pathname = `/${names.database}`;
    const upgrade = async () => {
      const migration = poolFor(migrationUrl.href);
      try {
        await migrate(migration, names.runtime);
      } finally {
        await migration.end();
      }
    };
    await upgrade();
    await upgrade();
    const fixture = poolFor(dbUrl.href);
    const runtime = poolFor(runtimeUrl.href);
    return {
      fixture, runtime, upgrade,
      oneConnection: () => poolFor(runtimeUrl.href, 1),
      async close() {
        try {
          await Promise.all([fixture.end(), runtime.end()]);
        } finally {
          await cleanup();
        }
      },
    };
  } catch (error) {
    await cleanup();
    const code = typeof error === 'object' && error && 'code' in error ? error.code : 'unknown';
    throw new Error(`Disposable PostgreSQL setup failed (${code})`);
  }
}

export type TestDatabase = Awaited<ReturnType<typeof testDatabase>>;

export async function seed(db: TestDatabase, other?: Enrollment): Promise<Enrollment> {
  const enrollment = {
    tenantId: randomUUID(), storeId: randomUUID(), terminalId: other?.terminalId ?? randomUUID(),
    generation: 1, cashierId: randomUUID(), token: randomBytes(32).toString('base64url'),
  };
  const { tenantId, storeId, terminalId, generation, cashierId } = enrollment;
  const client = await db.fixture.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO omni.tenants VALUES ($1)', [tenantId]);
    await client.query('INSERT INTO omni.stores VALUES ($1,$2)', [tenantId, storeId]);
    await client.query('INSERT INTO omni.terminals VALUES ($1,$2,$3,$4)', [tenantId, storeId, terminalId, generation]);
    await client.query('INSERT INTO omni.cashiers VALUES ($1,$2,$3)', [tenantId, storeId, cashierId]);
    await client.query('INSERT INTO omni.stock VALUES ($1,$2,$3,$4)', [tenantId, storeId, devItem.sku, devItem.onHand]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return enrollment;
}

export function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

type Message = { type: string; phase?: string; message?: string; value?: unknown };

export class TerminalChild {
  private readonly process: ChildProcess;
  private readonly exited: Promise<[number | null, NodeJS.Signals | null]>;
  private readonly ready: Promise<Message>;

  constructor(path: string) {
    const { OMNI_TEST_ADMIN_URL: _admin, ...env } = process.env;
    this.process = fork(fileURLToPath(new URL('terminal-child.ts', import.meta.url)), [path], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', execArgv: [], env,
    });
    this.exited = once(this.process, 'exit') as typeof this.exited;
    void this.exited.catch(() => {});
    this.ready = this.receive();
    void this.ready.catch(() => {});
  }

  private receive(payload?: object): Promise<Message> {
    const child = this.process;
    let onMessage!: (message: Message) => void;
    let onExit!: () => void;
    let onError!: (error: Error) => void;
    const response = new Promise<Message>((resolve, reject) => {
      onMessage = resolve;
      onExit = () => reject(new Error('Terminal child exited before replying'));
      onError = reject;
      child.once('message', onMessage).once('exit', onExit).once('error', onError);
      if (payload) child.send(payload, error => { if (error) reject(error); });
    });
    return bounded(response, 'terminal IPC', 12000).finally(() => {
      child.off('message', onMessage).off('exit', onExit).off('error', onError);
    });
  }

  async send(payload: object): Promise<Message> {
    assert.equal((await this.ready).type, 'ready');
    const response = await this.receive(payload);
    if (response.type === 'error') throw new Error(response.message);
    return response;
  }

  async kill(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    assert.equal(this.process.kill('SIGKILL'), true);
    assert.deepEqual(await bounded(this.exited, 'terminal forced exit'), [null, 'SIGKILL']);
  }

  async close(): Promise<void> {
    assert.equal((await this.send({ action: 'close' })).type, 'result');
    assert.deepEqual(await bounded(this.exited, 'terminal clean exit'), [0, null]);
  }
}

export async function testResources(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'omnipoint-'));
  const children: TerminalChild[] = [];
  const servers: Server[] = [];
  t.after(async () => {
    try {
      await Promise.allSettled(children.map(child => child.kill())).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
    } finally {
      try {
        await Promise.all(servers.map(server => new Promise<void>(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        })));
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 4 });
      }
    }
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { id: 'fixture-ed25519', key: privateKey };
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    dir, signer, publicKey, publicPem,
    register(enrollment: Enrollment) {
      const { token, ...scope } = enrollment;
      const path = join(dir, `${scope.terminalId}-${randomUUID()}.sqlite`);
      const terminal = new Terminal(path);
      try {
        terminal.initialize(scope, devItem);
      } finally {
        terminal.close();
      }
      return {
        path, enrollment, scope,
        input: { requestId: randomUUID(), cashierId: scope.cashierId, sku: devItem.sku, cashMinor: 2000 },
        child() {
          const child = new TerminalChild(path);
          children.push(child);
          return child;
        },
        sync(url: string) {
          return { action: 'sync', url, token, keyId: signer.id, publicPem };
        },
      };
    },
    async listen(server: Server) {
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await bounded(once(server, 'listening'), 'HTTP listen');
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sales`;
    },
  };
}

export async function scenario(t: TestContext, db: TestDatabase) {
  const resources = await testResources(t);
  return { ...resources, ...resources.register(await seed(db)) };
}

export function local<T>(path: string, inspect: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}
