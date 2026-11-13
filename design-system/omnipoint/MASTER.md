# OmniPoint operational design system

Manual accepted synthesis, 2026-11-11. UI/UX Pro Max search could not execute: python/python3 Store aliases unusable and py missing. This is built-in-rule fallback, not database output. See docs/UI_UX_AUDIT.md for scope and applicability.

Employee POS: prioritize basket, money, recovery and next action. React 19 + plain CSS. Local system font only. Neutral #f3f5f5 background, #ffffff surface, #172c32 text, #526268 muted text, #11665c primary, #8b4513 focus, #9e2f25 danger. Colors have textual state labels. Base 16px/1.5; labels 14px; headings 20/24/28px; tabular amounts. Spacing 4/8/12/16/24/32px; radius 6/10px; 44px minimum controls; 8px target gaps.

Five destinations with aria-current; browser hash preserves selected destination. No marketing hero, decorative scenes, external assets, automatic animation or fake authorization. Catalog and basket share a desktop grid, stack below 900px. Natural scrolling; no sticky payment panel. IDs wrap and live in disclosures. Receipts keep original bytes and distinguish local save, cloud ACK and fulfillment. Money inputs parse decimal strings to bounded integer cents with BigInt, never float multiplication. Blind expected cash remains absent until committed server result.

Use semantic landmarks, labeled forms, shared field errors, alert focus after failures, polite status only on meaningful actions, reduced motion and safe-area padding. Shared presentation in src/ui/components.tsx and tokens in register.css. Add no dark theme without an independently verified contrast review.

## Working-tree refinement, 2026-11-11

Keep the original identity and rules above. This pass uses built-in guidance again because interpreter checks still fail; no generated defaults were persisted over this master.

- Use aligned item/quantity/amount columns on wide baskets and a wrapped quantity row on phones. Keep variant, unit price, tax and discount readable.
- Group the dollar prefix and input in one full-width control with a shared focus ring. Disabled text uses an explicit readable foreground/background rather than reduced opacity.
- Use one subtle panel shadow, existing 6/10px radii and 4/8px spacing rhythm. Supporting actions use a secondary outline; consequential refund/release/cancel actions use the danger treatment while retaining their explicit labels and authorization.
- Place subtotal/tax beside the larger total on wide registers. Keep payment in document flow; Go to payment is a real keyboard-focusable in-page link, not a transaction. In-page anchors preserve the active destination.
- Present local receipt, cloud synchronization and inventory fulfillment as separate facts. Missing verified line evidence remains unknown, never inferred fulfilled.
- Hospitality/services use two aligned task groups when space permits and stack naturally otherwise. Diagnostics uses separated evidence records. No essential evidence or original receipt content is hidden for appearance.
- Event-driven workflow completion refreshes the existing read-only shell state. Rendering/effects do not create new attempts; existing money/recovery helpers and storage keys remain unchanged.
