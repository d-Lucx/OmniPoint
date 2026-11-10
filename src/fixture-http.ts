import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { decode, digest, jsonBytes, readBounded, trustedEndpoint } from './protocol.ts';

export function fixtureServer(
  token: string,
  run: (path: string, input: Record<string, unknown>) => Promise<unknown> | unknown,
  after?: (path: string, result: unknown, response: import('node:http').ServerResponse) => Promise<void> | void,
  limit = 8192,
) {
  const expected = Buffer.from(digest(Buffer.from('Bearer ' + token)), 'hex');
  return createServer(async (req, res) => {
    if (
      req.method !== 'POST' ||
      req.headers['content-type'] !== 'application/json' ||
      req.headers['content-encoding'] ||
      !timingSafeEqual(expected, Buffer.from(digest(Buffer.from(req.headers.authorization ?? '')), 'hex'))
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      const result = await run(
        req.url ?? '',
        decode(await readBounded(req.iterator({ destroyOnReturn: false }), limit)),
      );
      await after?.(req.url ?? '', result, res);
      if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(jsonBytes(result));
    } catch {
      if (!res.destroyed) res.writeHead(422).end();
    }
  });
}

export async function fixtureRequest(
  endpoint: { url: string; token: string },
  path: string,
  body: unknown,
): Promise<unknown> {
  const url = trustedEndpoint(new URL(path, endpoint.url).href);
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(3500),
    headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || res.headers.has('content-encoding') || !res.body) throw new Error('External operation held');
  return JSON.parse((await readBounded(res.body, 8192)).toString('utf8'));
}
