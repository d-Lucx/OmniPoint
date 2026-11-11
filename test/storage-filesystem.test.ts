import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseCard } from '../src/card-event.ts';
import { RetailRegister } from '../src/retail-local.ts';
import { SimulatedDevices } from '../src/retail-devices.ts';
import { Terminal } from '../src/terminal.ts';
import { local, testDatabase } from './fixture.ts';
import { paymentFixture } from './payment-fixture.ts';
import { pin } from './retail-fixture.ts';

test('Release storage: tmpfs exhaustion rolls back POS writes and recovers the original captured and signed receipt',
  {timeout:45_000}, async t => {
    const root=process.env.OMNI_STORAGE_FAULT_ROOT;
    if (!root) {
      t.skip('Set OMNI_STORAGE_FAULT_ROOT to a disposable Linux tmpfs mount of at most 64 MiB');
      return;
    }
    if (process.platform!=='linux' || process.env.OMNI_TEST_DISPOSABLE!=='1' || !isAbsolute(root))
      throw new Error('Filesystem exhaustion requires explicit disposable Linux setup');
    const fs=statfsSync(root);
    const capacity=fs.blocks*fs.bsize;
    if (fs.type!==0x01021994 || capacity<8*1024*1024 || capacity>64*1024*1024)
      throw new Error('Refusing to fill anything except a dedicated 8–64 MiB tmpfs');
    const scratch=mkdtempSync(join(root,'omnipoint-full-'));
    t.after(()=>rmSync(scratch,{recursive:true,force:true}));
    const database=await testDatabase();
    t.after(()=>database.close());
    const f=await paymentFixture(t,database);
    let lost=true;
    f.signerAfter((path,result,response)=>{
      if (lost && path==='/sign' && (result as {proof?:unknown}).proof) {
        lost=false;
        response.destroy();
      }
    });
    const a=f.terminal();
    const id=randomUUID();
    assert.equal((await a.register.payment!.start(id)).state,'SIGNING');
    assert.equal(f.evidence('CAPTURED').length,1);
    const signerRecord=local(f.signerPath,db=>String(db.prepare('SELECT result FROM device_receipts').get()?.result));
    const path=join(scratch,'terminal.sqlite');
    const source=new DatabaseSync(a.target.path,{readOnly:true});
    try {await backup(source,path);} finally {source.close();}
    a.connection.close();
    const db=new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA wal_checkpoint(TRUNCATE)');
    const register=new RetailRegister(db,a.target.scope,{
      devices:new SimulatedDevices(),payment:f.paymentOptions(),deviceTimeoutMs:20,
      cloud:{url:f.url,token:f.a.token,keys:f.keys},
      supervisor:{actorId:f.actorId,pin,signer:{id:'fixture-supervisor',key:f.supervisor.privateKey}},
    });
    const original=db.prepare('SELECT event_id,event_bytes,digest FROM retail_events ORDER BY rowid').all();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const fill=join(scratch,'allocated-space.bin');
    const fd=openSync(fill,'wx');
    let full=false, written=0;
    try {
      const block=Buffer.alloc(1024*1024,0x5a);
      while (written<=64*1024*1024) written+=writeSync(fd,block);
    } catch(error) {
      full=!!error && typeof error==='object' && 'code' in error && error.code==='ENOSPC';
      if (!full) throw error;
    } finally {closeSync(fd);}
    try {
      assert.equal(full,true);
      assert.equal(statfsSync(root).bavail,0);
      await assert.rejects(register.payment!.recover(id),(error:unknown)=>
        !!error && typeof error==='object' && 'errcode' in error && error.errcode===13);
      assert.equal(db.isTransaction,false);
      assert.equal(db.prepare('SELECT count(*) AS n FROM retail_receipts').get()?.n,0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM retail_spends').get()?.n,0);
      assert.equal(db.prepare('SELECT state FROM payment_intents WHERE intent_id=?').get(id)?.state,'SIGNING');
      assert.deepEqual(db.prepare('SELECT event_id,event_bytes,digest FROM retail_events ORDER BY rowid').all(),original);
    } finally {
      unlinkSync(fill);
      db.close();
    }
    const terminal=new Terminal(path);
    try {
      const recovered=terminal.retail({
        devices:new SimulatedDevices(),payment:f.paymentOptions(),deviceTimeoutMs:20,
        cloud:{url:f.url,token:f.a.token,keys:f.keys},
        supervisor:{actorId:f.actorId,pin,signer:{id:'fixture-supervisor',key:f.supervisor.privateKey}},
      });
      assert.equal((await recovered.payment!.recover(id)).state,'FINALIZED');
      const event=local(path,db=>db.prepare('SELECT event_bytes,digest FROM retail_events WHERE event_id=?').get(id))!;
      const bytes=Buffer.from(event.event_bytes as Uint8Array);
      assert.deepEqual(parseCard(bytes).envelope.proof,JSON.parse(signerRecord).proof);
      assert.equal(f.evidence('CAPTURED').length,1);
      assert.equal(local(f.signerPath,db=>db.prepare('SELECT count(*) AS n FROM device_receipts').get()?.n),1);
      assert.equal(await recovered.syncOnce(),'SYNCED');
      assert.equal(await recovered.syncOnce(),'SYNCED');
      assert.equal(local(path,db=>db.prepare('SELECT state FROM retail_events WHERE event_id=?').get(id)?.state),'SYNCED');
      assert.deepEqual(Buffer.from(local(path,db=>db.prepare('SELECT event_bytes FROM retail_events WHERE event_id=?')
        .get(id)?.event_bytes as Uint8Array)),bytes);
    } finally {terminal.close();}
    t.diagnostic('tmpfs capacity='+capacity+' allocated='+written+
      '; ENOSPC then SQLITE_FULL (13); transaction=false; one provider capture, one signed receipt, durable SYNCED');
  });
