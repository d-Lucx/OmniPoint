import type { Fact } from './treasury-protocol.ts';
import { cents, fail, uuid } from './treasury-protocol.ts';
import { identical, Treasury } from './treasury-store.ts';
import type { Position } from './treasury-store.ts';

type Pair={envelope:string;credit:string;minor:number};
function pair(data:Record<string,unknown>):Pair {
  return {envelope:uuid(data.envelope),credit:uuid(data.credit),minor:cents(data.minor)};
}

async function match(ctx:Treasury,fact:Fact,key:string,binding:Pair) {
  if (await ctx.effect(key)) return true;
  const envelope=await ctx.position('envelope',binding.envelope), credit=await ctx.position('credit',binding.credit);
  if (!envelope || !credit || envelope.remaining!==binding.minor || credit.remaining!==binding.minor ||
      credit.facts.purpose!=='RETURN' || !['AVAILABLE','REVOKED_HELD'].includes(credit.state) ||
      credit.facts.remitter!==ctx.account.remitter || credit.facts.remittance!==envelope.id) return false;
  if (credit.state==='REVOKED_HELD' && fact.kind!=='REINSTATE') return false;
  if (!await ctx.journal(key,fact,'InboundReturnSuspense','OutboundClearing',binding.minor,binding)) return false;
  await ctx.claim(envelope,binding.minor,'MATCHED',{...envelope.facts,matched:fact.id});
  await ctx.claim(credit,binding.minor,'ALLOCATED',{...credit.facts,matched:fact.id});
  return true;
}

async function statementAliases(ctx:Treasury,fact:Fact) {
  if (!Array.isArray(fact.data.lines) || fact.data.lines.length>8) return fail('STATEMENT_LINES_REJECTED');
  const candidates:string[]=[];
  const seen=new Set<string>();
  const covered=new Set<string>();
  for (const line of fact.data.lines) {
    if (!line || typeof line!=='object') return fail('STATEMENT_LINES_REJECTED');
    const id=uuid(line.id), amount=cents(line.minor);
    if (seen.has(id)) return fail('STATEMENT_ALIAS_COLLISION',409);
    seen.add(id);
    if (line.canonical===null) { candidates.push(id); continue; }
    const canonical=uuid(line.canonical);
    if (covered.has(canonical)) return fail('STATEMENT_ALIAS_CARDINALITY',409);
    covered.add(canonical);
    const row=await ctx.position('debit',canonical);
    const source=await ctx.effect('bank-debit:'+canonical) ?? await ctx.effect('fund-settlement:'+canonical);
    if (!row || source?.facts.minor!==amount || Number(row.facts.cut)>fact.cut) return fail('UNPROVEN_STATEMENT_ALIAS');
    const previous=await ctx.position('alias',id);
    if (previous && previous.facts.canonical!==canonical) return fail('STATEMENT_ALIAS_COLLISION',409);
    if (!previous) await ctx.set('alias',id,0,'BOUND',{canonical,statement:fact.id,minor:amount});
  }
  return candidates;
}

async function cashAt(ctx:Treasury,cut:number) {
  return ctx.account.opening_minor+(await ctx.effects()).reduce((sum,row)=>
    typeof row.facts.cash==='number' && typeof row.facts.cut==='number' && row.facts.cut<=cut ? sum+row.facts.cash : sum,0);
}

async function amend(ctx:Treasury,fact:Fact,previous:Position) {
  const {mode}=fact.data;
  if (mode==='AMBIGUOUS') {
    await ctx.set('incident',fact.id,0,'AMBIGUOUS_AMENDMENT',{previous:previous.id});
    return false;
  }
  const envelope=await ctx.position('envelope',uuid(fact.data.envelope));
  if (!envelope || envelope.id!==previous.facts.envelope) return fail('STATEMENT_ENVELOPE_REQUIRED');
  const minor=cents(envelope.facts.minor);
  if (mode==='GHOST') {
    if (envelope.remaining!==minor || Number(fact.data.closing)!==Number(previous.facts.closing)+minor)
      return fail('GHOST_CONTINUITY_REJECTED');
    if (!await ctx.journal('ghost:'+envelope.id,fact,'Cash','OutboundClearing',minor,
      {cash:minor,cut:fact.cut,envelope:envelope.id})) return false;
    await ctx.claim(envelope,minor,'GHOST_CORRECTED');
  } else if (mode==='REAL_RETURN' || mode==='FORWARD') {
    const credit=await ctx.position('credit',uuid(fact.data.credit));
    if (!credit) return false;
    if ((mode==='FORWARD' && (Number(credit.facts.cut)<=Number(previous.facts.cut) ||
        fact.data.closing!==previous.facts.closing)) ||
        (mode==='REAL_RETURN' && (Number(credit.facts.cut)>fact.cut ||
          Number(fact.data.closing)!==Number(previous.facts.closing)+minor))) return fail('RETURN_CUT_MISMATCH');
    if (fact.data.closing!==await cashAt(ctx,fact.cut)) return fail('STATEMENT_REVISION_BALANCE_MISMATCH');
    if (!await match(ctx,fact,'statement-match:'+envelope.id,{envelope:envelope.id,credit:credit.id,minor})) return false;
  } else return fail('STATEMENT_REVISION_UNSUPPORTED');
  return true;
}

export async function statements(ctx:Treasury) {
  const history=await ctx.facts('STATEMENT');
  for (const row of history) {
    const {fact,digest}=row;
    if (await ctx.position('statement',fact.id) || await ctx.position('incident',fact.id)) continue;
    const seq=cents(fact.data.sequence), revision=cents(fact.data.revision);
    const closing=cents(fact.data.closing,0);
    if (fact.lineage!==ctx.id || fact.data.opening!==ctx.account.opening_minor || fact.data.booked!==true)
      return fail('STATEMENT_PROFILE_REJECTED');
    const accepted=await ctx.positions('statement');
    const versions=accepted.filter(item=>item.facts.sequence===seq).sort((a,b)=>Number(b.facts.revision)-Number(a.facts.revision));
    const prior=versions[0];
    const preceding=accepted.filter(item=>item.facts.sequence===seq-1).sort((a,b)=>Number(b.facts.revision)-Number(a.facts.revision))[0];
    let envelope:string|null=null;
    if (revision>1) {
      if (!prior || revision>Number(prior.facts.revision)+1) continue;
      if (revision!==Number(prior.facts.revision)+1 || fact.data.previous!==prior.facts.digest ||
          fact.cut<Number(prior.facts.cut)) {
        await ctx.set('incident',fact.id,0,'STATEMENT_REVISION_CONFLICT',{sequence:seq,revision});
        continue;
      }
      if (!await amend(ctx,fact,prior)) continue;
      envelope=String(prior.facts.envelope);
    } else {
      if (seq>1 && !preceding) continue;
      if (prior || (preceding?.facts.digest ?? null)!==fact.data.previous ||
          (preceding && fact.cut<=Number(preceding.facts.cut))) {
        await ctx.set('incident',fact.id,0,'STATEMENT_CUT_CONFLICT',{sequence:seq,revision});
        continue;
      }
      const candidates=await statementAliases(ctx,fact);
      const difference=await cashAt(ctx,fact.cut)-closing;
      if (difference<0) {
        await ctx.set('incident',fact.id,-difference,'UNPROVEN_STATEMENT_CREDIT',{sequence:seq,revision});
        continue;
      }
      if (difference>0) {
        if (!candidates.length || !await ctx.journal('statement-debit:'+seq,fact,'OutboundClearing','Cash',difference,
          {cash:-difference,cut:fact.cut,candidates})) continue;
        envelope=fact.id;
        await ctx.set('envelope',envelope,difference,'AMBIGUOUS',{minor:difference,candidates,cut:fact.cut});
      }
    }
    await ctx.set('statement',fact.id,0,'VERIFIED',{sequence:seq,revision,closing,digest,cut:fact.cut,envelope,
      previous:fact.data.previous});
  }
}

async function promote(ctx:Treasury,original:string,successor:Fact,binding:Pair,mode:string) {
  await ctx.set('attestation',original,0,'REINSTATED',{successor:successor.id,mode});
  if (await ctx.position('attestation',successor.id)) return;
  const credit=await ctx.position('credit',binding.credit), envelope=await ctx.position('envelope',binding.envelope);
  if (credit?.remaining===0 && envelope?.remaining===0 && credit.facts.matched===original && envelope.facts.matched===original) {
    await ctx.set('credit',credit.id,0,credit.state,{...credit.facts,matched:successor.id});
    await ctx.set('envelope',envelope.id,0,envelope.state,{...envelope.facts,matched:successor.id});
  }
  await ctx.set('attestation',successor.id,0,'ACTIVE',{cut:successor.cut});
}

export async function attestations(ctx:Treasury) {
  const items=(await ctx.facts('ATTEST','REVOKE','REINSTATE')).map(row=>row.fact);
  const originals=items.filter(fact=>fact.kind==='ATTEST');
  const revocations=items.filter(fact=>fact.kind==='REVOKE');
  const successors=items.filter(fact=>fact.kind==='REINSTATE');
  for (const revoke of revocations) {
    const originalId=uuid(revoke.data.original), binding=pair(revoke.data);
    const old=await ctx.position('tombstone',originalId);
    if (old && old.facts.revocation!==revoke.id) return fail('REVOCATION_IDENTITY_CONFLICT',409);
    const original=items.find(item=>item.id===originalId && (item.kind==='ATTEST' || item.kind==='REINSTATE'));
    if (original && (revoke.lineage!==original.lineage || revoke.cut<=original.cut || !identical(binding,pair(original.data))))
      return fail('REVOCATION_LINEAGE_REJECTED');
    if (!old) await ctx.set('tombstone',originalId,0,'PERMANENT',{revocation:revoke.id,cut:revoke.cut,...binding});
    const credit=await ctx.position('credit',binding.credit);
    const envelope=await ctx.position('envelope',binding.envelope);
    const active=await ctx.effect('attest:'+originalId) ?? await ctx.effect('reinstate:'+originalId) ??
      await ctx.effect('authority-only:'+originalId);
    const journal=active?.journal ?? (typeof active?.facts.journal==='string' ? active.facts.journal : null);
    const inverse=await ctx.effect('revoke:'+originalId);
    const promoted=await ctx.position('attestation',originalId);
    if (promoted?.state==='REINSTATED') {
      const successor=successors.find(item=>item.id===promoted.facts.successor);
      if (successor && !await ctx.position('attestation',successor.id))
        await promote(ctx,originalId,successor,binding,String(promoted.facts.mode));
      continue;
    }
    const replacements=successors.filter(item=>item.data.original===originalId && item.data.revocation===revoke.id &&
      item.lineage===revoke.lineage && item.cut>revoke.cut && identical(binding,pair(item.data)));
    if (replacements.length>1) {
      await ctx.set('incident',originalId,0,'REINSTATEMENT_CONFLICT',{candidates:replacements.map(item=>item.id)});
    }
    const candidate=replacements.length===1 ? replacements[0] : undefined;
    const successor=candidate && !revocations.some(item=>item.data.original===candidate.id) ? candidate : undefined;
    if (successor && original && journal && !inverse && credit?.facts.matched===originalId &&
        envelope?.facts.matched===originalId && credit.remaining===0 && envelope.remaining===0) {
      await ctx.record('authority-only:'+successor.id,successor.id,journal,{original:originalId,revocation:revoke.id,journal});
      await promote(ctx,originalId,successor,binding,'CONTINUITY');
      continue;
    }
    if (journal && !inverse && credit && envelope) {
      if (credit.remaining!==0 || envelope.remaining!==0 ||
          credit.facts.matched!==originalId || envelope.facts.matched!==originalId)
        return fail('REVOCATION_ACTIVE_BINDING_MISMATCH',409);
      if (!await ctx.journal('revoke:'+originalId,revoke,'OutboundClearing','InboundReturnSuspense',binding.minor,
        {original:originalId,reference:'adjustment:'+journal+':InboundReturnSuspense'})) continue;
      await ctx.set('envelope',envelope.id,envelope.remaining+binding.minor,'AMBIGUOUS',envelope.facts);
      await ctx.set('credit',credit.id,credit.remaining+binding.minor,'REVOKED_HELD',credit.facts);
    } else if (credit?.remaining && credit.state==='AVAILABLE') {
      await ctx.set('credit',credit.id,credit.remaining,'REVOKED_HELD',credit.facts);
    }
    await ctx.set('attestation',originalId,0,'REVOKED',{revocation:revoke.id});
    if (successor && original && await match(ctx,successor,'reinstate:'+successor.id,binding))
      await promote(ctx,originalId,successor,binding,'REPOSTED');
  }
  for (const original of originals) {
    if (await ctx.position('tombstone',original.id)) continue;
    if (await match(ctx,original,'attest:'+original.id,pair(original.data)))
      await ctx.set('attestation',original.id,0,'ACTIVE',{cut:original.cut});
  }
  for (const successor of successors) {
    const original=uuid(successor.data.original);
    if (!await ctx.position('attestation',successor.id))
      await ctx.set('pending-attestation',successor.id,0,'WAITING',{original,revocation:successor.data.revocation});
    else if (await ctx.position('pending-attestation',successor.id))
      await ctx.set('pending-attestation',successor.id,0,'RESOLVED',{original});
  }
}
