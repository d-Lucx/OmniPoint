import { exact } from './authority.ts';
import { decode, digest, isCounter, isIsoDate, isScope, isUuid, jsonBytes, readQuotaSpend, record } from './protocol.ts';
import type { QuotaSpend } from './protocol.ts';
import { money, priceLine, totals } from './retail-money.ts';
import type { LineMoney, Quote } from './retail-money.ts';
import { parseApproval, parseVariant, retailBodyLimit, salePrintable } from './retail-protocol.ts';
import type { Approval, RetailSale } from './retail-protocol.ts';

export const menu = {
  toast: { sku: 'M1-ITEM', modifiers: ['butter', 'jam'] },
  salad: { sku: 'M3-TEA', modifiers: ['plain', 'dressing'] },
} as const;
export const labor: Quote = { ...parseVariant({ sku: 'LABOR', parentId: 'SERVICE', barcode: '900000',
  label: 'Service labor', unitMinor: 1000, taxBps: 500, taxMode: 'EXCLUSIVE' }), catalogVersion: 1, taxVersion: 1 };

export type Source = { id: string; quote: Quote; item: 'toast' | 'salad' | 'labor' | 'part'; seat: number; modifier: string };
export type Split = { mode: 'equal' | 'seat' | 'selected'; selected: string[] };
type Hospitality = { kind: 'hospitality'; split: Split };
export type Service = { kind: 'services'; booking: string | null; technician: 'alex' | 'sam';
  estimate: number; consent: string; approval: Approval };
export type Plan = { id: string; revision: number; profile: number; sources: Source[]; workflow: Hospitality | Service };
export type ModuleSale = { sale: RetailSale; plan: Plan; check: number; before: number; paid: number; tip: number;
  tipBefore: number; claims: { source: string; unit: QuotaSpend }[] };

export function stableId(...fields: (string | number)[]) {
  const hash = digest(jsonBytes(fields));
  return hash.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
}

export function readSplit(input: unknown): Split {
  const { mode, selected } = exact(input, ['mode','selected']);
  if ((mode !== 'equal' && mode !== 'seat' && mode !== 'selected') || !Array.isArray(selected) ||
      selected.some(value => !isUuid(value)) || new Set(selected).size !== selected.length ||
      (mode === 'selected') !== (selected.length > 0)) throw new Error('Invalid check assignment');
  return { mode, selected };
}

function readSource(input: unknown): Source {
  const { id, quote, item, seat, modifier } = exact(input, ['id','quote','item','seat','modifier']);
  const q = record(quote);
  if (!isUuid(id) || !isCounter(q.catalogVersion) || !isCounter(q.taxVersion) ||
      typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat > 6 ||
      typeof modifier !== 'string') throw new Error('Invalid source line');
  const priced = { ...parseVariant(q), catalogVersion: q.catalogVersion, taxVersion: q.taxVersion };
  if (item === 'toast' || item === 'salad') {
    if (seat < 1 || priced.sku !== menu[item].sku || !(menu[item].modifiers as readonly string[]).includes(modifier))
      throw new Error('Invalid menu line');
  } else {
    if ((item !== 'labor' && item !== 'part') || seat !== 0 || modifier !== '' ||
        (item === 'labor' ? !jsonBytes(priced).equals(jsonBytes(labor)) : priced.sku === labor.sku))
      throw new Error('Invalid estimate line');
  }
  return { id, quote: priced, item, seat, modifier };
}

export function serviceFacts(plan: Pick<Plan,'id'|'sources'>, workflow: Pick<Service,'booking'|'technician'|'estimate'|'consent'>) {
  return [plan.id, workflow.booking, workflow.technician, workflow.estimate, workflow.consent, plan.sources];
}

function readPlan(input: unknown): Plan {
  const { id, revision, profile, sources, workflow } = exact(input, ['id','revision','profile','sources','workflow']);
  const type = record(workflow).kind;
  if (!isUuid(id) || !isCounter(revision) || !isCounter(profile) || !Array.isArray(sources) ||
      !sources.length || sources.length > 8) throw new Error('Invalid frozen plan');
  const lines = sources.map(readSource);
  if (new Set(lines.map(line => line.id)).size !== lines.length) throw new Error('Duplicate source line');
  if (type === 'hospitality') {
    const { split } = exact(workflow, ['kind','split']);
    if (lines.some(line => line.seat === 0)) throw new Error('Expected menu lines');
    return { id, revision, profile, sources: lines, workflow: { kind: type, split: readSplit(split) } };
  }
  const { booking, technician, estimate, consent, approval } = exact(workflow,
    ['kind','booking','technician','estimate','consent','approval']);
  if (type !== 'services' || (booking !== null && !isUuid(booking)) || (technician !== 'alex' && technician !== 'sam') ||
      !isCounter(estimate) || !isUuid(consent) || lines.length !== 2 || lines[0].item !== 'labor' || lines[1].item !== 'part')
    throw new Error('Invalid approved estimate');
  return { id, revision, profile, sources: lines,
    workflow: { kind: type, booking, technician, estimate, consent, approval: parseApproval(approval) } };
}

function portions(amount: number, count: number, index: number) {
  return Math.floor(amount / count) + Number(index < amount % count);
}

export function checks(plan: Plan) {
  const split = plan.workflow.kind === 'hospitality' ? plan.workflow.split : undefined;
  const seats = [...new Set(plan.sources.map(source => source.seat))].sort((a, b) => a - b);
  if (split?.mode === 'selected' && (split.selected.length >= plan.sources.length ||
      split.selected.some(id => !plan.sources.some(source => source.id === id)))) throw new Error('Invalid selected sources');
  const count = split?.mode === 'seat' ? seats.length : split ? 2 : 1;
  return Array.from({ length: count }, (_, index) => {
    const lines = plan.sources.flatMap(source => {
      const target = split?.mode === 'seat' ? seats.indexOf(source.seat) :
        split?.mode === 'selected' ? Number(!split.selected.includes(source.id)) : 0;
      const equal = split?.mode === 'equal';
      if (!equal && target !== index) return [];
      const modifierMinor = source.modifier === 'jam' ? 20 : 0;
      const discountMinor = source.modifier === 'dressing' ? 5 : 0;
      const full = priceLine({ ...source.quote, unitMinor: source.quote.unitMinor + modifierMinor }, 1, discountMinor);
      const basisMinor = portions(full.basisMinor, equal ? count : 1, equal ? index : 0);
      const taxMinor = portions(full.taxMinor, equal ? count : 1, equal ? index : 0);
      if (!basisMinor && !taxMinor) return [];
      return [{ source, allocationId: stableId(plan.id, index, source.id), basisMinor, taxMinor,
        totalMinor: basisMinor + taxMinor }];
    });
    const sum = totals(lines);
    if (sum.totalMinor < 1) throw new Error('Empty check');
    return { index, lines, ...sum };
  });
}

function taxAt(amount: number, line: LineMoney) {
  return Number(BigInt(amount) * BigInt(line.taxMinor) / BigInt(line.totalMinor));
}

export function paymentLines(plan: Plan, check: number, before: number, paid: number) {
  const target = checks(plan)[check];
  if (!target || !money(before) || !money(paid, 1) || before + paid > target.totalMinor ||
      (plan.workflow.kind === 'services' && (before !== 0 || paid !== target.totalMinor)))
    throw new Error('Tender exceeds payable balance or invoice must be paid in full');
  let start = 0;
  return target.lines.flatMap(line => {
    const from = Math.max(0, before - start);
    const to = Math.min(line.totalMinor, before + paid - start);
    start += line.totalMinor;
    if (to <= from) return [];
    const taxMinor = taxAt(to, line) - taxAt(from, line);
    return [{ ...line, totalMinor: to - from, basisMinor: to - from - taxMinor, taxMinor }];
  });
}

export function makeModuleSale(head: Omit<RetailSale, keyof LineMoney | 'lines' | 'tenderMinor' | 'changeMinor'>,
  plan: Plan, check: number, before: number, paid: number, tip: number, tipBefore: number,
  claims: ModuleSale['claims']): ModuleSale {
  if (!money(tip) || !money(tipBefore + tip) || !money(paid + tip, 1) || (plan.workflow.kind === 'services' && tip))
    throw new Error('Invalid cash tip');
  const lines = paymentLines(plan, check, before, paid).map(line => ({
    id: stableId(head.saleId, line.allocationId), quote: line.source.quote, quantity: 1,
    units: claims.filter(claim => claim.source === line.source.id).map(claim => claim.unit), discount: null,
    basisMinor: line.basisMinor, taxMinor: line.taxMinor, totalMinor: line.totalMinor,
  }));
  return { sale: { ...head, lines, ...totals(lines), tenderMinor: paid + tip, changeMinor: 0 },
    plan, check, before, paid, tip, tipBefore, claims };
}

export function moduleBytes(event: ModuleSale) {
  const { sale, ...facts } = event;
  const { lines, tenderMinor, changeMinor, basisMinor, taxMinor, totalMinor, ...head } = sale;
  return jsonBytes({ ...head, version: 5, ...facts });
}

export function parseModuleSale(bytes: Buffer): ModuleSale {
  if (bytes.length > retailBodyLimit) throw new Error('Module event too large');
  const e = decode(bytes);
  exact(e, ['version','tenantId','storeId','terminalId','generation','cashierId','currency','saleId','shiftId',
    'sequence','occurredAt','kind','receiptId','plan','check','before','paid','tip','tipBefore','claims']);
  if (!isScope(e) || e.version !== 5 || e.currency !== 'USD' || e.kind !== 'SALE' || !isUuid(e.saleId) ||
      !isUuid(e.shiftId) || !isUuid(e.receiptId) || !isCounter(e.sequence) || !isIsoDate(e.occurredAt) ||
      !money(e.check) || e.check > 5 || !money(e.before) || !money(e.paid, 1) || !money(e.tip) || !money(e.tipBefore) ||
      !Array.isArray(e.claims) || e.claims.length > 8) throw new Error('Invalid module tender');
  const plan = readPlan(e.plan);
  const claims = e.claims.map(value => {
    const { source, unit } = exact(value, ['source','unit']);
    if (!isUuid(source)) throw new Error('Invalid source claim');
    return { source, unit: readQuotaSpend(unit) };
  });
  const payable = paymentLines(plan, e.check, e.before, e.paid);
  if (new Set(claims.map(claim => claim.source)).size !== claims.length ||
      new Set(claims.map(claim => claim.unit.sliceId)).size !== claims.length ||
      claims.some(claim => !payable.some(line => line.source.id === claim.source && line.source.item !== 'labor')))
    throw new Error('Invalid physical unit claim');
  const { tenantId, storeId, terminalId, generation, cashierId, saleId, shiftId, sequence, occurredAt, receiptId } = e;
  return makeModuleSale({ tenantId, storeId, terminalId, generation, cashierId, saleId, shiftId, sequence, occurredAt,
    receiptId, version: 3, currency: 'USD', kind: 'SALE' }, plan, e.check, e.before, e.paid, e.tip, e.tipBefore, claims);
}

export function modulePrintable(event: ModuleSale) {
  return salePrintable(event.sale) + '\nTip USD ' + (event.tip / 100).toFixed(2) +
    '\nCash total USD ' + (event.sale.tenderMinor / 100).toFixed(2);
}

export function moduleAccrual(event: ModuleSale) {
  const { sale, plan, tip, tipBefore } = event;
  if (plan.workflow.kind === 'services') {
    const basisMinor = priceLine(plan.sources[0].quote, 1, 0).basisMinor;
    return { commission: { id: stableId(plan.id,'commission'), version: 1, technician: plan.workflow.technician,
      basisMinor, rateBps: 1000, minor: Math.floor(basisMinor / 10) } };
  }
  return { tipPool: { id: stableId(sale.shiftId,'tip',sale.saleId), shift: sale.shiftId, version: 1,
    shares: ['alex','sam'].map((staff,index) => ({ staff, weight: 1,
      minor: portions(tipBefore + tip,2,index) - portions(tipBefore,2,index) })) } };
}
