# OmniPoint Milestones 1 through 7

OmniPoint completes a single-terminal cash sale offline and synchronizes it after a crash and a lost cloud response. Milestone 2 extends that path to two terminals with signed offline quotas and durable inventory arbitration. Milestone 3 adds the retail register, blind shifts, receipt-linked cash returns and custody-aware recount.

## Staff and design guides

- [Working-tree UI refinement](docs/UI_REFINEMENT.md): focused composition improvements, reproduced UI defects, comparable populated screenshots and fresh verification.

- [User manual](docs/USER_MANUAL.md): daily tasks, recovery, supervisor procedures, and operator-led management and finance workflows.
- [UI delivery audit](docs/UI_UX_AUDIT.md), [validation and screenshots](docs/UI_UX_VALIDATION.md), and [operational design system](design-system/omnipoint/MASTER.md).
- [UI/UX overhaul prompt](docs/UI_UX_OVERHAUL_PROMPT.md): implementation handoff using UI/UX Pro Max and taste-skill, with preserved recovery and accounting contracts.

## Run the integration suite

Use Node **24.22.1**, npm, and a disposable PostgreSQL **17.11** instance. Node supplies the SQLite driver and test runner. From the checkout, run `npm ci --ignore-scripts`, `npm run check`, and `npx playwright install --with-deps chromium` for Linux browser dependencies. Windows fixtures use installed Edge. In Windows PowerShell use `npm.cmd` if script execution policy blocks `npm.ps1`.

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

## Milestone 2 quota arbitration

### Run the suites and demonstration

Use the same disposable PostgreSQL service and environment variables above. `npm test` runs both milestones. On Windows, the following commands use `npm.cmd`.

```powershell
npm.cmd run check
npm.cmd test
node --test test/milestone.test.ts
node --test --test-name-pattern=M2-01 test/quota.test.ts
npm.cmd run demo:m2
```

The demo runs the two-terminal partition and the operator fulfillment scenario through the real HTTP service, independent SQLite files, and a disposable PostgreSQL database. It closes the issuing server before checkout, uses a deliberately overlapping historical grant from the fixture admin, and prints the winner, backorder, and resolution identifiers. Fresh fixtures exercise A first, B first, and a live race. In each run, two $20 cash receipts survive, one unit leaves inventory, and a restart with a new server and database pool replays the same vouchers. The demo cleans up its service, database, and local files.

### Upgrade and cut over one stock position

The cloud runner applies `001-cloud.sql` and `002-cloud.sql` as needed. Run `node --env-file=.env src/migrate.ts` with the migration owner before starting the upgraded cloud service. Opening an existing SQLite file automatically applies `002-local.sql` under the writer transaction. Schema v2 is additive. It preserves M1 receipts, outbox bytes and digests, outcomes, and vouchers.

1. Stop legacy checkout at every terminal for the position and drain its outbox online. A local quota cutover refuses to proceed while any outbox item still needs attention.
2. Run only upgraded cloud binaries before enabling quota for the position. An authenticated operator opens it with `legacyDrained: true` after verifying the drain. The stock row lock makes this cutover atomic with respect to new legacy admissions and quota activity. A previously admitted v1 sale can still recover its exact voucher after cutover. A newly delivered v1 sale for that position receives HTTP 422 and stays actionable for investigation.
3. Configure the terminal with the exact SKU, position UUID, and location UUID. Import a signed grant for that terminal and generation before any offline checkout. Retain the trusted public keys needed to replay existing grants and vouchers.

### Use the operator and terminal commands

The optional entries in [the environment example](.env.example) enable the operator route. Set `OMNI_OPERATORS_FILE` on the cloud and `OMNI_OPERATOR_TOKEN` on the operator client. The operator file is an array of records with `tenantId` and `token`. Use a distinct token for each enrollment and keep operator tokens separate from terminal tokens. The terminal and cloud can also be configured with a separate custody authority public key.

Each operator request is a JSON object saved to a file and submitted with `node --env-file=.env src/inventory-cli.ts action.json`. The operator scope comes from its credential. The names below are JSON keys. Substitute the enrolled UUIDs and use stable IDs on retry.

| Action | Request fields | Result |
| --- | --- | --- |
| `open-position` | `storeId`, `sku`, `positionId`, `locationId`, `legacyDrained: true` | Enables quota for that stock position and records its opening on-hand. |
| `issue` | `positionId`, `grantId`, `terminalId`, `generation`, `quantity`, `expiresAt` | Returns a signed grant packet. Quantity is one to eight integer units. Use a UTC ISO timestamp with milliseconds within the next seven days. |
| `dispatch` | The `issue` fields plus `transferId`, `dispatchLegId`, `sourceLocationId` | Reserves slices in transit from the stock location to the enrolled receiving terminal. |
| `file-custody` | `receipt` containing a signed custody authority packet | Records the received subset and settles matching staged claims under the stock lock. |
| `inspect-shortfall` | `saleId` | Returns the case status, original receipt, required quantity, winning claim and ordering evidence, and any resolution. |
| `receive-replacement` | `positionId`, `replacementId`, `provenance` | Records one independently evidenced physical unit and fences it for fulfillment. Use a unique receiving document entry as provenance. |
| `resolve-shortfall` | `saleId`, `resolutionId`, `replacementId` | Fulfills the case once with the unconsumed replacement at the same position. A retry with the same identifiers returns the existing resolution. |

For example, use the losing sale UUID for the shortfall request and save the object as `inspect.json`.

```json
{
  "action": "inspect-shortfall",
  "saleId": "51a54763-de87-4f31-80d9-70b7f6d508a4"
}
```

Run `node --env-file=.env src/inventory-cli.ts inspect.json`. After verifying the new physical unit and filing `receive-replacement`, save the `resolve-shortfall` object with its own resolution UUID and the recorded replacement UUID, then run the same CLI with that file. A resolved case retains the original backorder voucher and financial postings.

For a manually enrolled terminal, provide a JSON object with `tenantId`, `storeId`, `terminalId`, `generation`, and `cashierId`. The position file contains `sku`, `positionId`, and `locationId`. Save the operator's signed grant response as `grant.json`. Use a distinct SQLite path, credential, and request UUID for each terminal. Set `OMNI_CASHIER_ID` to the enrolled cashier and use the public key and terminal token for that register.

```text
node --env-file=.env src/terminal-cli.ts terminal-a.sqlite init-enrolled terminal-a.json
node --env-file=.env src/terminal-cli.ts terminal-a.sqlite enable-quota position.json
node --env-file=.env src/terminal-cli.ts terminal-a.sqlite import-grant grant.json
node --env-file=.env src/terminal-cli.ts terminal-a.sqlite checkout 51a54763-de87-4f31-80d9-70b7f6d508a4 2000
node --env-file=.env src/terminal-cli.ts terminal-a.sqlite sync
```

For a transfer, the receiving terminal imports the signed custody packet with `import-custody receipt.json`. The custody authority attests the destination terminal and generation, tenant, position, grant, transfer, dispatch and receipt leg IDs, and the received slice IDs. It signs the UTF-8 receipt JSON with Ed25519 under the `OmniPoint-Inventory-v1\nCUSTODY_RECEIPT\n` prefix. The envelope carries `body` and `signature` as unpadded base64url plus `keyId`. The grant uses the same envelope with the separate `GRANT` purpose. The destination can import its evidence before an operator files it in the cloud.

### Inventory and financial rules

- Canonical on-hand includes in-transit units while they remain inside this custody position. Available stock subtracts each unresolved slice and each unconsumed replacement exactly once. Dispatch from the source location reserves the slice in transit. Filing receipt evidence changes custody of the existing slice. A confirmed spend reduces canonical on-hand and clears that slice's encumbrance together. The inventory view also computes on-hand from the immutable cutover balance, stock movements, replacement arrivals and resolutions.
- The terminal uses its local UTC wall clock for the signed interval `issuedAt <= occurredAt < expiresAt`. Local checkout requires unspent, in-scope quota and receipt evidence for a transfer. The cloud validates the recorded event time against the same interval and allows delayed delivery after expiry. Expired unresolved slices stay reserved. M2 has no automatic release or reissue for an unresolved slice. Clock rollback resistance is outside this fixture.
- Issuance, custody, sale admission, and fulfillment take the same PostgreSQL stock row lock before reading shared capacity. The first eligible transaction to commit a slice decision wins. The decision stores the position, slice, winner, rule version, and a database order number allocated under the lock. Rolled-back attempts can leave gaps in order numbers. Retried arrivals use the stored decision.
- V2 sale events carry the exact grant body digest, slice, location, position and any signed custody receipt. A receiving sale with valid local evidence can post its receipt and cash facts while cloud filing is pending. It returns unsigned HTTP 202 and remains actionable. Filing a matching leg rechecks staged claims in the same locked transaction. Unreceived and ambiguous slices stay fenced.
- Both a confirmed sale and a valid finalized backorder post the fixture journal once, with a Cash debit and Revenue credit of 2,000¢ per sale. A backorder consumes zero original shelf units and owns a durable shortfall case. A separately evidenced replacement adds one physical unit and resolution consumes it once. Resolution adds no cash or receipt. The v2 ACK uses the existing Ed25519 status-and-body signature profile with a v2 body. The terminal retires only verified final `COMMITTED` or `BACKORDER` outcomes. V1 retains its original format and dispositions.

## Milestone 3 retail register

### Run the tests and demonstration

Use the disposable PostgreSQL 17.11 service above. The Windows browser test uses Microsoft Edge by default. To use bundled Chromium, run `npx playwright install chromium` and set `OMNI_BROWSER_CHANNEL=chromium` on Windows. Linux CI installs and uses Playwright Chromium.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd test
npm.cmd run demo:m2
npm.cmd run demo:m3
npm.cmd run build:register
node --test --test-name-pattern=M3-01 test/retail.test.ts
```

The M3 demo runs seven controls, starting with an actual headless browser. It starts the register against its own SQLite file, shuts down cloud access for checkout, kills the register process after commit, then recovers the printable receipt in the browser. The first cloud voucher response is dropped after commit. The demo prints the receipt UUID and SHA-256 of the retried event. The remaining controls exercise mixed line outcomes, refund contention, blind close, devices, recount, and upgrade with real PostgreSQL.

### Start a register you can use

1. Use the fresh manual cloud demo setup above and apply `node --env-file=.env src/migrate.ts`. In its admin PostgreSQL session, seed two more stock rows in `omnipoint_demo`.

   ```sql
   INSERT INTO omni.stock VALUES
     ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'M3-RED', 3),
     ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'M3-TEA', 3);
   ```

2. Copy [register.example.json](register.example.json) to `register.local.json`. Configure the cashier secret, supervisor PIN, operator credential and supervisor file using the optional values in `.env.example`. Keep the cashier secret distinct from the PIN and operator and cloud credentials. Generate the supervisor key pair separately from the cloud signing pair.

   ```powershell
   node -e "const {privateKey,publicKey}=require('node:crypto').generateKeyPairSync('ed25519'); const fs=require('node:fs'); fs.writeFileSync('supervisor-private.pem',privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600}); fs.writeFileSync('supervisor-public.pem',publicKey.export({type:'spki',format:'pem'}),{flag:'wx'})"
   $config = Get-Content -Raw register.local.json | ConvertFrom-Json
   ConvertTo-Json -InputObject @(@{tenantId=$config.scope.tenantId; storeId=$config.scope.storeId; actorId=$config.supervisor.actorId; publicKeyFile='supervisor-public.pem'}) |
     Set-Content -Encoding utf8 supervisors.local.json
   ConvertTo-Json -InputObject @(@{tenantId=$config.scope.tenantId; actorId=$config.supervisor.actorId; token='local-development-operator-token'}) |
     Set-Content -Encoding utf8 operators.local.json
   ```

3. Start the cloud with `node --env-file=.env src/cloud-cli.ts` in its own shell. In another shell, publish the fixture catalog, open each position, enable v3, and issue a grant. Start with a fresh demo database so no legacy reservations need to be drained.

   ```powershell
   $config = Get-Content -Raw register.local.json | ConvertFrom-Json
   function Send-RetailOperation($body) {
     $body | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 retail-operation.local.json
     $result = node --env-file=.env src/inventory-cli.ts retail-operation.local.json
     if ($LASTEXITCODE -ne 0) { throw 'Retail inventory operation failed' }
     $result
   }
   Send-RetailOperation @{action='retail-catalog'; storeId=$config.scope.storeId; catalog=$config.catalog}
   foreach ($position in $config.positions) {
     Send-RetailOperation @{action='open-position'; storeId=$config.scope.storeId; sku=$position.sku; positionId=$position.positionId; locationId=$position.locationId; legacyDrained=$true}
     Send-RetailOperation @{action='retail-enable'; positionId=$position.positionId; legacyDrained=$true}
     Send-RetailOperation @{action='issue'; positionId=$position.positionId; grantId=[guid]::NewGuid().ToString(); terminalId=$config.scope.terminalId; generation=$config.scope.generation; quantity=3; expiresAt=[DateTime]::UtcNow.AddHours(2).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')} |
       Set-Content -Encoding utf8 ("grant-" + $position.sku + ".local.json")
   }
   npm.cmd run build:register
   node --env-file=.env src/register-cli.ts retail.sqlite register.local.json
   ```

4. Once the register starts, its catalog and quota position config are installed in SQLite. In another shell import each grant with `node --env-file=.env src/terminal-cli.ts retail.sqlite import-grant grant-M1-ITEM.local.json` and repeat for `M3-RED` and `M3-TEA`. Open `http://127.0.0.1:4317` and sign in. The local API checks its exact loopback Host and Origin and uses an HttpOnly session cookie. The register process retains database and cloud access. The browser receives display state and accepts only the register actions.

5. Open a shift with 5,000¢ float. Focus **Barcode scanner** and type `210001` followed by Enter, as a keyboard-wedge scanner would. Search or use **Add M1-ITEM** for manual entry. Enter 500¢ tender and finalize. The register shows 220¢ collected, including 10¢ tax, and 280¢ change. To see the offline path, stop the cloud before checkout and use **Sync next** to observe the retryable failure. Restart the cloud and sync the shift opening and sale. Find or reprint the original receipt using the receipt UUID or saved checkout request ID. Diagnostics shows the verified line disposition and device status.

### Operator walkthrough

- **Return.** Sync the original sale and the open receiving shift. Copy the receipt and line IDs from receipt lookup. Enter the quantity and supervisor PIN under **Cash return**. The cloud reserves the original fulfilled units and returns a signed quote. **Begin payout** issues a one-time instruction and records a drawer command. After the cashier physically hands over the authorized amount, use **Confirm cash paid** with supervisor authority and sync the confirmation. An interrupted payout appears as a hold. Confirm a verified payout or release a verified unpaid reservation with evidence. Inventory remains unchanged until the operator files `retail-restock` with the return ID, a stable `evidenceId`, `provenance`, and disposition `SELLABLE` or `QUARANTINED`.
- **Blind close.** Enter denominations before seeing expected cash. The committed count displays expected cash and variance. For a verified drop, enter a distinct destination cash-location UUID, amount, and supervisor PIN. Review a nonzero variance using **Supervisor close revision** with the latest count, reason, and PIN before opening another shift. Submit the same counted amount to approve a reviewed discrepancy with a zero delta, or enter the witnessed recount to record its difference. Sync all earlier shift facts before the close. The cloud holds gaps at the source sequence and recomputes expected cash from the covered events.
- **Recount and custody.** File `retail-count` with `positionId`, `countId`, `observed`, and `witness`. It captures the scoped stock snapshot and cutoff under the stock lock. Use `retail-inspect-count` with `countId` to inspect the evidence and status. File a matching signed custody receipt with `file-custody`. For recount, that receipt must carry the signed UTC `observedAt` time as well as its original dispatch and slice identities. Run `retail-decide-count` with `countId`, `decisionId`, `previousId: null`, and `evidence` to approve the first result. For a revision, supply the prior decision UUID as `previousId` and the revised `observed` count. A separate `retail-found` action accepts a position, evidence UUID, quantity, and unique provenance. The late-custody and revision sequence is executable via `node --test --test-name-pattern=M3-06 test/retail.test.ts`.

Submit operator actions as JSON files using the same inventory CLI as M2. The operator token supplies tenant and actor identity. The browser does not need that token.

### Fixture policy and forward migration

- V3 records USD explicitly and uses integer cents with BigInt intermediates. Each extended line is rounded half to even once. Exclusive tax is added to the discounted extended price. Inclusive tax is extracted using rate divided by one plus rate. A line discount applies to the extended sticker price and must leave at least one cent per unit. The immutable quote binds SKU, catalog and tax versions, price, quantity, rate, and tax mode. The cloud checks it against the scoped, immutable catalog version and verifies a separate supervisor signature for discounts.
- Partial refunds assign gross cents to stable unit ordinals by cumulative floor, then allocate the original line tax by cumulative gross share. The remaining cents are revenue. Reserved and completed ordinals stay claimed until verified nonexecution or confirmed payout. A full cumulative return reimburses exactly the original gross, revenue and tax. The fixture reverses the original Cash, Revenue and SalesTax components. These choices are fixture accounting and tax policy.
- The retail event and its cash, quota, receipt, and device intents commit atomically on SQLite. The cloud accepts a shift's source sequence contiguously and serializes affected stock rows by SKU. Final `BACKORDER` means at least one valid line unit lost. Other lines may be fulfilled, and the single sale journal covers the accepted cash. Missing custody returns a retryable HTTP 202 before the sale's cloud effects. The terminal retries from its durable outbox once receipt evidence is filed. The same stored Ed25519 voucher authenticates the final line outcomes on replay.
- Printer and drawer commands execute through simulators after the local transaction. Paper-out and disconnect are known failures. Timeout or interruption remains uncertain even when a delayed response later arrives. An operator records a check without automatic re-pulsing. Reprint uses the original receipt bytes and a separate printer command. The browser test exercised a keyboard-wedge input sequence with ordinary typing and malformed scans. Physical USB scanners, printers, drawers and fiscal devices were outside the verification.
- Run the cloud owner migration before launching v3. SQLite applies `003-local.sql` on open. The additive migrations preserve stored v1/v2 receipts, bytes, digests and vouchers. Drain legacy outboxes and settle active v2 reservations before enabling retail for a position. New v1/v2 effects remain fenced there. Previously admitted legacy events can replay. V3 accepts only signed grants issued in retail mode after cutover. Recount uses the stock anchor and keeps unresolved grants fenced. Late evidence can correct attribution at the original cut without a stock movement. A changed book cut holds an adjustment for a fresh observation.

## Milestone 4 card payments and fiscal recovery

### Run the verified fault paths

Use the disposable PostgreSQL service and Playwright setup above. The demo starts the simulated provider and fiscal signer as separate loopback HTTP services with separate SQLite files and test-only fault controls. The register runs in a separate process for the crash tests.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd test
npm.cmd run demo:m4
npm.cmd run build:register
node --test --test-name-pattern=M4-01 test/payment.test.ts
```

M4-01 uses the existing register in Edge or Chromium. It waits for a provider capture to commit, kills the POS while the attempt is still `MAY_HAVE_SENT`, and drops the provider response. After restarting the provider against its original SQLite file and the register against its own file, the operator checks the original attempt. The sale becomes a signed fiscal receipt for 220¢. The test then drops the first final cloud voucher response and checks byte-for-byte replay and durable outbox retirement. The remaining demo tests cover unknown provider status, authenticated duplicate evidence, refunds, signer death and grants, fiscal gaps and forks, `SQLITE_FULL`, and migration and boundary controls.

### Run the fixtures with the interactive register

Start with the fresh disposable M3 register and catalog configuration above. Apply `node --env-file=.env src/migrate.ts` for migration 004. The terminal applies `004-local.sql` when it opens the database. Use separate files for the POS, provider, and fiscal signer databases and one writer process per file. Use only synthetic card entry at the reader fixture. No browser card-entry fields are required.

1. Generate three separate Ed25519 pairs for the provider, fiscal authority, and fiscal device. Use the key-generation pattern from the M3 walkthrough with distinct names. The provider signing key ID matches `providerId`. The device signing key ID matches its UUID `deviceId`. Keep the fiscal authority private key in the operator's issuance environment. Its public key is the root for enrollment, genesis, and grants.
2. Create three facts files from the register's `scope` object. Copy all five scope fields into each file. Add `deviceId`, `epochId`, and `series` to each. Use separate UUIDs for the device and epoch and a series such as `DemoSeries`.

   | Facts file | Additional fields |
   | --- | --- |
   | `enrollment-facts.local.json` | `publicKey` containing the device's DER SPKI public key encoded as unpadded base64url |
   | `genesis-facts.local.json` | `previousEpochId: null` for the first epoch, or the exact retired epoch UUID for replacement |
   | `grant-facts.local.json` | A unique `grantId`, sequence `start` and `end` inclusive, and UTC ISO `issuedAt` and `expiresAt` with milliseconds. The range covers at most 100 slots and the interval at most 24 hours. |

   Convert a PEM public key with `node -e "const {createPublicKey}=require('node:crypto'); const fs=require('node:fs'); console.log(createPublicKey(fs.readFileSync('device-public.pem')).export({type:'spki',format:'der'}).toString('base64url'))"`. Sign each file under its own purpose with the authority key.

   ```powershell
   node src/payment-fixture-cli.ts sign enrollment-facts.local.json fiscal-enrollment fiscal-root authority-private.pem | Set-Content -Encoding utf8 enrollment.local.json
   node src/payment-fixture-cli.ts sign genesis-facts.local.json fiscal-genesis fiscal-root authority-private.pem | Set-Content -Encoding utf8 genesis.local.json
   node src/payment-fixture-cli.ts sign grant-facts.local.json fiscal-grant fiscal-root authority-private.pem | Set-Content -Encoding utf8 fiscal-grant.local.json
   ```

3. Create a `route` JSON object with the register's five scope fields plus `providerId: "demo-provider"`, `merchantId: "demo-merchant"`, and `readerId: "demo-reader"`. Use that same route in the three configurations below. Key lists use entries of the form `{"id":"fiscal-root","file":"authority-public.pem"}` or `{"id":"demo-provider","file":"provider-public.pem"}`.

   | Configuration | Fields |
   | --- | --- |
   | `provider.local.json` | `database: "provider.sqlite"`, `port: 4321`, `keyId: "demo-provider"`, `privateKey: "provider-private.pem"`, `routes: [route]`, `idempotencyMs: 30000` |
   | `signer.local.json` | `database: "fiscal.sqlite"`, `port: 4322`, device UUID as `keyId`, `privateKey: "device-private.pem"`, `enrollment: "enrollment.local.json"`, `genesis: "genesis.local.json"`, and authority key list as `roots` |
   | `payment-trust.local.json` | `routes: [route]`, `providerKeys`, and `fiscalRoots` |
   | `payment.local.json` | `provider` with `url: "http://127.0.0.1:4321"`, `route`, `keys` containing the provider public key, and matching `idempotencyMs`. `fiscal` with `url: "http://127.0.0.1:4322"`, `enrollment: "enrollment.local.json"`, authority `roots`, and `grant: "fiscal-grant.local.json"`. |

4. Set `OMNI_PAYMENT_TRUST_FILE=payment-trust.local.json` for the cloud and `OMNI_PAYMENT_FILE=payment.local.json` for the register. Configure distinct `OMNI_PROVIDER_TOKEN` and `OMNI_FISCAL_TOKEN` values of at least 24 characters in the fixture and register environments. Restart the cloud and send the `fiscal-enroll` operator action with `enrollment` and `genesis` containing the signed packet objects. Use the inventory CLI and the scoped operator actor from M3. Run each service in its own shell.

   ```powershell
   node --env-file=.env src/payment-fixture-cli.ts provider provider.local.json
   node --env-file=.env src/payment-fixture-cli.ts signer signer.local.json
   node --env-file=.env src/register-cli.ts retail.sqlite register.local.json
   ```

   Open or reuse the shift, scan `210001`, and select **Charge card reader**. The Blue mug fixture is 210¢ plus 10¢ tax. On success the printable receipt identifies the card rail, fiscal series, sequence, and epoch. Use **Sync next** to send the opening and the sale. The register retains its provider credential and the device retains its fiscal private key.

### Operator recovery

- **Unresolved capture.** Check the original payment from **Card payment recovery**. A signed webhook is recorded as delivery evidence. It prompts a read-only status check for an outstanding attempt. Status that cannot prove an outcome leaves the basket, quota, and shift cut fenced. The explicit **Check and retry same attempt** path first queries status, then replays the original operation only inside configured provider idempotency retention and with the worker lease available. For a definitive decline or nonexecution, the supervisor can authorize a replacement attempt with a reason code. The replacement retains the original quote and a link to the previous attempt.
- **Captured funds.** Use `payment-inspect` with `intentId` to inspect the cloud case and its original attempt. `FISCAL_GRANT_REQUIRED` leaves a capture recoverable without charging again. To finish, issue a distinct grant for the required slot and replace the grant file. The register reads it on the next recovery. To refund instead, choose **Refund captured funds** and authorize with a supervisor PIN and a fixed reason code. The signer durably fences signing for that intent, the cloud reserves the linked refund, and the register records `REFUND_PENDING` before dispatch. If the response is lost, check the original attempt until authenticated status confirms refund. A pending refund leaves the case held. The cash return command rejects card receipts.
- **Fiscal gap.** Use `fiscal-inspect` with `epochId` to see the canonical head and pending or forked slots. Recover the original payment and signed receipt on the terminal that owns the missing slot and replay its unchanged outbox bytes. Retrying either original can resume promotion of contiguous staged receipts. For an irreparable gap, the authority signs a new enrollment and a replacement genesis naming the old epoch. Submit the pair, then configure the new signer and grant. Late old-epoch receipts remain evidence under the retired epoch. Previously applied receipts retain their original vouchers.
- **Storage.** Diagnostics samples filesystem free bytes, WAL size, and frames pending after a passive checkpoint. Pending frames can reflect an active writer or a long-lived reader. The fixture does not attribute reader age. M4-06 uses SQLite's page limit and a receipt-insert trigger to produce genuine result code 13 during local finalization. It checks transaction rollback and reopens the database to recover the exact signer proof and outbox event. Physical filesystem exhaustion requires a separate deployment test.

### Simulator and accounting boundaries

- The provider's fixture contract binds operation, merchant, reader, terminal generation, amount, currency, basket digest, and attempt. It persists authorization, capture, refund and test-injected settlement or reversal as separate facts. Within the configured idempotency window, it replays the original same-attempt effect. Definitive decline or nonexecution means the original attempt cannot later capture under this simulator contract. The adapter rejects fields outside its allowlist. Tests inject synthetic PAN-shaped, track, PIN block, verification code and reader-secret canaries and check HTTP errors, terminal logs, diagnostics, SQLite DB/WAL files, outbox and PostgreSQL artifacts.
- At capture, the fixture debits CardClearing 220¢ and credits CapturedFunds 220¢. At fiscal application it debits CapturedFunds 220¢ and credits Revenue 210¢ and SalesTax 10¢. If an unapplied capture is refunded, it debits CapturedFunds and credits CardClearing for 220¢. Settlement and reversal remain separate audit facts in this fixture. It retains M3's cash-only return path and introduces no Cash posting or drawer pulse for card activity.
- The fiscal signer records receipt bytes, head, and spent sequence together. Trusted time is an interval wholly within the grant and cannot move backward from the last signed interval. Recovery of an existing signature ignores later expiry. The interactive signer fixture uses the host clock as its interval source. The test clock injects missing, ambiguous and backward intervals. Device state is retained for replay and audit. A deployed device needs authenticated time, rollback-resistant head and spent state, protected keys, trusted enrollment and replacement authority, and jurisdiction-specific receipt certification. A copied or rolled-back software database does not provide those hardware guarantees.

## Milestone 5 workflows and fleet recovery

Apply the same forward migration command used for Milestones 1–4. Migration 005 adds
tenant-scoped capability profiles and confirmed appointments in PostgreSQL, plus
verified profile history and a workflow event stream in the terminal SQLite file.
Migration 006 adds module tender records and allows service and split-share lines
without a stock position. Module tenders use immutable v5 events and signed
acknowledgments through the shared retail outbox. Existing v1–v4 bytes and signatures
retain their original formats.

For a disposable demo tenant, a database administrator can create the initial profile.
Use the enrolled tenant ID and append a higher version for a capability change.

```sql
INSERT INTO omni.capability_profiles (tenant_id, version, retail, hospitality, services)
VALUES ('<enrolled-tenant-uuid>', 1, true, true, true);
```

Start the cloud and local register using the existing setup. Sign in at the register,
open **Workflows**, then select **Refresh capabilities**. Profiles are signed by the
existing cloud authority and checked against the terminal enrollment before caching.
The cached profile permits local draft and kitchen work while the cloud is offline.
A terminal without a verified profile starts in legacy retail mode. A refreshed
disabled profile blocks new module work. Already finalized offline tenders can upload
using their historical authorized profile and original terminal scope.

### Hospitality

- Seat guests at T1 or T2. Toast requires butter or jam and routes to the hot station.
  Salad routes to the cold station with plain or dressing. Dispatch and ready or
  cancel transitions persist in SQLite before appearing on the display.
- Set separate 24–128 character base64url values in `OMNI_KITCHEN_HOT_TOKEN` and
  `OMNI_KITCHEN_COLD_TOKEN` on the register process. Open `/kitchen` on the register's
  loopback origin and enter one station token. The browser holds it in memory.
  Reload and reconnect to rebuild the station view. The source retains all revisions
  for this fixture. The UI applies monotonically newer revisions per order.
- Open a cash shift and provision retail quota for the menu SKUs. Toast uses
  `M1-ITEM` and salad uses `M3-TEA`. Dispatch snapshots the catalog quote. For
  pre-006 tickets, the first split takes the missing price snapshot. The v5 fixture
  charges 20¢ for jam and applies a 5¢ dressing promotion before tax. Butter and
  plain add no charge.
- Freeze checks by seat, selected lines, or equal halves. Equal halves split net and
  tax separately and give each odd cent to the first share. A 211¢ gross line with
  10¢ tax becomes 106¢ and 105¢ with 5¢ tax each. Partial cash tenders consume the
  check balance in frozen line order and allocate incremental tax by cumulative
  proportion. The first tender for each physical source line claims its quota unit.
  Later portions carry the same stock disposition and reference the original claim.
- Enter cash and an optional tip in cents, then tender. A partial tender leaves the
  remaining cents visible. Recover the original receipt from **Workflows** and use
  **Sync next** to upload. Cash tips debit Cash and credit TipsPayable separately from
  Revenue and SalesTax. The shift pool uses an equal Alex/Sam roster, with Alex first
  for an odd cent. Incremental shares follow cumulative shift totals, so the first
  5¢ produces 3¢ and 2¢. Tip payout and module returns are outside this fixture.

### Services

- Save an appointment draft while offline. Confirm after reconnecting. The cloud
  checks the saved capability version, staff and the shared bay in one transaction.
  The fixture schedules half-open UTC intervals from 08:00 through 18:00. Adjacent
  appointments can share an endpoint. An already confirmed request can replay
  under its original identity even after a profile change.
- In **Work order**, start intake, select a part, and save an estimate. Capture a
  customer consent UUID with supervisor authorization, then start work. Saving a
  material revision invalidates the previous authorization. With a valid approval
  and physical quota, **Invoice and tender** takes the exact amount and makes the
  original receipt recoverable. The fixture posts 1,000¢ labor plus 5% tax and the
  frozen part price and tax. Commission v1 accrues 10% of pretax labor, rounded down
  to a cent, to the authorized technician. The calculation is stored with the
  original invoice. Commission payout is outside the fixture.

### Fleet load and restore

The module API requires a pool of at least five connections and reserves two slots
each for bookings and settlements. Each tenant can use one background slot and one
settlement slot. A tenant can have two concurrent booking requests so the shared
resource lock can resolve contention. Excess work receives HTTP 429 with a one-second
retry hint. **Inspect fleet pressure** shows active and rejected counts for the
enrolled tenant. The load drill holds one database worker, rejects another request
from the same tenant, and concurrently completes a separate tenant's tender and an
original voucher replay. These limits and counters are per cloud process.

The restore drill pauses fixture writes while taking each paired cut. It takes a
SQLite online backup and captures PostgreSQL rows in a repeatable-read transaction.
A hash-pinned manifest names the checkpoint and links later complete image segments.
Replay validates continuity, SQLite integrity and the display cut before installing
the images into a fresh, isolated fixture database and terminal file. The fixture
quarantines an invalid diagnostic record and continues to a later verified image.
A missing or mismatched segment blocks startup. The drill compares signed vouchers,
receipt and journal data, quota encumbrances, pending work, and an unresolved M4
capture. The capture is restored from stored evidence and the test confirms there
was only one provider capture. These paired images cover quiesced fixture cuts.
Provider and fiscal signer stores are outside the backup. This is a fixture restore,
with no automatic failover or continuous change capture.

Using the disposable PostgreSQL environment above and Edge on Windows:

```powershell
npm.cmd run demo:m5
npm.cmd run build:register
node --test --test-name-pattern="M5 kitchen foundation" test/modules.test.ts
node --test --test-name-pattern="M5-01|M5-02" test/module-completion.test.ts
node --test --test-name-pattern="M5-04" test/module-completion.test.ts
node --test --test-name-pattern="M5-05|M5-06" test/module-completion.test.ts
```

## Milestone 6 close and governed reporting

Apply the normal cloud migration command. Migration 007 backfills a normalized
ledger from committed legacy sales, retail and module postings, and payment
postings. Terminal SQLite stays at 006. Original receipt, event, and voucher
formats are preserved.

Periods are UTC calendar months. Legacy and retail sales use the original event
date. Capture and refund use the corresponding verified provider fact. Applying a
capture uses the sale date. Approved adjustments use their stated business date.
A seal fences its month and earlier months. Close refuses to skip an earlier
month with unsealed entries. First-seen late financial events receive a durable
`PERIOD_SEALED` hold with the original request digest and bytes. They remain
actionable at the terminal. Exact replays return the original committed outcome.
A correction references a sealed line and uses a later open period.

### Operator setup

Set `OMNI_GOVERNANCE_KEY_FILE` and `OMNI_GOVERNANCE_KEY_ID` on the cloud to a
dedicated Ed25519 signing key. Enroll each governance operator in the existing
`OMNI_OPERATORS_FILE` with its `tenantId`, `actorId`, `token`, and
`"governance": true`. Use distinct enrolled actors for vault witness and approval.
The CLI reads the endpoint from `OMNI_INGEST_URL` and the operator token from
`OMNI_GOVERNANCE_TOKEN`. The independent verification commands read
`OMNI_GOVERNANCE_PUBLIC_KEY_FILE` and `OMNI_GOVERNANCE_KEY_ID`. Distribute the public
key through a trusted channel.

Send one JSON request per invocation.

```powershell
npm.cmd run --silent governance -- send request.json
```

### Cash reconciliation

1. Open a shift, record a drop to the vault UUID and complete the blind drawer
   count. Use the existing supervisor revision when a recount changes the count.
   Sync the source events before reconciliation.
2. Send `cash-state` with `shift`, `vault` and the expected final source sequence
   `through`. The result identifies the covered events, gaps, drawer expected
   and counted amounts, and in-transit drop value. Send `cash-vault-receive`
   with a new `id`, `vault`, original `drop` ID and an `evidence` UUID.
3. Record `cash-drawer-retain` with `id`, `vault`, `shift`, the approved `close` ID,
   `minor` and `evidence`. If a supervisor revision leaves a recognized variance,
   `cash-drawer-adjust` takes the same shift and close references plus
   `businessAt` and posts the difference from the prior recognized variance.
4. Take a fresh `cash-state` cut. The witness sends `cash-vault-witness` with
   `id`, `vault`, the returned `vaultCut` as `cut`, `priorCount` as `previous`,
   `counted` cents, `businessAt` and `evidence`. The approving operator submits
   `cash-vault-count` with the same cut and count, a new `id` and `evidence`,
   and the witness record ID as `witness`. A recount starts from the updated cut.
   Positive pooled variance debits CashVault and credits CashVarianceClearing.
   A correction reverses only the difference. The drawer equivalent uses CashDrawer.
5. Send `cash-deposit-send` with `id`, `vault`, `destination`, `minor` and
   `evidence`. The handoff stays in transit until `cash-deposit-receive` names
   the same vault and destination and references the send ID as `transfer`.
   Use a fresh receipt `id` and `evidence`. Custody moves do not post revenue.

### Period seal and restore

Use `period-close` with the UTC month as `period`, a seal UUID as `id`, the
current predecessor seal UUID as `previous` (or JSON null for genesis), and an
`approval` UUID. Use `period-get` to retrieve the immutable bundle. The database
lock is acquired before the final journal read. The bundle contains explicit
ledger membership and evidence objects with receipt, voucher, custody, replay and
hold facts from a commit-consistent evidence read. Checkout writers take the shared
mode so existing stock locks can still arbitrate concurrent checkouts. Close takes
the exclusive mode. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) · [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)

The Ed25519 manifest names the signer by key ID. It binds scope, approval,
predecessor, counts, balances, and separate SHA-256 roots for the ledger and
evidence objects. Canonical bytes are UTF-8 JSON with recursively sorted object
keys and ordered arrays. Journal membership uses journal ID then line ID in
byte order. This fixture has one governance signing authority.

```powershell
npm.cmd run --silent governance -- send close.json | Set-Content -Encoding utf8NoBOM seal.json
npm.cmd run --silent governance -- verify-seal seal.json TENANT_UUID 2026-03 none
node --test --test-name-pattern=M6-03 test/governance.test.ts
```

The restore drill uses the Milestone 5 paired SQLite backup and PostgreSQL
snapshot segments with writers paused. It checks the stored seal against its
actual backing objects and the restored ledger before starting the restored
service. It replays an original receipt voucher and posts a successor correction
once. The drill preserves a cloud and terminal capture hold and verifies that
there was no second provider capture. Provider and fiscal signer stores remain
outside the snapshot.

### Comparative plans and signed exports

The demonstration uses synthetic treasury evidence. Post fixture movements with
`period-adjust`, an `id`, UTC `businessAt`, `evidence`, signed `minor`,
`account` and `counteraccount`. The TreasuryClearing/TreasuryOffset bridge
classifies April movements as `RESTORE`, `POST`, or `REVOKE`. The revocation
references the original debit-side ledger line. Use JSON null for `reference`
when the effect does not use one. The 125¢ `UNRELATED` movement stays itemized
even though it uses the same account.

For the technical replacement fixture, send `period-technical-replace` with the
original debit-side `line`, `id`, `reverseId`, UTC `businessAt` and `evidence`.
The operator records one atomic reversal and replacement pair for the period.
The plan binds both actual journal effects and the original absorbed slice.

Approve with `report-approve`, giving `id`, `lineage`, `predecessor`, the
March `seal`, the April month as `april`, `approval`, a `slices` array of
`{line,start,minor}` and optional technical `replacement` evidence as
`{line,evidence}` (or JSON null). Each absorbed slice binds the exact posting
line, amount and offset in the 50¢ family. The plan pins the sealed March
reference and exact April ledger membership. Historical approvals render from
their original extract. Publish using `report-publish` with `plan` and an export
`id`. Retrieve with `report-get`. Withdraw with `report-withdraw`, giving `plan`
and `evidence`. Retrieval keeps the original export bytes and reports current
withdrawal and successor status.

```powershell
npm.cmd run --silent governance -- send publish.json | Set-Content -Encoding utf8NoBOM export.json
npm.cmd run --silent governance -- verify-export export.json TENANT_UUID PLAN_UUID SEAL_UUID
npm.cmd run --silent governance -- verify-plan plan.json TENANT_UUID PLAN_UUID SEAL_UUID
```

### Reproduce the gates

With the disposable PostgreSQL environment above:

```powershell
npm.cmd run check
npm.cmd run demo:m6
node --test --test-name-pattern="M6-01|M6-02" test/governance.test.ts
node --test --test-name-pattern="M6-04|M6-05" test/governance.test.ts
npm.cmd test
git diff --check
```

## Milestone 7 statutory and bank reconciliation

Migration 008 adds treasury accounts, durable outbound attempts, authenticated
facts, capacity positions, and journal effects. All new tables use forced tenant
RLS and tenant-scoped keys. Treasury writes acquire the M6 tenant ledger lock,
then the scoped bank-account anchor before testing for absent predecessors or
available capacity. Journals use the existing governed adjustment table and
period fence. A late financial fact retains its signed bytes and a
`PERIOD_SEALED` case. An operator can authorize an explicit successor date with
`treasury-authorize-period`. Replays retain the original evidence identities.

### Independent fixtures and trust

Run one agency service and one bank service with separate SQLite paths, tokens,
Ed25519 private keys and key IDs. The fixtures use WAL and synchronous FULL.
The authenticated `/execute` endpoint stores the exact request and one signed
transmission result before responding. Attempt IDs have permanent idempotency in
this fixture. A changed request under an existing attempt is rejected.
Authenticated `/status` returns the durable result or `UNKNOWN`. Transmission
acceptance carries no booked-cash or agency-application authority.
Authenticated `/fact` issues durable synthetic evidence for the test channels.

```powershell
$env:OMNI_TREASURY_FIXTURE_TOKEN = '<agency-development-token>'
$env:OMNI_TREASURY_FIXTURE_KEY_FILE = 'agency-private.pem'
$env:OMNI_TREASURY_FIXTURE_KEY_ID = 'demo-agency'
npm.cmd run treasury:fixture -- agency agency.sqlite 4511
```

Start the bank in another terminal with its own values and path, using
`npm.cmd run treasury:fixture -- bank bank.sqlite 4512`.
The cloud reads `OMNI_TREASURY_TRUST_FILE`, a protected JSON file with `agency`
and `bank` entries. Each entry contains `url`, `token`, `keyId` and
`publicKeyFile`. The two public keys, key IDs and credentials must be distinct.
The existing governance operator enrollment and CLI authorize treasury actions.

Evidence is Ed25519-signed UTF-8 JSON with domain purposes
`treasury-bank-v1` and `treasury-agency-v1`. The body identifies
`tenant`, `account`, `source`, `id`, `lineage`, positive integer `cut`,
`kind`, UTC `at`, `currency: "USD"` and typed `data`. Original signed body
bytes, digest and signature remain stored. A scoped ID with changed bytes is a
collision. Conflicting signed bodies and both digests are retained in a durable
incident before HTTP 409 is returned. Automated allocation and payment for that
account stay held. Bank evidence controls booked cash and statement balances. Agency
evidence controls filing, assessment, application and reimbursement authority.

The synthetic jurisdiction is OMNI-DEMO and its channel is fixture-api.
The filing preserves its America/Denver timezone context. The fixture deadline
is 23:59 UTC on the fifteenth of the following month. Timeliness uses the agency's
authoritative filed timestamp, which must follow the accepted transmission.
Docket precedence follows the signed lineage and strictly increasing source cut.
Amendment, withdrawal, merger and severance retain their predecessor references.
These contracts describe the simulators used by the tests.

### Filing and funding recovery

Use the M6 CLI with JSON request files:

```powershell
npm.cmd run --silent governance -- send treasury-request.json
```

1. `treasury-open` takes an account UUID, taxpayer, remitter and opening bank
   balance in cents. `treasury-get` returns case status, evidence, original
   request bodies and digests, outstanding capacity, journal links and holds.
2. `treasury-send` takes `account`, `operation`, `attempt`, `predecessor`
   (JSON null for the first attempt), `kind`, `subject`, `minor` and `terms`.
   Filing terms are period, timezone, jurisdiction, channel, base64url payload
   and deadline. Funding terms name the assessment evidence ID and exact cut.
   The attempt is committed as MAY_HAVE_SENT before the HTTP call.
3. `treasury-recover` names the account and original attempt and queries status.
   An unknown result stays held. `treasury-resume` may dispatch the original
   bytes under the fixture's permanent idempotency guarantee. A replacement
   attempt needs a definitive rejection and a link to the rejected attempt.
4. `treasury-ingest` takes `account`, `source` and the signed `packet`.
   FILED, FILING_CHANGE, ASSESSMENT, COLLECTION, RECEIVED and APPLIED remain
   separate facts. Funding uses the assessment's covered-attempt membership to
   avoid subtracting the same commitment twice. Split booked bank settlement
   debits OutboundClearing and credits Cash. Agency application debits
   StatutoryPayable and credits OutboundClearing. Refund/application reservations
   for agency-held credit share one locked capacity.

### Inbound, disputed and statement cases

The reimbursement fixture seeds Dr. AgencyReceivable / Cr. AgencyIncome for
1,000¢. A booked bank credit posts Dr. Cash / Cr. InboundSuspense once.
Authenticated principal remittance applies the supported amount to the receivable.
Agency fee advice can claim its residual with Dr. FeeExpense / Cr. AgencyReceivable.
A signed PROOF binds the exact fee and reimbursement-credit IDs. A signed FINAL
lists the complete candidate set at its attested cut. Comparable signed
supersession can select a successor. Incomparable final candidates freeze the
credit and open an incident. Once eligible, reimbursement posts
Dr. InboundSuspense / Cr. FeeExpense. The six arrival-order tests finish with
two cash debits totaling 1,000¢ and zero receivable, fee and suspense balances.

ALLOCATION_CORRECT references the original proof and sealed allocation.
Correction to an available fee posts the inter-fee amount in the successor.
Correction to an already satisfied fee records senior provenance at the
destination and fences the displaced credit in SurplusHold. Booked bank debit
and agency offset execution remain distinct. Dual execution consumes the hold
once and records DisputeReceivable for the extra exposure. Recognition,
discharge and replacement-payment barriers remain visible. Release needs linked
bank-release and agency-release evidence.

The one statement profile supplies authenticated opening and closing balances,
sequence, revision, cutoff, booked status, predecessor digest and line references.
The fixture profile bounds each statement to eight line references.
A causal canonical reference can bind a new alias. Equal amounts and dates do not
bind an alias. The aggregate test starts with 1,000¢, retains a sealed 50¢ debit,
then proves one additional 50¢ debit from the 900¢ overlapping closing.
The debit envelope fences the identical candidates. A GHOST revision appends a
cash correction. REAL_RETURN uses a newly booked return. FORWARD uses the existing
credit from the subsequent cut and adds only the non-cash suspense match.
AMBIGUOUS revisions remain incidents.
OutboundClearing is the fixture account for both funding clearing and the
outbound debit envelope. Each match retains its own source and capacity.

Agency ATTEST, REVOKE and REINSTATE facts bind the exact envelope, credit and
amount. Revocation leaves a permanent tombstone even when the original or credit
is missing. Active invalidation restores both capacities with one open-period
inverse and holds the credit. A new, higher-cut reinstatement links both
predecessors. Unchanged active allocation can promote authority without another
journal. Broken continuity follows the inverse and rematch path.

### Reporting, upgrade and cold restore

`treasury-report-link` binds a verified bank fact to its exact approved M6
classification line. Supply account, source, evidence and line. Add the returned
`{account,key}` references as the `treasury` array in a report approval.
The signed plan pins those digests with the existing 30¢ and 20¢ slices,
technical replacement, substantive reopening and unrelated 125¢ movement.
Historical exports retain their original bytes and signatures.

M6 close evidence includes the bank and agency source cuts, attempts, aliases,
positions, permanent tombstones, incidents and payment barriers. Old M6 bundles
continue to verify with their original member sets. The cold restore uses the
M5/M6 quiesced SQLite and PostgreSQL images, validates the two period seals and
backing ledger before starting the restored service, then recovers the original
external attempt by read-only status. Bank and agency fixture databases remain
durable external stores during this drill. Their authenticated facts are also
retained in OmniPoint's backup. The drill restarts the retained agency store.
Provider and fiscal signer stores retain the M6 backup boundary.

With the disposable PostgreSQL environment:

```powershell
npm.cmd run check
npm.cmd run demo:m7
node --test --test-name-pattern="M7-01|M7-02" test/treasury.test.ts
node --test --test-name-pattern="M7-04|M7-05|M7-06" test/treasury.test.ts
npm.cmd test
git diff --check
```

The HTTP fixtures run as independent services with separate database files and
keys in the integration harness. The CLI commands above also run them as separate
processes. The CI test command includes the M7 suite with the existing real
PostgreSQL service and M1–M6 regression tests.

## Release candidate verification

See [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md) for clean-install commands, gate mapping, restore boundaries and observed verification. The separate npm run test:storage command requires the bounded disposable Linux tmpfs documented there.
