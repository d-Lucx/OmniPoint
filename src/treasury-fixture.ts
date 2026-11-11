import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { exact, signArtifact } from './authority.ts';
import { stableId } from './module-sale.ts';
import { decode,digest,jsonBytes,readBounded } from './protocol.ts';
import type { SigningKey } from './protocol.ts';
import { cents,purpose,uuid } from './treasury-protocol.ts';
import type { Source } from './treasury-protocol.ts';

export function treasuryFixture(path:string,source:Source,token:string,signer:SigningKey,options?:{
  reject?:(request:Record<string,unknown>)=>boolean;
  afterCommit?:(attempt:string,response:ServerResponse)=>void|Promise<void>;
}) {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token) || !path || path===':memory:')
    throw new Error('Fixture token and durable database path required');
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS attempts(tenant TEXT,account TEXT,attempt TEXT,digest TEXT NOT NULL,
      body BLOB NOT NULL,packet TEXT NOT NULL,PRIMARY KEY(tenant,account,attempt)) STRICT;
    CREATE TABLE IF NOT EXISTS facts(tenant TEXT,account TEXT,id TEXT,digest TEXT NOT NULL,
      body BLOB NOT NULL,packet TEXT NOT NULL,PRIMARY KEY(tenant,account,id)) STRICT;`);
  const credential=Buffer.from(digest(Buffer.from(token)),'hex');
  const server=createServer(async (request,response)=>{
    const auth=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{24,128})$/)?.[1];
    if (!auth || !timingSafeEqual(credential,Buffer.from(digest(Buffer.from(auth)),'hex'))) {
      response.writeHead(401).end(); return;
    }
    if (request.method!=='POST' || request.headers['content-type']!=='application/json') {
      response.writeHead(415).end(); return;
    }
    try {
      const bytes=await readBounded(request,8192);
      const input=decode(bytes);
      const tenant=uuid(input.tenant), account=uuid(input.account);
      if (request.url==='/fact') {
        exact(input,['tenant','account','source','id','lineage','cut','kind','at','currency','data']);
        const id=uuid(input.id);
        if (input.source!==source || input.currency!=='USD') throw new Error('Fixture evidence scope');
        const prior=db.prepare('SELECT digest,packet FROM facts WHERE tenant=? AND account=? AND id=?').get(tenant,account,id);
        const hash=digest(bytes);
        if (prior && prior.digest!==hash) { response.writeHead(409).end(); return; }
        const packet=prior ? String(prior.packet) : JSON.stringify(signArtifact(purpose(source),input,signer));
        if (!prior) db.prepare('INSERT INTO facts VALUES(?,?,?,?,?,?)').run(tenant,account,id,hash,bytes,packet);
        response.writeHead(200,{'content-type':'application/json'}).end(packet);
        return;
      }
      if (request.url!=='/execute' && request.url!=='/status') { response.writeHead(404).end(); return; }
      exact(input,['tenant','account','taxpayer','currency','operation','attempt','predecessor','kind','subject','minor','terms']);
      const attempt=uuid(input.attempt), operation=uuid(input.operation);
      uuid(input.subject); cents(input.minor,0);
      if (input.currency!=='USD' || input.kind!==(source==='bank'?'FUNDING':'FILING')) throw new Error('Wrong rail');
      const hash=digest(bytes);
      const stored=db.prepare('SELECT digest,packet FROM attempts WHERE tenant=? AND account=? AND attempt=?')
        .get(tenant,account,attempt);
      if (stored) {
        if (stored.digest!==hash) { response.writeHead(409).end(); return; }
        response.writeHead(200,{'content-type':'application/json'}).end(String(stored.packet));
        return;
      }
      const status=request.url==='/status'?'UNKNOWN':options?.reject?.(input)?'REJECTED':'TRANSMITTED';
      const packet=jsonBytes(signArtifact(purpose(source),{tenant,account,source,kind:status,
        id:stableId(source,tenant,account,attempt,status),lineage:operation,cut:1,currency:'USD',
        at:status==='UNKNOWN'?'2000-01-01T00:00:00.000Z':new Date().toISOString(),
        data:{attempt,operation,requestDigest:hash}},signer));
      if (status!=='UNKNOWN') {
        db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?)').run(tenant,account,attempt,hash,bytes,packet.toString());
        await options?.afterCommit?.(attempt,response);
      }
      if (!response.destroyed) response.writeHead(200,{'content-type':'application/json'}).end(packet);
    } catch { if (!response.destroyed) response.writeHead(422).end(); }
  });
  return {server,close:()=>db.close()};
}
