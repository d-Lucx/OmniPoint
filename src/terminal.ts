import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Position } from './inventory-protocol.ts';
import { RetailRegister } from './retail-local.ts';
import type { RetailLocalOptions } from './retail-local.ts';
import { availableQuota, enableQuota, importGrant, importReceipt } from './quota-local.ts';
import {
  currency, digest, isLabel, isMinor, isScope, isSku, isUuid, jsonBytes, maxAckBytes,
  parseEvent, printableReceipt, readBounded, sameScope, trustedEndpoint, verifyVoucher,
} from './protocol.ts';
import type { SaleEvent, Scope, SignedEvidence } from './protocol.ts';

export interface Checkout {
  requestId: string;
  cashierId: string;
  sku: string;
  cashMinor: number;
}
export interface Receipt { saleId: string; receiptId: string; printable: string }
export interface ReceiptPrinter { print(receipt: Receipt): void }

export class VirtualPrinter implements ReceiptPrinter {
  readonly deliveries: Receipt[] = [];

  print(receipt: Receipt): void {
    this.deliveries.push({ ...receipt });
  }
}

export interface SyncConfig {
  url: string;
  token: string;
  keys: ReadonlyMap<string, KeyObject>;
}

const httpTimeoutMs = 8_000;
const leaseMs = 20_000;
type Attempt = { sale_id: string; event_bytes: Uint8Array; digest: string; attempts: number };
type CheckoutBoundary = (phase: 'before-commit' | 'after-commit') => Promise<void>;

export class Terminal {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path || path === ':memory:') throw new Error('A local SQLite file is required');
    const db = new DatabaseSync(path, { timeout: 5000 });
    this.db = db;
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
          db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
          db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
        throw new Error('Required SQLite durability settings unavailable');
      }
      this.write(() => {
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        const files = ['001-local.sql', '002-local.sql', '003-local.sql', '004-local.sql'];
        if (!Number.isInteger(version) || version < 0 || version > files.length) throw new Error('Unsupported local schema');
        for (const [index, file] of files.entries()) {
          if (index < version) continue;
          db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
          db.exec(`PRAGMA user_version = ${index + 1}`);
        }
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  retail(options: RetailLocalOptions): RetailRegister {
    const scope = this.scope();
    if (!scope) throw new Error('Enroll the terminal first');
    return new RetailRegister(this.db, scope, options);
  }

  enableQuota(position: Position): void {
    this.write(() => enableQuota(this.db, position));
  }

  importGrant(packet: SignedEvidence, keys: ReadonlyMap<string, KeyObject>): void {
    this.write(() => {
      const scope = this.scope();
      if (!scope) throw new Error('Terminal must be enrolled');
      importGrant(this.db, scope, packet, keys);
    });
  }

  importCustody(packet: SignedEvidence, keys: ReadonlyMap<string, KeyObject>): void {
    this.write(() => importReceipt(this.db, packet, keys));
  }

  close(): void {
    this.db.close();
  }

  private write<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  initialize(scope: Scope, item: { sku: string; label: string; unitMinor: number; onHand: number }): void {
    if (!isScope({ ...scope }) || !isSku(item.sku) || !isLabel(item.label) || !isMinor(item.unitMinor) ||
        !Number.isSafeInteger(item.onHand) || item.onHand < 0) throw new Error('Invalid terminal setup');
    this.write(() => {
      const current = this.scope();
      if (current) {
        if (!sameScope(current, scope)) throw new Error('Terminal is already enrolled');
        return;
      }
      this.db.prepare('INSERT INTO terminal VALUES (1, ?, ?, ?, ?, ?, 1)')
        .run(scope.tenantId, scope.storeId, scope.terminalId, scope.generation, scope.cashierId);
      this.db.prepare('INSERT INTO catalog VALUES (?, ?, ?, ?, ?)')
        .run(item.sku, item.label, currency, item.unitMinor, item.onHand);
    });
  }

  private scope(): Scope | undefined {
    return this.db.prepare(`
      SELECT tenant_id AS tenantId, store_id AS storeId, terminal_id AS terminalId,
             generation, cashier_id AS cashierId FROM terminal
    `).get() as Scope | undefined;
  }

  recover(requestId: string): Receipt | undefined {
    if (this.db.isTransaction) throw new Error('Checkout is in progress');
    return this.findReceipt(requestId);
  }

  private findReceipt(requestId: string): Receipt | undefined {
    return this.db.prepare(`
      SELECT sale_id AS saleId, receipt_id AS receiptId, printable
      FROM receipts JOIN sales USING (sale_id) WHERE request_id = ?
    `).get(requestId) as Receipt | undefined;
  }

  reprint(requestId: string, printer: ReceiptPrinter): Receipt {
    const receipt = this.recover(requestId);
    if (!receipt) throw new Error('Receipt not found');
    printer.print(receipt);
    return receipt;
  }

  async checkout(input: Checkout, boundary?: CheckoutBoundary): Promise<Receipt> {
    if (!isUuid(input.requestId) || !isUuid(input.cashierId) || !isSku(input.sku) || !isMinor(input.cashMinor)) {
      throw new Error('Invalid checkout');
    }
    this.db.exec('BEGIN IMMEDIATE');
    let receipt: Receipt;
    try {
      const scope = this.scope();
      if (!scope || scope.cashierId !== input.cashierId) throw new Error('Cashier is not enrolled');
      const existing = this.findReceipt(input.requestId);
      if (existing) {
        const facts = this.db.prepare(`
          SELECT sku, cash_minor FROM sales JOIN sale_lines USING (sale_id) WHERE request_id = ?
        `).get(input.requestId);
        if (facts?.sku !== input.sku || facts.cash_minor !== input.cashMinor) throw new Error('Checkout request conflict');
        this.db.exec('COMMIT');
        return existing;
      }
      const item = this.db.prepare('SELECT label, unit_minor, currency FROM catalog WHERE sku = ?').get(input.sku);
      if (!item || item.currency !== currency || item.unit_minor !== input.cashMinor) {
        throw new Error('Exact cash tender for a catalog item is required');
      }
      const occurredAt = new Date().toISOString();
      if (this.db.prepare('SELECT 1 FROM retail_positions WHERE sku=?').get(input.sku)) {
        throw new Error('Use a retail shift for this position');
      }
      const quota = availableQuota(this.db, input.sku, occurredAt);
      if (!quota) {
        const stock = this.db.prepare('UPDATE catalog SET on_hand = on_hand - 1 WHERE sku = ? AND on_hand >= 1')
          .run(input.sku);
        if (stock.changes !== 1) throw new Error('Insufficient stock');
      }
      const counter = this.db.prepare(`
        UPDATE terminal SET next_sequence = next_sequence + 1 WHERE singleton = 1
        RETURNING next_sequence - 1 AS sequence
      `).get();
      const event: SaleEvent = {
        ...scope, ...(quota ? { version: 2, quota } as const : { version: 1 } as const),
        saleId: randomUUID(), receiptId: randomUUID(),
        sequence: Number(counter?.sequence), occurredAt, currency,
        line: { id: randomUUID(), sku: input.sku, label: String(item.label), quantity: 1,
          unitMinor: input.cashMinor, stockDelta: -1 },
        taxMinor: 0, totalMinor: input.cashMinor,
        tender: { method: 'CASH', cashMinor: input.cashMinor, changeMinor: 0 },
      };
      const bytes = jsonBytes(event);
      parseEvent(bytes);
      receipt = { saleId: event.saleId, receiptId: event.receiptId, printable: printableReceipt(event) };
      this.db.prepare('INSERT INTO sales VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(event.saleId, input.requestId, event.sequence, event.cashierId, currency,
          event.totalMinor, event.tender.cashMinor, event.occurredAt);
      this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?)').run(receipt.receiptId, receipt.saleId, receipt.printable);
      this.db.prepare('INSERT INTO sale_lines VALUES (?, ?, ?, ?, ?, ?)')
        .run(event.line.id, event.saleId, input.sku, event.line.quantity, event.line.label, event.line.unitMinor);
      this.db.prepare('INSERT INTO stock_movements VALUES (?, ?)').run(event.line.id, event.line.stockDelta);
      if (quota) this.db.prepare('INSERT INTO quota_spends VALUES (?, ?, ?)').run(quota.grantId, quota.sliceId, event.saleId);
      this.db.prepare("INSERT INTO outbox (sale_id, event_bytes, digest, state) VALUES (?, ?, ?, 'PENDING')")
        .run(event.saleId, bytes, digest(bytes));
      if (boundary) await boundary('before-commit');
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    if (boundary) await boundary('after-commit');
    return receipt;
  }

  private claim(now: number): Attempt | undefined {
    return this.write(() => {
      const row = this.db.prepare(`
        SELECT sale_id, event_bytes, digest, attempts FROM outbox JOIN sales USING (sale_id)
        WHERE state IN ('PENDING', 'RETRY_WAIT') OR (state = 'IN_FLIGHT' AND lease_until <= ?)
        ORDER BY local_sequence_no LIMIT 1
      `).get(now) as Attempt | undefined;
      if (!row) return undefined;
      this.db.prepare(`
        UPDATE outbox_attempts SET result = 'LEASE_EXPIRED' WHERE sale_id = ? AND attempt = ? AND result IS NULL
      `).run(row.sale_id, row.attempts);
      row.attempts++;
      this.db.prepare("UPDATE outbox SET state = 'IN_FLIGHT', attempts = ?, lease_until = ? WHERE sale_id = ?")
        .run(row.attempts, now + leaseMs, row.sale_id);
      this.db.prepare('INSERT INTO outbox_attempts VALUES (?, ?, ?, NULL)').run(row.sale_id, row.attempts, now);
      return row;
    });
  }

  async syncOnce(config: SyncConfig, now = Date.now()): Promise<string> {
    const url = trustedEndpoint(config.url);
    const row = this.claim(now);
    if (!row) return 'IDLE';
    let state = 'RETRY_WAIT';
    let result = 'TRANSPORT_ERROR';
    let ackId: string | null = null;
    try {
      const bytes = Buffer.from(row.event_bytes);
      const event = parseEvent(bytes);
      if (digest(bytes) !== row.digest || event.saleId !== row.sale_id) throw new Error('Corrupt local event');
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(httpTimeoutMs),
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: bytes,
      });
      if (response.status === 202 && event.version === 2) {
        await response.body?.cancel();
        result = 'HTTP_202';
        throw new Error('Staged response is retryable');
      }
      result = 'ACK_REJECTED';
      if (response.headers.has('content-encoding')) {
        await response.body?.cancel();
        throw new Error('Encoded acknowledgment');
      }
      const body = response.body ? await readBounded(response.body, maxAckBytes) : Buffer.alloc(0);
      const ack = verifyVoucher(response.status, body, response.headers, config.keys, event, row.digest);
      ackId = ack.ackId;
      result = ack.disposition;
      state = result === 'COMMITTED' || result === 'BACKORDER' ? 'SYNCED' : 'CONFLICT_HELD';
    } catch {
      // An uncertain attempt must remain actionable.
    }
    return this.write(() => {
      const changed = this.db.prepare(`
        UPDATE outbox SET state = ?, lease_until = NULL, ack_id = ?
        WHERE sale_id = ? AND state = 'IN_FLIGHT' AND attempts = ?
      `).run(state, ackId, row.sale_id, row.attempts);
      if (changed.changes !== 1) return 'LEASE_LOST';
      this.db.prepare('UPDATE outbox_attempts SET result = ? WHERE sale_id = ? AND attempt = ?')
        .run(result, row.sale_id, row.attempts);
      return state;
    });
  }
}
