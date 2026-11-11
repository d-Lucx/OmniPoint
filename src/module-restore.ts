import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { Pool, PoolClient } from 'pg';
import { identifier } from './postgres.ts';
import { digest, isDigest, isUuid, jsonBytes } from './protocol.ts';

type Table = { name: string; depends: string[] };
type Image = { name: string; rows: string };
type Segment = { number: number; parent: string | null; kind: 'image' | 'note';
  images?: Image[]; sqlite?: string; sqliteHash?: string; displayCut?: number; note?: unknown };
type Manifest = { id: string; segments: string[] };
type Restored = { checkpoint: string; replayCursor: number; displayCut: number; quarantined: number[] };

async function tables(db: PoolClient): Promise<Table[]> {
  const { rows } = await db.query<Table>(`
    SELECT c.relname AS name, ARRAY(
      SELECT target.relname::text FROM pg_constraint f JOIN pg_class target ON target.oid=f.confrelid
      WHERE f.contype='f' AND f.conrelid=c.oid AND f.confrelid<>c.oid ORDER BY target.relname
    ) AS depends FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='omni' AND c.relkind='r' AND c.relname<>'migrations' ORDER BY c.relname
  `);
  const ordered: Table[] = [];
  const added = new Set<string>();
  while (ordered.length < rows.length) {
    const next = rows.find(row => !added.has(row.name) && row.depends.every(name => added.has(name)));
    if (!next) throw new Error('Restore schema has a cross-table cycle or external dependency');
    ordered.push(next);
    added.add(next.name);
  }
  return ordered;
}

function tableName(name: string) {
  return 'omni.' + identifier(name);
}

function requireDisposable() {
  if (process.env.OMNI_TEST_DISPOSABLE !== '1') throw new Error('Restore requires disposable fixture opt-in');
}

function fixturePool(pool: Pool) {
  const url = new URL(pool.options.connectionString ?? '');
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
      !/^\/omni_m1_[a-f0-9]{16}$/.test(url.pathname)) throw new Error('Restore requires an isolated loopback fixture database');
}

function displayCursor(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite restore image failed integrity validation');
    return Number(db.prepare('SELECT coalesce(max(cursor),0) AS n FROM module_events').get()?.n);
  } finally { db.close(); }
}

function persist(dir: string, segment: Segment) {
  const bytes = jsonBytes(segment);
  const hash = digest(bytes);
  writeFileSync(join(dir, hash + '.json'), bytes, { flag: 'wx', flush: true });
  return hash;
}

// The caller pauses terminal and cloud mutations for the duration of each paired capture.
export async function captureModuleCut(dir: string, source: Pool, path: string, number: number, parent: string | null) {
  requireDisposable();
  fixturePool(source);
  if (!Number.isSafeInteger(number) || number < 0 || (number === 0 ? parent !== null : !isDigest(parent)))
    throw new Error('Invalid restore cut');
  const sqlite = 'terminal-' + number + '.sqlite';
  const target = join(dir,sqlite);
  if (existsSync(target)) throw new Error('Restore image already exists');
  const local = new DatabaseSync(path, { readOnly: true });
  try { await backup(local,target); }
  finally { local.close(); }
  const sqliteHash = digest(readFileSync(target));
  const db = await source.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const images: Image[] = [];
    for (const {name} of await tables(db)) {
      const { rows: [image] } = await db.query<{ rows: string }>(`
        SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]')::text AS rows FROM ${tableName(name)} r
      `);
      images.push({ name, rows:image.rows });
    }
    await db.query('COMMIT');
    return persist(dir,{ number, parent, kind:'image', images, sqlite, sqliteHash, displayCut:displayCursor(target) });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

export function appendRestoreNote(dir: string, number: number, parent: string, note: unknown) {
  requireDisposable();
  return persist(dir,{number,parent,kind:'note',note});
}

export function sealModuleCuts(dir: string, manifest: Manifest) {
  requireDisposable();
  if (!isUuid(manifest.id) || !manifest.segments.length || manifest.segments.some(hash => !isDigest(hash)))
    throw new Error('Invalid restore manifest');
  const bytes = jsonBytes(manifest);
  writeFileSync(join(dir,'manifest.json'),bytes,{flag:'wx',flush:true});
  return digest(bytes);
}

async function installImages(db: PoolClient, images: Image[], expected: Table[]) {
  const ledgerSources = ['journals','journal_lines','retail_postings','payment_postings','governed_adjustments'];
  if (expected.some(table => table.name === 'ledger_lines')) {
    for (const source of ledgerSources) await db.query('ALTER TABLE '+tableName(source)+' DISABLE TRIGGER ledger_record');
  }
  await db.query('TRUNCATE ' + expected.map(table => tableName(table.name)).join(','));
  for (const image of images) {
    const name = tableName(image.name);
    await db.query(`INSERT INTO ${name} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::${name},$1)`, [image.rows]);
    const {rows} = await db.query<{ column_name: string; identity_increment: string }>(`
      SELECT column_name,identity_increment FROM information_schema.columns
      WHERE table_schema='omni' AND table_name=$1 AND is_identity='YES'`, [image.name]);
    for (const {column_name: column, identity_increment: increment} of rows) {
      if (increment !== '1') throw new Error('Unsupported restore identity increment');
      await db.query(`SELECT setval(pg_get_serial_sequence($1,$2),coalesce(max(${identifier(column)}),1),
        max(${identifier(column)}) IS NOT NULL) FROM ${name}`, [name,column]);
    }
  }
  if (expected.some(table => table.name === 'ledger_lines')) {
    for (const source of ledgerSources) await db.query('ALTER TABLE '+tableName(source)+' ENABLE TRIGGER ledger_record');
  }
}

export async function restoreModuleCuts(dir: string, manifestHash: string, target: Pool, terminalPath: string): Promise<Restored> {
  requireDisposable();
  fixturePool(target);
  const bytes = readFileSync(join(dir,'manifest.json'));
  if (digest(bytes) !== manifestHash) throw new Error('Restore manifest digest mismatch');
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (!isUuid(manifest.id) || !manifest.segments.length || manifest.segments.length > 100 ||
      manifest.segments.some(hash => !isDigest(hash))) throw new Error('Invalid restore manifest');
  if (existsSync(terminalPath)) throw new Error('Restore terminal must be fresh');
  const seen = new Set<string>();
  const quarantined: number[] = [];
  const cuts: Segment[] = [];
  let parent: string | null = null;
  for (const hash of manifest.segments) {
    if (seen.has(hash)) continue;
    const file = join(dir,hash + '.json');
    if (!existsSync(file)) throw new Error('Missing restore segment');
    const body = readFileSync(file);
    if (digest(body) !== hash) throw new Error('Restore segment digest mismatch');
    const cut = JSON.parse(body.toString()) as Segment;
    if (cut.number !== seen.size || cut.parent !== parent) throw new Error('Restore cursor or cut mismatch');
    if (cut.kind === 'image') {
      if (cut.sqlite !== 'terminal-' + cut.number + '.sqlite' || !Array.isArray(cut.images))
        throw new Error('Invalid store image');
      const path = join(dir,cut.sqlite);
      if (digest(readFileSync(path)) !== cut.sqliteHash || displayCursor(path) !== cut.displayCut ||
          (cuts.at(-1)?.displayCut ?? 0) > cut.displayCut!) throw new Error('Restore image or display cursor mismatch');
      cuts.push(cut);
    } else if (cut.kind === 'note' && seen.size > 0 && !cut.images && !cut.sqlite) {
      if (typeof cut.note !== 'string' || !/^[a-z0-9 ._-]{1,80}$/i.test(cut.note)) quarantined.push(cut.number);
    } else throw new Error('Invalid restore record');
    parent = hash;
    seen.add(hash);
  }
  const last = cuts.at(-1);
  if (!last) throw new Error('Checkpoint is missing');
  const db = await target.connect();
  try {
    await db.query('BEGIN');
    const expected = await tables(db);
    await db.query('LOCK TABLE ' + expected.map(table => tableName(table.name)).join(',') + ' IN ACCESS EXCLUSIVE MODE');
    for (const {name} of expected) {
      const nonempty = await db.query('SELECT 1 FROM ' + tableName(name) + ' LIMIT 1');
      if (nonempty.rowCount) throw new Error('Restore database must be fresh');
    }
    for (const cut of cuts) {
      if (cut.images!.map(image => image.name).join() !== expected.map(table => table.name).join())
        throw new Error('Restore image schema mismatch');
      await installImages(db,cut.images!,expected);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
  copyFileSync(join(dir,last.sqlite!),terminalPath,constants.COPYFILE_EXCL);
  const result = { checkpoint:manifest.id, replayCursor:seen.size - 1, displayCut:last.displayCut!, quarantined };
  writeFileSync(terminalPath + '.restore.json',jsonBytes(result),{flag:'wx',flush:true});
  return result;
}
