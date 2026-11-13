# OmniPoint operational UI audit and delivery checklist

Kind: employee-facing offline transactional application. Voice: direct operational instructions, exact amounts, no promotional copy.

## Baseline and approach

Checkout inspected on 2026-11-11: main at 3ea424a5b52c210e87c4a3cd44fa1aaf1215bad8. Pre-existing README edits and untracked USER_MANUAL.md / UI_UX_OVERHAUL_PROMPT.md are retained. React 19, TypeScript, plain CSS, esbuild, Node 24.22.1. No AGENTS.md found. TypeScript baseline passed; test results are recorded in UI_UX_VALIDATION.md.

Keep the existing register/controller boundaries; extract presentation and exact money entry rather than rewrite services. A CSS-only reskin would leave tasks and recovery buried. A replacement backend or component library adds unnecessary contract risk. Five destinations: Register, Receipts & returns, Shift & cash, Workflows, Diagnostics. Checkout remains one action away.

## Authority and task map

| Person / task | Current action contract | Offline / recovery |
| --- | --- | --- |
| Cashier / scan, add, quantity | Local register scan/add/quantity; catalog snapshot, quota fences | Local; server validates stock and quantities |
| Supervisor / discount | discount + reason/PIN, signed authority | Existing local supervisor authority; server checks PIN |
| Cashier / open, cash sale | open/checkout; stable request UUID | SQLite atomic completion; recover receipt by original request; sync separately |
| Cashier / card | card-start/recover/retry | Enrolled reader only; MAY_HAVE_SENT and fiscal holds require original attempt; replacement/refund supervisor gated |
| Staff / receipt and paper | receipt/reprint with original identity + command UUID | Local original bytes; physical device delivery may remain uncertain |
| Supervisor / refund | reserve-return, begin-payout, confirm-payout, release-return | Online reservation; durable uncertain payout; signed confirmation or nonexecution evidence; close fenced |
| Cashier / shift close | close denomination count | Blind until commit; revision requires predecessor/reason/PIN; drops require destination authority |
| Hospitality / table, ticket, split | seat-table, dispatch-ticket, split-checks | Enabled signed profile; revision checks, frozen split; local module state |
| Hospitality / tender | module-tender | Original tender UUID, before/paid/tip; receipt recovery; inventory/sync separate |
| Kitchen / prepare | station-scoped feed, ready/cancel | Station credential; cursor replay on reload; disconnected display is stale |
| Services / booking | appointment-draft/book | Draft local; authority confirms, contention may hold |
| Services / work | intake/estimate/authorize/start/module-tender | Revision invalidates consent; supervisor + customer reference; exact invoice |
| Support / exceptions | sync/dispatch/check-device/storage/module-diagnostics | Signed ACK required, device uncertainty evidence, quota/custody/fleet pressure |
| Manager / inventory | inventory CLI + /v2/inventory operator contracts | Separate operator credentials; receiving/count/custody/shortfall evidence |
| Finance / treasury, seals, reports | governance CLI + /v6/governance and treasury authority | Separate operator/signer; append-only facts, exact reporting slices and historical exports |

Manager browser authority is absent from the cashier session. Keep existing inventory/governance CLI paths: do not put operator credentials in browser, create a role selector, fabricate aggregates, or add backend authority in this overhaul. Receipt lookup currently returns line ID/SKU, not a remaining-returnable quantity read model; use named line selection and server reservation validation, without inventing availability.

## Accepted system and skill applicability

No prior design-system/omnipoint/MASTER.md exists. Python and Python3 Store aliases fail to execute; py launcher missing. Search database recommendations could not run. MASTER.md is an explicitly manual synthesis of UI/UX Pro Max built-in accessibility/form/navigation rules and taste-skill craftsmanship, not generated search output.

Use neutral light surfaces, deep teal primary action, visible amber focus, 16px system font, tabular currency, 4/8px spacing, 44px controls, one radius/button system. Desktop: catalog + basket; tablet/narrow: stacked natural document scrolling. No fixed bottom panel obscures controls. Technical IDs in evidence disclosures; real receipts remain unchanged. Status text always accompanies color. No external fonts/assets/analytics.

Taste-skill system/copy/copy-voice/layout references inform aligned edges, hierarchy, readable forms, and plain feedback. Its full-screen hero/section heights, deal/moments, photos, shaders, invented contacts, missing caption rule and motion recipes conflict with the explicitly authorized POS brief and are inapplicable. Keep authentic business data and evidence captions. No marketing assets or kit JS copied. CUA is the sole manual browser automation route; skill scripts that launch another Chrome stack and marketing gate are not run. No GATE: PASS claim.

## Implementation plan / checklist

- [x] Phase A: shared tokens/components, five-destination shell, labeled focus/error states, exact currency input.
- [x] Phase A: scan/search/cart, discount, cash/change, durable local receipt and separate sync/fulfillment status.
- [x] Phase A: original receipt recovery/reprint, guided receipt-line return, explicit payout uncertainty.
- [x] Phase A: blind close/drop/revision; persistent recovery and repeat-click fences.
- [x] Phase B: hospitality/service existing contracts, stable action identities and plain state/amount labels.
- [x] Phase B: kitchen freshness and large action feedback; actionable diagnostics.
- [x] Retained operator path: inventory administration, custody, treasury, seals, reporting and exports. Separate operator contracts exist; a cashier browser-session authorization contract for those tasks does not.
- [x] Validation: exact money/recovery/layout regressions, 69-test persistent integration suite, focused journeys, CUA before/after and responsive review, staff documentation. Validation limits remain documented, not passed by assumption.
- [ ] Unavailable validation: actual 200% browser zoom (native app access timed out), Linux tmpfs exhaustion (Windows), physical/live-provider and screen-reader speech checks. See UI_UX_VALIDATION.md for precise evidence and screenshot limits.

## Review focus

Lost response must retain identity and original input. Navigation/reload cannot clear receipt recovery. Invalid currency (exponent, rounding, overflow) must never reach accounting. A saved receipt is distinct from cloud confirmation and stock fulfillment. Expected drawer value must not appear before commit. Small screens, zoom, long IDs/names and pending card/refund holds must stay legible.

## Refinement of the existing overhaul

The later refinement began from all the changes above, with a fresh passing 69-test baseline. It did not use the older merged UI as its starting point. [UI_REFINEMENT.md](UI_REFINEMENT.md) records five observed composition/usability problems, matched before/after screenshots, the implementation and fresh checks. The original evidence and design decisions above remain historical.

The refinement changes presentation and two reproduced UI read/navigation defects: in-page anchors previously unmounted Workflows, and workflow completion left shell/Diagnostics snapshots stale. New regression assertions failed before each fix. The changes preserve the current workflow draft on skip, perform only an existing read-only state refresh after an event-driven workflow action, and prove navigation adds no receipt. No server, ledger, migration, money parser, pending-request helper, API schema or storage key changed in this refinement.
