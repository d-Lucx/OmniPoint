# OmniPoint Milestones 1 through 3

OmniPoint completes a single-terminal cash sale offline and synchronizes it after a crash and a lost cloud response. Milestone 2 extends that path to two terminals with signed offline quotas and durable inventory arbitration. Milestone 3 adds the retail register, blind shifts, receipt-linked cash returns and custody-aware recount.

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
