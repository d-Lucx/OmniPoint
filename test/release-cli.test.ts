import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCloud } from '../src/cloud.ts';
import { local, seed, testDatabase, testResources } from './fixture.ts';

const execute=promisify(execFile);
const script=(name:string)=>fileURLToPath(new URL('../src/'+name,import.meta.url));

test('Release CLI: offline terminal checkout recovers and reprints the same committed receipt',async t=>{
  const f=await testResources(t);
  const path=join(f.dir,'cli.sqlite');
  const run=(...args:string[])=>execute(process.execPath,[script('terminal-cli.ts'),path,...args],{timeout:15_000});
  await run('init-demo');
  const request=randomUUID();
  const {stdout}=await run('checkout',request,'2000');
  const receipt=JSON.parse(stdout);
  assert.deepEqual(JSON.parse((await run('recover',request)).stdout),receipt);
  assert.equal((await run('reprint',request)).stdout.trim(),receipt.printable);
  assert.deepEqual(JSON.parse((await run('checkout',request,'2000')).stdout),receipt);
  assert.equal(local(path,db=>db.prepare('SELECT count(*) AS n FROM receipts').get()?.n),1);
  assert.equal(local(path,db=>db.prepare('SELECT on_hand FROM catalog').get()?.on_hand),2);
});

test('Release CLI: operator closes, verifies, approves, publishes and retrieves exact signed bytes', {timeout:35_000},async t=>{
  const db=await testDatabase();
  t.after(()=>db.close());
  const f=await testResources(t), enrollment=await seed(db);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const signer={id:'release-governance',key:privateKey};
  const actor=randomUUID(),token=randomBytes(32).toString('base64url');
  const server=createCloud(db.runtime,[enrollment],f.signer,undefined,{
    governanceSigner:signer,operators:[{tenantId:enrollment.tenantId,actorId:actor,token,governance:true}],
  });
  const url=await f.listen(server);
  const pem=join(f.dir,'public.pem');
  await writeFile(pem,publicKey.export({type:'spki',format:'pem'}));
  const env={...process.env,OMNI_INGEST_URL:url,OMNI_GOVERNANCE_TOKEN:token,
    OMNI_GOVERNANCE_PUBLIC_KEY_FILE:pem,OMNI_GOVERNANCE_KEY_ID:signer.id};
  const run=(...args:string[])=>execute(process.execPath,[script('governance-cli.ts'),...args],{env,timeout:15_000});
  const persist=async (name:string,value:unknown)=>{
    const file=join(f.dir,name+'.json'); await writeFile(file,JSON.stringify(value)); return file;
  };
  const send=async (name:string,value:unknown)=>{
    const response=await run('send',await persist(name,value));
    return JSON.parse(response.stdout);
  };
  const seal=randomUUID();
  const bundle=await send('close',{action:'period-close',period:'2026-03',id:seal,previous:null,approval:randomUUID()});
  const bundlePath=await persist('bundle',bundle);
  const verified=await run('verify-seal',bundlePath,enrollment.tenantId,'2026-03','none');
  assert.equal(JSON.parse(verified.stdout).id,seal);
  await assert.rejects(run('verify-seal',bundlePath,randomUUID(),'2026-03','none'));
  const planId=randomUUID();
  const plan=await send('approve',{action:'report-approve',id:planId,lineage:randomUUID(),predecessor:null,seal,
    april:'2026-04',approval:randomUUID(),slices:[],replacement:null});
  const checked=await run('verify-plan',await persist('plan',plan),enrollment.tenantId,planId,seal);
  assert.equal(JSON.parse(checked.stdout).bridge.TreasuryClearing.closing,0);
  const exportId=randomUUID();
  const export1=await send('publish',{action:'report-publish',plan:planId,id:exportId});
  const bytes=await run('verify-export',await persist('export',export1),enrollment.tenantId,planId,seal);
  assert.deepEqual(Buffer.from(bytes.stdout),Buffer.from(export1.bytes,'base64url'));
  const again=await send('retrieve',{action:'report-get',plan:planId});
  assert.deepEqual(again.export,export1);
});
