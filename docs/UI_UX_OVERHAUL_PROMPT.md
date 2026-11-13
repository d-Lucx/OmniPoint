# OmniPoint UI/UX overhaul — new-session implementation prompt

Copy the prompt below into a new coding session with this repository open.

---

You are implementing a UI/UX overhaul of OmniPoint, an offline POS with retail, hospitality, service, inventory, payments, and governed finance workflows. Carry the work through implementation, meaningful regression tests, browser verification, and updated staff documentation. Begin by inspecting the checkout and existing instructions. Preserve unrelated local work. Do not merge, push, deploy, or replace production data unless separately requested.

## Required skills

Use **[$ui-ux-pro-max](C:/Users/Renelyn/.agents/skills/ui-ux-pro-max/SKILL.md)** throughout the design and review. Read that file and announce its use before starting. Its local search script is:

```powershell
python C:/Users/Renelyn/.agents/skills/ui-ux-pro-max/scripts/search.py "retail POS touch operations" --design-system -p OmniPoint -f markdown
python C:/Users/Renelyn/.agents/skills/ui-ux-pro-max/scripts/search.py "forms focus state" --stack react
```

If `python` is unavailable, try `python3`, then `py -3`. The prompt-preparation session found only unusable Windows Store Python aliases and no `py` launcher; no search-generated design system has been accepted or persisted. Recheck the new environment. If all interpreters are unavailable, use the skill's built-in rules as an explicitly identified fallback; do not invent database search results or install software merely to run the search.

Inspect any existing `design-system/omnipoint/MASTER.md` before changing it. Generate and inspect search recommendations before persisting them. Use `--output-dir C:/Yan2_Projects/POS/OmniPoint` when persisting an accepted system. Do not use `--force` without explicit authorization. Treat a generic SaaS/landing-page recommendation as unsuitable for a working register unless verified against the POS workflow. Read the relevant accessibility/form/navigation rules and `references/pro-rules.md` before final UI review.

### Taste-skill: visual quality and product-specific judgment

Also use **[$design-taste-frontend](C:/Users/Renelyn/.agents/skills/design-taste-frontend/SKILL.md)**, the installed **taste-skill / tasteskill 2.5.1**. Read and announce both skills. Use UI/UX Pro Max for interaction, accessibility, and product/stack guidance; use taste-skill for deliberate typography, aligned edges, disciplined spacing, one consistent component system, plain copy, useful interaction feedback, and browser-based visual critique. Read its relevant `references/system.md`, `copy.md`, `copy-voice.md`, and `layout-v4.md` before implementation.

**Project-specific scope instruction:** this is an employee-facing transactional application. The task is to redesign the working POS interface, not create a promotional website. Apply taste-skill's visual craftsmanship to real baskets, receipts, payment states, kitchen tickets, and service work. Keep the actual product and employee's next task central. Do not add marketing heroes, viewport-height sections, promotional photography, shaders, award-site scenes, decorative loops, or invented business details to operational screens. Keep essential instructions, financial labels, timestamps, and evidence captions where employees need them. Keyboard, touch, reduced motion, accurate state, and offline speed take priority over decorative motion. Retain authentic receipt and organization data rather than applying the skill's fictional marketing contact rules to business records.

The user-authorized POS requirements above govern wherever the skill's website recipes conflict with this application. Record those applicability decisions in the design audit. For a separately requested public marketing page, reassess its full website workflow; such a page is outside this overhaul.

Follow the current environment's required browser/computer-use tooling for real UI testing. Use compatible taste-skill checks only when they fit the app and are permitted by those tool instructions. Report any gate that could not run or is inapplicable, with its reason; never claim `GATE: PASS` without an actual passing result. Do not run a second browser automation stack when the environment requires CUA. Finish with an actual visual review at register, tablet, and narrow widths, explaining any retained visual or accessibility issues.

## Repository and evidence

- Repository: `C:/Yan2_Projects/POS/OmniPoint`.
- Architecture/handoff history: `C:/Yan2_Projects/POS/docs/`.
- Read `README.md`, `docs/RELEASE_READINESS.md`, and `docs/USER_MANUAL.md`.
- Inspect `src/ui/register.tsx`, `src/ui/module-views.tsx`, `src/ui/retail-diagnostics.tsx`, `src/ui/register.css`, register API/runtime, and the tests before designing new controls.
- Current UI stack is React 19, TypeScript, plain CSS, and esbuild. It is not Next.js, Tailwind, or a component-library app. Recheck `package.json`; prefer the existing stack.
- M1–M7 were merged through PR #1 into `main` at `3ea424a5b52c210e87c4a3cd44fa1aaf1215bad8`. This is historical context; establish the actual current branch, HEAD, status, and baseline rather than assuming it is still current.
- The merged baseline had 64 integration tests plus a separate Linux filesystem-exhaustion test. Preserve coverage; do not hardcode that historical count as the current count.
- Existing live validation proved offline checkout recovery, exact replay after a dropped cloud response, supervised cash refund, blocked drawer close during uncertain payout, and a zero-variance close.

## Product outcome

Make OmniPoint understandable and efficient for a cashier during a busy shift, a kitchen employee preparing orders, a service employee managing work, and a manager resolving exceptions. Use a coherent, restrained operational design: legible type, consistent spacing, clear hierarchy, strong focus, and explicit action feedback. Prefer familiar labels and currency values over UUIDs and raw state-machine codes. Keep exact IDs available in details and support views.

Do not turn the register into a marketing dashboard. The cart, totals, payment action, and recovery state should be immediately understandable. Technical evidence belongs in expandable details. Never hide an unresolved financial or fulfillment outcome behind a generic success message.

## Non-negotiable behavior

1. Preserve stored receipt bytes, event BLOBs, payload digests, signed vouchers, migrations, tenant boundaries, and API contracts. Do not reserialize an existing event to make it fit the new UI.
2. Preserve one-time sale, stock, payment, refund, device, and receipt effects. UI retries reuse the original operation identity; rerendering, browser refresh, navigation, or restart must not create a new attempt.
3. Keep offline local completion separate from verified cloud synchronization and from inventory fulfillment. A finalized receipt can include a backorder. Show those outcomes accurately.
4. Never initiate a replacement card charge or payout because a response was lost. Preserve original-attempt recovery and supervisor/evidence requirements.
5. Preserve blind drawer counting: expected cash is revealed only after committing the count. Preserve payout holds, supervised revisions, stock custody fences, and period seals.
6. Keep bank cash facts, agency facts, attribution, and reporting adjustments distinct. Preserve append-only corrections, revoked-attestation tombstones, exact-slice reporting provenance, and historical export retrieval.
7. Hiding a manager control is not authorization. Retain server-side authorization, origin/session checks, credential separation, and station/tenant scopes. Do not add a pretend role selector that grants privileges.
8. Do not send customer, payment, PIN, secret, or evidence data to third-party analytics or design services. Card entry stays on the enrolled reader.

## Scope and information architecture

First map every currently available action, its backend authority, allowed offline behavior, and recovery state. Mark missing capabilities rather than creating inert controls.

### Phase A — daily register and shared components

- Create reusable layout, form, button, dialog, status, table/list, receipt, empty-state, and evidence-detail components with semantic CSS tokens.
- Establish a predictable shell with a clear active destination. Keep checkout one action away; separate sales, receipts/returns, shift/cash, workflows, and support as appropriate to verified capabilities.
- Keep scan/search entry prominent, with predictable scanner focus and keyboard operation. Show product name, variant, quantity, unit/line amount, discount, tax, and total clearly.
- Use currency entry for staff-facing money fields where feasible; convert to integer cents at the boundary with strict validation and no floating-point accounting drift. Explain units wherever cents remain necessary.
- Keep cart/payment context visible on wide screens; use a usable stacked flow on smaller displays without covering actions with sticky panels.
- Give completed checkout a durable receipt/recovery view. Clearly distinguish locally saved, awaiting sync, cloud confirmed, held, and backordered results.
- Give cash refunds a guided original-receipt/line/quantity flow using existing data. Preserve separate authorization, payout uncertainty, confirmation, and verified nonpayment release steps.
- Simplify blind close and supervised recount without exposing expected totals early.
- Make card recovery prominent when unresolved; describe what is known, what remains uncertain, and which original-attempt action is safe.

### Phase B — hospitality, services, and manager support

- Hospitality: tables/seats, modifiers, station dispatch, ticket state, frozen check split, remaining balance, partial cash tender, tips, and original check receipt recovery.
- Kitchen: station sign-in, connection freshness, queued/ready/cancel state, clear large actions, and reload recovery. A stale screen must not look live.
- Services: appointment draft versus confirmed booking, explicit timezone, contention feedback, intake, estimate revisions, invalidated approval, customer consent reference, work start, exact invoice amount, and receipt recovery.
- Diagnostics: group sync holds, payment uncertainty, device checks, quota/custody, storage, and fleet pressure by actionability. Provide a short explanation and next step before raw IDs.
- Manager work: use existing authorized APIs where a real browser workflow can be added without changing domain rules. Inventory administration, treasury, period close, and signed reporting are currently CLI-led. Audit their contracts before adding UI. If a necessary authority/read API is absent, document the gap and keep the working CLI path; do not fabricate dashboard data or quietly expand this task into a backend rewrite.

Deliver Phase A completely before expanding to Phase B. Keep an explicit checklist of what is implemented, retained through the existing operator path, or blocked by an actual missing contract.

## Accessibility and interaction requirements

- Semantic headings, landmarks, real buttons, visible labels, useful accessible names, keyboard navigation, visible focus, and sensible tab order.
- Aim for WCAG 2.2 AA; verify the relevant criteria rather than declaring compliance from appearance. Normal text contrast at least 4.5:1; do not use color as the only state signal.
- Primary touch targets at least 44 × 44 CSS pixels with adequate spacing. No hover-only actions.
- Inline errors tied to fields, actionable error summaries when needed, focus moved deliberately after errors/dialogs, and status announcements that avoid repeated screen-reader noise.
- Support 200% zoom, narrow reflow, long product names, large counts, and unbroken IDs. Test 390px, 768px, 1280px, and a typical 1366 × 768 register window.
- Respect reduced motion. Use subtle transitions only when they clarify a state change. No unnecessary animation library or externally fetched font dependency for core offline operation.
- Busy state and repeat-click fencing per operation. Preserve entered data after recoverable errors. Do not clear a basket or hide a receipt while an outcome is uncertain.
- Avoid nesting unrelated forms or presenting every supervisor field on the main selling screen.

## Implementation and validation plan

1. Inspect instructions and working tree; record baseline commands and results. Use the disposable database setup documented in README. Do not run test setup against deployment data.
2. Write a concise current-state audit, role/task map, screen map, and accepted design system. Include actual failure states and a component plan. Do not stop at planning; continue implementation within the authorized scope.
3. Implement the shared shell and complete the daily register flow. Keep domain behavior in existing services; avoid a wholesale rewrite of the large UI file without first identifying reusable boundaries.
4. Implement remaining prioritized screens in reviewable increments. Add meaningful browser integration coverage for changed user journeys and recovery boundaries. Do not replace real persistence tests with mocked UI assertions.
5. Run TypeScript, full integration suite, appropriate focused demos/browser tests, and whitespace checks. Run the Linux storage gate only in its documented bounded disposable environment; report unavailable validation accurately.
6. Browser-test: scan/search, quantity removal, authorized discount, cash/change, offline checkout/crash recovery, original receipt/reprint, duplicate action protection, dropped cloud response, partial/backordered outcomes, uncertain card recovery, supervised refund, blocked close during payout uncertainty, blind close and revision. Verify hospitality and service paths touched by the overhaul.
7. Check keyboard/touch, focus and errors, responsive layouts, reduced motion, and overflow. Use the prescribed computer-use tooling for UI automation. Capture actual before/after screenshots from the running application.
8. Update `docs/USER_MANUAL.md` and quick-reference sections to match the delivered labels and navigation. Keep current behavior separate from proposals. Update README navigation.
9. Provide a final report with changed screens, screenshots, tests actually run, preserved contracts, remaining operator-only tasks, and concrete limitations. Leave an inspectable working tree; do not claim physical hardware or live-provider validation from simulators.

## Acceptance criteria

- Cashiers can complete and recover a sale without interpreting technical IDs or raw internal states.
- Every changed financial action retains its original idempotency/recovery behavior and server authorization.
- Offline, pending, fulfilled, backordered, confirmed, and disputed states remain distinguishable.
- Blind close remains blind, uncertain payouts remain fenced, and card activity does not pulse the cash drawer.
- No global account-level reporting flag replaces exact overlay slices or suppresses unrelated adjustments.
- Core operation works using local assets while the cloud is unreachable.
- The full existing test suite and new meaningful journey checks pass, or any blocker is explicitly documented with evidence.
- Staff documentation matches the implemented interface; unsupported administration is labeled as operator-led.

Start by inspecting the repository and both required skills, then carry the overhaul through a working, verified implementation.
