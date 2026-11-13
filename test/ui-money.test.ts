import assert from 'node:assert/strict';
import { test } from 'node:test';

test('staff dollar amounts convert exactly and reject rounding, exponent and overflow', async () => {
  const { parseCurrency } = await import('../src/ui/money.ts');
  for (const [text, cents] of [['0', 0], ['0.01', 1], ['2.20', 220], ['50', 5000], ['1.1', 110], ['1000000.00', 100000000]] as const)
    assert.equal(parseCurrency(text), cents);
  for (const text of ['', ' ', '1e2', '-1', '1.001', '.5', '1,000', 'Infinity', '1000000.01', '9007199254740993'])
    assert.throws(() => parseCurrency(text), /Enter/);
});
