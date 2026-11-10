# OmniPoint Milestone 1

OmniPoint completes a single-terminal cash sale offline and synchronizes it after a crash and a lost cloud response. The fixture sells one tax-free item for USD 20.00 with exact cash. Both stock projections start at three units.

## Run the integration suite

Use Node **24.22.1**, npm, and a disposable PostgreSQL **17.11** instance. Node supplies the SQLite driver and test runner. From the checkout, run `npm ci --ignore-scripts` and `npm run check`. In Windows PowerShell use `npm.cmd` if script execution policy blocks `npm.ps1`.

For a disposable PostgreSQL service with Docker, run this one-line command.

```sh
docker run --rm -d --name omnipoint-m1-pg -p 127.0.0.1:55432:5432 -e POSTGRES_USER=omnipoint_test_admin -e POSTGRES_PASSWORD=local-test-admin-only -e POSTGRES_DB=omnipoint_test postgres:17.11-bookworm
docker exec omnipoint-m1-pg pg_isready -U omnipoint_test_admin -d omnipoint_test
```

A native Windows PostgreSQL instance works as well. Initialize a separate cluster with password authentication, bind it to loopback, and create the empty `omnipoint_test` database. Use a dedicated local admin login that can create database and login roles, seed forced-RLS fixtures, install the test trigger, and inspect lock waits. Set the URL below to that cluster. Use a local disk for the terminal database.

PowerShell invocation, verified with native PostgreSQL 17.11:

```powershell
$env:OMNI_TEST_DISPOSABLE = '1'
$env:OMNI_TEST_ADMIN_URL = 'postgresql://omnipoint_test_admin:local-test-admin-only@127.0.0.1:55432/omnipoint_test'
npm.cmd test
```

Bash invocation:

```sh
export OMNI_TEST_DISPOSABLE=1
export OMNI_TEST_ADMIN_URL=postgresql://omnipoint_test_admin:local-test-admin-only@127.0.0.1:55432/omnipoint_test
npm test
```

The harness requires explicit disposable opt-in and a loopback URL with an explicit port and the exact database name `omnipoint_test`. It creates its own randomly named database and separate migration and runtime logins. It drops only those generated resources and removes its temporary SQLite directories. Each scenario gets fresh tenant records, terminal credentials, and Ed25519 keys. When finished with the Docker service, run `docker stop omnipoint-m1-pg`.

Run just the combined crash and dropped-response scenario with `node --test --test-name-pattern=M1-01 test/milestone.test.ts` in the same environment. The full suite also covers pre-commit process death, real PostgreSQL COMMIT failure, a concurrent claim and voucher race, forged and malformed ACKs, pooled tenant isolation, reprint, interrupted voucher issuance, and dead-worker lease recovery.

## Try the terminal offline

```text
npm run terminal -- m1.sqlite init-demo
npm run terminal -- m1.sqlite checkout 51a54763-de87-4f31-80d9-70b7f6d508a4 2000
npm run terminal -- m1.sqlite recover 51a54763-de87-4f31-80d9-70b7f6d508a4
npm run terminal -- m1.sqlite reprint 51a54763-de87-4f31-80d9-70b7f6d508a4
```

Keep the request UUID before calling checkout. Reuse it to recover the original receipt or retry the same checkout, and generate a new UUID for a different sale. The virtual printer records dispatch in memory and the CLI prints that content to the console. The receipt row is the durable logical issuance. Physical paper delivery requires device evidence and can be uncertain across interruption. An operator reprint sends the same receipt identity and content.

## Run the cloud CLI against a local demo database

Use a disposable service separate from other development data. The integration suite provisions its own isolated database automatically. For a manual demo, copy `.env.example` to `.env` and provision these example roles and database through an admin PostgreSQL session. For Docker, open the session with `docker exec -it omnipoint-m1-pg psql -U omnipoint_test_admin -d omnipoint_test`.

```sql
CREATE ROLE omnipoint_owner LOGIN PASSWORD 'local-demo-owner-only';
CREATE ROLE omnipoint_app LOGIN PASSWORD 'local-demo-app-only';
CREATE DATABASE omnipoint_demo OWNER omnipoint_owner;
```

Run `node --env-file=.env src/migrate.ts`. This applies the cloud migration as the schema owner and grants narrowly scoped permissions to the restricted app login. The SQLite migration runs when the terminal opens a new database. Re-running the PostgreSQL command preserves the schema and its records.

In the admin PostgreSQL session, connect to the demo database with `\c omnipoint_demo` and seed the demo enrollment. Run the seed once per fresh demo database.

```sql
BEGIN;
INSERT INTO omni.tenants VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO omni.stores VALUES ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');
INSERT INTO omni.terminals VALUES ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 1);
INSERT INTO omni.cashiers VALUES ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001');
INSERT INTO omni.stock VALUES ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'M1-ITEM', 3);
COMMIT;
```

Save this development enrollment as `enrollments.local.json`.

```json
[
  {
    "token": "local-development-terminal-token",
    "tenantId": "10000000-0000-4000-8000-000000000001",
    "storeId": "20000000-0000-4000-8000-000000000001",
    "terminalId": "30000000-0000-4000-8000-000000000001",
    "generation": 1,
    "cashierId": "40000000-0000-4000-8000-000000000001"
  }
]
```

Generate local signing keys, start the cloud CLI, and run a sync attempt in a separate shell.

```text
node -e "const {privateKey,publicKey}=require('node:crypto').generateKeyPairSync('ed25519'); const fs=require('node:fs'); fs.writeFileSync('cloud-private.pem',privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600}); fs.writeFileSync('cloud-public.pem',publicKey.export({type:'spki',format:'pem'}),{flag:'wx'})"
node --env-file=.env src/cloud-cli.ts
node --env-file=.env src/terminal-cli.ts m1.sqlite sync
```

A verified commit prints `SYNCED`. The next attempt prints `IDLE` when no actionable event remains. Keep the public key trusted by the terminal for as long as the cloud can replay vouchers signed with it.

## Storage and acknowledgment profile

- The terminal verifies SQLite WAL, `synchronous=FULL`, and foreign keys on the writer connection. One transaction persists the sequence, finalized sale, line, original receipt, stock decrement and movement, and exact UTF-8 event BLOB with its SHA-256 digest. The checkout returns after commit. A lease and monotonically increasing attempt fence protect outbox retirement when a worker dies or runs late.
- The HTTP endpoint is `POST /v1/sales` with a bearer credential and an `application/json` body. The cloud hashes raw request bytes before parsing. It checks the event against the authenticated enrollment and sets the tenant context for each PostgreSQL transaction. The runtime login has forced RLS and tenant-scoped foreign keys. The migration owner and fixture admin are separate from the runtime login.
- PostgreSQL claims the sale with a targeted unique key and uses a separate unique terminal sequence key. A fresh statement at `READ COMMITTED` can see a concurrent winner. One transaction commits the original receipt, stock effects, Cash debit and Revenue credit, and stable outcome. A subsequent transaction persists the voucher. A replay completes missing issuance or returns the persisted winner. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- The custom v1 voucher signs the ASCII prefix `OmniPoint-Ack-v1\n<decimal HTTP status>\n` followed by the exact response body bytes with Ed25519. `Omni-Algorithm` must be `ed25519`, `Omni-Key-Id` selects a locally trusted public key, and `Omni-Signature` contains the unpadded base64url signature. The body binds disposition, ACK ID, tenant, terminal, generation, sequence, sale and request SHA-256. Only a verified `200 COMMITTED` retires the event as `SYNCED`. Verified `409` identity conflicts enter `CONFLICT_HELD`. Other responses or lost connections leave the event retryable.
- The Linux GitHub Actions workflow pins the Node version and a real PostgreSQL service and runs the same forced-process-exit suite. Local verification used Windows, Node 24.22.1, SQLite 3.53.4 and PostgreSQL 17.11. The tests cover process recovery. Host power-loss validation requires a separate storage test. [SQLite WAL](https://www.sqlite.org/wal.html) · [SQLite synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous) · [Node child processes](https://nodejs.org/download/release/v24.22.1/docs/api/child_process.html)
