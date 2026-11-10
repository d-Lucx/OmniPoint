import { randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync,statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { enableQuota, availableQuota } from './quota-local.ts';
import type { Position } from './inventory-protocol.ts';
import { digest, isLabel, isUuid, jsonBytes, maxAckBytes, readBounded, record, trustedEndpoint, verifySignedResponse, verifyVoucher } from './protocol.ts';
import type { Scope, SigningKey } from './protocol.ts';
import { blindTotal, money, priceLine, quantity, totals } from './retail-money.ts';
import type { Quote } from './retail-money.ts';
import { approve, discountFacts, dropFacts, parseCatalog, parseRetail, payoutFacts, revisionFacts, salePrintable } from './retail-protocol.ts';
import type { Adjustment, RetailCount, RetailEvent, RetailHeader, RetailLine, RetailReturn, RetailSale } from './retail-protocol.ts';
import { releaseFacts, returnRequest } from './retail-return.ts';
import type { ReturnReservation } from './retail-return.ts';
import { observeDevice } from './retail-devices.ts';
import type { DeviceAdapter, DeviceKind } from './retail-devices.ts';
import { parseCard } from './card-event.ts';
import { PaymentRegister } from './payment-local.ts';
import type { PaymentOptions } from './payment-local.ts';

export interface RetailLocalOptions {
  supervisor: { actorId: string; pin: string; signer: SigningKey };
  devices: DeviceAdapter;
  cloud?: { url: string; token: string; keys: ReadonlyMap<string, KeyObject> };
  deviceTimeoutMs?: number;
  payment?: PaymentOptions;
}
type Shift = { shift_id: string; drawer_id: string; state: 'OPEN' | 'CLOSED' };
type CartLine = { id: string; quote: Quote; quantity: number; discount: Adjustment | null };
type Receipt = { receiptId: string; eventId: string; originalReceiptId: string | null; printable: string;
  lines?: Array<{ id: string; sku: string }> };
type Refund = { state: string; reservation: ReturnReservation };
type CheckoutBoundary = (phase: 'before-commit' | 'after-commit') => Promise<void>;

export class RetailRegister {
  private readonly db: DatabaseSync;
  private readonly scope: Scope;
  private readonly options: RetailLocalOptions;
  private cloudState: 'UNKNOWN' | 'OFFLINE' | 'ONLINE' = 'UNKNOWN';
  readonly payment?: PaymentRegister;

  constructor(db: DatabaseSync, scope: Scope, options: RetailLocalOptions) {
    this.db = db;
    this.scope = scope;
    this.options = options;
    if (options.payment) this.payment = new PaymentRegister(db,scope,options.payment,{
      build: id => {
        const shift = this.open();
        if (this.db.prepare("SELECT 1 FROM retail_refunds WHERE shift_id=? AND state IN ('RESERVED','UNCERTAIN')").get(shift.shift_id)) {
          throw new Error('Resolve cash refund first');
        }
        return this.buildSale(id,undefined,true);
      },
      finalize: (sale,bytes,printable) => this.saveSale(sale,bytes,printable),
      receipt: id => this.receipt(id),
      approval: (pin,action,facts) => this.approval(pin,action,facts),
      funds: async (action,payload) => {
        const {response,body} = await this.cloud('funds','/v4/funds',jsonBytes({action,payload}));
        verifySignedResponse(response.status,body,response.headers,this.options.cloud!.keys);
      },
    });
    this.db.prepare("UPDATE retail_devices SET state='UNCERTAIN', detail='INTERRUPTED' WHERE state='IN_FLIGHT'").run();
  }

  private write<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if(this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private unfrozen(except?: string) {
    if(this.db.prepare(`SELECT 1 FROM payment_intents WHERE state NOT IN ('FINALIZED','REFUNDED') AND intent_id<>?`)
      .get(except ?? '')) throw new Error('A card payment owns this basket and shift cut');
  }

  storageStatus() {
    const path=this.db.location();
    let freeBytes:number|null=null;
    let walBytes=0;
    if(path) {
      try { const stat=statfsSync(dirname(path)); freeBytes=stat.bavail*stat.bsize; } catch { /* Filesystem counters unavailable. */ }
      try { walBytes=statSync(path+'-wal').size; } catch { /* No WAL file. */ }
    }
    const checkpoint=this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    return {freeBytes,walBytes,pages:this.db.prepare('PRAGMA page_count').get()?.page_count,
      maxPages:this.db.prepare('PRAGMA max_page_count').get()?.max_page_count,
      pendingWalFrames:Math.max(0,Number(checkpoint?.log??0)-Number(checkpoint?.checkpointed??0))};
  }

  installCatalog(value: unknown, positions: readonly Position[]): void {
    const catalog = parseCatalog(value);
    this.write(() => {
      const body = JSON.stringify(catalog);
      const old = this.db.prepare('SELECT body FROM retail_catalogs WHERE version=?').get(catalog.version);
      if (old && old.body !== body) throw new Error('Catalog version conflict');
      this.db.prepare('INSERT OR IGNORE INTO retail_catalogs VALUES (?,?)').run(catalog.version, body);
      const variant = this.db.prepare("INSERT OR IGNORE INTO catalog VALUES (?,?,'USD',?,0)");
      for (const item of catalog.variants) variant.run(item.sku, item.label, item.unitMinor);
      for (const position of positions) {
        if (!this.db.prepare('SELECT 1 FROM retail_positions WHERE sku=?').get(position.sku) &&
            this.db.prepare("SELECT 1 FROM outbox WHERE state <> 'SYNCED' LIMIT 1").get()) {
          throw new Error('Drain the legacy outbox before retail cutover');
        }
        enableQuota(this.db, position);
        this.db.prepare('INSERT OR IGNORE INTO retail_positions VALUES (?)').run(position.sku);
      }
    });
  }

  private authorized(pin: unknown): void {
    const supervisor = this.options.supervisor;
    if (typeof pin !== 'string' || pin.length > 128 ||
        !timingSafeEqual(Buffer.from(digest(Buffer.from(pin)), 'hex'), Buffer.from(digest(Buffer.from(supervisor.pin)), 'hex'))) {
      throw new Error('Supervisor authorization required');
    }
  }

  private approval(pin: unknown, action: string, facts: unknown) {
    this.authorized(pin);
    const { actorId, signer } = this.options.supervisor;
    return approve(this.scope, actorId, action, facts, signer);
  }

  private shift(): Shift | undefined {
    return this.db.prepare('SELECT shift_id,drawer_id,state FROM retail_shifts ORDER BY rowid DESC LIMIT 1').get() as Shift | undefined;
  }

  private open(): Shift {
    const shift = this.shift();
    if (shift?.state !== 'OPEN') throw new Error('Open a shift first');
    return shift;
  }

  private header(shiftId: string, id: unknown): RetailHeader {
    if (!isUuid(id)) throw new Error('Stable request UUID required');
    const next = this.db.prepare('SELECT coalesce(max(source_no),0)+1 AS n FROM retail_events WHERE shift_id=?').get(shiftId);
    return { ...this.scope, version: 3, currency: 'USD', saleId: id, shiftId, sequence: Number(next?.n), occurredAt: new Date().toISOString() };
  }

  private event(id: unknown): RetailEvent | undefined {
    if (!isUuid(id)) throw new Error('Stable request UUID required');
    const row = this.db.prepare('SELECT event_bytes FROM retail_events WHERE event_id=?').get(id);
    if(!row) return;
    const bytes=Buffer.from(row.event_bytes as Uint8Array);
    return record(JSON.parse(bytes.toString('utf8'))).version===4 ? parseCard(bytes).sale : parseRetail(bytes);
  }

  private append(event: RetailEvent, card?: Buffer): void {
    const bytes = card ?? jsonBytes(event);
    if(card) parseCard(bytes); else parseRetail(bytes);
    this.db.prepare('INSERT INTO retail_events (event_id,shift_id,source_no,kind,event_bytes,digest) VALUES (?,?,?,?,?,?)')
      .run(event.saleId, event.shiftId, event.sequence, event.kind, bytes, digest(bytes));
  }

  private cash(event: RetailEvent, amount: number, destination: string | null = null): void {
    const next = this.expected(event.shiftId) + amount;
    if (!money(next)) throw new Error('Cash balance outside fixture bounds');
    this.db.prepare('INSERT INTO retail_cash VALUES (?,?,?,?,?)').run(event.saleId, event.shiftId, event.kind, amount, destination);
  }

  private expected(shiftId: string): number {
    return Number(this.db.prepare('SELECT coalesce(sum(signed_minor),0) AS amount FROM retail_cash WHERE shift_id=?').get(shiftId)?.amount);
  }

  openShift(id: unknown, drawerId: unknown, floatMinor: unknown) {
    if (!isUuid(id) || !isUuid(drawerId) || !money(floatMinor)) throw new Error('Invalid shift opening');
    return this.write(() => {
      const old = this.event(id);
      if (old) {
        if (old.kind !== 'OPEN' || old.drawerId !== drawerId || old.floatMinor !== floatMinor) throw new Error('Request conflict');
        return { shiftId: old.shiftId };
      }
      if (this.shift()?.state === 'OPEN') throw new Error('A shift is already open');
      this.db.prepare("INSERT INTO retail_shifts VALUES (?,?,?,'OPEN')").run(id, drawerId, this.scope.cashierId);
      const event: RetailEvent = { ...this.header(id, id), kind: 'OPEN', drawerId, floatMinor };
      this.append(event);
      this.cash(event, floatMinor);
      return { shiftId: id };
    });
  }

  private cart(shiftId: string): CartLine[] {
    return this.db.prepare('SELECT id,quote,quantity,discount FROM retail_cart_lines WHERE shift_id=? ORDER BY rowid').all(shiftId)
      .map(row => ({ id: String(row.id), quote: JSON.parse(String(row.quote)), quantity: Number(row.quantity),
        discount: row.discount ? JSON.parse(String(row.discount)) : null }));
  }

  private catalog(): Quote[] {
    const row = this.db.prepare('SELECT body FROM retail_catalogs ORDER BY version DESC LIMIT 1').get();
    if (!row) return [];
    const catalog = parseCatalog(JSON.parse(String(row.body)));
    return catalog.variants.map(v => ({ ...v, catalogVersion: catalog.version, taxVersion: catalog.taxVersion }));
  }

  scan(code: unknown, bySku = false) {
    if (typeof code !== 'string' || (bySku ? !/^[A-Z0-9-]{1,32}$/.test(code) : !/^\d{4,18}$/.test(code))) {
      throw new Error('Malformed scan or SKU');
    }
    return this.write(() => {
      this.unfrozen();
      const { shift_id } = this.open();
      const quote = this.catalog().find(item => (bySku ? item.sku : item.barcode) === code);
      if (!quote) throw new Error('Unknown item');
      const cart = this.cart(shift_id);
      const same = cart.find(line => line.quote.sku === quote.sku && line.quote.catalogVersion === quote.catalogVersion && !line.discount);
      if (same) {
        if (!quantity(same.quantity + 1)) throw new Error('Quantity limit reached');
        this.db.prepare('UPDATE retail_cart_lines SET quantity=quantity+1 WHERE id=?').run(same.id);
        return same.id;
      }
      if (cart.length >= 8) throw new Error('Cart line limit reached');
      const id = randomUUID();
      this.db.prepare('INSERT INTO retail_cart_lines VALUES (?,?,?,1,NULL)').run(id, shift_id, JSON.stringify(quote));
      return id;
    });
  }

  setQuantity(id: unknown, units: unknown) {
    if (!isUuid(id) || (units !== 0 && !quantity(units))) throw new Error('Invalid quantity');
    this.write(() => {
      this.unfrozen();
      const { shift_id } = this.open();
      if (units === 0) this.db.prepare('DELETE FROM retail_cart_lines WHERE id=? AND shift_id=?').run(id, shift_id);
      else this.db.prepare('UPDATE retail_cart_lines SET quantity=?,discount=NULL WHERE id=? AND shift_id=?').run(units, id, shift_id);
    });
  }

  discount(id: unknown, amount: unknown, reason: unknown, pin: unknown) {
    if (!isUuid(id) || !money(amount, 1) || !isLabel(reason)) throw new Error('Invalid discount');
    this.write(() => {
      this.unfrozen();
      const { shift_id } = this.open();
      const line = this.cart(shift_id).find(line => line.id === id);
      if (!line) throw new Error('Unknown cart line');
      priceLine(line.quote, line.quantity, amount);
      const approval = this.approval(pin, 'discount', discountFacts(shift_id, id, line.quote, line.quantity, amount, reason));
      this.db.prepare('UPDATE retail_cart_lines SET discount=? WHERE id=?').run(JSON.stringify({ amount, reason, approval }), id);
    });
  }

  receipt(id: unknown): Receipt | undefined {
    if (!isUuid(id)) throw new Error('Receipt or request UUID required');
    const row = this.db.prepare(`
      SELECT receipt_id AS receiptId,event_id AS eventId,original_receipt_id AS originalReceiptId,printable
      FROM retail_receipts WHERE receipt_id=? OR event_id=?
    `).get(id, id) as Receipt | undefined;
    if (!row) return;
    const event = this.event(row.eventId);
    return { ...row, ...(event?.kind === 'SALE' ? { lines: event.lines.map(line => ({ id: line.id, sku: line.quote.sku })) } : {}) };
  }

  private saveReceipt(event: RetailSale | RetailReturn, printable: string, original: string | null = null) {
    this.db.prepare('INSERT INTO retail_receipts VALUES (?,?,?,?)').run(event.receiptId, event.saleId, original, printable);
    this.intent(event.saleId, 'PRINTER', printable);
  }

  private buildSale(id:string,tender?:number,card=false): RetailSale {
    this.unfrozen(card?id:undefined);
    const {shift_id}=this.open();
    const cart=this.cart(shift_id);
    if(!cart.length) throw new Error('Cart is empty');
    const head=this.header(shift_id,id);
    const slices:string[]=[];
    const lines:RetailLine[]=cart.map(line=>{
      if(!this.db.prepare('SELECT 1 FROM retail_positions WHERE sku=?').get(line.quote.sku)) throw new Error('Retail quota required');
      const units=Array.from({length:line.quantity},()=>{
        const unit=availableQuota(this.db,line.quote.sku,head.occurredAt,slices,true);
        if(!unit) throw new Error('Retail quota required');
        slices.push(unit.sliceId);
        return unit;
      });
      return {...line,units,...priceLine(line.quote,line.quantity,line.discount?.amount??0)};
    });
    const sum=totals(lines);
    const tenderMinor=tender??sum.totalMinor;
    if(tenderMinor<sum.totalMinor) throw new Error('Insufficient cash tender');
    return {...head,kind:'SALE',receiptId:randomUUID(),lines,...sum,tenderMinor,changeMinor:tenderMinor-sum.totalMinor};
  }

  private saveSale(event:RetailSale,card?:Buffer,printable=salePrintable(event)) {
    const current=this.header(this.open().shift_id,event.saleId);
    if(current.shiftId!==event.shiftId||current.sequence!==event.sequence) throw new Error('Frozen shift cut changed');
    this.append(event,card);
    const spend=this.db.prepare('INSERT INTO retail_spends VALUES (?,?,?,?)');
    for(const line of event.lines) for(const unit of line.units) spend.run(unit.sliceId,unit.grantId,line.id,event.saleId);
    if(!card) this.cash(event,event.totalMinor);
    this.saveReceipt(event,printable);
    if(!card) this.intent(event.saleId,'DRAWER',null);
    this.db.prepare('DELETE FROM retail_cart_lines WHERE shift_id=?').run(event.shiftId);
  }

  async checkout(id: unknown, tender: unknown, boundary?: CheckoutBoundary): Promise<Receipt> {
    if (!isUuid(id) || !money(tender, 1)) throw new Error('Invalid checkout');
    this.db.exec('BEGIN IMMEDIATE');
    let receipt: Receipt;
    try {
      const previous = this.event(id);
      if (previous) {
        if(this.db.prepare('SELECT 1 FROM fiscal_local_receipts WHERE intent_id=?').get(id)) throw new Error('Card receipt already issued');
        if (previous.kind !== 'SALE' || previous.tenderMinor !== tender) throw new Error('Checkout request conflict');
        receipt = this.receipt(id)!;
        this.db.exec('COMMIT');
        return receipt;
      }
      this.saveSale(this.buildSale(id,tender));
      receipt = this.receipt(id)!;
      if (boundary) await boundary('before-commit');
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    if (boundary) await boundary('after-commit');
    return receipt;
  }

  drop(id: unknown, destinationId: unknown, amountMinor: unknown, pin: unknown) {
    if (!isUuid(id) || !isUuid(destinationId) || !money(amountMinor, 1)) throw new Error('Invalid drawer drop');
    this.authorized(pin);
    this.write(() => {
      this.unfrozen();
      const previous = this.event(id);
      if (previous) {
        if (previous.kind !== 'DROP' || previous.amountMinor !== amountMinor || previous.destinationId !== destinationId) throw new Error('Request conflict');
        return;
      }
      const shift = this.open();
      if (this.db.prepare("SELECT 1 FROM retail_refunds WHERE shift_id=? AND state='UNCERTAIN'").get(shift.shift_id)) {
        throw new Error('Resolve pending payout before moving drawer cash');
      }
      if (destinationId === shift.drawer_id) throw new Error('Choose a different cash location');
      const facts = { ...this.header(shift.shift_id, id), destinationId, amountMinor };
      const event: RetailEvent = { ...facts, kind: 'DROP', approval: this.approval(pin, 'drop', dropFacts(facts)) };
      this.append(event);
      this.cash(event, -amountMinor, destinationId);
      this.intent(id, 'DRAWER', null);
    });
  }

  close(id: unknown, counts: unknown, revision?: { previousId: unknown; reason: unknown; pin: unknown }) {
    const count = record(counts) as Record<string, number>;
    const counted = blindTotal(count);
    return this.write(() => {
      this.unfrozen();
      if (revision) this.authorized(revision.pin);
      const previous = this.event(id);
      if (previous) {
        if (previous.kind !== (revision ? 'REVISION' : 'CLOSE') ||
            JSON.stringify(previous.count) !== JSON.stringify(count) ||
            (revision && (previous.previousId !== revision.previousId || previous.reason !== revision.reason))) {
          throw new Error('Count request conflict');
        }
        return this.closeResult(previous.saleId);
      }
      const shift = revision ? this.shift() : this.open();
      if (!shift || (revision && shift.state !== 'CLOSED')) throw new Error('Closed shift required');
      if (this.db.prepare("SELECT 1 FROM retail_refunds WHERE shift_id=? AND state IN ('RESERVED','UNCERTAIN')").get(shift.shift_id)) {
        throw new Error('Resolve outstanding refund before close');
      }
      const head = this.header(shift.shift_id, id);
      const prior = this.db.prepare('SELECT * FROM retail_closes WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shift.shift_id);
      if (revision && (!isUuid(revision.previousId) || revision.previousId !== prior?.event_id || !isLabel(revision.reason))) {
        throw new Error('Latest count and revision reason required');
      }
      const expectedMinor = this.expected(shift.shift_id);
      const event: RetailCount = { ...head, kind: revision ? 'REVISION' : 'CLOSE', count, countedMinor: counted,
        expectedMinor, covers: head.sequence - 1, previousId: revision ? String(revision.previousId) : null,
        reason: revision ? String(revision.reason) : null, approval: null };
      if (revision) event.approval = this.approval(revision.pin, 'revision', revisionFacts(event));
      this.append(event);
      const variance = counted - expectedMinor;
      this.db.prepare('INSERT INTO retail_closes VALUES (?,?,?,?,?,?,?,?)').run(event.saleId, event.shiftId, event.previousId,
        counted, expectedMinor, event.covers, variance, variance - Number(prior?.variance_minor ?? 0));
      this.db.prepare("UPDATE retail_shifts SET state='CLOSED' WHERE shift_id=?").run(shift.shift_id);
      return this.closeResult(event.saleId);
    });
  }

  private closeResult(id: string) {
    return this.db.prepare('SELECT * FROM retail_closes WHERE event_id=?').get(id);
  }

  private intent(eventId: string, kind: DeviceKind, payload: string | null, id: string = randomUUID()) {
    this.db.prepare("INSERT INTO retail_devices (command_id,kind,event_id,payload,state) VALUES (?,?,?,?,'UNSENT')")
      .run(id, kind, eventId, payload);
    return id;
  }

  async dispatchEvent(eventId: string) {
    const pending = this.db.prepare("SELECT command_id FROM retail_devices WHERE event_id=? AND state='UNSENT' ORDER BY rowid")
      .all(eventId);
    for (const command of pending) await this.dispatch(String(command.command_id));
  }

  async reprint(id: unknown, commandId: unknown) {
    if (!isUuid(commandId)) throw new Error('Stable command UUID required');
    const receipt = this.receipt(id);
    if (!receipt) throw new Error('Receipt unavailable');
    this.write(() => {
      const prior = this.db.prepare('SELECT kind,event_id,payload FROM retail_devices WHERE command_id=?').get(commandId);
      if (prior && (prior.kind !== 'PRINTER' || prior.event_id !== receipt.eventId || prior.payload !== receipt.printable)) {
        throw new Error('Device command conflict');
      }
      if (!prior) this.intent(receipt.eventId, 'PRINTER', receipt.printable, commandId);
    });
    await this.dispatch(commandId);
    return receipt;
  }

  async dispatch(commandId?: string): Promise<void> {
    const command = this.write(() => {
      const row = commandId ?
        this.db.prepare("SELECT * FROM retail_devices WHERE command_id=? AND state='UNSENT'").get(commandId) :
        this.db.prepare("SELECT * FROM retail_devices WHERE state='UNSENT' ORDER BY rowid LIMIT 1").get();
      if (row) this.db.prepare("UPDATE retail_devices SET state='IN_FLIGHT' WHERE command_id=?").run(row.command_id!);
      return row;
    });
    if (!command) return;
    const result = await observeDevice(this.options.devices, {
      id: String(command.command_id), kind: command.kind as DeviceKind, payload: command.payload as string | null,
    }, this.options.deviceTimeoutMs ?? 1500);
    this.db.prepare('UPDATE retail_devices SET state=?,detail=? WHERE command_id=? AND state=\'IN_FLIGHT\'')
      .run(result.state, result.detail, command.command_id!);
  }

  checkDevice(id: unknown, evidence: unknown, pin: unknown) {
    if (!isUuid(id) || !isLabel(evidence)) throw new Error('Operator check evidence required');
    this.authorized(pin);
    const changed = this.db.prepare("UPDATE retail_devices SET state='CHECKED', check_evidence=? WHERE command_id=? AND state='UNCERTAIN'")
      .run(evidence, id);
    if (!changed.changes) throw new Error('No uncertain device command');
  }

  private async cloud(action: string, path: string, bytes: Buffer) {
    const config = this.options.cloud;
    if (!config) throw new Error('Cloud unavailable');
    let response: Response;
    try {
      const url = trustedEndpoint(new URL(path, config.url).href);
      response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: Uint8Array.from(bytes),
      });
      this.cloudState = 'ONLINE';
    } catch {
      this.cloudState = 'OFFLINE';
      throw new Error('Cloud unavailable');
    }
    if (response.headers.has('content-encoding')) throw new Error('Encoded cloud response');
    const body = response.body ? await readBounded(response.body, maxAckBytes) : Buffer.alloc(0);
    if (action !== 'sync' && !response.ok) {
      const reason = body.length ? JSON.parse(body.toString('utf8')).reason : 'RETURN_HELD';
      throw new Error(String(reason));
    }
    return { response, body };
  }

  private async returnCloud(action: string, payload: unknown): Promise<ReturnReservation> {
    const { response, body } = await this.cloud(action, '/v3/returns', jsonBytes({ action, payload }));
    verifySignedResponse(response.status, body, response.headers, this.options.cloud!.keys);
    const raw = JSON.parse(body.toString('utf8'));
    const request = returnRequest(record(raw));
    if (!money(raw.basisMinor) || !money(raw.taxMinor) || !money(raw.basisMinor + raw.taxMinor, 1) ||
        !['RESERVED','PAYOUT_PENDING','CONFIRMED','RELEASED'].includes(raw.state) || response.status !== 200) {
      throw new Error('Invalid refund reservation');
    }
    return { ...request, basisMinor: raw.basisMinor, taxMinor: raw.taxMinor, state: raw.state };
  }

  async reserveReturn(input: Record<string, unknown>, pin: unknown) {
    this.unfrozen();
    const shift = this.open();
    const request = returnRequest({ ...input, shiftId: shift.shift_id });
    const approval = this.approval(pin, 'reserve-return', request);
    const local = this.refund(request.returnId);
    if (local) {
      if (Object.entries(request).some(([key, value]) => local.reservation[key as keyof ReturnReservation] !== value)) throw new Error('Return identity conflict');
      return local;
    }
    const original = this.receipt(request.receiptId);
    if (original && this.db.prepare("SELECT 1 FROM retail_events WHERE event_id=? AND state <> 'SYNCED'").get(original.eventId)) {
      throw new Error('Original receipt has not synchronized');
    }
    const reservation = await this.returnCloud('reserve', { request, approval });
    if (Object.entries(request).some(([key, value]) => reservation[key as keyof ReturnReservation] !== value)) throw new Error('Reservation binding mismatch');
    if (reservation.state !== 'RESERVED') throw new Error('Existing payout requires reconciliation');
    this.db.prepare("INSERT OR IGNORE INTO retail_refunds VALUES (?,?,?,?,'RESERVED')")
      .run(request.returnId, request.shiftId, request.attemptId, JSON.stringify(reservation));
    return this.refund(request.returnId)!;
  }

  private refund(id: unknown): Refund | undefined {
    if (!isUuid(id)) throw new Error('Return UUID required');
    const row = this.db.prepare('SELECT state,reservation FROM retail_refunds WHERE return_id=?').get(id);
    return row && { state: String(row.state), reservation: JSON.parse(String(row.reservation)) };
  }

  async beginPayout(id: unknown) {
    this.unfrozen();
    const refund = this.refund(id);
    if (!refund || refund.state !== 'RESERVED' || this.open().shift_id !== refund.reservation.shiftId) {
      throw new Error('Payout held for reconciliation');
    }
    const { returnId, attemptId, basisMinor, taxMinor } = refund.reservation;
    if (this.expected(refund.reservation.shiftId) < basisMinor + taxMinor ||
        this.db.prepare("SELECT 1 FROM retail_refunds WHERE shift_id=? AND state='UNCERTAIN'").get(refund.reservation.shiftId)) {
      throw new Error('Drawer cash unavailable for payout');
    }
    // Once intent is durable a restart never gives another automatic instruction to hand over cash.
    const claim = this.db.prepare("UPDATE retail_refunds SET state='UNCERTAIN' WHERE return_id=? AND state='RESERVED'").run(returnId);
    if (!claim.changes) throw new Error('Payout held for reconciliation');
    const reservation = await this.returnCloud('begin', { returnId, attemptId });
    if (reservation.state !== 'PAYOUT_PENDING' || reservation.returnId !== returnId || reservation.attemptId !== attemptId ||
        reservation.shiftId !== refund.reservation.shiftId || reservation.basisMinor !== basisMinor || reservation.taxMinor !== taxMinor) {
      throw new Error('Payout held for reconciliation');
    }
    this.db.prepare("INSERT INTO retail_devices (command_id,kind,return_id,state) VALUES (?,'DRAWER',?,'UNSENT')")
      .run(attemptId, returnId);
    return { amountMinor: basisMinor + taxMinor, attemptId };
  }

  async releaseReturn(id: unknown, evidence: unknown, pin: unknown) {
    const refund = this.refund(id);
    if (!refund || refund.state === 'CONFIRMED') throw new Error('Return cannot be released');
    const facts = releaseFacts({ returnId: id, attemptId: refund.reservation.attemptId, evidence });
    const approval = this.approval(pin, 'release-return', facts);
    const released = await this.returnCloud('release', { ...facts, approval });
    if (released.state !== 'RELEASED' || released.returnId !== facts.returnId || released.attemptId !== facts.attemptId) {
      throw new Error('Return release held');
    }
    this.write(() => {
      this.db.prepare("UPDATE retail_refunds SET state='RELEASED' WHERE return_id=?").run(facts.returnId);
      this.dismissPayoutDevice(facts.returnId, 'PAYOUT_RELEASED');
    });
  }

  private dismissPayoutDevice(returnId: string, detail: string) {
    this.db.prepare("UPDATE retail_devices SET state='CANCELLED',detail=? WHERE return_id=? AND state='UNSENT'")
      .run(detail, returnId);
  }

  confirmPayout(id: unknown, pin: unknown) {
    this.authorized(pin);
    return this.write(() => {
      this.unfrozen();
      const refund = this.refund(id);
      if (!refund) throw new Error('Unknown return');
      const r = refund.reservation;
      if (refund.state === 'CONFIRMED') return this.receipt(r.returnId);
      const shift = this.open();
      if (refund.state !== 'UNCERTAIN' || shift.shift_id !== r.shiftId) throw new Error('Payout is not pending');
      if (!this.db.prepare('SELECT 1 FROM retail_devices WHERE return_id=?').get(r.returnId)) {
        throw new Error('Payout authorization did not reach this register');
      }
      const amountMinor = r.basisMinor + r.taxMinor;
      const facts = { ...this.header(r.shiftId, r.returnId), kind: 'RETURN' as const,
        receiptId: randomUUID(), returnId: r.returnId, attemptId: r.attemptId, amountMinor };
      const event: RetailReturn = { ...facts, approval: this.approval(pin, 'confirm-payout', payoutFacts(facts)) };
      this.append(event);
      this.cash(event, -amountMinor);
      this.saveReceipt(event, `OmniPoint Refund\nReceipt ${event.receiptId}\nOriginal ${r.receiptId}\nCash USD ${(amountMinor / 100).toFixed(2)}`, r.receiptId);
      this.db.prepare("UPDATE retail_refunds SET state='CONFIRMED' WHERE return_id=?").run(r.returnId);
      this.dismissPayoutDevice(r.returnId, 'PAYOUT_CONFIRMED_MANUALLY');
      return this.receipt(r.returnId);
    });
  }

  async syncOnce(now = Date.now()) {
    const item = this.write(() => {
      // An earlier prerequisite must be resolved before advancing a shift.
      const row = this.db.prepare("SELECT * FROM retail_events WHERE state <> 'SYNCED' ORDER BY rowid LIMIT 1").get();
      if (!row || row.state === 'CONFLICT_HELD' || (row.state === 'IN_FLIGHT' && Number(row.lease_until) > now)) return undefined;
      const id = String(row.event_id);
      const attempt = Number(row.attempts) + 1;
      this.db.prepare("UPDATE retail_attempts SET result='LEASE_EXPIRED' WHERE event_id=? AND result IS NULL").run(id);
      this.db.prepare("UPDATE retail_events SET state='IN_FLIGHT', attempts=?, lease_until=? WHERE event_id=?").run(attempt, now + 15000, id);
      this.db.prepare('INSERT INTO retail_attempts VALUES (?,?,?,NULL)').run(id, attempt, now);
      return { id, attempt, bytes: Buffer.from(row.event_bytes as Uint8Array), digest: String(row.digest) };
    });
    if (!item) return await this.payment?.syncFunds() ? 'FUNDS_CHECKED' : 'IDLE';
    let state = 'RETRY_WAIT';
    let result = 'TRANSPORT_ERROR';
    let ackId: string | null = null;
    let ackBytes: Buffer | null = null;
    try {
      const card = record(JSON.parse(item.bytes.toString('utf8'))).version===4;
      const event = card ? parseCard(item.bytes).sale : parseRetail(item.bytes);
      if (event.saleId !== item.id || digest(item.bytes) !== item.digest) throw new Error('Invalid stored retail event');
      const { response, body } = await this.cloud('sync', card?'/v4/register':'/v3/register', item.bytes);
      result = 'ACK_REJECTED';
      if (response.status === 202) {
        const reason = body.length ? JSON.parse(body.toString('utf8')).reason : '';
        result = ['SHIFT_OPEN_MISSING','SHIFT_SEQUENCE_GAP','CUSTODY_RECEIPT_MISSING','FISCAL_GAP','FISCAL_FORK',
          'FISCAL_RETIRED','FISCAL_DEPENDENCY_HELD'].includes(reason) ? reason : 'HTTP_202';
      }
      else {
        const ack = verifyVoucher(response.status, body, response.headers, this.options.cloud!.keys,
          card?{...event,version:4}:event, item.digest);
        if (ack.disposition === 'BACKORDER' && event.kind !== 'SALE') throw new Error('Unexpected backorder');
        if (event.kind === 'SALE' && (ack.disposition === 'BACKORDER' || ack.disposition === 'COMMITTED')) {
          const lines: unknown = JSON.parse(body.toString('utf8')).lines;
          if (!Array.isArray(lines) || lines.length !== event.lines.length) throw new Error('Missing line outcomes');
          let short = false;
          for (const [index, item] of lines.entries()) {
            const line = record(item);
            if (line.lineId !== event.lines[index].id || !money(line.fulfilled) || !money(line.backordered) ||
                line.fulfilled + line.backordered !== event.lines[index].quantity) throw new Error('Invalid line outcome');
            short ||= line.backordered > 0;
          }
          if (short !== (ack.disposition === 'BACKORDER')) throw new Error('Invalid aggregate outcome');
        }
        state = ack.disposition === 'BACKORDER' || ack.disposition === 'COMMITTED' ? 'SYNCED' : 'CONFLICT_HELD';
        result = ack.disposition;
        ackId = ack.ackId;
        ackBytes = body;
      }
    } catch {
      // Timeout, lost transport and unauthenticated acknowledgments preserve the pending event.
    }
    return this.write(() => {
      const changed = this.db.prepare(`
        UPDATE retail_events SET state=?,lease_until=NULL,result=?,ack=?,ack_id=? WHERE event_id=? AND state='IN_FLIGHT' AND attempts=?
      `).run(state, result, ackBytes, ackId, item.id, item.attempt);
      if (!changed.changes) return 'LEASE_LOST';
      this.db.prepare('UPDATE retail_attempts SET result=? WHERE event_id=? AND attempt=?').run(result, item.id, item.attempt);
      if(state==='SYNCED') this.db.prepare("UPDATE payment_intents SET reported=1 WHERE intent_id=? AND state='FINALIZED'").run(item.id);
      return state;
    });
  }

  state() {
    const shift = this.shift();
    const cart = shift?.state === 'OPEN' ? this.cart(shift.shift_id).map(line => ({
      ...line, discount: line.discount && { amount: line.discount.amount, reason: line.discount.reason },
      ...priceLine(line.quote, line.quantity, line.discount?.amount ?? 0),
    })) : [];
    const outbox = this.db.prepare(`
      SELECT event_id,kind,state,attempts,result,ack_id,ack FROM retail_events
      ORDER BY state='SYNCED', CASE WHEN state='SYNCED' THEN -rowid ELSE rowid END LIMIT 40
    `)
      .all().map(({ ack, ...row }) => ({ ...row,
        ...(ack && row.kind === 'SALE' ? { lines: JSON.parse(Buffer.from(ack as Uint8Array).toString('utf8')).lines } : {}),
      }));
    return {
      shift, cart, catalog: this.catalog(), totals: totals(cart), cloud: this.cloudState,
      paymentsEnabled:Boolean(this.payment),
      payments:this.db.prepare(`SELECT intent_id,state,reason,
        json_extract(fiscal_intent,'$.sequence') AS fiscal_sequence,json_extract(fiscal_intent,'$.epochId') AS fiscal_epoch
        FROM payment_intents ORDER BY rowid DESC LIMIT 40`).all(),
      close: shift?.state === 'CLOSED' ? this.db.prepare('SELECT * FROM retail_closes WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shift.shift_id) : null,
      outbox, pendingCount: Number(this.db.prepare("SELECT count(*) AS n FROM retail_events WHERE state <> 'SYNCED'").get()?.n),
      devices: this.db.prepare(`
        SELECT command_id,kind,event_id,return_id,state,CASE WHEN state='CHECKED' THEN 'OPERATOR_CHECK_RECORDED' ELSE detail END AS detail
        FROM retail_devices ORDER BY rowid DESC LIMIT 40
      `).all(),
      refunds: this.db.prepare('SELECT return_id,attempt_id,state FROM retail_refunds ORDER BY rowid DESC LIMIT 40').all(),
      quota: this.db.prepare(`
        SELECT p.sku,g.grant_id,g.expires_at,g.transfer_id, count(*) AS issued,
          sum(CASE WHEN s.slice_id IS NULL AND o.slice_id IS NULL THEN 1 ELSE 0 END) AS unspent,
          sum(CASE WHEN g.transfer_id IS NOT NULL AND c.slice_id IS NULL THEN 1 ELSE 0 END) AS awaiting_custody
        FROM quota_position p JOIN quota_grants g USING (position_id) JOIN quota_units u USING (grant_id)
        LEFT JOIN retail_spends s ON s.slice_id=u.slice_id LEFT JOIN quota_spends o ON o.slice_id=u.slice_id
        LEFT JOIN custody_units c USING(grant_id,slice_id)
        GROUP BY p.sku,g.grant_id ORDER BY p.sku,g.grant_id LIMIT 40
      `).all(),
    };
  }
}
