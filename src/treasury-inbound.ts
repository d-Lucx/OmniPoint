import { isUuid } from './protocol.ts';
import { cents, fail, uuid } from './treasury-protocol.ts';
import { Treasury } from './treasury-store.ts';
import type { Position } from './treasury-store.ts';

export async function bookedCash(ctx:Treasury) {
  for (const {fact} of await ctx.facts('CREDIT','DEBIT')) {
    const minor=cents(fact.data.minor), credit=fact.kind==='CREDIT';
    const key='bank-'+fact.kind.toLowerCase()+':'+fact.id;
    if (await ctx.effect(key)) continue;
    if (credit && (typeof fact.data.remitter!=='string' || typeof fact.data.remittance!=='string'))
      return fail('BANK_REMITTANCE_REQUIRED');
    const clearing=credit && fact.data.purpose==='RETURN' ? 'InboundReturnSuspense' : 'InboundSuspense';
    if (!await ctx.journal(key,fact,credit?'Cash':'OutboundClearing',credit?clearing:'Cash',minor,
      {cash:credit?minor:-minor,cut:fact.cut,trace:fact.data.trace ?? null})) continue;
    await ctx.set(credit?'credit':'debit',fact.id,minor,'AVAILABLE',{...fact.data,clearing,cut:fact.cut});
  }
}

export async function reimburse(ctx:Treasury) {
  for (const credit of await ctx.positions('credit')) {
    if (credit.facts.purpose!=='PRINCIPAL' || credit.facts.remitter!==ctx.account.remitter ||
        !isUuid(credit.facts.remittance) || !credit.remaining) continue;
    const receivable=await ctx.position('receivable',credit.facts.remittance);
    if (!receivable || receivable.remaining<credit.remaining) continue;
    const proof=(await ctx.facts('CREDIT')).find(row=>row.fact.id===credit.id)!.fact;
    const minor=credit.remaining;
    if (await ctx.journal('principal:'+credit.id,proof,'InboundSuspense','AgencyReceivable',minor,{receivable:receivable.id})) {
      await ctx.claim(receivable,minor,receivable.remaining===minor?'SETTLED':'OPEN');
      await ctx.claim(credit,minor,'ALLOCATED');
    }
  }
  for (const {fact} of await ctx.facts('FEE')) {
    if (await ctx.position('fee',fact.id)) continue;
    const {receivable,principal,account}=fact.data;
    if (account!=='FeeA' && account!=='FeeB' && account!=='FeeExpense') return fail('FEE_ACCOUNT_REJECTED');
    const amount=cents(fact.data.minor);
    const debt=await ctx.position('receivable',uuid(receivable));
    const principalEffect=await ctx.effect('principal:'+uuid(principal));
    if (!debt || principalEffect?.facts.receivable!==debt.id || debt.remaining<amount) continue;
    if (await ctx.journal('fee:'+fact.id,fact,account,'AgencyReceivable',amount,{receivable:debt.id,principal})) {
      await ctx.claim(debt,amount,debt.remaining===amount?'SETTLED':'OPEN');
      await ctx.set('fee',fact.id,amount,'OPEN',{account,principal,receivable,originalMinor:amount});
    }
  }
  const proofs=(await ctx.facts('PROOF')).map(row=>row.fact);
  for (const {fact:boundary} of await ctx.facts('FINAL')) {
    const feeId=uuid(boundary.data.fee);
    if (!Array.isArray(boundary.data.candidates) || !boundary.data.candidates.length ||
        boundary.data.candidates.length>8 || new Set(boundary.data.candidates).size!==boundary.data.candidates.length)
      return fail('PROOF_COMPLETENESS_REQUIRED');
    const ids=boundary.data.candidates.map(uuid);
    const candidates=ids.flatMap(id=>proofs.filter(proof=>proof.id===id && proof.data.fee===feeId));
    if (candidates.length!==ids.length) {
      await ctx.set('proof',boundary.id,0,'WAITING',{fee:feeId,missing:ids.filter(id=>!candidates.some(p=>p.id===id))});
      continue;
    }
    const omitted=proofs.filter(proof=>proof.data.fee===feeId && proof.cut<=boundary.cut && !ids.includes(proof.id));
    const winners=candidates.filter(proof=>!candidates.some(other=>other.lineage===proof.lineage &&
      other.data.supersedes===proof.id && other.cut>proof.cut));
    const current=await ctx.position('reimbursement',feeId);
    // Historical finality evidence cannot replace a later allocation correction.
    if (current?.facts.correction) continue;
    if (omitted.length || winners.length!==1 || winners[0].cut>boundary.cut ||
        (current && current.facts.proof!==winners[0].id)) {
      await ctx.set('incident',feeId,0,'PROOF_CONFLICT',{boundary:boundary.id,candidates:ids,omitted:omitted.map(row=>row.id)});
      if (current && current.state!=='CORRECTED')
        await ctx.set('reimbursement',feeId,current.remaining,'FROZEN',current.facts);
      for (const proof of candidates) {
        const id=uuid(proof.data.credit);
        const credit=await ctx.position('credit',id);
        if (credit?.remaining) await ctx.set('credit',id,credit.remaining,'FROZEN',{...credit.facts,incident:feeId});
      }
      continue;
    }
    if (current || await ctx.position('incident',feeId)) continue;
    const proof=winners[0];
    const fee=await ctx.position('fee',feeId), credit=await ctx.position('credit',uuid(proof.data.credit));
    const amount=cents(proof.data.minor);
    if (!fee || !credit || fee.remaining<amount || credit.remaining<amount || credit.state!=='AVAILABLE' ||
        credit.facts.remitter!==ctx.account.remitter || credit.facts.purpose!=='REIMBURSEMENT' ||
        credit.facts.remittance!==feeId) {
      await ctx.set('proof',boundary.id,0,'WAITING',{fee:feeId,credit:proof.data.credit,proof:proof.id});
      continue;
    }
    if (await ctx.journal('reimbursement:'+feeId,proof,'InboundSuspense',String(fee.facts.account),amount,
      {credit:credit.id,fee:fee.id,boundary:boundary.id})) {
      await ctx.claim(fee,amount,fee.remaining===amount?'SATISFIED':'OPEN',{...fee.facts,credit:credit.id,proof:proof.id});
      await ctx.claim(credit,amount,credit.remaining===amount?'ALLOCATED':'AVAILABLE');
      await ctx.set('proof',boundary.id,0,'FINAL',{proof:proof.id,fee:feeId});
      await ctx.set('reimbursement',feeId,amount,'FINAL',{credit:credit.id,proof:proof.id,boundary:boundary.id});
    }
  }
}

async function activeAllocation(ctx:Treasury,fee:Position) {
  let allocation=await ctx.position('reimbursement',fee.id);
  let journal=typeof allocation?.facts.journal==='string' ? allocation.facts.journal :
    (await ctx.effect('reimbursement:'+fee.id))?.journal;
  // Older releases moved the fee pointer without recording the destination head.
  const correctionId=fee.facts.corrected;
  if (typeof correctionId==='string' && allocation?.facts.correction!==correctionId) {
    const correction=await ctx.effect('allocation-correction:'+correctionId);
    if (correction?.facts.to===fee.id) {
      journal=correction.facts.displaced ? journal : correction.journal;
      if (!journal) return fail('ALLOCATION_JOURNAL_REQUIRED',409);
      await ctx.set('reimbursement',fee.id,cents(correction.facts.minor),'FINAL',
        {credit:correction.facts.credit,proof:correction.evidence,correction:correctionId,journal});
      allocation=await ctx.position('reimbursement',fee.id);
    }
  }
  return {allocation,journal};
}

export async function correctAllocations(ctx:Treasury) {
  for (const {fact} of await ctx.facts('ALLOCATION_CORRECT')) {
    const from=uuid(fact.data.from), to=uuid(fact.data.to);
    if (from===to) return fail('ALLOCATION_DESTINATION_REJECTED');
    const key='allocation-correction:'+fact.id;
    if (await ctx.effect(key)) continue;
    const a=await ctx.position('fee',from), b=await ctx.position('fee',to);
    if (!a || !b) continue;
    const {allocation,journal}=await activeAllocation(ctx,a);
    if (!journal || !allocation) continue;
    const minor=cents(fact.data.minor);
    const sealed=(await ctx.db.query(`SELECT 1 FROM omni.ledger_lines l JOIN omni.period_seals s
      USING(tenant_id,period) WHERE l.tenant_id=$1 AND l.journal_id=$2 LIMIT 1`,
    [ctx.tenant,'adjustment:'+journal])).rowCount;
    if (!sealed || allocation.state!=='FINAL' || allocation.facts.proof!==fact.data.proof || minor!==allocation.remaining ||
        (b.remaining!==0 && b.remaining<minor) || a.facts.account===b.facts.account)
      return fail('SEALED_ALLOCATION_CORRECTION_REJECTED',409);
    const displaced=b.remaining===0 ? b.facts.credit : undefined;
    if (b.remaining===0 && typeof displaced!=='string') continue;
    const destination=displaced ? await activeAllocation(ctx,b) : undefined;
    if (displaced && (!destination?.journal || destination.allocation?.state!=='FINAL' ||
        destination.allocation.facts.credit!==displaced)) return fail('DESTINATION_ALLOCATION_REQUIRED',409);
    if (await ctx.journal(key,fact,String(a.facts.account),displaced?'SurplusHold':String(b.facts.account),minor,
      {reference:'adjustment:'+journal+':'+String(a.facts.account),from,to,credit:allocation.facts.credit,displaced})) {
      const correctedJournal=displaced ? destination!.journal : (await ctx.effect(key))!.journal;
      await ctx.set('fee',from,a.remaining+minor,'OPEN',{...a.facts,credit:null,corrected:fact.id});
      const residual=b.remaining ? b.remaining-minor : 0;
      await ctx.set('fee',to,residual,residual?'OPEN':'SATISFIED',
        {...b.facts,credit:allocation.facts.credit,corrected:fact.id});
      await ctx.set('reimbursement',from,0,'CORRECTED',{...allocation.facts,journal,to,correction:fact.id});
      await ctx.set('reimbursement',to,minor,'FINAL',
        {credit:allocation.facts.credit,proof:fact.id,correction:fact.id,journal:correctedJournal});
      if (displaced) await ctx.set('surplus',fact.id,0,'FENCED',{held:minor,credit:displaced,to,consumed:null});
    }
  }
}

export async function disputes(ctx:Treasury) {
  for (const position of await ctx.positions('surplus')) {
    const rows=(await ctx.facts('CLAWBACK','CLAWBACK_RELEASE','OFFSET','DEBIT','DISPUTE_RELEASE')).map(row=>row.fact)
      .filter(fact=>fact.data.surplus===position.id);
    const bank=rows.some(fact=>fact.kind==='CLAWBACK'), agency=rows.some(fact=>fact.kind==='OFFSET');
    const minor=cents(position.facts.held);
    let consumed=position.facts.consumed;
    let dual=Boolean(position.facts.dual);
    for (const fact of rows) {
      if (fact.kind!=='DEBIT' && !(fact.kind==='OFFSET' && fact.data.phase==='EXECUTED')) continue;
      if (cents(fact.data.minor)!==minor) return fail('DISPUTE_AMOUNT_MISMATCH');
      const rail=fact.kind==='DEBIT'?'bank':'agency';
      if (rail==='bank' && !await ctx.effect('bank-debit:'+fact.id)) continue;
      const key='surplus-execution:'+position.id+':'+rail;
      if (await ctx.effect(key)) continue;
      if (await ctx.journal(key,fact,consumed?'DisputeReceivable':'SurplusHold',
        rail==='bank'?'OutboundClearing':'AgencyClearing',minor,{surplus:position.id,rail})) {
        if (consumed) dual=true;
        else consumed=rail;
      }
    }
    const bankRelease=rows.find(fact=>fact.kind==='CLAWBACK_RELEASE' &&
      fact.data.clawback===rows.find(row=>row.kind==='CLAWBACK')?.id && fact.data.credit===position.facts.credit);
    const release=bank && agency && bankRelease && rows.find(fact=>fact.kind==='DISPUTE_RELEASE' &&
      fact.data.bank===bankRelease.id &&
      fact.data.agency===rows.find(row=>row.kind==='OFFSET')?.id && fact.data.credit===position.facts.credit);
    const released=release && !consumed;
    await ctx.set('surplus',position.id,released?minor:0,released?'RELEASED':dual?'DUAL_EXECUTION':
      bank&&agency?'DISPUTED':consumed?'EXECUTED_HELD':'FENCED',
    {...position.facts,consumed,dual,bank,agency,recognitionHold:!released,dischargeHold:!released,paymentHold:!released});
  }
}
