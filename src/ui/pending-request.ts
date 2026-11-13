type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function readRequest(storage: Pick<Storage, 'getItem'>, key: string): Record<string, unknown> | undefined {
  const saved = storage.getItem(key);
  if (!saved) return;
  try { const data = JSON.parse(saved); return data && typeof data === 'object' && !Array.isArray(data) ? data : undefined; }
  catch { return; }
}

export function rememberRequest(storage: Store, key: string, request: Record<string, unknown>): Record<string, unknown> {
  const { pin, ...facts } = request;
  const original = readRequest(storage, key) ?? facts;
  storage.setItem(key, JSON.stringify(original));
  return { ...original, ...(pin === undefined ? {} : { pin }) };
}
