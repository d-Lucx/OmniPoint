import { readFileSync } from 'node:fs';
import { maxEventBytes, maxAckBytes, readBounded, trustedEndpoint } from './protocol.ts';

const [file] = process.argv.slice(2);
const { OMNI_INGEST_URL, OMNI_OPERATOR_TOKEN } = process.env;
if (!file || !OMNI_INGEST_URL || !OMNI_OPERATOR_TOKEN) {
  throw new Error('Usage: set OMNI_INGEST_URL and OMNI_OPERATOR_TOKEN, then run inventory <action.json>');
}
const body = readFileSync(file);
if (body.length > maxEventBytes) throw new Error('Inventory action is too large');
const url = trustedEndpoint(new URL('/v2/inventory', OMNI_INGEST_URL).href);
const response = await fetch(url, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
  headers: { authorization: `Bearer ${OMNI_OPERATOR_TOKEN}`, 'content-type': 'application/json' }, body,
});
if (!response.ok) {
  console.error(`Inventory action failed with HTTP ${response.status}`);
  process.exitCode = 1;
} else if (response.body) {
  console.log((await readBounded(response.body, maxAckBytes)).toString('utf8'));
}
