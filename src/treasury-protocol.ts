import type { KeyObject } from 'node:crypto';
import { exact, openArtifact } from './authority.ts';
import { isIsoDate, isUuid, readBounded, trustedEndpoint } from './protocol.ts';
import { money } from './retail-money.ts';
import { InventoryError } from './quota-cloud.ts';

export type Source = 'agency'|'bank';
export type Rail = { url:string; token:string; keyId:string; key:KeyObject };
export type TreasuryTrust = Record<Source,Rail>;
export type Fact = { tenant:string; account:string; source:Source; id:string; lineage:string; cut:number;
  kind:string; at:string; currency:'USD'; data:Record<string,unknown> };
export const purpose = (source:Source) => 'treasury-'+source+'-v1';
export const fail = (message:string,status=422):never => { throw new InventoryError(message,status); };

export function validateTreasuryTrust(trust:TreasuryTrust) {
  for (const source of ['bank','agency'] as const) {
    const rail=trust[source];
    trustedEndpoint(rail.url);
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(rail.token) || !/^[A-Za-z0-9_-]{1,64}$/.test(rail.keyId) ||
        rail.key.type!=='public' || rail.key.asymmetricKeyType!=='ed25519') throw new Error('Invalid treasury enrollment');
  }
  if (trust.bank.keyId===trust.agency.keyId || trust.bank.token===trust.agency.token ||
      trust.bank.key.export({type:'spki',format:'der'}).equals(trust.agency.key.export({type:'spki',format:'der'})))
    throw new Error('Bank and agency require distinct enrolled keys and credentials');
}

export function uuid(value:unknown):string {
  if (!isUuid(value)) return fail('TREASURY_ID_REQUIRED');
  return value;
}
export function cents(value:unknown,min=1):number {
  if (!money(value,min)) return fail('INVALID_TREASURY_AMOUNT');
  return value;
}
export function time(value:unknown):string {
  if (!isIsoDate(value)) return fail('INVALID_TREASURY_DATE');
  return value;
}
export function text(value:unknown,max=128):string {
  if (typeof value!=='string' || !value.length || value.length>max || !/^[A-Za-z0-9 .:_-]+$/.test(value))
    return fail('INVALID_TREASURY_TEXT');
  return value;
}

const domains:Record<Source,readonly string[]> = {
  bank:['TRANSMITTED','REJECTED','UNKNOWN','SETTLED','RETURN','CREDIT','DEBIT','STATEMENT','CLAWBACK','CLAWBACK_RELEASE'],
  agency:['TRANSMITTED','REJECTED','UNKNOWN','FILED','FILING_CHANGE','ASSESSMENT','COLLECTION','RECEIVED','APPLIED',
    'HELD_CREDIT','FEE','PROOF','FINAL','ALLOCATION_CORRECT','OFFSET','DISPUTE_RELEASE','ATTEST','REVOKE','REINSTATE'],
};

export function verifyTreasury(packet:unknown,trust:TreasuryTrust,source:Source,tenant:string,account:string) {
  const {keyId,key}=trust[source];
  let opened:ReturnType<typeof openArtifact>;
  try {opened=openArtifact(purpose(source),packet,new Map([[keyId,key]]));}
  catch {return fail('TREASURY_SIGNATURE_REJECTED');}
  const {bytes,data}=opened;
  exact(data,['tenant','account','source','id','lineage','cut','kind','at','currency','data']);
  if (data.tenant!==tenant || data.account!==account || data.source!==source || data.currency!=='USD' ||
      typeof data.kind!=='string' || !domains[source].includes(data.kind)) return fail('TREASURY_SCOPE_REJECTED',403);
  uuid(data.id); uuid(data.lineage); cents(data.cut); time(data.at);
  if (!data.data || typeof data.data!=='object' || Array.isArray(data.data)) return fail('INVALID_TREASURY_FACT');
  return {bytes,fact:data as unknown as Fact};
}

export async function railRequest(rail:Rail,path:string,body:Buffer) {
  const response=await fetch(new URL(path,trustedEndpoint(rail.url)),{
    method:'POST',headers:{authorization:'Bearer '+rail.token,'content-type':'application/json',connection:'close'},
    body:new Uint8Array(body),signal:AbortSignal.timeout(4500),redirect:'error',
  });
  if (!response.ok || !response.body) throw new Error('Rail request failed');
  return JSON.parse(Buffer.from(await readBounded(response.body,8192)).toString()) as unknown;
}
