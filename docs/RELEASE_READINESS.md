# OmniPoint M1–M7 release readiness

## Candidate

Candidate branch: `release/m1-m7-rc`. Exact identity: `git rev-parse HEAD` (also retained in hosted artifacts). This packages the local M5–M7 foundation, including migrations 005–008, on published M4 commit `c91b1d1bdc4f185d85e5a23a8f85ba3e5512df73`. Parent design documents and prior history are preserved. No production deployment or main-branch replacement is included.

Verification is in progress; final observations are recorded below. This is a review candidate for synthetic fixture workflows, not certified payments, fiscal hardware, tax or statutory integration.

## Clean installation and reviewer walkthrough

Use Node 24.22.1, npm, PostgreSQL 17.11 and Playwright Chromium (installed Edge on Windows). Clone tracked source without copying dependencies, configurations or build output:

```sh
git clone --branch release/m1-m7-rc https://github.com/d-Lucx/OmniPoint.git omnipoint-rc
cd omnipoint-rc
git rev-parse HEAD
npm ci --ignore-scripts
npm run check
npx playwright install --with-deps chromium
docker run --rm -d --name omnipoint-rc-pg -p 127.0.0.1:55432:5432 -e POSTGRES_USER=omnipoint_test_admin -e POSTGRES_PASSWORD=local-test-admin-only -e POSTGRES_DB=omnipoint_test postgres:17.11-bookworm
docker exec omnipoint-rc-pg pg_isready -U omnipoint_test_admin -d omnipoint_test
export OMNI_TEST_DISPOSABLE=1
export OMNI_TEST_ADMIN_URL=postgresql://omnipoint_test_admin:local-test-admin-only@127.0.0.1:55432/omnipoint_test
npm test
npm run demo:m5
npm run demo:m6
npm run demo:m7
git diff --check
docker stop omnipoint-rc-pg
```

Wait for pg_isready to succeed. PowerShell uses npm.cmd and `$env:OMNI_TEST_DISPOSABLE='1'`, `$env:OMNI_TEST_ADMIN_URL='...'`. A dedicated native PostgreSQL cluster can replace Docker. Browser bundles are built by tests/demos. The harness requires loopback, explicit port, exact omnipoint_test database and disposable opt-in. It creates and drops only its own randomized databases/roles and temporary terminal directories. Never use a shared database.

The following focused commands use normal HTTP/browser/process entry points and inspect exact persisted money, quantities and immutable artifacts. Repeated invocations are not additional coverage:

- `node --test --test-name-pattern=M3-01 test/retail.test.ts`: offline browser sale, forced POS death, original receipt recovery, lost final response and verified ACK retirement.
- `node --test --test-name-pattern=M4-01 test/payment.test.ts`: one 220-cent capture before POS death, one receipt/inventory effect, balanced clearing/revenue/tax, zero Cash/drawer effect. M4-03 separately exercises a held capture and authorized completion/refund.
- `npm run demo:m5`: hospitality 211-cent gross splits 106/105 with 5 cents tax each; five-cent tip pool splits 3/2; stock consumed once. Approved mixed service invoice retains one commission.
- `npm run demo:m6`: drawer/vault/deposit, supported variance deltas, both posting/close race orders, sealed March and successor April correction, exact independently verified report exports.
- `npm run demo:m7`: six reimbursement artifact orders converge to two Cash debits and receivable credits totaling 1,000 cents each, zero residual receivable/fee/suspense; permanent revocations and statement forward matching preserve cash.
- `node --test test/release-cli.test.ts`: actual terminal and governance CLI children recover/reprint, close/verify, approve/publish and retrieve original signed bytes.

Manual use requires enrolled terminal/operator credentials, trusted public keys, explicit approvals and separate simulator authority configuration; README M3–M7 sections document these. Tests generate isolated keys and credentials. No generated secrets, terminal databases or bundles belong in Git.

## Gate-to-entry-point mapping

Run a listed file with node --test after build:register, or filter by gate using --test-name-pattern. The core suite contains 62 tests: 60 existing milestone tests and two release CLI regressions. The separate filesystem test requires an explicit disposable mount and skips visibly without one.

| Gates | Normal boundary | Executable coverage |
| --- | --- | --- |
| M1-01–07 | terminal CLI/child; /v1/sales | test/milestone.test.ts: nine crash, commit failure, replay, ACK, RLS and receipt controls |
| M2-01–06 | inventory authority; signed quota; sale ingest | test/quota.test.ts: both winner orders/race, issuance/expiry, crash, custody, shortfall resolution and upgrade |
| M3-01–07 | register/browser/local API; /v3/register | test/retail.test.ts: offline crash journey, exact money, cash returns, blind close, devices, recount and upgrade |
| M4-01–07 | independent provider/signer HTTP; payment/register | test/payment.test.ts: capture recovery/hold/refund, grants, chains/forks, page-limit FULL, canaries and upgrade |
| M5-01–02 | module browser/local API; shared retail; booking authority | test/module-completion.test.ts: fractional settlement/tips, mixed work-order invoice/commission, shared backorder |
| M5-03–04 | profiles; station display; fleet admission | test/modules.test.ts and module-completion.test.ts: profile/station/tenant scopes, cursor reload, held worker and another tenant live/recovery progress |
| M5-05–06 | paired restore/replay; migration runners | module-completion.test.ts: fresh restore, exact voucher/hold, quarantine/gap fence and populated 005 upgrade |
| M6-01–06 | /v6/governance; common ledger and CLI | test/governance.test.ts: custody, period races, signed bundle/backing restore, bridge, export race and 006 upgrade |
| M7-01–07 | treasury governance; independent bank/agency HTTP | test/treasury.test.ts: uncertain execution, six permutations, sealed allocation, statements/amendments, revocation, reporting/restore and 007 upgrade |
| Release CLI | actual terminal/governance child processes | test/release-cli.test.ts: offline exact receipt; verified seal/plan/export and historical retrieval |
| Release storage | retained capture/signer; final retail recovery | test/storage-filesystem.test.ts: tmpfs ENOSPC, SQLite result 13, rollback, reopen and exact signed receipt/SYNCED |

## Fresh and populated migration

Cloud runner applies 001–008 transactionally under a schema advisory lock; terminal opening applies local 001–006. Manual migration: `node --env-file=.env src/migrate.ts` with dedicated owner/runtime roles per README. Re-running preserves records. Never rewrite applied migrations.

Each test database is freshly migrated twice. Populated controls preserve:
- M2-06/M3-07: v1/v2 receipt/event BLOBs, digests, vouchers and quota cutover fences.
- M4-07: retail receipts and signed outcomes through payment/fiscal upgrade.
- M5-06: populated 005 to 006 original local receipt and cloud voucher.
- M6-06: populated 006 to 007 journals, immutable artifacts and captured-funds hold.
- M7-07: populated 007 to 008 exact sale voucher/signature, seal bundle and published report; tenant denial and authorized successor posting.

Privileged fixture schema-removal helpers are test-only, not deployment procedures.

## Trust/write-boundary review

This focused entry-point/database review is not a penetration test or compliance assessment.

- Trusted tenant context is transaction-local on pooled connections; forced RLS and tenant-scoped foreign keys constrain runtime access. Migration/fixture roles are separate.
- Legacy, retail/module, payment/refund and governed journals enter the common ledger through shared period locks and append-only database triggers. Close acquires the exclusive lock before a subsequent READ COMMITTED membership query. Runtime direct ledger mutation is denied. Exact replay returns the old result; first-seen sealed facts are held or authorized into an open successor.
- ACK validation binds actual response bytes/status/disposition to the stored request digest and identity. A key ID only selects trusted keys. Provider, fiscal, custody, capability, seal, report, bank and agency artifacts have purpose/scope checks.
- Register sessions are authenticated, loopback-bound and origin-checked. Browsers receive no cloud credentials/signing keys. Kitchen credentials constrain station/location; trusted code enforces capability and role.
- Governance requires its own enrolled operator and signer. Ordinary terminal credentials cannot submit close/treasury actions. Independent fixtures use separate trust keys and authentication. In-process fault observers and privileged fixture SQL are absent from ordinary operator routes.
- Durable MAY_HAVE_SENT precedes external I/O; unknown status holds original attempts. Stored fact replay does not dispatch a new operation.
- Existing controls reject forged known-key signatures, cross-tenant scopes, conflicting exact-body evidence and synthetic sensitive-data canaries. Source/configuration inventory excludes generated private keys and local databases.

## Recovery and storage boundaries

M5–M7 restore uses **quiesced paired OmniPoint SQLite/PostgreSQL images** plus retained later verified images with known cuts/cursors/digests. It supplies actual backing data, verifies coverage before mutations and quarantines invalid replay without blocking unrelated work. This is not continuous production backup/PITR.

M6 restores seal backing, successor linkage, exact vouchers and a captured-funds hold. M7 additionally verifies two seals, signed historical reports, canonical bank identities/aliases, permanent revocation tombstones, unresolved statement envelope and original external filing attempt. Missing/altered segments fence resumption. Original replay adds no journal; a supported successor adjustment posts once.

Independent provider, signer, bank and agency SQLite stores remain available and restart against retained state. They are **not restored by the paired-image protocol**. Recovery queries original external identities. Catastrophic loss/rollback of these authorities requires separate backup and operator/status evidence. Block mutations/external dispatch until restored data and authoritative status are reconciled.

M4-06 produces genuine SQLITE_FULL using a SQLite page limit. The release test separately fills a dedicated 32 MiB tmpfs with allocated bytes until ENOSPC, then attempts POS recovery after provider capture and signer commit. It checks SQLite code 13, rollback/no phantom receipt or quota spend, unchanged old outbox, reopen, original proof and durable SYNCED. It never fills the host filesystem.

```sh
storage_root="$(mktemp -d)"
sudo mount -t tmpfs -o size=32m,mode=1777 tmpfs "$storage_root"
export OMNI_STORAGE_FAULT_ROOT="$storage_root"
npm run test:storage
sudo umount "$storage_root"
rmdir "$storage_root"
```

Use cleanup even on test failure. The test refuses non-Linux, non-tmpfs, missing disposable opt-in or capacity outside 8–64 MiB. tmpfs exhaustion does not prove physical media/controller or host-power-loss durability. Windows here has no administrator access or usable WSL/Docker; no constrained native Windows filesystem result is claimed.

## Evidence and release decision

Local: Windows, Node 24.22.1, npm 11.19.1, dedicated native PostgreSQL 17.11. Type checking and both new CLI tests passed before snapshot. Clean-checkout/full evidence pending.

Historical M4 [run 42914815853](https://github.com/d-Lucx/OmniPoint/actions/runs/42914815853) failed on c91b1d1 with asynchronous PostgreSQL teardown errors despite 37 passing assertions. It is not candidate success.

Candidate hosted Ubuntu and filesystem results pending. CI installs pinned dependencies, Chromium and PostgreSQL, runs every core suite/process-kill journey and the bounded tmpfs test, and uploads SHA/log artifacts on success or failure. Final evidence will name tested commits and runs.

Production requirements remain live payment/fiscal/bank/agency contracts, approved accounting/tax/jurisdiction mappings, real peripheral validation, hardware rollback resistance, backup retention/RPO/RTO, throughput sizing and host-power-loss testing. Synthetic approvals and mappings are fixture inputs.
