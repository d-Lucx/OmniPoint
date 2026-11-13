# OmniPoint user manual

**For cashiers, kitchen and service staff, supervisors, managers, finance employees, and support.**

This guide describes the M1–M7 services with the operational UI overhaul delivered on 2026-11-11. Some management and finance tasks use an operator command rather than a browser screen. Those tasks are identified below.

The current demonstration uses USD, simulated payment and fiscal services, and example hospitality/service rules. Your organization must approve its actual payment, tax, accounting, hardware, and bank/agency integrations before production use. Do not treat demo prices, credentials, schedules, or statutory deadlines as business policy.

## Find your task

- [Start a shift and make a sale](#1-start-a-shift-and-make-a-sale)
- [Recover or reprint a receipt](#2-recover-or-reprint-a-receipt)
- [Understand sync and offline work](#3-understand-sync-and-offline-work)
- [Take a card payment](#4-take-a-card-payment)
- [Process a cash return](#5-process-a-cash-return)
- [Drop cash and close a drawer](#6-drop-cash-and-close-a-drawer)
- [Handle stock and backorders](#7-handle-stock-and-backorders)
- [Use hospitality and kitchen workflows](#8-use-hospitality-and-kitchen-workflows)
- [Use appointments and service work orders](#9-use-appointments-and-service-work-orders)
- [Reconcile cash custody](#10-reconcile-cash-custody)
- [Close a period and retrieve reports](#11-close-a-period-and-retrieve-reports)
- [Manage treasury and external evidence](#12-manage-treasury-and-external-evidence)
- [Resolve common problems](#13-resolve-common-problems)
- [Support, recovery, and training](#14-support-recovery-and-training)

## Before you begin

Your manager or administrator provides the register address, cashier sign-in secret, enabled modules, and contact for support. In the local demo the register is usually at `http://127.0.0.1:4317`. That address refers to the computer running the register; it is not a shared cloud login.

Use the **Cashier sign-in** form and select **Sign in**. Keep supervisor credentials private. A button appearing on a screen does not authorize you to use someone else's approval.

The main navigation contains:

| Destination | Use it for |
| --- | --- |
| **Register** | Open a shift, scan/search, build the cart, take payment and recover the last receipt |
| **Receipts & returns** | Find/reprint original receipts, choose return lines, reconcile payouts and card attempts |
| **Shift & cash** | Cash drops, blind denomination counts and supervised close revisions |
| **Diagnostics** | Sync outcomes, device attempts, stock quota/custody, refund holds, storage, and payment recovery |
| **Workflows** | Enabled hospitality and services tasks; capability refresh and fleet status |
| **Sync next** | Attempt the next pending event; several events may require several attempts |

### Amounts and counts

Staff money fields labeled **(USD)** use dollars: enter `50.00` for $50.00, `5.00` for $5.00, and `2.20` for $2.20. Enter at most two decimal places, without a currency symbol, commas or exponent notation. The UI converts exactly to integer cents. Operator JSON contracts still use integer cents where documented. A denomination **count** asks for the number of notes or coins: for one $50 note, enter `1` in **$50.00 count**.

### Who handles what?

| Employee | Typical responsibility |
| --- | --- |
| Cashier | Sell, find receipts, follow payout instructions, count drawer, report uncertainty |
| Supervisor | Approve discounts/returns, verify uncertain device or cash outcomes, review drawer differences |
| Kitchen staff | Use the assigned station display, mark tickets ready or cancelled |
| Service staff | Draft appointments, prepare estimates, perform approved work, invoice |
| Inventory manager | Evidence-based receiving, stock counts, quarantine/restock, backorder fulfillment |
| Finance/treasury operator | Cash custody, period seals, reporting approval, bank/agency reconciliation |
| Administrator/support | Enrollment, credentials, startup, backups, recovery, peripheral and integration setup |

These are work responsibilities, not a claim that the application provides a complete employee-role administration screen. Authorization depends on configured enrollments and server checks.

## 1. Start a shift and make a sale

### Open the cash shift

1. Select **Register**.
2. Count the starting drawer float according to store procedure.
3. Enter **Opening float (USD)**. Example: `50.00` for $50.00.
4. Select **Open shift** and confirm that **Shift open** appears.

If a prior shift has an unresolved difference, ask the supervisor to review it before opening another shift. An administrator must provision catalog and usable stock quota before sales can proceed.

### Build the basket

1. Focus **Barcode scanner**, scan the item, and press Enter if the scanner does not do so automatically. **Add barcode** also submits the entered code.
2. Alternatively, use **Catalog search** and select the item's **Add …** button.
3. Check the variant, quantity, and price in **Cart**.
4. Use the quantity selector to change units. Select **Remove** to remove that line.
5. Review tax and total before collecting payment.

On wide screens, **Cart** aligns item details, quantity and line amount in separate columns. On narrow screens the quantity control moves below the item. **Go to payment** beside **New sale** shows the current total and jumps to the payment summary; it does not submit or change the sale. Keyboard users can activate the link and press Tab to reach **Cash received (USD)**.

After a successful barcode submission, focus returns to **Barcode scanner**. The application does not claim physical scanner validation from simulated input.

For an approved discount, expand **Authorized line discount**, select the line, enter **Discount amount (USD)** and a reason, and have the supervisor enter their PIN. Select **Apply discount** and review the new total. Staff should not manually recalculate the system's tax or change the stored sale afterward.

### Take cash

1. Enter the money received in **Cash received (USD)**.
2. Check the displayed change.
3. Select **Finalize cash sale** once.
4. Wait for the result and original receipt. Give the displayed change according to your store's cash procedure.
5. Keep the receipt available until the customer transaction is complete.

Example: a $2.20 total paid with $5.00 uses `5.00` dollars received and shows $2.80 change.

If the screen stops responding, recover the original checkout before starting another sale for the same purchase. A missing response does not mean that the sale failed.

## 2. Recover or reprint a receipt

### Find an existing receipt

1. Select **Receipts & returns**. In **Original receipt**, enter the receipt ID or original checkout request ID.
2. Select **Find receipt**.
3. Check the printable receipt and item details.

After an interrupted checkout in the same browser, select **Recover last checkout**. This retrieves the original sale identity. If the browser's remembered request is unavailable, use the recorded receipt/request ID and ask support if necessary.

### Print again

**Saved receipt** separates **Local receipt**, **Cloud synchronization**, and **Inventory fulfillment**. A local save alone does not establish cloud confirmation or fulfilled goods. Review the verified fulfilled/backordered counts and original receipt below these facts.

Select **Reprint original** after loading the receipt. Reprinting uses the original receipt identity and content; it does not create a second sale.

Paper delivery can be uncertain after a device interruption. Inspect the printer and **Diagnostics → Device attempts** before deciding whether to reprint. Do not repeat checkout to obtain paper.

## 3. Understand sync and offline work

The register saves supported offline work on its own computer. The cloud connection and the local register are separate: **Cloud OFFLINE** does not by itself mean a locally completed sale was lost.

| What you see | Meaning and next step |
| --- | --- |
| **Cloud ONLINE** | Cloud access is available; individual events may still be pending |
| Pending sync count | Local events remain to be sent or resolved |
| **SYNCED** | The terminal verified the cloud's signed final outcome for that event |
| Pending/retryable outcome | Retain the event; retry the original through sync |
| **BACKORDER** or backordered line units | The sale outcome is recorded, but those goods still need fulfillment |
| **CONFLICT_HELD**, a hold, or an incident | Supervisor/support must review the original evidence |
| **PERIOD_SEALED** | Finance must decide an authorized later-period treatment |

**SYNCED does not mean every line was fulfilled.** Read the line outcomes in Diagnostics.

To synchronize, restore connectivity and select **Sync next**, or **Diagnostics → Retry next event**. Review the outcome and repeat while actionable events remain. Shift events have an order; a later event may wait for earlier events.

Offline cash selling needs valid, unspent quota and any required custody evidence. A cached module profile permits supported local drafts and kitchen work. Appointment confirmation and online cash-return authorization require cloud access. Card availability depends on the provider and fiscal authority; do not assume cash offline rules also apply to cards.

Never delete local storage, recreate a sale, change the computer clock, or issue new stock grants to make a pending event disappear. Ask support before clearing browser data or replacing a terminal computer.

## 4. Take a card payment

Card controls appear only when payments are configured.

1. Check the basket and total.
2. Select **Charge card reader** once.
3. Let the customer enter card details on the enrolled reader.
4. Wait for the final payment/receipt result.

Do not enter card numbers, security codes, or PINs into register text fields, notes, or support messages. A card sale should not open the cash drawer or be counted as cash takings.

### If the reader or screen times out

Open **Card payment recovery** in **Receipts & returns** or **Diagnostics**. Check the existing attempt using **Check payment**. Where offered, **Check and retry same attempt** uses the existing attempt rather than creating another charge. Technical details retain the exact internal state and attempt identity.

| Display label (technical state) | Employee action |
| --- | --- |
| **Payment outcome uncertain** (`MAY_HAVE_SENT`) | The request may have reached the provider. Check the original attempt; do not charge again |
| **Funds captured; receipt not finalized** (`CAPTURED`) | Funds were captured but final receipt/application may still need recovery. Escalate if it cannot finish |
| **Receipt finalized** (`FINALIZED`) | The sale has its finalized receipt |
| **Payment declined** (`DECLINED`) | Supervisor may authorize a replacement attempt using the offered reason and PIN flow |
| **Refund outcome uncertain** (`REFUND_PENDING`) | Check/recover the same refund; do not create another refund |
| **Funds refunded** (`REFUNDED`) | The linked refund outcome has been recorded |

**Refund captured funds** addresses an unapplied capture using the displayed approved reason and supervisor PIN. It is not a general card-merchandise-return screen. The current retail merchandise return flow below is cash-only.

## 5. Process a cash return

**Supervisor and cloud authorization are required.** First sync the original sale and the receiving open shift. Only eligible original fulfilled units can be reserved.

1. Select **Receipts & returns** and find the original receipt.
2. In **Cash return**, verify **Original receipt ID**, choose the product in **Original receipt line**, and enter **Return quantity**. If the receipt has not been loaded, find it first; support can use the exact original line ID. Remaining returnable quantities are validated by the server, not guessed by this screen.
3. Have the supervisor enter their PIN. Select **Reserve return**.
4. Check the authorized refund and original tax allocation. Do not substitute today's price or manually round it.
5. Expand the reserved return and select **Begin payout** when ready to pay.
6. Follow the one-time cash instruction. After the money has actually been handed over, have the supervisor use **Confirm cash paid**.
7. Keep the refund receipt and sync the confirmation.

The payout becomes **UNCERTAIN** between beginning and confirmed completion. If interrupted, check whether cash was handed out before proceeding. Never pay the customer again merely because the confirmation was lost.

If payment definitely did not occur, the supervisor can use **Release verified unpaid return** with genuine nonexecution evidence. If the outcome is unknown, keep the hold and escalate. **New return request** is for a separate return request; it is not a recovery button for an uncertain payout.

A refund does not automatically return merchandise to sellable stock. Give the goods to the inventory manager for inspection and a recorded sellable/quarantined disposition.

## 6. Drop cash and close a drawer

### Record a cash drop

1. Obtain the approved destination cash-location ID from the manager.
2. Follow the physical handoff procedure and obtain its evidence.
3. Select **Shift & cash**. In **Drop cash**, enter the destination, **Drop amount (USD)**, and supervisor PIN.
4. Select **Record verified drop** and sync the event.

A recorded drop does not by itself prove that the vault received the money. Finance records the receiving custody step separately.

### Perform the blind count

1. Select **Shift & cash**. Finish or escalate outstanding payout holds. Uncertain refunds block close.
2. Count each denomination physically. Enter the number of notes/coins in each **… count** field under **Blind drawer close**. Leave absent denominations blank or enter zero.
3. Select **Commit blind count**.
4. Read **Counted**, **Expected**, and **Variance**, which appear after commitment.
5. Sync the shift facts and close. Report any nonzero variance to the supervisor.

Example: one $50 note means **$50.00 count = 1**, producing $50.00 counted.

### Correct a witnessed counting error

The supervisor uses **Supervisor close revision**, enters the recounted denomination quantities, provides the revision reason and PIN, and selects **Submit revised count**. A revision preserves the earlier count and records the difference. Review a remaining discrepancy rather than changing a count just to force zero variance.

## 7. Handle stock and backorders

**Diagnostics → Quota and custody** shows permitted local stock units, units awaiting custody evidence, and expiry. A quota is permission for this terminal to sell specified units offline; it is not an extra delivery of goods.

When two disconnected terminals claim the same final unit, cloud reconciliation can fulfill one sale and record the other as a durable backorder. Each keeps its original receipt. Tell the customer the actual fulfillment result and follow the store's backorder procedure.

### Inventory manager tasks — operator command workflow

These controls currently use approved inventory JSON request files and the inventory CLI, not a browser inventory-management page. An enrolled operator uses the command format below; request schemas and setup are in [README](../README.md#milestone-2-quota-arbitration) and its retail recount section.

```powershell
npm.cmd run inventory -- approved-request.json
```

The administrator supplies the endpoint and operator credential securely. Keep a stable operation/evidence ID when recovering a submitted action.

| Task | Required handling |
| --- | --- |
| Issue offline quota | Confirm position, destination terminal/generation, units, expiry, and existing reservations |
| Transfer stock | Preserve dispatch, receipt, and signed custody identities; unreceived units remain fenced |
| Resolve a backorder | Record an independently evidenced replacement unit, then resolve the shortfall against that replacement |
| Inspect returned goods | File `retail-restock` with the return, evidence/provenance, and `SELLABLE` or `QUARANTINED` disposition |
| Count inventory | Record `retail-count`; inspect via `retail-inspect-count`; approve/revise via `retail-decide-count` |
| Record found stock | Use `retail-found` with unique provenance and quantity |

Expired unresolved quota stays reserved until its evidence is resolved. Do not create replacement grants against that capacity or edit on-hand totals directly. Backorder fulfillment preserves the original receipt and cash postings.

## 8. Use hospitality and kitchen workflows

Select **Workflows → Refresh capabilities**. Hospitality appears only when enabled by the signed business profile. The current demonstration offers T1/T2 and a small toast/salad menu; these are fixture choices.

Hospitality and services appear as aligned task groups on wide screens and stack on smaller screens. Completed workflow actions refresh the shell's pending-sync count and Diagnostics snapshot. **Skip to content** keeps the active workflow and unsaved draft fields in place. Supporting actions use outlined buttons; consequential cancel/refund/release actions have a red outline and retain their existing approval requirements. Always read the action label and outcome.

### Seat guests and send food

1. Choose **Table**, enter **Guests**, and select **Seat guests**.
2. Choose the seat, menu item, and modifier.
3. Select **Dispatch to kitchen** and check the listed ticket/station.
4. Repeat for the remaining items.

Dispatch can be saved locally while the cloud is offline. A local register or station connection failure is different from cloud loss; check the kitchen connection before assuming staff saw the ticket.

### Kitchen employee

1. Follow **Open kitchen display**, or use the administrator-provided `/kitchen` address.
2. Enter your assigned **Station token** and select **Connect display**.
3. Confirm **Connected** and review **Last station update**. Review table, seat, item, modifier, and ticket status.
4. Select **Ready** after preparation, or **Cancel ticket** according to the cancellation procedure.
5. If the page reports stale/disconnected tickets, restore the connection before relying on it as a live queue. Ticket actions are disabled when the latest successful station update is older than five seconds or the connection fails. A recent update proves the local station connection, not cloud synchronization.

Reloading requires station sign-in again and rebuilds the view from recorded revisions. Station credentials restrict the displayed work; never share another station's token.

### Split and settle checks

1. Review the order before freezing it.
2. Choose **Equal halves**, **By seat**, or **Selected lines**. Select lines where that method requires them.
3. Select **Freeze checks**. The checks now show gross, tax, and remaining due.
4. Enter **Cash payment (USD)** for a check, and a separate **Tip (USD)** if applicable.
5. Select **Tender check …**. A partial payment leaves the remainder visible.
6. Continue until the appropriate checks are paid; recover their original receipts using **Recover check receipt …**.
7. Sync the resulting events.

The system allocates odd cents and original tax consistently. Do not create another order to correct a lost tender response. Use original receipt recovery. In the fixture, tips accrue separately from sales and are allocated across an Alex/Sam pool. Tip payout and module returns are outside the implemented fixture.

## 9. Use appointments and service work orders

Services must be enabled under **Workflows**.

### Appointment

1. Choose **Staff**, **Start (UTC)**, and **Duration in minutes**.
2. Select **Save appointment draft**. A draft can be saved offline.
3. After connecting, select **Confirm appointment**.
4. Treat the appointment as booked only after it shows **confirmed**.

The current field is explicitly **UTC**. Convert a customer's local appointment time using the business's scheduling procedure before entering it. The fixture checks staff and a shared bay in the 08:00–18:00 UTC window. A draft does not reserve that resource; confirmation can lose a contention race.

### Work and invoice

1. Select **Start intake**. A confirmed appointment can be attached to the work order.
2. Select the part and **Save estimate**. Review total and tax.
3. Record the **Customer consent reference** supplied by the approved consent process; the current workflow expects a UUID reference.
4. Have the supervisor authorize using **Authorize estimate**.
5. Select **Start work** when the approved work is ready to begin.
6. If the estimate changes, obtain approval again. A material revision invalidates the earlier authorization.
7. Once work is ready for billing, select **Invoice and tender $…** only after collecting the exact cash amount shown according to procedure. This button tenders the estimate total; it is not a separate flexible payment-entry screen.
8. Use **Recover invoice receipt** if needed, and sync the invoice.

The fixture includes labor, part, and tax, and accrues the technician's stored commission rule. It does not provide commission payout. Do not promise a payout from an accrual display alone.

## 10. Reconcile cash custody

**Finance/authorized operators — governance CLI.** The browser records the drawer side; vault/deposit custody is recorded separately. See [README: cash reconciliation](../README.md#cash-reconciliation) for exact request fields.

```powershell
npm.cmd run --silent governance -- send approved-request.json
```

1. Sync the drawer opening, sales/refunds, drops, count, and approved revisions.
2. Retrieve `cash-state` for the shift/vault through the expected source sequence. Resolve missing events first.
3. Record `cash-vault-receive` for a witnessed drop arrival, referencing the original drop.
4. Record approved retained float with `cash-drawer-retain`. Use `cash-drawer-adjust` for a recognized variance; recount corrections record only the changed difference.
5. Get a fresh vault cut. One enrolled actor submits `cash-vault-witness`; a distinct approving actor submits `cash-vault-count` against the same cut/count.
6. Record `cash-deposit-send` for a deposit handoff. Keep it in transit until `cash-deposit-receive` references the transfer and confirms receipt.

Moving money between drawer, vault, and deposit custody does not create new sales revenue. Keep handoff evidence and unresolved transfers available for the next shift/finance review.

## 11. Close a period and retrieve reports

**Finance/authorized operators — governance CLI.** These are not cashier browser tasks. Periods are UTC calendar months.

### Seal a month

1. Review pending events, reconciliations, custody gaps, payment uncertainty, and open incidents.
2. Obtain the required close approval. Unresolved holds may need to be carried into the signed bundle; a seal does not resolve them.
3. Submit `period-close` with the period, stable seal ID, predecessor seal, and approval.
4. Retrieve the bundle using `period-get` and independently verify it with the trusted governance public key.

A seal preserves the included journals and supporting evidence. It is not permission to edit the original records later. New financial facts for a sealed period remain held until finance authorizes a proper later open-period treatment. An exact replay returns its original outcome.

### Approve and publish reporting

The current governed-report demonstration has specific synthetic March/April clearing classifications; it is not a general-purpose financial statement designer.

1. Finance reviews exact source lines, evidence, reporting slices, and predecessor plan.
2. Submit `report-approve` with the approved slices and any technical replacement/treasury evidence links.
3. Submit `report-publish`, then retrieve the signed export using `report-get`.
4. Verify its signature and expected tenant, plan, and seal before distribution.
5. If withdrawn, use `report-withdraw`. Original export bytes remain retrievable with withdrawal/successor status; do not distribute a withdrawn version as current.

Reporting adjustments change the approved view, not the sealed source journal. Posted 30¢ and 20¢ tranches, unposted amounts, technical replacements, and substantive reopenings must retain their own provenance. Do not suppress a whole account's adjustments because one slice was posted.

Verification commands are documented in [README: comparative plans and signed exports](../README.md#comparative-plans-and-signed-exports). The administrator configures trusted keys; staff must not accept a key merely because it arrived alongside an export.

## 12. Manage treasury and external evidence

**Treasury/finance operators — governance CLI and independently authenticated channels.** The test jurisdiction, agency, bank, deadlines, signatures, and precedence rules are synthetic. Real legal/accounting determinations require approved business policy and actual source evidence.

### Filing or funding

1. Inspect the account with `treasury-get` before acting.
2. Submit an approved `treasury-send` instruction using a stable operation and attempt ID.
3. If the response is lost, use `treasury-recover` for the original attempt. **MAY_HAVE_SENT** means it might have executed.
4. Use `treasury-resume` only under the channel's approved same-attempt recovery contract. A replacement requires definitive rejection and predecessor linkage.
5. Ingest authenticated bank/agency packets through `treasury-ingest`.

Transmission acceptance, filing acceptance, assessment, bank settlement, and agency application are different facts. A successful submission does not prove that cash moved or a liability was discharged.

### Common evidence cases

| Case | Correct operator handling |
| --- | --- |
| $10 expected, $9.50 cash, $0.50 shortfall | Preserve the residual until verified principal/fee evidence supports its treatment |
| Unclassified incoming cash | Cash is recorded once; attribution remains in suspense until proven |
| Proof arrives before fee or credit | Retain staged proof; no invented settlement journal |
| Two proofs claim one credit | Retain both, freeze disputed capacity, and seek authoritative resolution |
| Correction after period seal | Use an approved open-period correction; preserve the original sealed journal |
| Correction targets an already reimbursed fee | Keep displaced cash in a specific surplus hold; do not release it as available |
| Bank clawback and agency offset disagree | Record verified facts separately and keep discrepancy/payment/recognition barriers |
| Same date and amount with new statement IDs | Require lineage or supported aggregate proof; do not guess which line is historical |
| Reissued statement changes old totals | Preserve both versions and evaluate authenticated amendment/return evidence |
| Revocation arrives first | Keep the permanent tombstone; block the delayed invalid instruction |
| Higher-cut reinstatement arrives | Verify exact lineage and continuity before changing authority or rematching |

The system retains conflicting signed payloads and freezes affected automation. A balance that looks zero in an agency transcript does not by itself authorize local gain recognition, removal of holds, or a replacement payment.

If finance approves a late effect into an open successor period, use `treasury-authorize-period`. Reporting links use `treasury-report-link`. Keep the source evidence, exact amount, references, and approval. Full request contracts are in [README: statutory and bank reconciliation](../README.md#milestone-7-statutory-and-bank-reconciliation).

## 13. Resolve common problems

| Problem | What to do |
| --- | --- |
| Register unavailable after restart | Ask support to restart the existing register/database; recover the original checkout after access returns |
| Sale response lost | Find/recover original receipt before another checkout |
| Cloud offline or request held | Keep saved work; reconnect and retry original sync. Confirmation-only tasks must wait |
| Repeated pending event | Inspect Diagnostics and earlier source events; provide event ID/outcome to support |
| Backordered units | Tell the customer what remains unfulfilled; manager arranges an evidenced replacement |
| No usable/expired stock quota | Stop that sale path and ask inventory management; never change time or duplicate a grant |
| Printer paper-out/disconnect | Correct the physical problem; inspect original command state and reprint original when appropriate |
| Printer/drawer **UNCERTAIN** | Inspect actual physical outcome; supervisor records genuine operator-check evidence; do not automatically repeat drawer pulses |
| Card may have charged | Recover the original attempt; do not take another payment without a definitive outcome |
| Cash payout **UNCERTAIN** | Verify whether the customer received cash; confirm or release only with evidence |
| Drawer close blocked | Resolve the outstanding refund/required prior facts; do not bypass the hold |
| Nonzero drawer variance | Supervisor recount/review with reason; preserve the earlier count |
| Appointment remains draft | Reconnect and confirm; check staff/resource conflict and UTC entry |
| Estimate approval disappeared | A revision changed the approved work; obtain consent/authorization again |
| Kitchen display stale | Reconnect and confirm fresh station status before acting on an old view |
| HTTP 429 / fleet pressure | Allow the documented retry interval and retry the same operation; report sustained load |
| Storage full or storage hold | Stop initiating new transactions; preserve pending attempts and get support to recover capacity safely |
| Period sealed / disputed evidence | Escalate to finance with the original IDs and evidence; no direct journal edits |

## 14. Support, recovery, and training

### Include these details in a support request

- Store and terminal identifier, date/time and timezone.
- Task being performed and exact displayed message.
- Receipt, event, payment attempt, return, shift, or case ID as applicable.
- Whether goods, cash, printer paper, or drawer movement actually occurred.
- Cloud connectivity and pending count.
- Any earlier recovery action already attempted.

Use your organization's approved support channel. Do not include passwords, supervisor PINs, card data, private signing keys, access tokens, or unredacted sensitive evidence. Keep customer-facing receipt details private.

### Administrator recovery responsibilities

Use [README](../README.md) and [release readiness](RELEASE_READINESS.md) for installation, migrations, key enrollment, test commands, and restore boundaries. This staff guide is not a database restore procedure.

The restore drill uses coordinated quiesced SQLite/PostgreSQL snapshots and verified later images. It validates seals, receipts, vouchers, attempts, holds, aliases, and tombstones before service startup. Missing segments block startup. Independent bank/agency fixtures retain their external databases; provider and fiscal signer stores are outside OmniPoint's snapshot scope. A restored OmniPoint database alone is not proof those external operations did not happen.

Never restore an arbitrary old terminal file and resume charging. Support must verify terminal generation, original attempts, external status, inventory reservations, and signing authority before resuming. Physical hardware, real provider contracts, storage power-loss behavior, retention, and recovery objectives need separate deployment validation.

### New-employee practice checklist

Use a designated training environment and simulated money/devices.

- Sign in, identify the register and cloud status, and open the approved float.
- Scan an item, change quantity, remove a line, and explain dollar amounts versus denomination counts.
- Finalize cash, give correct change, and find/reprint the same receipt.
- Explain what to do after a lost checkout response and during cloud loss.
- Recognize fulfilled versus backordered units.
- Demonstrate a supervised return and why uncertain payout blocks close.
- Commit a blind denomination count and explain a variance.
- For assigned duties, practice kitchen freshness, appointment confirmation, or estimate reapproval.
- Show how to contact a supervisor without exposing credentials.

### Quick end-of-shift checklist

1. Recover any uncertain checkout/payment using its original identity.
2. Resolve or hand over payout/device holds with evidence.
3. Sync pending events and review final fulfillment outcomes.
4. Record verified cash drops and preserve handoff references.
5. Count denominations blindly and commit the close.
6. Have the supervisor review any difference and record a revision if needed.
7. Sync the close and hand over remaining cases to the next responsible employee.

### Plain-language glossary

| Term | Meaning |
| --- | --- |
| Receipt ID | Permanent reference for an original receipt |
| Checkout/operation/attempt ID | Reference used to recover the same action rather than perform it twice |
| Outbox | Saved local work waiting for a verified cloud outcome |
| Voucher / ACK | Signed cloud evidence that binds the original request to its outcome |
| Quota | Permission for a terminal to claim specified stock units |
| Custody | Evidence of where goods or cash physically moved |
| Backorder | Recorded sale with goods still awaiting fulfillment |
| Suspense / clearing | Temporary accounting classification awaiting supported attribution |
| Hold | A fence that blocks a specific action pending evidence or approval |
| Tombstone | Permanent record preventing an invalid old instruction from executing |
| Period seal | Signed boundary preserving a closed accounting period and its evidence |
| Reporting plan / overlay | Approved, versioned presentation adjustments with exact source references |

### Documentation basis

Checked against `src/ui/register.tsx`, `src/ui/module-views.tsx`, `src/ui/retail-diagnostics.tsx`, the inventory/governance CLIs, README M1–M7 walkthroughs, and the release readiness report. The live refund/close walkthrough also verified original receipt recovery, a $2.20 refund, payout close-blocking, and a $50 expected/count result with zero variance. Update this guide whenever navigation, policy, or supported integrations change.

## Quick reference: recovery and navigation

- **Register** is always one navigation action away. The active destination is highlighted and retained in the browser URL.
- **Checkout needs recovery**: choose **Check original checkout** before collecting money again. If no saved receipt exists, correct cash received and submit using the same retained checkout identity. **Retry original cash checkout** uses the saved original amount. A returned original receipt clears the recovery fence.
- A saved receipt shows local completion separately from cloud confirmation and fulfillment. A cloud-confirmed sale can still contain backordered units. Exact IDs remain in technical details. The current state window retains at most 40 recent entries; absence from that view is not proof that an older receipt was never synchronized.
- **Workflow response uncertain**: use **Retry original workflow action** after a lost response or reload. The original inputs and identity are retained. Re-enter the supervisor PIN when requested; PINs are not saved for retry. Do not create a replacement order or invoice.
- **Ticket action needs recovery**: reconnect to the original station and retry the saved ticket action. Reload requires station sign-in again.
- **Cash payout uncertain**: review **Receipts & returns**. Do not pay again. Confirm actual cash payment with the supervisor, or release only with verified nonpayment evidence.
- **Card payment needs attention**: review the original attempt under **Receipts & returns** or **Diagnostics**. Card entry remains on the enrolled reader.
- Scan and money errors appear beside their fields; server failures appear in a focused error notice. Recoverable failures retain the current form.
- At tablet/narrow widths the catalog and basket stack and scroll naturally. There is no fixed payment panel covering controls. Keyboard focus is visible; core fonts/assets are local.

Inventory administration, custody, treasury, period seals and signed reports remain operator-led. See the existing sections above and the [design audit](UI_UX_AUDIT.md) for the boundary; browser navigation never grants authority.
