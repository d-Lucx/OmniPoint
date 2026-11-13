import { maxMoney } from '../retail-money.ts';

export function parseCurrency(text: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || text.length > 12)
    throw new Error('Enter dollars and up to two decimal places, for example 5.00');
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(maxMoney)) throw new Error('Enter an amount of $1,000,000.00 or less');
  return Number(cents);
}

export const usd = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);

export function currencyPreview(text: string): number {
  try { return parseCurrency(text); } catch { return 0; }
}
