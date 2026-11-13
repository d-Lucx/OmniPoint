# OmniPoint — improve the UI while preserving functionality

Copy the following prompt into a new session with the OmniPoint repository open.

---

Improve the visual design and usability of the **existing OmniPoint application**. Implement and verify the improvements. Preserve every working transaction, recovery path, permission check, and accounting rule.

This is a refinement of the current interface. The working tree already contains a UI overhaul, shared components, money-entry helpers, recovery helpers, tests, a design system, screenshots, and validation notes. Inspect and build on that work. Do not reset, discard, overwrite, or replace existing changes. Do not assume that the older merged UI is the current starting point.

## Required skills

Read and use both:

1. **[$ui-ux-pro-max](C:/Users/Renelyn/.agents/skills/ui-ux-pro-max/SKILL.md)** — task flow, accessibility, forms, responsive layout, typography, colors, and React implementation guidance.
2. **[$design-taste-frontend](C:/Users/Renelyn/.agents/skills/design-taste-frontend/SKILL.md)** — the installed taste-skill: visual judgment, consistent components, aligned edges, considered typography, concise copy, and actual browser review.

Announce their use. Read the existing `design-system/omnipoint/MASTER.md` before proposing visual changes. Follow UI/UX Pro Max's search workflow when a verified local interpreter is available. Use the detected React stack; do not assume Next.js or Tailwind. If a tool cannot run, document the limitation and use explicitly identified fallback guidance. Do not invent skill results, overwrite the accepted design system with generated defaults, or claim a visual gate passed without running it.

**Project-specific instruction for applying taste-skill:** OmniPoint is an employee-facing transactional POS. Apply its craftsmanship to functional screens. Preserve necessary descriptions, field labels, financial details, and evidence captions. Use restrained interaction feedback and reduced-motion support. Marketing heroes, full-screen promotional sections, shaders, stock photography, decorative loops, and invented metrics are outside scope. Do not copy a reference site's code or distinctive assets. Use the environment's prescribed browser/computer-use tooling; report any incompatible skill checker as unrun rather than bypassing that tooling.

## Establish the actual starting point

Repository: `C:/Yan2_Projects/POS/OmniPoint`.

1. Read applicable repository instructions and inspect Git status and diff. Identify the pre-existing changes and keep them intact.
2. Read `docs/UI_UX_AUDIT.md`, `docs/UI_UX_VALIDATION.md`, `docs/USER_MANUAL.md`, `docs/RELEASE_READINESS.md`, and the design-system master. These describe prior observations, not proof of the current checkout passing.
3. Inspect `package.json`, `src/ui/register.tsx`, `register.css`, `module-views.tsx`, `retail-diagnostics.tsx`, `components.tsx`, `money.ts`, and `pending-request.ts`, plus the corresponding server contracts and tests.
4. Run the application in its documented disposable environment. Inspect actual populated screens and exception states before changing the design. Take comparable before screenshots.
5. Establish current TypeScript/build/test results. Keep existing failures separate from regressions introduced by this task; investigate rather than concealing them.

The detected stack is React, TypeScript, plain CSS, and esbuild. Keep it unless an unavoidable, documented requirement demands otherwise. Prefer small, reviewable presentation changes over a framework migration or wholesale rewrite.

## Desired result

Make the register look deliberate, polished, and easy to operate during a busy shift. Prioritize:

- Clear hierarchy between current task, supporting information, and technical detail.
- A cohesive spacing, type, color, border, radius, and elevation system.
- A balanced catalog-and-basket layout with readable product names, quantities, prices, tax, discounts, totals, and change.
- A prominent payment action that remains easy to find without covering content.
- Consistent navigation, section headings, forms, buttons, alerts, receipt views, tables, and lists.
- Clear distinction between primary, secondary, destructive, disabled, busy, and recovery actions.
- Legible financial amounts using aligned tabular numerals where useful.
- Plain status messages explaining what happened and what the employee should do next.
- Useful empty, loading, validation, offline, stale, pending, success, and held states.
- A credible operational interface with restrained color and minimal visual clutter.

Show meaningful improvements to actual screen composition, spacing, and interaction clarity. Avoid changing only the accent color or adding more rounded cards. Keep the established identity where it works. Do not hide important information merely to make screenshots look cleaner.

## Functional preservation contract

Treat these as acceptance requirements, not implementation suggestions:

| Area | Must remain unchanged in behavior |
| --- | --- |
| Checkout | One committed sale, original receipt, correct tax/change, correct stock effect |
| Local persistence | SQLite commit boundaries, saved operation identity, exact stored event bytes and digest |
| Recovery | Crash/reload/navigation and lost responses recover the same operation, receipt, and payment attempt |
| Cloud sync | Original payload replay, signed ACK verification, duplicate delivery safety, durable pending/held outcomes |
| Money entry | Exact integer-cent parsing and existing rounding; no floating-point accounting drift or unit conversion regression |
| Inventory | Quota, custody, expiry, fulfilled/backordered lines, and unresolved capacity fences |
| Card payments | Original-attempt status/retry, fiscal holds, supervised replacement/refund, no extra capture or cash-drawer pulse |
| Returns | Original receipt/line eligibility, quantity/tax allocation, authorization, one-time payout, uncertainty and nonpayment evidence |
| Cash close | Blind counting before expected amount is revealed, uncertain payout close-blocking, supervised revisions |
| Hospitality | Revision-aware kitchen tickets, station scope, frozen check splits, partial tender, tips, original receipts |
| Services | Draft versus confirmed booking, UTC meaning, estimate revisions invalidating approval, consent, exact invoice |
| Finance | Sealed journals, append-only corrections, evidence lineage, tombstones, exact reporting slices, historical signed exports |
| Security | Server authorization, tenant/station boundaries, session/origin checks, supervisor requirements, secret separation |

Do not rename API actions, alter request/response schemas, rewrite migrations, modify ledger logic, or regenerate old receipts/events/vouchers for a visual change. Keep existing operation IDs and storage keys stable. Do not create new requests from render/effect code or replace stable IDs with newly generated IDs on a retry.

Navigation and dialog changes must preserve the current basket, pending request, entered values, and recovery context. Verify that moving or unmounting components does not reset or duplicate work. Do not remove `aria-live`, accessible names, focus behavior, or testable semantic relationships during component cleanup.

Do not bypass a backend error to make a flow appear successful. A disabled button is not an authorization boundary. A finalized local receipt, verified cloud sync, and fulfilled goods are separate outcomes and must remain separately understandable.

Inventory and governance operations that remain CLI-led must stay accurately described. Do not fabricate a browser manager role, dashboard numbers, permissions, or unsupported workflows.

If a genuine functional defect is discovered, reproduce and document it first. Fix only what is needed to preserve the changed journey, with a meaningful regression test. Keep broader domain changes separate from this visual refinement.

## Accessibility and responsive behavior

- Use semantic controls, visible labels, logical headings, a working skip link, visible keyboard focus, and predictable tab order.
- Preserve scanner-friendly focus and Enter behavior. Opening a dialog must not accidentally submit a sale; closing it should restore useful focus.
- Minimum 44 × 44 CSS pixel primary touch targets with adequate spacing. No hover-only features.
- Normal text contrast at least 4.5:1, state conveyed by words/icons as well as color, and readable disabled/helper text.
- Keep errors near the relevant fields, preserve correct input after recoverable failures, and announce important status without excessive repetition.
- Respect reduced motion. Keep all essential assets local for offline operation; no required external font or CDN dependency.
- Test 1366 × 768 and 1280px register layouts, 768px tablet, 390px phone, and 320px overflow stress. Inspect long baskets, long labels, large amounts, and long IDs.
- Test actual 200% browser zoom if supported. If it cannot be verified, state that explicitly; narrow viewport testing is not a substitute for a zoom result.
- Accessibility checks are evidence for specific behaviors, not an unsupported claim of full WCAG certification.

## Work in controlled increments

1. Identify the five most consequential visual/usability problems from the running app. Write a short refinement plan tied to employee tasks and current screenshots.
2. Adjust shared tokens and components, then refine the main register. Preserve service boundaries and the current design system's useful decisions.
3. Apply the same system to receipts/returns, shift/cash, payment recovery, Diagnostics, hospitality/kitchen, and services. Avoid unrelated feature work.
4. After each meaningful change, build/type-check and exercise the affected flow. Add tests only for meaningful changed behavior or an identified regression risk; do not create screenshot-only evidence for transaction correctness.
5. Complete the full regression suite against the disposable database. Do not modify test expectations or remove checks just to turn failures green.
6. Inspect the finished app visually and through keyboard/touch operation. Fix layout, focus, loading, and error-state defects before finishing.
7. Update the design audit, validation notes, screenshots, and user manual if labels/navigation actually changed. Preserve earlier evidence as historical rather than replacing it with unsupported claims.

## Required regression evidence

Use the actual scripts and harness in the checkout. At minimum run `npm.cmd run check`, `npm.cmd run build:register`, `npm.cmd test`, and `git diff --check`. Run focused retail/payment/module/UI-money/UI-recovery tests as appropriate. The Linux filesystem-exhaustion test needs its separately documented bounded disposable environment; never fill the user's working filesystem.

Browser-verify the affected flows using real application state:

- Add/scan/search, quantity/remove, discount validation, exact currency entry, cash/change, final receipt.
- Offline checkout and crash recovery; dropped cloud response replay without another sale or stock effect.
- Pending checkout after navigation/reload; no changed-byte duplicate request.
- Receipt lookup/reprint and correctly displayed fulfilled/backordered units.
- Card uncertainty and recovery of the existing attempt; no replacement charge caused by lost UI state.
- Supervised return, uncertain payout, close-blocking, confirmation, and blind drawer close/revision.
- Hospitality dispatch and station freshness, split/partial tender and tips, receipt recovery.
- Service draft/confirmation, estimate change and reapproval, invoice receipt recovery.

Retain meaningful database assertions for one-time effects and exact payloads. Inspect screens with pending, held, failed, and completed outcomes, not only empty or successful states.

Use simulated peripherals/providers in training fixtures. Do not perform real financial actions to prove a visual change.

## Final delivery

Provide:

- A concise explanation of the specific design improvements and their benefit to employees.
- Comparable before/after screenshots of actual populated screens, including a narrow view and an exception/recovery state.
- Files changed, test commands and actual results, any pre-existing failures, and remaining verification limitations.
- Confirmation based on evidence that protected recovery, money, authorization, and accounting behaviors still work.
- Updated staff instructions where the UI changed.

Do not commit, merge, push, deploy, or run destructive cleanup without a separate request. Do not claim completion after only a design proposal: deliver a working refinement and verify it. Start by inspecting the current working tree, existing design system, and running interface.
