import type { PoolClient } from 'pg';
import { stableId } from './module-sale.ts';
import { canonical, ledgerLock } from './period-close.ts';
import { digest } from './protocol.ts';
import { fail } from './treasury-protocol.ts';
import type { Fact } from './treasury-protocol.ts';

type Account = { taxpayer:string; remitter:string; opening_minor:number };
export type Position = { id:string; kind:string; remaining:number; state:string; facts:Record<string,unknown> };
export type Effect = { effect:string; evidence:string; journal:string|null; facts:Record<string,unknown> };
type StoredFact = { digest:string; fact:Fact };

export class Treasury {
  readonly db:PoolClient;
  readonly tenant:string;
  readonly id:string;
  readonly actor:string;
  readonly account:Account;
  constructor(db:PoolClient,tenant:string,id:string,actor:string,account:Account) {
    this.db=db; this.tenant=tenant; this.id=id; this.actor=actor; this.account=account;
  }
  static async open(db:PoolClient,tenant:string,id:string,actor:string) {
    await ledgerLock(db,tenant);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,708001))',[tenant+':'+id]);
    const {rows:[account]}=await db.query<Account>(`SELECT taxpayer,remitter,opening_minor
      FROM omni.treasury_accounts WHERE tenant_id=$1 AND account_id=$2`,[tenant,id]);
    if (!account) return fail('TREASURY_ACCOUNT_UNKNOWN',404);
    return new Treasury(db,tenant,id,actor,account);
  }
  args(...rest:unknown[]) { return [this.tenant,this.id,...rest]; }

  async store(fact:Fact,body:Buffer,packet:unknown) {
    const args=this.args(fact.source,fact.id);
    const {rows:[prior]}=await this.db.query<StoredFact>(`SELECT digest,facts AS fact FROM omni.treasury_facts
      WHERE tenant_id=$1 AND account_id=$2 AND source=$3 AND id=$4`,args);
    const hash=digest(body);
    if (prior) {
      if (prior.digest!==hash) {
        await this.db.query(`INSERT INTO omni.treasury_collisions VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT DO NOTHING`,[...args,hash,prior.digest,body,JSON.stringify(packet)]);
        await this.set('incident',fact.id,0,'EVIDENCE_COLLISION',{source:fact.source,original:prior.digest,conflicting:hash});
        return 'COLLISION' as const;
      }
      return false;
    }
    await this.db.query(`INSERT INTO omni.treasury_facts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [...args,fact.kind,fact.lineage,fact.cut,fact.at,body,hash,JSON.stringify(packet),JSON.stringify(fact)]);
    return true;
  }
  async facts(...kinds:string[]) {
    return (await this.db.query<StoredFact>(`SELECT digest,facts AS fact FROM omni.treasury_facts WHERE tenant_id=$1 AND account_id=$2
      AND (cardinality($3::text[])=0 OR kind=ANY($3)) ORDER BY source_cut,source,id`,this.args(kinds))).rows;
  }
  async positions(kind:string) {
    return (await this.db.query<Position>(`SELECT kind,id,remaining,state,facts FROM omni.treasury_positions
      WHERE tenant_id=$1 AND account_id=$2 AND kind=$3 ORDER BY id`,this.args(kind))).rows;
  }
  async position(kind:string,id:string) {
    return (await this.db.query<Position>(`SELECT kind,id,remaining,state,facts FROM omni.treasury_positions
      WHERE tenant_id=$1 AND account_id=$2 AND kind=$3 AND id=$4`,this.args(kind,id))).rows[0];
  }
  async set(kind:string,id:string,remaining:number,state:string,facts:Record<string,unknown>={}) {
    await this.db.query(`INSERT INTO omni.treasury_positions VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(tenant_id,account_id,kind,id) DO UPDATE
      SET remaining=excluded.remaining,state=excluded.state,facts=excluded.facts`,
    this.args(kind,id,remaining,state,JSON.stringify(facts)));
  }
  async claim(position:Position,minor:number,state:string,facts=position.facts) {
    const result=await this.db.query(`UPDATE omni.treasury_positions SET remaining=remaining-$5,state=$6,facts=$7
      WHERE tenant_id=$1 AND account_id=$2 AND kind=$3 AND id=$4 AND remaining=$8 AND remaining >= $5`,
    this.args(position.kind,position.id,minor,state,JSON.stringify(facts),position.remaining));
    if (!result.rowCount) return fail('TREASURY_CAPACITY_CHANGED',409);
  }
  async effects() {
    return (await this.db.query<Effect>(`SELECT effect,evidence,journal,facts FROM omni.treasury_effects
      WHERE tenant_id=$1 AND account_id=$2 ORDER BY effect`,this.args())).rows;
  }
  async effect(effect:string) {
    return (await this.db.query<Effect>(`SELECT effect,evidence,journal,facts FROM omni.treasury_effects
      WHERE tenant_id=$1 AND account_id=$2 AND effect=$3`,this.args(effect))).rows[0];
  }
  async record(effect:string,evidence:string,journal:string|null,facts:Record<string,unknown>) {
    await this.db.query('INSERT INTO omni.treasury_effects VALUES($1,$2,$3,$4,$5,$6)',
      this.args(effect,evidence,journal,JSON.stringify(facts)));
  }
  async journal(effect:string, fact:Pick<Fact,'id'|'at'>, debit:string,credit:string,minor:number,
    details:Record<string,unknown>={}, classification={family:'statutory',effect:'RECONCILIATION'}) {
    if (await this.effect(effect)) return false;
    const id=stableId(this.tenant,this.id,effect);
    const correction=await this.position('period-approval',fact.id);
    const date=typeof correction?.facts.at==='string' ? correction.facts.at : fact.at;
    await this.db.query('SAVEPOINT treasury_journal');
    try {
      await this.db.query('INSERT INTO omni.governed_adjustments VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [this.tenant,id,date,debit,credit,minor,fact.id,this.actor,classification.family,classification.effect,
          typeof details.reference==='string' ? details.reference : null]);
    } catch(error) {
      if (!(error && typeof error==='object' && 'code' in error && error.code==='OP601')) throw error;
      await this.db.query('ROLLBACK TO SAVEPOINT treasury_journal');
      await this.db.query('RELEASE SAVEPOINT treasury_journal');
      await this.set('late',stableId(this.id,effect),minor,'PERIOD_SEALED',{evidence:fact.id,at:fact.at,effect});
      return false;
    }
    await this.db.query('RELEASE SAVEPOINT treasury_journal');
    await this.record(effect,fact.id,id,{...details,minor,originalAt:fact.at,at:date});
    const held=await this.position('late',stableId(this.id,effect));
    if (held) await this.set('late',held.id,0,'CORRECTED',{...held.facts,journal:id});
    return true;
  }
}

export function identical(a:unknown,b:unknown) { return canonical(a).equals(canonical(b)); }
