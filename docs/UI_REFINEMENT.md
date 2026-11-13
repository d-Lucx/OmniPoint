# OmniPoint operational refinement

Kind: employee-facing transactional POS. Build on the existing 2026-11-11 overhaul, preserving teal/neutral identity and local system fonts. No marketing layout/deal/motion recipes apply. Voice: short task instructions with exact financial labels.

## Starting evidence

`main` at 3ea424a5b52c210e87c4a3cd44fa1aaf1215bad8 with the prior overhaul already modified/untracked. No reset, discard, commit or production-data replacement. Relevant source snapshots retained in `C:/Yan2_Projects/POS/.release-verify/refinement-start`. README/manual/audit/design system and all prior screenshot/test evidence remain intact.

Fresh baseline: TypeScript/build passed; full disposable suite **69/69 passed**, 198.2 seconds. Python/Python3 Store aliases remain unusable; `py` is absent. Use explicitly identified built-in UI/UX Pro Max rules, not fabricated search output. Accepted MASTER read before changes. Its useful tokens and React/plain-CSS stack remain.

## Five observed problems and plan

1. **Payment discovery:** at 1366×768 a two-line $13.20 basket pushes cash/payment below the fold; on 390px the catalog precedes a long basket scroll. Add an in-page keyboard/touch payment jump with current total. Keep natural document flow and every recovery instruction visible.
2. **Basket scanning:** amounts sit beneath names, quantity labels repeat SKUs, and price columns do not align. Use explicit item/quantity/amount columns on wide screens and a legible stacked row on narrow screens. Retain variant, unit price, tax and discount details and existing accessible control names.
3. **Form proportions:** the wide-screen cash field is only 160px because a later money-input rule wins; a detached dollar prefix weakens grouping. Give currency controls a shared bordered addon and flexible full-width input, preserving exact parsing/validation. Use readable disabled states rather than low-opacity text.
4. **Action hierarchy:** support refresh, cash tender, captured-funds refund and kitchen cancellation share filled teal emphasis. Keep main next actions filled; use consistent secondary and danger treatments for recovery/support/destructive actions. No permission or request changes.
5. **Outcome hierarchy:** receipt cloud and goods outcomes share one prose block; diagnostics reads as dense bullets and workflows nest similar panels. Separate local/cloud/fulfillment facts, provide concise record rows, and group related workflow/cash forms with consistent section headings and spacing. Keep timestamps, exact IDs in evidence, original receipt bytes, error/live-region semantics and all necessary descriptions.

Before evidence from the current running overhaul: [register](ui-refinement/before-register-1366.jpg), [narrow register](ui-refinement/before-register-390.jpg), [recovery](ui-refinement/before-recovery-390.jpg), [receipt](ui-refinement/before-receipt-390.jpg). These supplement rather than replace the earlier delivery screenshots.

## Reproduced defect within the changed navigation journey

From Workflows, keyboard-activate Skip to content. `#main` currently falls through the hash route parser and selects Register, unmounting the workflow and losing unsaved draft fields. Fix only destination-hash handling: known destination hashes select screens; in-page anchors preserve the current screen. Add a persistence-backed browser regression asserting the UTC draft value survives, basket/cash/search survive navigation, and the new payment jump submits no sale. Do not change operation identities or server contracts.

A second reproduced read-state defect: workflow tender saves a real receipt/event but the parent shell retains its earlier pending count and Diagnostics snapshot. The regression observed `register.state().pendingCount === 3` while the UI still showed two pending events. Refresh the existing read-only `state` after an event-driven workflow operation completes, before releasing its local busy fence. This keeps the shell current even before leaving Workflows. The callback is never invoked by rendering or the initial effect, creates no mutation/operation ID, and does not alter service contracts. Receipt-count assertions prove navigation adds no sale. Both defects were observed in failing browser regressions before their fixes.

## Execution and validation

- [x] Implement shared control/spacing/action refinements and register composition.
- [x] Apply matching receipt/diagnostic/workflow/kitchen treatments.
- [x] Build/type-check and focused real persistence/UI regressions.
- [x] Full integration suite alone against README disposable PostgreSQL; retain original exact-byte, one-time-effect, authorization and finance checks.
- [x] CUA review at 1366/1280/768/390/320; comparable populated and recovery screenshots and keyboard/error checks. Actual 200% zoom remains unverified as described below.
- [x] Append current results and limitations to audit/validation; staff changes only for delivered labels/navigation.

Taste-skill's standalone Chrome gate is unrun because manual browser interaction must use CUA and marketing section/hero checks do not apply. No GATE: PASS claim. Actual 200% zoom, Linux tmpfs, physical hardware and live providers require separate evidence; narrow reflow alone is not a zoom result.

## Delivered implementation

The basket now aligns item, quantity and line amount, retains unit/tax/discount information, and places totals and cash entry in a distinct payment section. A two-item basket's cash action fits the tested 1366×768 window; longer baskets retain natural scrolling and a keyboard-accessible **Go to payment** link. Currency prefixes and inputs share one full-width control. Receipt facts distinguish locally saved, cloud-confirmed/held/pending, and inventory fulfillment outcomes. Supporting actions are secondary; refunds, unpaid-return release and kitchen cancellation have consistent danger treatment. Diagnostics rows and workflow sections use the same restrained spacing and hierarchy.

Changed presentation files: `src/ui/register.css`, `register.tsx`, `components.tsx`, `module-views.tsx`, and `retail-diagnostics.tsx`. Meaningful regression additions are in `test/retail.test.ts`. Staff instructions, README links, MASTER, audit and validation notes reflect the delivered interface. Existing uncommitted work in other files remains intact.

No API action/schema, migration, ledger service, tenant/authorization rule, operation identity or storage key was changed by this refinement. `money.ts` and `pending-request.ts` match the pre-refinement snapshots. The only behavioral fixes are the two reproduced UI navigation/read-state defects above. Original printable receipts and persisted event bytes remain checked against their stored values.

## Verification results

Final report completed on 2026-11-13; captures and implementation-session evidence retain their original timestamps. The final suite completed before handoff; it is not inferred from the earlier baseline.

| Check | Actual result |
| --- | --- |
| `npm.cmd run check` | Passed |
| `npm.cmd run build:register` | Passed; local React/plain-CSS assets built |
| `npm.cmd test` | **70 passed, 0 failed, 0 skipped**, 200.3 seconds; [full final output](ui-refinement-tests.log) |
| Focused retail/payment/module/UI checks | 10/10 passed; subsequent read-refresh group 6/6 passed; receipt/backorder check 1/1 passed |
| New regression red/green | Skip-link draft loss and stale parent pending count each failed before its fix, then passed against real fixture persistence |
| `npm.cmd run test:storage` | 1 skipped on Windows; bounded Linux tmpfs gate unavailable |
| `git diff --check` | Passed |
| Taste source copy lint | 0 failures, 3 warnings from JavaScript `!` operators; not a rendered-copy certification |

The complete suite retains exact-byte replay, one-time sale/stock/payment/refund effects, original-attempt recovery, blind close, uncertainty fences, server authorization, migration and governed-finance checks. Disposable fixture databases and simulated peripherals/providers were used throughout. No live financial action or production data was used.

CUA exercised populated scan/search and cash/change, navigation/reload with the same pending request, receipt lookup/sync and fulfillment facts, a supervised return with uncertain payout blocking blind close, payout confirmation, service estimate invalidation/reapproval and exact invoice recovery, hospitality split/partial cash/tip/original receipt recovery, and scoped kitchen ready/disconnected states. Existing persisted integration tests cover the dropped cloud response, offline/crash replay and uncertain original card attempt. These claims are based on both browser journeys and database assertions, not screenshots alone.

## Comparable visual evidence

Before captures show the already-overhauled interface that this task refined. The matched register contains Blue and Red mugs, quantity one each, total $13.20, cash $20.00 and change $6.80. Full-page screenshot width excludes a scrollbar where present.

| Screen | Before | After |
| --- | --- | --- |
| Populated register, 1366×768 | [Before](ui-refinement/before-register-1366.jpg) | [After](ui-refinement/after-register-1366.jpg) |
| Populated register, 390px | [Before](ui-refinement/before-register-390.jpg) | [After](ui-refinement/after-register-390.jpg) |
| Pending/error recovery, 390px | [Before](ui-refinement/before-recovery-390.jpg) | [After](ui-refinement/after-recovery-390.jpg) |
| Original receipt, 390px | [Before](ui-refinement/before-receipt-390.jpg) | [After](ui-refinement/after-receipt-390.jpg) |

Additional actual screens: [1280px register](ui-refinement/after-register-1280.jpg), [768px register](ui-refinement/after-register-768.jpg), [payment jump destination](ui-refinement/after-payment-390.jpg), [confirmed receipt](ui-refinement/after-receipt-confirmed-390.jpg), [close blocked by uncertain payout](ui-refinement/after-blocked-close-390.jpg), [workflow groups](ui-refinement/after-workflows-1280.jpg), [narrow workflows](ui-refinement/after-workflows-390.jpg), [large basket/amount](ui-refinement/after-large-basket-390.jpg), [kitchen ready](ui-refinement/after-kitchen-768.jpg), and [explicit disconnected kitchen](ui-refinement/after-kitchen-stale.jpg). `after-diagnostics-390.jpg` records the earlier stale parent read that prompted the second regression fix; it is retained as historical evidence, not proof of final state freshness.

## Accessibility evidence and remaining limits

No horizontal overflow was observed at 1366, 1280, 390 or the 320px stress width; 768px register/workflow/kitchen layouts were visually reviewed. A three-line basket, quantity eight and a large entered currency amount retained readable flow. The payment link focuses its section; Tab reaches cash entry. Skip to content preserves the active workflow and draft. Recovery input and operation identity survive navigation/reload. Reviewed narrow controls met the 44px target check. Reduced-motion handling remains local CSS. Calculated representative contrast ratios are 14.56:1 body text, 5.62:1 muted text on muted surface, 6.82:1 white on primary, 5.23:1 disabled text, and 6.60:1 danger text.

Actual 200% browser zoom is **unverified**: IAB Ctrl-plus did not change measured viewport/scale and native Chrome access was unavailable. Narrow reflow is separate evidence. No full screen-reader audit or WCAG certification is claimed. Long baskets still require scrolling; the payment jump is provided without an overlay that obscures content. Linux storage exhaustion, physical readers/drawers/printers, live providers and host-power-loss behavior remain outside this Windows simulated run. Inventory administration, treasury, period close and signed reporting remain on their documented operator/CLI paths; no fabricated browser permissions or data were added.

Preview services and temporary browser tabs were closed after review. No commit, merge, push or deployment was performed.
