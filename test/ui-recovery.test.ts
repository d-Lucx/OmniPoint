import assert from 'node:assert/strict';
import { test } from 'node:test';

test('workflow retries retain original request after reload and never persist supervisor PIN', async () => {
  const { rememberRequest, readRequest } = await import('../src/ui/pending-request.ts');
  const values = new Map<string,string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); } };
  const original = rememberRequest(storage, 'workflow', { action: 'work-authorize', operationId: 'original', revision: 4, pin: 'private-pin' });
  assert.equal(original.pin, 'private-pin');
  assert.equal(values.get('workflow')?.includes('private-pin'), false);
  assert.deepEqual(readRequest(storage, 'workflow'), { action: 'work-authorize', operationId: 'original', revision: 4 });
  const retry = rememberRequest(storage, 'workflow', { action: 'work-authorize', operationId: 'replacement', revision: 5, pin: 'new-pin' });
  assert.deepEqual(retry, { action: 'work-authorize', operationId: 'original', revision: 4, pin: 'new-pin' });
});
