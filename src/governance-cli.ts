import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyExport, verifyPlan } from './governed-report.ts';
import { verifySeal } from './period-close.ts';
import { readBounded, trustedEndpoint } from './protocol.ts';

const [action,path,...scope] = process.argv.slice(2);
if (!path) throw new Error('Usage: governance send request.json | verify-seal bundle.json tenant period previous-or-none | verify-plan plan.json tenant plan seal | verify-export export.json tenant plan seal');
const input = JSON.parse(readFileSync(path,'utf8'));
if (action==='send') {
  const {OMNI_INGEST_URL,OMNI_GOVERNANCE_TOKEN} = process.env;
  if (!OMNI_INGEST_URL || !OMNI_GOVERNANCE_TOKEN) throw new Error('Set governance endpoint and operator token');
  const response = await fetch(new URL('/v6/governance',trustedEndpoint(OMNI_INGEST_URL)),{
    method:'POST',headers:{authorization:'Bearer '+OMNI_GOVERNANCE_TOKEN,'content-type':'application/json'},
    body:JSON.stringify(input),signal:AbortSignal.timeout(10_000),redirect:'error',
  });
  if (!response.ok || !response.body) throw new Error('Governance request rejected with HTTP '+response.status);
  process.stdout.write(await readBounded(response.body,16*1024*1024));
} else {
  const {OMNI_GOVERNANCE_PUBLIC_KEY_FILE,OMNI_GOVERNANCE_KEY_ID} = process.env;
  if (!OMNI_GOVERNANCE_PUBLIC_KEY_FILE || !OMNI_GOVERNANCE_KEY_ID || scope.length!==3)
    throw new Error('Set the trusted public key, key ID and expected scope');
  const keys = new Map([[OMNI_GOVERNANCE_KEY_ID,createPublicKey(readFileSync(OMNI_GOVERNANCE_PUBLIC_KEY_FILE))]]);
  const [tenant,subject,reference] = scope;
  if (action==='verify-seal') {
    const {manifest} = verifySeal(input,keys,{tenant,period:subject,previous:reference==='none' ? null : reference});
    process.stdout.write(JSON.stringify(manifest)+'\n');
  } else if (action==='verify-plan') {
    process.stdout.write(JSON.stringify(verifyPlan(input,keys,{tenant,id:subject,seal:reference}))+'\n');
  } else if (action==='verify-export') {
    process.stdout.write(verifyExport(input,keys,{tenant,plan:subject,seal:reference}));
  } else throw new Error('Unknown governance command');
}
