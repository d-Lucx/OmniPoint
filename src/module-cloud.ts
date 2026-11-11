import type { Pool, PoolClient } from 'pg';
import { exact } from './authority.ts';
import { digest, isUuid, jsonBytes } from './protocol.ts';
import type { Scope } from './protocol.ts';
import { tenantTransaction } from './postgres.ts';

export class ModuleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Capabilities = { version: number; retail: boolean; hospitality: boolean; services: boolean };
type Lane = 'background' | 'booking' | 'settlement';

export class FleetAdmission {
  private readonly connections: number;
  private readonly active = new Map<string, number>();
  private readonly totals = { background: 0, booking: 0, settlement: 0 };
  private readonly rejected = new Map<string,number>();

  constructor(connections: number) {
    if (!Number.isInteger(connections) || connections < 5) throw new Error('Fleet requires five database slots');
    this.connections = connections;
  }

  async run<T>(tenant: string, lane: Lane, work: () => Promise<T>): Promise<T> {
    const key = tenant + ':' + lane;
    const limit = lane === 'background' ? this.connections - 4 : 2;
    const current = this.active.get(key) ?? 0;
    if (current >= (lane === 'booking' ? 2 : 1) || this.totals[lane] >= limit) {
      this.rejected.set(key,(this.rejected.get(key) ?? 0)+1);
      throw new ModuleError(429, 'FLEET_RETRY');
    }
    this.active.set(key, current + 1);
    this.totals[lane]++;
    try { return await work(); }
    finally {
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining) this.active.set(key, remaining);
      else this.active.delete(key);
      this.totals[lane]--;
    }
  }

  inspect(tenant: string) {
    return {
      active: {
        background: this.active.get(tenant + ':background') ?? 0,
        booking: this.active.get(tenant + ':booking') ?? 0,
        settlement: this.active.get(tenant + ':settlement') ?? 0,
      },
      rejected: (['background','booking','settlement'] as const)
        .reduce((sum,lane) => sum + (this.rejected.get(tenant + ':' + lane) ?? 0),0),
      queueLimit: 0,
    };
  }
}

export async function moduleAction(pool: Pool, scope: Scope, input: Record<string, unknown>,
  observe?: (db: PoolClient, scope: Scope, action: unknown) => Promise<void>) {
  if (input.action !== 'profile' && input.action !== 'book') throw new ModuleError(400, 'UNKNOWN_MODULE_ACTION');
  if (input.action === 'profile') exact(input, ['action']);
  else exact(input, ['action', 'id', 'version', 'staff', 'resource', 'start', 'minutes', 'timezone']);
  return tenantTransaction(pool, scope.tenantId, async db => {
    await observe?.(db,scope,input.action);
    if (input.action === 'book') {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 5001))', [scope.tenantId + ':' + scope.storeId]);
    }
    const profile = (await db.query<Capabilities>(
      'SELECT version,retail,hospitality,services FROM omni.capability_profiles ORDER BY version DESC LIMIT 1',
    )).rows[0];
    if (input.action === 'profile') {
      return { purpose: 'MODULE_PROFILE', scope, profile: profile ?? { version: 0, retail: true, hospitality: false, services: false } };
    }
    const { id, version, staff, resource, start, minutes, timezone } = input;
    if (!isUuid(id) || (staff !== 'alex' && staff !== 'sam') || resource !== 'bay' ||
        typeof start !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/.test(start) ||
        typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 15 || minutes > 120 ||
        timezone !== 'UTC' || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new ModuleError(422, 'INVALID_APPOINTMENT');
    }
    const date = new Date(start);
    const end = new Date(date.valueOf() + minutes * 60_000);
    if (!Number.isFinite(date.valueOf()) || date.toISOString() !== start || date.getUTCHours() < 8 ||
        end.toISOString().slice(0, 10) !== start.slice(0, 10) ||
        end.getUTCHours() * 60 + end.getUTCMinutes() > 18 * 60) {
      throw new ModuleError(422, 'OUTSIDE_AVAILABILITY');
    }
    const hash = digest(jsonBytes([scope.storeId, scope.terminalId, scope.generation, scope.cashierId,
      id, version, staff, resource, start, minutes, timezone]));
    const prior = (await db.query<{ request_digest: string }>(
      'SELECT request_digest FROM omni.service_appointments WHERE tenant_id=$1 AND booking_id=$2', [scope.tenantId, id],
    )).rows[0];
    if (prior && prior.request_digest !== hash) throw new ModuleError(409, 'BOOKING_ID_CONFLICT');
    if (!prior) {
      if (!profile?.services || profile.version !== version) throw new ModuleError(403, 'PROFILE_STALE_OR_DISABLED');
      const overlap = await db.query(
        `SELECT 1 FROM omni.service_appointments
          WHERE tenant_id=$1 AND store_id=$2 AND (staff=$3 OR resource=$4)
            AND starts_at<$5 AND ends_at>$6 LIMIT 1`,
        [scope.tenantId, scope.storeId, staff, resource, end, date],
      );
      if (overlap.rowCount) throw new ModuleError(409, 'APPOINTMENT_CONFLICT');
      await db.query(`INSERT INTO omni.service_appointments
        (tenant_id,booking_id,store_id,terminal_id,generation,cashier_id,profile_version,request_digest,
          staff,resource,starts_at,ends_at,timezone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [scope.tenantId, id, scope.storeId, scope.terminalId, scope.generation, scope.cashierId,
        version, hash, staff, resource, date, end, timezone]);
    }
    return { purpose: 'SERVICE_BOOKING', scope, id, version, staff, resource, start, minutes, timezone,
      end: end.toISOString(), status: 'CONFIRMED' };
  });
}
