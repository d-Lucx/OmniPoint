import type { Pool } from 'pg';
import { cashAction } from './cash-close.ts';
import { adjustment, reportAction, technicalReplacement } from './governed-report.ts';
import { isPeriod, loadSeal, sealPeriod } from './period-close.ts';
import { tenantTransaction } from './postgres.ts';
import { InventoryError } from './quota-cloud.ts';
import type { SigningKey } from './protocol.ts';
import { digest } from './protocol.ts';
import { treasuryAction } from './treasury-api.ts';
import type { TreasuryTrust } from './treasury-protocol.ts';

export function governanceAction(pool:Pool, tenant:string, actor:string, input:Record<string,unknown>, signer:SigningKey, treasury?:TreasuryTrust) {
  if (typeof input.action==='string' && input.action.startsWith('treasury-')) {
    if (!treasury) throw new InventoryError('TREASURY_ADAPTERS_REQUIRED',503);
    return treasuryAction(pool,tenant,actor,input,treasury);
  }
  return tenantTransaction(pool,tenant,async db => {
    const action=input.action;
    if (typeof action==='string' && action.startsWith('cash-')) return cashAction(db,tenant,actor,input);
    if (typeof action==='string' && action.startsWith('report-')) return reportAction(db,tenant,actor,input,signer);
    if (action==='period-adjust') return adjustment(db,tenant,actor,input);
    if (action==='period-technical-replace') return technicalReplacement(db,tenant,actor,input);
    if (action==='period-close') return sealPeriod(db,tenant,actor,input,signer);
    if (action==='period-get' && isPeriod(input.period)) {
      const seal=await loadSeal(db,tenant,input.period);
      if (seal) return {packet:seal.packet,objects:seal.objects};
      throw new InventoryError('PERIOD_SEAL_UNKNOWN',404);
    }
    throw new InventoryError('UNKNOWN_GOVERNANCE_ACTION',400);
  });
}

export function isSealedPeriodError(error:unknown) {
  return typeof error==='object' && error!==null && 'code' in error && error.code==='OP601';
}

export function retainLatePosting(pool:Pool,tenant:string,route:string,bytes:Buffer) {
  return tenantTransaction(pool,tenant,db => db.query(`INSERT INTO omni.late_ledger_holds VALUES($1,$2,$3,$4)
    ON CONFLICT DO NOTHING`,[tenant,digest(bytes),route,bytes]));
}
