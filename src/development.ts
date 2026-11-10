import type { Scope } from './protocol.ts';

export const devScope: Scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
  terminalId: '30000000-0000-4000-8000-000000000001',
  generation: 1,
  cashierId: '40000000-0000-4000-8000-000000000001',
};
export const devItem = { sku: 'M1-ITEM', label: 'Milestone item', unitMinor: 2000, onHand: 3 };
