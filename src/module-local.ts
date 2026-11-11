import type { KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { exact, openArtifact } from './authority.ts';
import type { Capabilities } from './module-cloud.ts';
import { decode, digest, isScope, isUuid, jsonBytes, readBounded, record, sameScope, trustedEndpoint } from './protocol.ts';
import type { Scope } from './protocol.ts';
import { checks, labor, menu, readSplit, serviceFacts, stableId } from './module-sale.ts';
import { priceLine, totals } from './retail-money.ts';
import type { Plan, Source } from './module-sale.ts';
import type { Quote } from './retail-money.ts';
import type { Approval } from './retail-protocol.ts';

export type ModuleConnection = { url: string; token: string; keys: ReadonlyMap<string, KeyObject> };
type EventRow = { cursor: number; revision: number; kind: string; body: Uint8Array; digest: string };
type Ticket = { id: string; seat: number; sku: string; modifier: string; station: 'hot' | 'cold';
  status: 'QUEUED' | 'READY' | 'CANCELLED'; revision: number; source?: Source };
type Order = { table: string; seats: number; tickets: Ticket[]; plan?: Plan };
type Work = { booking: string | null; technician: 'alex' | 'sam'; stage: 'INTAKE' | 'ESTIMATE' | 'APPROVED' | 'WORK';
  estimate?: number; sources?: Source[]; consent?: string; approval?: Approval };
type TenderRow = { check_no: number; tender_id: string; facts: string; request_digest: string };

export class LocalModules {
  private connectivity: 'UNKNOWN' | 'ONLINE' | 'OFFLINE' = 'UNKNOWN';
  private readonly db: DatabaseSync;
  private readonly scope: Scope;
  private readonly cloud?: ModuleConnection;
  private readonly quote: (sku: string) => Quote | undefined;

  constructor(db: DatabaseSync, scope: Scope, quote: (sku: string) => Quote | undefined, cloud?: ModuleConnection) {
    this.db = db;
    this.scope = scope;
    this.cloud = cloud;
    this.quote = quote;
  }

  private get cached() {
    const row = this.db.prepare('SELECT evidence FROM module_profile ORDER BY version DESC LIMIT 1').get();
    if (!row || !this.cloud) return { version: 0, retail: true, hospitality: false, services: false };
    return this.profile(JSON.parse(String(row.evidence)));
  }

  private profile(packet: unknown): Capabilities {
    const data = this.open(packet, 'MODULE_PROFILE');
    const profile = exact(data.profile, ['version','retail','hospitality','services']);
    if (typeof profile.version !== 'number' || !Number.isSafeInteger(profile.version) || profile.version < 0 ||
        typeof profile.retail !== 'boolean' || typeof profile.hospitality !== 'boolean' || typeof profile.services !== 'boolean') {
      throw new Error('Invalid capability profile');
    }
    return { version: profile.version, retail: profile.retail, hospitality: profile.hospitality, services: profile.services };
  }

  private open(packet: unknown, purpose: string) {
    if (!this.cloud) throw new Error('Module authority unavailable');
    const { data } = openArtifact('module-v5', packet, this.cloud.keys);
    const scope = record(data.scope);
    if (data.purpose !== purpose || !isScope(scope) || !sameScope(scope, this.scope))
      throw new Error('Module evidence scope rejected');
    return data;
  }

  private async request(input: Record<string, unknown>) {
    if (!this.cloud) throw new Error('Module authority unavailable');
    const url = trustedEndpoint(this.cloud.url);
    let response: Response;
    try {
      response = await fetch(new URL('/v5/modules', url), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.cloud.token },
        body: new Uint8Array(jsonBytes(input)), redirect: 'error', signal: AbortSignal.timeout(2500),
      });
    } catch {
      this.connectivity = 'OFFLINE';
      throw new Error('Module authority offline');
    }
    this.connectivity = 'ONLINE';
    const data = decode(await readBounded(response.body!, 4096));
    if (!response.ok) {
      const reason = data.reason;
      throw new Error(typeof reason === 'string' && /^[A-Z_]{1,64}$/.test(reason) ? reason : 'Module authority held');
    }
    return data;
  }

  state() {
    const profile = this.cached;
    const recent = (kind: string) => {
      const row = this.db.prepare(`SELECT aggregate_id,revision,body FROM module_events
        WHERE kind=? ORDER BY cursor DESC LIMIT 1`).get(kind);
      if (!row) return;
      const id = String(row.aggregate_id);
      const data = decode(Buffer.from(row.body as Uint8Array));
      const tenders = this.tenders(id);
      const payable = data.plan ? checks(data.plan as Plan).map(check => ({
        ...check, balance: check.totalMinor - this.paid(tenders, check.index),
      })) : undefined;
      const estimate = kind === 'work' && data.sources ? totals((data.sources as Source[]).map(line => priceLine(line.quote,1,0))) : undefined;
      return { id, revision: Number(row.revision), data, checks: payable, estimate,
        receipts: tenders.map(row => row.tender_id) };
    };
    return { profile, connectivity: this.connectivity, parts: profile.services ?
      Object.values(menu).flatMap(item => this.quote(item.sku) ? [item.sku] : []) : [],
      order: profile.hospitality ? recent('order') : undefined,
      appointment: profile.services ? recent('appointment') : undefined,
      work: profile.services ? recent('work') : undefined };
  }

  require(capability: keyof Omit<Capabilities, 'version'>) {
    if (!this.cached[capability]) throw new Error('Module disabled by verified profile');
  }

  async refresh() {
    const packet = await this.request({ action: 'profile' });
    const profile = this.profile(packet);
    const previous = this.cached;
    if (profile.version < previous.version || (profile.version === previous.version &&
        JSON.stringify(profile) !== JSON.stringify(previous))) throw new Error('Capability version conflict');
    if (profile.version > previous.version)
      this.db.prepare('INSERT INTO module_profile VALUES (?,?)').run(profile.version, JSON.stringify(packet));
    return this.state();
  }

  async diagnostics() {
    const { purpose, scope, ...data } = this.open(await this.request({action:'diagnostics'}),'MODULE_DIAGNOSTICS');
    return data;
  }

  private latest(id: string) {
    return this.db.prepare('SELECT * FROM module_events WHERE aggregate_id=? ORDER BY revision DESC LIMIT 1')
      .get(id) as EventRow | undefined;
  }

  private append<T>(kind: string, id: unknown, op: unknown, expected: unknown, input: unknown,
    apply: (prior?: T) => T): T {
    if (!isUuid(id) || !isUuid(op) || typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0)
      throw new Error('Invalid module revision identity');
    const hash = digest(jsonBytes([kind, id, expected, input]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.db.prepare('SELECT * FROM module_events WHERE operation_id=?').get(op) as EventRow | undefined;
      if (replay) {
        if (replay.digest !== hash) throw new Error('Module operation ID conflict');
        this.db.exec('COMMIT');
        return JSON.parse(Buffer.from(replay.body).toString()) as T;
      }
      const prior = this.latest(id);
      if ((prior?.revision ?? 0) !== expected || (prior && prior.kind !== kind)) throw new Error('Stale module revision');
      const result = apply(prior && JSON.parse(Buffer.from(prior.body).toString()) as T);
      this.db.prepare(`INSERT INTO module_events(operation_id,aggregate_id,revision,kind,body,digest)
        VALUES (?,?,?,?,?,?)`).run(op, id, expected + 1, kind, jsonBytes(result), hash);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  seat(id: unknown, op: unknown, table: unknown, seats: unknown) {
    this.require('hospitality');
    if ((table !== 'T1' && table !== 'T2') || typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1 || seats > 6)
      throw new Error('Invalid table or seat count');
    return this.append<Order>('order', id, op, 0, [table, seats], () => {
      const occupied = this.db.prepare(`SELECT aggregate_id,body FROM module_events e
        WHERE kind='order' AND json_extract(CAST(body AS TEXT),'$.table')=? AND revision=(
          SELECT max(revision) FROM module_events WHERE aggregate_id=e.aggregate_id)`).all(table);
      if (occupied.some(row => {
        const prior = JSON.parse(Buffer.from(row.body as Uint8Array).toString()) as Order;
        const tenders = this.tenders(String(row.aggregate_id));
        return !prior.plan || checks(prior.plan).some(check => check.totalMinor !== this.paid(tenders,check.index));
      })) throw new Error('Table is occupied');
      return { table, seats, tickets: [] };
    });
  }

  dispatch(id: unknown, op: unknown, revision: unknown, seat: unknown, sku: unknown, modifier: unknown) {
    this.require('hospitality');
    if (!isUuid(op) || typeof seat !== 'number' || !Number.isInteger(seat) || seat < 1 ||
        (sku !== 'toast' && sku !== 'salad') || (sku === 'toast' && modifier !== 'butter' && modifier !== 'jam') ||
        (sku === 'salad' && modifier !== 'plain' && modifier !== 'dressing')) throw new Error('Invalid menu selection');
    return this.append<Order>('order', id, op, revision, [seat,sku,modifier], order => {
      if (!order || order.plan || seat > order.seats || order.tickets.length >= 8) throw new Error('Seat or ticket limit exceeded');
      const quote = this.quote(menu[sku].sku);
      const source: Source | undefined = quote && { id: op, quote, item: sku, seat, modifier: String(modifier) };
      return { ...order, tickets: [...order.tickets, { id: op, seat, sku, modifier: String(modifier),
        station: sku === 'toast' ? 'hot' : 'cold', status: 'QUEUED', revision: 1, source }] };
    });
  }

  kitchenUpdate(id: unknown, op: unknown, revision: unknown, ticketId: unknown,
    station: Ticket['station'], status: 'READY' | 'CANCELLED') {
    this.require('hospitality');
    return this.append<Order>('order', id, op, revision, [ticketId, station, status], order => {
      const ticket = order?.tickets.find(row => row.id === ticketId && row.station === station);
      if (!order || !ticket || ticket.status !== 'QUEUED' || (order.plan && status === 'CANCELLED'))
        throw new Error('Ticket unavailable in station');
      return { ...order, tickets: order.tickets.map(row => row.id === ticketId ?
        { ...row, status, revision: row.revision + 1 } : row) };
    }).tickets.filter(ticket => ticket.station === station);
  }

  kitchenFeed(station: Ticket['station'], cursor: unknown) {
    this.require('hospitality');
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid display cursor');
    const rows = this.db.prepare(`SELECT aggregate_id,cursor,revision,body FROM module_events
      WHERE kind='order' AND cursor>? ORDER BY cursor LIMIT 100`).all(cursor);
    return { cursor: Number(rows.at(-1)?.cursor ?? cursor), revisions: rows.flatMap(row => {
      const order = JSON.parse(Buffer.from(row.body as Uint8Array).toString()) as Order;
      const tickets = order.tickets.filter(ticket => ticket.station === station)
        .map(({source, ...ticket}) => ticket);
      return tickets.length ? [{ orderId: row.aggregate_id, table: order.table, revision: row.revision, tickets }] : [];
    }) };
  }

  draft(id: unknown, op: unknown, staff: unknown, start: unknown, minutes: unknown) {
    this.require('services');
    if ((staff !== 'alex' && staff !== 'sam') || typeof start !== 'string' || start.length !== 24 ||
        typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 15 || minutes > 120)
      throw new Error('Invalid appointment draft');
    const version = this.cached.version;
    return this.append('appointment', id, op, 0, [staff,start,minutes], () =>
      ({ status: 'DRAFT', staff, start, minutes, timezone: 'UTC', resource: 'bay', version }));
  }

  async book(id: unknown, op: unknown) {
    if (!isUuid(id) || !isUuid(op)) throw new Error('Invalid appointment identity');
    const original = this.db.prepare(`SELECT body FROM module_events WHERE aggregate_id=? AND kind='appointment'
      AND revision=1`).get(id);
    if (!original) throw new Error('Appointment draft required');
    const { staff, start, minutes, timezone, resource, version } = decode(Buffer.from(original.body as Uint8Array));
    const previous = this.latest(id);
    if (previous?.revision === 2) return decode(Buffer.from(previous.body));
    const packet = await this.request({ action: 'book', id, version, staff, start, minutes, timezone, resource });
    const data = this.open(packet, 'SERVICE_BOOKING');
    if (data.id !== id || data.version !== version || data.staff !== staff || data.start !== start ||
        data.minutes !== minutes || data.timezone !== timezone || data.resource !== resource || data.status !== 'CONFIRMED')
      throw new Error('Booking evidence does not match draft');
    return this.append('appointment', id, op, 1, [id,version], () =>
      ({ status: data.status, staff, start, minutes, timezone, resource, version, evidence: packet }));
  }

  split(id: unknown, op: unknown, revision: unknown, value: unknown) {
    this.require('hospitality');
    if (!isUuid(id) || typeof revision !== 'number') throw new Error('Invalid order revision');
    const split = readSplit(value);
    return this.append<Order>('order', id, op, revision, split, order => {
      if (!order || order.plan) throw new Error('Order already has frozen checks');
      const sources = order.tickets.filter(ticket => ticket.status !== 'CANCELLED').map(ticket => {
        if (ticket.source) return ticket.source;
        // A 005 ticket has dispatch facts but no price snapshot. Freeze the catalog quote on its first split.
        if (ticket.sku !== 'toast' && ticket.sku !== 'salad') return;
        const quote = this.quote(menu[ticket.sku].sku);
        if (quote) return { id:ticket.id, quote, item:ticket.sku, seat:ticket.seat, modifier:ticket.modifier };
      });
      if (!sources.length || sources.some(source => !source)) throw new Error('Order has no complete price snapshots');
      const plan: Plan = { id, revision: revision + 1, profile: this.cached.version, sources: sources as Source[],
        workflow: { kind: 'hospitality', split } };
      checks(plan);
      return { ...order, plan };
    });
  }

  intake(id: unknown, op: unknown, booking: unknown, technician: unknown) {
    this.require('services');
    if ((booking !== null && !isUuid(booking)) || (technician !== 'alex' && technician !== 'sam'))
      throw new Error('Invalid work order');
    return this.append<Work>('work', id, op, 0, [booking,technician], () => {
      if (booking) {
        const row = this.latest(booking);
        const data = row?.kind === 'appointment' ? decode(row.body) : undefined;
        if (data?.status !== 'CONFIRMED' || data.staff !== technician) throw new Error('Confirmed booking required');
      }
      return { stage: 'INTAKE', booking, technician };
    });
  }

  estimate(id: unknown, op: unknown, revision: unknown, sku: unknown) {
    this.require('services');
    if (!isUuid(id) || typeof revision !== 'number' || typeof sku !== 'string') throw new Error('Invalid estimate revision');
    return this.append<Work>('work', id, op, revision, ['estimate',sku], work => {
      const quote = this.quote(sku);
      if (!work || !quote || quote.sku === labor.sku || this.tenders(id).length) throw new Error('Estimate is not editable');
      const estimate = revision + 1;
      return { stage:'ESTIMATE', booking: work.booking, technician: work.technician, estimate,
        sources: [{ id: stableId(id,estimate,'labor'), quote:labor,item:'labor',seat:0,modifier:'' },
          { id: stableId(id,estimate,'part'), quote,item:'part',seat:0,modifier:'' }] };
    });
  }

  authorize(id: unknown, op: unknown, revision: unknown, consent: unknown, sign: (facts: unknown) => Approval) {
    this.require('services');
    if (!isUuid(id) || !isUuid(consent)) throw new Error('Customer authorization reference required');
    return this.append<Work>('work', id, op, revision, ['authorize',consent], work => {
      if (!work || work.stage !== 'ESTIMATE' || !work.sources || !work.estimate)
        throw new Error('New estimate required');
      const authorization = { booking:work.booking, technician:work.technician, estimate:work.estimate, consent };
      const facts = serviceFacts({ id, sources: work.sources }, authorization);
      return { ...work, stage:'APPROVED', consent, approval:sign(facts) };
    });
  }

  startWork(id: unknown, op: unknown, revision: unknown) {
    this.require('services');
    return this.append<Work>('work', id, op, revision, 'start-work', work => {
      if (work?.stage !== 'APPROVED') throw new Error('Approved estimate required');
      return { ...work, stage:'WORK' };
    });
  }

  tenders(id: string) {
    return this.db.prepare('SELECT * FROM module_tenders WHERE aggregate_id=? ORDER BY rowid').all(id) as TenderRow[];
  }

  private paid(rows: TenderRow[], check: number) {
    return rows.filter(row => row.check_no === check).reduce((sum,row) => sum + Number(JSON.parse(row.facts).paid), 0);
  }

  payable(id: string, revision: number, check: number) {
    const latest = this.latest(id);
    if (!latest || latest.revision !== revision) throw new Error('Stale module revision');
    const rows = this.tenders(id);
    const before = this.paid(rows, check);
    const claimed = new Set<string>(rows.flatMap(row => JSON.parse(row.facts).claimed));
    if (latest.kind === 'order') {
      this.require('hospitality');
      const { plan } = JSON.parse(Buffer.from(latest.body).toString()) as Order;
      if (!plan) throw new Error('Freeze checks before tender');
      return { plan, before, claimed };
    }
    this.require('services');
    const work = JSON.parse(Buffer.from(latest.body).toString()) as Work;
    if (latest.kind !== 'work' || work.stage !== 'WORK' || !work.sources || !work.approval || !work.estimate || !work.consent)
      throw new Error('Authorized work must be performed before invoicing');
    const plan: Plan = { id, revision, profile: this.cached.version, sources: work.sources, workflow: {
      kind:'services', booking:work.booking, technician:work.technician, estimate:work.estimate,
      consent:work.consent, approval:work.approval } };
    return { plan, before, claimed };
  }
}
