import { DatabaseSync } from 'node:sqlite';
import type { KeyObject } from 'node:crypto';
import { exact, openArtifact, signArtifact } from './authority.ts';
import { fixtureRequest, fixtureServer } from './fixture-http.ts';
import {
  covers,
  deviceKey,
  fiscalPurpose,
  readEnrollment,
  readFiscalReceipt,
  readGenesis,
  readGrant,
  readHead,
  readIntent,
  sameEpoch,
} from './fiscal-protocol.ts';
import type { Epoch, FiscalHead, FiscalIntent } from './fiscal-protocol.ts';
import { digest, jsonBytes } from './protocol.ts';
import type { SignedEvidence, SigningKey } from './protocol.ts';
import { parseRetail } from './retail-protocol.ts';

export type FiscalResult = { proof: SignedEvidence; grant: SignedEvidence };
export interface FiscalSigner {
  epoch: Epoch;
  head(): Promise<FiscalHead>;
  sign(intent: FiscalIntent, sale: Buffer): Promise<FiscalResult | null>;
  abandon(intent: FiscalIntent): Promise<SignedEvidence>;
}

export function fiscalAdapter(config: {
  url: string;
  token: string;
  enrollment: SignedEvidence;
  roots: ReadonlyMap<string, KeyObject>;
  grant: () => SignedEvidence | null;
}): FiscalSigner {
  const { publicKey: _, ...epoch } = readEnrollment(config.enrollment, config.roots);
  const keys = new Map([[epoch.deviceId, deviceKey(readEnrollment(config.enrollment, config.roots))]]);
  return {
    epoch,
    async head() {
      const head = readHead(await fixtureRequest(config, '/head', {}), keys);
      if (!sameEpoch(head, epoch)) throw new Error('Fiscal head binding rejected');
      return head;
    },
    async sign(intent, sale) {
      const response = exact(
        await fixtureRequest(config, '/sign', {
          intent,
          sale: sale.toString('base64url'),
          grant: config.grant(),
        }),
        ['proof', 'grant', 'hold'],
      );
      if (response.hold) {
        const hold = openArtifact(fiscalPurpose.hold, response.hold, keys).data;
        if (hold.intentDigest !== digest(jsonBytes(intent)) || hold.code !== 'GRANT_REQUIRED')
          throw new Error('Fiscal hold rejected');
        return null;
      }
      const { receipt } = readFiscalReceipt(response.proof, keys);
      const { grantId, lower, upper, ...facts } = receipt;
      const grant = readGrant(response.grant, config.roots);
      if (
        !jsonBytes(facts).equals(jsonBytes(intent)) ||
        grantId !== grant.grantId ||
        !covers(grant, intent, lower, upper)
      ) {
        throw new Error('Fiscal result binding rejected');
      }
      return { proof: response.proof as SignedEvidence, grant: response.grant as SignedEvidence };
    },
    async abandon(intent) {
      const packet = await fixtureRequest(config, '/abandon', intent);
      const value = openArtifact(fiscalPurpose.abandonment, packet, keys).data;
      if (!jsonBytes(value).equals(jsonBytes(intent))) throw new Error('Fiscal abandonment binding rejected');
      return packet as SignedEvidence;
    },
  };
}

export function createDurableSigner(
  path: string,
  token: string,
  options: {
    enrollment: SignedEvidence;
    genesis: SignedEvidence;
    roots: ReadonlyMap<string, KeyObject>;
    signer: SigningKey;
    clock: () => { lower: string; upper: string } | null;
    after?: Parameters<typeof fixtureServer>[2];
  },
) {
  const { publicKey: _, ...epoch } = readEnrollment(options.enrollment, options.roots);
  const genesis = readGenesis(options.genesis, options.roots);
  if (!sameEpoch(genesis, epoch) || options.signer.id !== epoch.deviceId)
    throw new Error('Unenrolled fiscal device');
  const sample = signArtifact(fiscalPurpose.head, { ...epoch, sequence: 0, digest: null }, options.signer);
  readHead(sample, new Map([[epoch.deviceId, deviceKey(readEnrollment(options.enrollment, options.roots))]]));
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS device_head(epoch_id TEXT PRIMARY KEY, enrollment_digest TEXT NOT NULL,
      genesis_digest TEXT NOT NULL, sequence INTEGER NOT NULL,
      digest TEXT, lower TEXT, upper TEXT, retired INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE IF NOT EXISTS device_receipts(epoch_id TEXT, sale_id TEXT, receipt_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      intent BLOB NOT NULL, sale BLOB NOT NULL, grant_id TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(epoch_id,sale_id), UNIQUE(epoch_id,sequence), UNIQUE(epoch_id,receipt_id));
    CREATE TABLE IF NOT EXISTS device_grants(grant_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS device_abandoned(epoch_id TEXT,sale_id TEXT,intent BLOB NOT NULL,PRIMARY KEY(epoch_id,sale_id));
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    const enrollmentHash = digest(Buffer.from(options.enrollment.body, 'base64url'));
    const genesisHash = digest(Buffer.from(options.genesis.body, 'base64url'));
    const head = db
      .prepare('SELECT enrollment_digest,genesis_digest FROM device_head WHERE epoch_id=?')
      .get(epoch.epochId);
    if (head && (head.enrollment_digest !== enrollmentHash || head.genesis_digest !== genesisHash)) {
      throw new Error('Fiscal epoch authority changed');
    }
    if (!head) {
      const active = db.prepare('SELECT epoch_id FROM device_head WHERE retired=0').get();
      if (active && active.epoch_id !== genesis.previousEpochId)
        throw new Error('Replacement genesis required');
      if (active) db.prepare('UPDATE device_head SET retired=1 WHERE epoch_id=?').run(active.epoch_id!);
      db.prepare(
        'INSERT INTO device_head(epoch_id,enrollment_digest,genesis_digest,sequence) VALUES(?,?,?,0)',
      ).run(epoch.epochId, enrollmentHash, genesisHash);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  const server = fixtureServer(
    token,
    (route, input) => {
      const head = () => db.prepare('SELECT * FROM device_head WHERE epoch_id=?').get(epoch.epochId)!;
      if (route === '/head') {
        exact(input, []);
        const h = head();
        if (h.retired) throw new Error('Retired fiscal epoch');
        return signArtifact(
          fiscalPurpose.head,
          { ...epoch, sequence: h.sequence, digest: h.digest },
          options.signer,
        );
      }
      if (route === '/abandon') {
        const intent = readIntent(input);
        if (!sameEpoch(intent, epoch)) throw new Error('Fiscal scope rejected');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (
            db
              .prepare('SELECT 1 FROM device_receipts WHERE epoch_id=? AND sale_id=?')
              .get(epoch.epochId, intent.saleId)
          ) {
            throw new Error('Signed receipt must be recovered');
          }
          const prior = db
            .prepare('SELECT intent FROM device_abandoned WHERE epoch_id=? AND sale_id=?')
            .get(epoch.epochId, intent.saleId);
          if (prior && !Buffer.from(prior.intent as Uint8Array).equals(jsonBytes(intent)))
            throw new Error('Fiscal intent conflict');
          db.prepare('INSERT OR IGNORE INTO device_abandoned VALUES(?,?,?)').run(
            epoch.epochId,
            intent.saleId,
            jsonBytes(intent),
          );
          db.exec('COMMIT');
          return signArtifact(fiscalPurpose.abandonment, intent, options.signer);
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
      }
      if (route !== '/sign') throw new Error('Unsupported fiscal operation');
      const data = exact(input, ['intent', 'sale', 'grant']);
      const intent = readIntent(data.intent);
      if (!sameEpoch(intent, epoch) || typeof data.sale !== 'string' || data.sale.length > 90_000)
        throw new Error('Fiscal scope rejected');
      const saleBytes = Buffer.from(data.sale, 'base64url');
      const sale = parseRetail(saleBytes);
      if (
        sale.kind !== 'SALE' ||
        sale.saleId !== intent.saleId ||
        sale.receiptId !== intent.receiptId ||
        sale.tenantId !== epoch.tenantId ||
        sale.storeId !== epoch.storeId ||
        sale.terminalId !== epoch.terminalId ||
        sale.generation !== epoch.generation ||
        sale.cashierId !== epoch.cashierId ||
        digest(saleBytes) !== intent.saleDigest
      ) {
        throw new Error('Fiscal receipt facts rejected');
      }
      const canonical = jsonBytes(intent);
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db
          .prepare('SELECT intent,result FROM device_receipts WHERE epoch_id=? AND sale_id=?')
          .get(epoch.epochId, intent.saleId);
        if (prior) {
          if (!Buffer.from(prior.intent as Uint8Array).equals(canonical))
            throw new Error('Fiscal intent conflict');
          db.exec('COMMIT');
          return JSON.parse(String(prior.result));
        }
        const h = head();
        if (
          db
            .prepare('SELECT 1 FROM device_abandoned WHERE epoch_id=? AND sale_id=?')
            .get(epoch.epochId, intent.saleId)
        ) {
          throw new Error('Fiscal intent abandoned');
        }
        if (h.retired || intent.sequence !== Number(h.sequence) + 1 || intent.predecessor !== h.digest)
          throw new Error('Fiscal predecessor rejected');
        const time = options.clock();
        const grant = data.grant ? readGrant(data.grant, options.roots) : null;
        if (
          !grant ||
          !time ||
          !covers(grant, intent, time.lower, time.upper) ||
          (h.lower && time.lower < String(h.lower)) ||
          (h.upper && time.upper < String(h.upper))
        ) {
          db.exec('COMMIT');
          return {
            proof: null,
            grant: null,
            hold: signArtifact(
              fiscalPurpose.hold,
              { intentDigest: digest(canonical), code: 'GRANT_REQUIRED' },
              options.signer,
            ),
          };
        }
        const grantBody = (data.grant as SignedEvidence).body;
        const priorGrant = db.prepare('SELECT body FROM device_grants WHERE grant_id=?').get(grant.grantId);
        if (priorGrant && priorGrant.body !== grantBody) throw new Error('Fiscal grant identity conflict');
        db.prepare('INSERT OR IGNORE INTO device_grants VALUES(?,?)').run(grant.grantId, grantBody);
        const proof = signArtifact(
          fiscalPurpose.receipt,
          { ...intent, grantId: grant.grantId, ...time },
          options.signer,
        );
        const result = { proof, grant: data.grant, hold: null };
        db.prepare('INSERT INTO device_receipts VALUES(?,?,?,?,?,?,?,?)').run(
          epoch.epochId,
          intent.saleId,
          intent.receiptId,
          intent.sequence,
          canonical,
          saleBytes,
          grant.grantId,
          JSON.stringify(result),
        );
        db.prepare(
          'UPDATE device_head SET sequence=?,digest=?,lower=?,upper=? WHERE epoch_id=? AND sequence=?',
        ).run(
          intent.sequence,
          digest(Buffer.from(proof.body, 'base64url')),
          time.lower,
          time.upper,
          epoch.epochId,
          h.sequence!,
        );
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    options.after,
    131_072,
  );
  return { server, close: () => db.close() };
}
