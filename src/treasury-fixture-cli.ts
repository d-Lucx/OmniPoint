import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { treasuryFixture } from './treasury-fixture.ts';

const [source,path,port] = process.argv.slice(2);
const {OMNI_TREASURY_FIXTURE_TOKEN,OMNI_TREASURY_FIXTURE_KEY_FILE,OMNI_TREASURY_FIXTURE_KEY_ID}=process.env;
if ((source!=='agency' && source!=='bank') || !path || !port || !OMNI_TREASURY_FIXTURE_TOKEN ||
    !OMNI_TREASURY_FIXTURE_KEY_FILE || !OMNI_TREASURY_FIXTURE_KEY_ID)
  throw new Error('Use treasury:fixture agency|bank DB_PATH PORT with the fixture token and signing key');
const fixture=treasuryFixture(path,source,OMNI_TREASURY_FIXTURE_TOKEN,{
  id:OMNI_TREASURY_FIXTURE_KEY_ID,key:createPrivateKey(readFileSync(OMNI_TREASURY_FIXTURE_KEY_FILE)),
});
fixture.server.listen(Number(port),'127.0.0.1',()=>console.log('Synthetic '+source+' listening on loopback'));
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>fixture.server.close(()=>fixture.close()));
