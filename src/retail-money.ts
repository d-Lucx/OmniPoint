export const maxMoney = 100_000_000;
export const maxQuantity = 8;
export const denominations = [1, 5, 10, 25, 50, 100, 500, 1000, 2000, 5000, 10000] as const;

export interface Variant {
  sku: string;
  parentId: string;
  label: string;
  barcode: string;
  unitMinor: number;
  taxBps: number;
  taxMode: 'INCLUSIVE' | 'EXCLUSIVE';
}
export interface Catalog {
  version: number;
  taxVersion: number;
  variants: Variant[];
}
export interface Quote extends Variant { catalogVersion: number; taxVersion: number }
export interface LineMoney { basisMinor: number; taxMinor: number; totalMinor: number }

export function money(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= maxMoney;
}

export function quantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxQuantity;
}

function bounded(value: bigint): number {
  if (value < 0n || value > BigInt(maxMoney)) throw new Error('Money limit exceeded');
  return Number(value);
}

function halfEven(numerator: bigint, denominator: bigint): bigint {
  const whole = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  return whole + (twiceRemainder > denominator || (twiceRemainder === denominator && whole % 2n === 1n) ? 1n : 0n);
}

export function priceLine(quote: Quote, units: number, discountMinor: number): LineMoney {
  if (!quantity(units) || !money(quote.unitMinor, 1) || !money(discountMinor) ||
      !Number.isInteger(quote.taxBps) || quote.taxBps < 0 || quote.taxBps > 10_000) throw new Error('Invalid line amount');
  const extended = BigInt(quote.unitMinor) * BigInt(units);
  if (extended - BigInt(discountMinor) < BigInt(units)) throw new Error('Discount must leave at least one cent per unit');
  const price = extended - BigInt(discountMinor);
  const rate = BigInt(quote.taxBps);
  const inclusive = quote.taxMode === 'INCLUSIVE';
  const tax = halfEven(price * rate, inclusive ? 10_000n + rate : 10_000n);
  return { basisMinor: bounded(inclusive ? price - tax : price), taxMinor: bounded(tax),
    totalMinor: bounded(inclusive ? price : price + tax) };
}

export function totals(lines: LineMoney[]): LineMoney {
  return {
    basisMinor: bounded(lines.reduce((sum, line) => sum + BigInt(line.basisMinor), 0n)),
    taxMinor: bounded(lines.reduce((sum, line) => sum + BigInt(line.taxMinor), 0n)),
    totalMinor: bounded(lines.reduce((sum, line) => sum + BigInt(line.totalMinor), 0n)),
  };
}

export function blindTotal(counts: Record<string, unknown>): number {
  let sum = 0n;
  for (const [key, amount] of Object.entries(counts)) {
    const denomination = denominations.find(value => String(value) === key);
    if (!denomination || !money(amount)) throw new Error('Invalid denomination count');
    sum += BigInt(denomination) * BigInt(amount);
  }
  return bounded(sum);
}

export function allocateUnit(basis: number, tax: number, units: number, ordinal: number) {
  const gross = BigInt(basis + tax);
  const before = gross * BigInt(ordinal) / BigInt(units);
  const after = gross * BigInt(ordinal + 1) / BigInt(units);
  const allocatedTax = BigInt(tax) * after / gross - BigInt(tax) * before / gross;
  return { tax: Number(allocatedTax), basis: Number(after - before - allocatedTax) };
}
