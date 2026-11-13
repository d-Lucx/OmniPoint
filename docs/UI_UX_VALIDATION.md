# Operational UI delivery and verification

Taste-skill marketing/browser gate: **not run**. Its standalone Chrome automation conflicts with the prescribed CUA route; hero/dealt-moment/viewport-height marketing checks do not apply to this employee POS. No `GATE: PASS` is claimed. The applicable design decisions are in [the audit](UI_UX_AUDIT.md) and [MASTER](../design-system/omnipoint/MASTER.md).

## Delivered screens

- **Register:** active navigation, scanner with restored keyboard focus, product names/variant/price/tax, quantity removal, line amounts/discounts, exact USD entry, subtotal/tax/total/change, durable original receipt and recovery fence.
- **Receipts & returns:** original receipt/reprint, named receipt-line selection, separate supervisor reservation, one-time payout instructions, uncertain-payout confirmation and verified nonpayment release. An uncertain return blocks a new return request and remains visible elsewhere.
- **Shift & cash:** float/drop in dollars, blind denomination counting, post-commit comparison, supervised append-only revision. Expected cash remains absent before commit.
- **Workflows:** readable money/check balances/work stages, UTC appointment input, draft/confirmed booking distinction, estimate revision and consent explanation, exact invoice amount, receipt recovery. Pending workflow actions retain original input/identity across navigation and restart; PINs are excluded from persistent retry data.
- **Kitchen:** station sign-in, last-update time, explicit stale/disconnected state, queued/ready/cancelled tickets, 52px action buttons and per-operation fencing. Saved ticket actions can recover their original identity. Actions require a successful local station feed less than five seconds old.
- **Diagnostics:** held outcomes and uncertain devices appear first, plain explanations and next steps precede IDs, expandable event/device/grant/return evidence, storage guidance, operator-led administration boundary, existing fleet inspection.

Shared presentation lives in `src/ui/components.tsx`, native semantic forms/buttons/details use one CSS token system, and money/retry helpers are isolated. No dialogs or new backend privileges were necessary. Existing hospitality menu/table/staff fixtures remain explicitly demonstration data.

## Contract preservation

No domain services, migrations, authorization routes, wire schemas, event encoders, receipt renderers or accounting logic changed. Stored receipt text is rendered verbatim. Existing exact-byte/digest/voucher/tenant tests remain in the full suite. UI retries retain original identities; uncertain card/payout actions never create a replacement attempt automatically. No role switcher, browser operator credential, external asset/font, analytics or design-service data transfer was introduced.

Inventory receiving/counts/custody, treasury, period close, and signed reporting remain on the authorized inventory/governance CLI paths documented in the user manual. Cashier-session authority does not expose their operator read/write contracts. Return lookup exposes original line IDs/SKUs, not a remaining-returnable-quantity read model; the server validates reservation quantity. Recent state lists contain up to 40 entries; absence of an older receipt from that view does not imply lack of synchronization.

## Actual validation

Environment: Windows, Node 24.22.1, PostgreSQL 17.11 on the documented disposable loopback service. Test fixtures create randomized databases/roles and temporary SQLite stores. Existing deployment/demo data was not replaced. Native Python/Python3 are unusable Store aliases and `py` is missing: design search and generated persistence were unavailable; the checked-in system is explicitly a built-in-rule synthesis.

- Baseline: `npm.cmd run check` passed; `npm.cmd test` passed **64 tests**.
- Added money and persistent-request helper tests were observed failing before implementation and then passing.
- New real register browser journey verifies decimal rejection, insufficient-cash correction under the original ID, double-click fencing, discount, change, one receipt, original reprint, supervised return, close blocked by payout uncertainty, confirmation, blind close and revision, unchanged event bytes.
- New workflow journey discards real HTTP responses after SQLite commit, reloads, and replays identical seat/tender requests, asserting one receipt and unchanged event bytes. It does not substitute mocked persistence.
- New layout journey verifies a long name, maximum quantity eight, $1,000,000 input, scanner focus, reduced motion, and no horizontal overflow at 1366/1280/768/390/320px.
- Focused final UI/hospitality/services/kitchen run: **6 passed**; separate long-name/reduced-motion run: **1 passed**.
- An intermediate full run passed **67 tests**. A later run of 68 tests had **one cleanup failure** in `M7-05 permanent revocation, early reinstatement, continuity and open-period inverse`: PostgreSQL `57014` statement timeout at `test/fixture.ts:54` during `DROP DATABASE`. The treasury worker stayed alive and was stopped after its tests finished so the reporter could exit. The isolated test passed. This happened while a separate focused test job was also using disposable fixture setup/cleanup; contention is an inference, not a proven product defect. No finance assertions or database timeout settings were changed. The failed log is retained at `../.release-verify/ui-cleanup-timeout.log` relative to the repository root.
- Final isolated run: `npm.cmd run check` passed; `npm.cmd test` passed **69/69**, zero failures/skips, in 178.3 seconds. This includes the previously timed-out treasury cleanup. [Retained final integration output](ui-final-tests.log). Build completed at 262.8 KiB minified JS (local assets only). `git diff --check` passed; Git only reported its normal LF-to-CRLF working-copy notices.
- `npm.cmd run test:storage`: **1 skipped**, explicitly requiring an 8–64 MiB disposable Linux tmpfs. No filesystem was filled on this Windows host. Existing SQLite page-limit exhaustion remains exercised in the full suite.

The existing integration harness uses its established installed-Edge Playwright tests as explicitly requested for regression coverage. Manual browser operation and screenshots used CUA only. No taste-skill browser runner, replacement browser stack, or externally hosted design service was used.

## CUA visual and accessibility review

Actual running application reviewed at 1366×768 and 1280px register widths, 768px tablet, 390px narrow and 320px stress width. Register payment action was visible at 1366×768 with a one-line basket. Catalog and basket stack in document flow on narrow screens; scrolling is required and no sticky panel covers actions. CUA read-only DOM measurements found no horizontal overflow or sub-44px register form/button/select/summary heights at checked sizes. Longer baskets naturally require scrolling.

Observed: first Tab shows the skip link and focus ring; successful scan returns focus to scanner; scanner failure preserves text, exposes `aria-invalid`/`aria-describedby`, and focuses the alert; semantic navigation announces active destination. Real cash receipt and named return line, hospitality dispatch/check tender, service intake/estimate, kitchen queued→ready, and disconnected station views were inspected. A stale hospitality revision after a kitchen update was correctly rejected and refreshed; final copy explains the required review/retry.

Calculated contrast ratios on actual CSS pairs: ink/white **14.56:1**, muted/white **6.35:1**, white/teal button **6.82:1**, warning **7.70:1**, success **7.92:1**, error **6.60:1**, focus/white **7.10:1**. State labels accompany colors. Reduced motion is exercised in the browser regression; no automatic decorative motion exists. The application intentionally supplies one light theme.

Actual **200% browser zoom remains unverified**: IAB shortcut did not establish a measurable zoom change and native Chrome app access timed out. Small-width reflow was tested separately, not represented as an actual zoom pass. No screen-reader speech audit, physical scanner/printer/drawer/reader validation, live payment/fiscal/bank/agency provider validation, or complete WCAG 2.2 AA certification is claimed. Browser scope and remaining validation limits are explicit.

## Screenshots

Captured from disposable synthetic data through CUA; these are actual application states, not mockups. Full-page screenshots include controls below the fold.

| View | Evidence |
| --- | --- |
| Before (partial capture) | [Original register](ui-screenshots/before-register.jpg); the baseline viewport-resize capture retained only 752×768 pixels and clips the right side. It is not a full-width comparison. |
| After, 1366×768 | [Register and basket](ui-screenshots/after-register-1366.jpg) |
| After, 1280px | [Register](ui-screenshots/after-register-1280.jpg) |
| Tablet, 768px | [Stacked register](ui-screenshots/after-tablet-768.jpg) |
| Narrow, 390px | [Register](ui-screenshots/after-narrow-390.jpg), [receipt and return](ui-screenshots/after-receipt-390.jpg) |
| Hospitality | [Checks and workflow receipt](ui-screenshots/after-workflows-tablet.jpg) |
| Service, 390px | [Estimate and consent](ui-screenshots/after-service-390.jpg) |
| Kitchen | [Ready ticket](ui-screenshots/after-kitchen-768.jpg), [disconnected display](ui-screenshots/after-kitchen-stale.jpg) |
| Diagnostics, 390px | [Actionable outcomes](ui-screenshots/after-diagnostics-390.jpg) |
| Scanner error, 390px | [Preserved input and error](ui-screenshots/after-scan-error-390.jpg) |

No visual facts, contacts, providers or prices were invented. Receipt organization data and operational evidence captions were retained. Copy lint ran on the three TSX screen sources: zero failures, three `copy-exclaim` warnings caused by JavaScript logical/non-null operators; retained because these are code, not printed exclamation marks. The marketing layout/performance gate was not run, and this limited source scan is not a rendered-copy certification.

For an independent disposable manual review, set the README test environment variables and run `node test/ui-preview.ts` in an interactive terminal, then open `http://127.0.0.1:4318`. It provisions generated fixture tenants/keys and simulated devices, not deployment data. Enter `exit` in that terminal to close services and remove its generated database/SQLite resources. Review credentials printed there are synthetic fixture credentials. Automated verification remains `npm.cmd test`.

## Staff handoff

[USER_MANUAL.md](USER_MANUAL.md) now matches the five destinations and dollar entry, named return line, original-action recovery, stale kitchen behavior and operator-only administration. README links to the manual, audit, design system and this report. No merge, push or deployment was performed; source and evidence remain in the working tree for review.

## Later working-tree refinement

The observations and 69-test result above belong to the first overhaul. The subsequent refinement kept that implementation and its evidence intact, established a new 69/69 baseline, and added a navigation/read-state regression plus receipt-backorder UI assertions. See [the refinement report](UI_REFINEMENT.md) for the current delivery and separately named logs/screenshots. Earlier before/after captures were not overwritten.

Current refinement handoff: **70/70 tests passed**, zero failures/skips, 200.3 seconds; TypeScript, register build and whitespace checks passed. [Final suite output](ui-refinement-tests.log). The report records CUA viewport/keyboard/recovery checks, both reproduced UI defects and red/green regressions, and remaining actual-zoom/Linux-storage/hardware limits. This result applies to the inspectable working tree, not a new release commit or production qualification.
