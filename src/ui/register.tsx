import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { denominations } from '../retail-money.ts';
import type { LineMoney, Quote } from '../retail-money.ts';
import { Diagnostics } from './retail-diagnostics.tsx';
import type { DiagnosticsState } from './retail-diagnostics.tsx';
import { KitchenDisplay, ModulePanel } from './module-views.tsx';
import { Amounts, Evidence, MoneyInput, ReceiptView, Status } from './components.tsx';
import { currencyPreview, parseCurrency, usd } from './money.ts';
import { readRequest } from './pending-request.ts';

type Receipt = { receiptId: string; eventId: string; printable: string; lines?: Array<{ id: string; sku: string }> };
type Cart = LineMoney & { id: string; quote: Quote; quantity: number; discount: { amount: number } | null };
type State = DiagnosticsState & {
  shift?: { shift_id: string; state: string }; catalog: Quote[]; cart: Cart[]; totals: LineMoney;
  pendingCount: number;
  paymentsEnabled?:boolean;
  payments?: Array<{intent_id:string;state:string;reason:string|null;fiscal_sequence:number|null;fiscal_epoch:string|null}>;
  close?: { event_id: string; counted_minor: number; expected_minor: number; variance_minor: number; delta_minor: number };
};
type Api = { data: unknown; state?: State; error?: string };
const savedCheckout = 'omnipoint-last-checkout';
const pendingCheckout = 'omnipoint-pending-checkout';
const syncMessage = (result: unknown) => ({
  SYNCED: 'Cloud confirmation verified for the next event.',
  IDLE: 'No events ready to synchronize.',
  FUNDS_CHECKED: 'Original payment funds checked. Review the recorded payment outcome.',
  CONFLICT_HELD: 'Event held for review. Open Diagnostics and inspect the original evidence.',
} as Record<string,string>)[String(result)] ?? 'Cloud confirmation pending. Original event retained for retry.';
const destinations = { register: 'Register', receipts: 'Receipts & returns', shift: 'Shift & cash', workflows: 'Workflows', diagnostics: 'Diagnostics' };
type Screen = keyof typeof destinations;
const initialScreen = (): Screen => Object.hasOwn(destinations, location.hash.slice(1)) ? location.hash.slice(1) as Screen : 'register';

async function api(action: string, input: object = {}): Promise<Api> {
  const response = await fetch('/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }),
  });
  if (response.status === 401) throw new Error('Sign in to the register');
  return response.json() as Promise<Api>;
}

function formData(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}

function BlindCount({ onCount, disabled, previous }: {
  onCount: (count: Record<string, number>, reason?: string, pin?: string) => void; disabled: boolean; previous?: string;
}) {
  return <form className="count-form" onSubmit={event => {
    const data = formData(event);
    const count = Object.fromEntries(denominations.filter(d => data.get(String(d))).map(d => [String(d), Number(data.get(String(d)))]));
    onCount(count, String(data.get('reason') ?? ''), String(data.get('pin') ?? ''));
  }}>
    {denominations.map(d => <label key={d}>{usd(d)} count<input name={String(d)} type="number" min="0" step="1" /></label>)}
    {previous && <><label>Revision reason<input name="reason" required /></label>
      <label>Supervisor PIN<input name="pin" type="password" required /></label></>}
    <button disabled={disabled}>{previous ? 'Submit revised count' : 'Commit blind count'}</button>
  </form>;
}

function App() {
  const [state, setState] = useState<State>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const scannerRef = useRef<HTMLInputElement>(null);
  const restoreScanner = useRef(false);
  const [failed, setFailed] = useState(false);
  const [errorAction, setErrorAction] = useState('');
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState('');
  const [cash, setCash] = useState('');
  const [lookup, setLookup] = useState('');
  const [requestId, setRequestId] = useState(() => localStorage.getItem(pendingCheckout) ?? '');
  const [editableCheckout, setEditableCheckout] = useState(false);
  const [returnId, setReturnId] = useState(() => localStorage.getItem('omnipoint-return') ?? crypto.randomUUID());
  const [attemptId, setAttemptId] = useState(() => localStorage.getItem('omnipoint-attempt') ?? crypto.randomUUID());

  function navigate(next: Screen) { location.hash = next; setScreen(next); setMessage(''); setFailed(false); }
  useEffect(() => { const change = () => { if (Object.hasOwn(destinations, location.hash.slice(1))) setScreen(initialScreen()); }; window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { if (failed) noticeRef.current?.focus(); }, [failed, message]);
  useEffect(() => { if (!busy && restoreScanner.current) { scannerRef.current?.focus(); restoreScanner.current = false; } }, [busy]);

  useEffect(() => {
    let current = true;
    void api('state').then(data => { if (current) setState(data.state); }).catch(() => {});
    return () => { current = false; };
  }, []);

  async function run(action: string, input: object = {}, done?: (data: unknown) => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    setErrorAction(action);
    setMessage('');
    try {
      const response = await api(action, input);
      if (response.state) setState(response.state);
      if (response.error) throw new Error(response.error);
      done?.(response.data);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'Register operation held');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function identified(action: string, input: object, done?: (data: unknown) => void, field = 'id', subject = '') {
    const key = `omnipoint-operation:${action}:${subject}`;
    if (busyRef.current) return;
    const id = localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? crypto.randomUUID();
    localStorage.setItem(key, id);
    void run(action, { ...input, [field]: id }, data => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
      setMessage('Action recorded');
      done?.(data);
    });
  }

  function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run('scan', { code: scan }, () => { setScan(''); setMessage('Item added'); restoreScanner.current = true; });
  }

  const setReceiptResult = (data: unknown) => {
    if (!data) { setMessage('Receipt unavailable'); return; }
    const result = data as Receipt;
    setReceipt(result);
    setLookup(result.receiptId);
    setMessage('Original receipt loaded');
  };

  function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    let tenderMinor: number;
    try { tenderMinor = parseCurrency(cash); } catch (error) { setFailed(true); setMessage((error as Error).message); return; }
    const id = requestId || crypto.randomUUID();
    setEditableCheckout(false);
    localStorage.setItem(savedCheckout, id);
    localStorage.setItem(pendingCheckout, id);
    setRequestId(id);
    localStorage.setItem('omnipoint-pending-tender', String(tenderMinor));
    void run('checkout', { id, tenderMinor }, data => {
      setReceiptResult(data);
      setMessage('Sale saved on this register. Cloud confirmation and fulfillment are separate.');
      localStorage.removeItem(pendingCheckout);
      localStorage.removeItem('omnipoint-pending-tender');
      setRequestId('');
      setCash('');
    });
  }

  function finishForm(event: FormEvent<HTMLFormElement>, action: string, handler?: (data: unknown) => void) {
    const data = formData(event);
    const input = Object.fromEntries([...data.entries()].map(([key, value]) => [key,
      key === 'quantity' ? Number(value) : key === 'amount' ? parseCurrency(String(value)) : value]));
    if (action === 'reserve-return') {
      localStorage.setItem('omnipoint-return', returnId);
      localStorage.setItem('omnipoint-attempt', attemptId);
    }
    void run(action, input, handler);
  }

  const pending = state?.pendingCount ?? 0;
  const recoverCheckout = () => void run('receipt', { id: localStorage.getItem(savedCheckout) }, data => {
    setReceiptResult(data);
    if (data) { localStorage.removeItem(pendingCheckout); localStorage.removeItem('omnipoint-pending-tender'); setRequestId(''); }
    else if (requestId) { setEditableCheckout(true); navigate('register'); setMessage('No saved receipt found. Correct cash received and retry using the same checkout identity.'); }
  });
  const activePayments = state?.payments?.filter(item => !['FINALIZED','REFUNDED','DECLINED'].includes(item.state)) ?? [];
  const paymentResult=(value:unknown)=>{
    const result=value as {state:string;receipt?:Receipt;reason?:string};
    if(result.receipt) setReceiptResult(result.receipt);
    setMessage(result.reason ?? ({ FINALIZED: 'Card receipt finalized. Review cloud confirmation separately.', MAY_HAVE_SENT: 'Card outcome uncertain. Check the original attempt before collecting payment again.', REFUND_PENDING: 'Refund outcome uncertain. Check the original attempt.', CAPTURED: 'Funds captured. Receipt is held for fiscal recovery.', REFUNDED: 'Captured funds refunded.', DECLINED: 'Payment declined. Review the original attempt.' } as Record<string,string>)[result.state] ?? 'Payment recorded. Review the original attempt below.');
  };
  const paymentPanel=state?.paymentsEnabled&&<section className="payment-recovery"><h2>Card payment recovery</h2>
    <p>Card entry stays on the enrolled reader. Check the original attempt before retrying.</p>
    <ul className="record-list">{state.payments?.map(item=><li key={item.intent_id}>
      <strong>{({ MAY_HAVE_SENT: 'Payment outcome uncertain', REFUND_PENDING: 'Refund outcome uncertain', CAPTURED: 'Funds captured; receipt not finalized', FINALIZED: 'Receipt finalized', DECLINED: 'Payment declined', REFUNDED: 'Funds refunded' } as Record<string,string>)[item.state] ?? 'Payment needs review'}</strong>
      <p>{item.reason ?? 'Check this original attempt before collecting payment again.'}</p>
      <Evidence><p>State: {item.state} · Attempt: {item.intent_id}</p>
      {item.fiscal_sequence!==null&&<p>Fiscal slot {item.fiscal_sequence} · Epoch {item.fiscal_epoch}</p>}</Evidence>
      {!['FINALIZED','REFUNDED','DECLINED'].includes(item.state)&&<div className="row">
        <button disabled={busy} onClick={()=>void run('card-recover',{id:item.intent_id},paymentResult)}>Check payment</button>
        {['MAY_HAVE_SENT','REFUND_PENDING'].includes(item.state)&&<button className="secondary" disabled={busy}
          onClick={()=>void run('card-retry',{id:item.intent_id},paymentResult)}>Check and retry same attempt</button>}
      </div>}
      {['CAPTURED','DECLINED'].includes(item.state)&&<form onSubmit={event=>{
        const data=formData(event);
        void run(item.state==='CAPTURED'?'card-refund':'card-replace',
          {id:item.intent_id,reason:data.get('reason'),pin:data.get('pin')},paymentResult);
      }}>
        <label>Payment reason<select name="reason" required>
          {item.state==='CAPTURED'?<><option value="FISCAL_UNAVAILABLE">Fiscal authority unavailable</option>
            <option value="OPERATOR_CANCELLED">Operator cancelled</option></>:
            <><option value="PROVIDER_DECLINED">Provider declined</option>
              <option value="VERIFIED_NONEXECUTION">Verified nonexecution</option></>}
        </select></label>
        <label>Payment supervisor PIN<input type="password" name="pin" required /></label>
        <button className={item.state==='CAPTURED'?'danger':'secondary'} disabled={busy}>{item.state==='CAPTURED'?'Refund captured funds':'Authorize replacement attempt'}</button>
      </form>}
    </li>)}</ul>
  </section>;
  let content: ReactNode;
  if (!state) {
    content = <section><h2>Cashier sign-in</h2><form onSubmit={event => {
      const data = formData(event);
      void run('login', { secret: data.get('secret') }, () => { void api('state').then(reply => setState(reply.state)).catch(() => {}); });
    }}>
      <label>Cashier secret<input name="secret" type="password" required autoComplete="current-password" /></label>
      <button disabled={busy}>Sign in</button>
    </form></section>;
  } else if (screen === 'diagnostics') {
    content = <><Diagnostics state={state} busy={busy} onSync={() => void run('sync', {}, data => setMessage(syncMessage(data)))}
      onDispatch={() => void run('dispatch')} onCheck={(id, evidence, pin) => void run('check-device', { id, evidence, pin })} />
      <section><h2>Storage</h2><p>Inspect free space and the write-ahead log when local completion is blocked. Ask support before removing files; receipt and event data must be preserved.</p><button disabled={busy} onClick={()=>void run('storage',{},data=>{
        const info=data as {freeBytes:number|null;walBytes:number;pendingWalFrames:number};
        setMessage(`Free bytes ${info.freeBytes??'unavailable'} · WAL bytes ${info.walBytes} · pending frames ${info.pendingWalFrames}`);
      })}>Inspect storage</button></section>{paymentPanel}</>;
  } else {
    const shiftOpen = state.shift?.state === 'OPEN';
    const variants = state.catalog.filter(v => `${v.label} ${v.parentId} ${v.sku}`.toLowerCase().includes(search.toLowerCase()));
    content = <>
      {(screen === 'shift' || (screen === 'register' && !shiftOpen)) && <section><h2>Cash shift</h2>
        {shiftOpen ? <><p><Status tone="success">Shift open</Status></p><Evidence title="Shift identity">{state.shift?.shift_id}</Evidence></> :
          <form onSubmit={event => {
            const data = formData(event);
            identified('open', { floatMinor: parseCurrency(String(data.get('float'))) }, () => navigate('register'));
          }}>
            <MoneyInput label="Opening float (USD)" name="float" defaultValue="50.00" required />
            <button disabled={busy}>Open shift</button>
          </form>}
        {state.close && <p>Counted {usd(state.close.counted_minor)} · Expected {usd(state.close.expected_minor)} · Variance {usd(state.close.variance_minor)}</p>}
      </section>}
      {shiftOpen && screen === 'register' && <><div className="section-heading task-heading"><div><h2>New sale</h2><div className="task-meta"><Status tone="success">Shift open</Status><span>{state.cart.reduce((count,line)=>count+line.quantity,0)} items in cart</span></div></div><a className="payment-jump" href="#payment">Go to payment <span>{usd(state.totals.totalMinor)}</span></a></div><div className="columns">
        <section className="catalog-panel"><div className="section-heading"><h2>Catalog</h2><small>{variants.length} products</small></div>
          <form className="scan-form" onSubmit={submitScan}>
            <label>Barcode scanner<input ref={scannerRef} disabled={busy || !!requestId} value={scan} onChange={event => setScan(event.target.value)} inputMode="numeric"
              aria-invalid={failed && errorAction === 'scan' ? true : undefined} aria-describedby={failed && errorAction === 'scan' ? 'scan-error' : undefined}
              autoComplete="off" maxLength={40} placeholder="Focus, scan, then Enter" />{failed && errorAction === 'scan' && <span className="field-error" id="scan-error">{message}</span>}</label>
            <button disabled={busy || !!requestId}>Add barcode</button>
          </form>
          <label className="catalog-search">Catalog search<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search name, variant or SKU" /></label>
          <ul className="product-list">{variants.map(item => <li key={item.sku}><div><strong>{item.label}</strong><small>{item.parentId} · {item.sku}</small><small>{item.taxMode === 'INCLUSIVE' ? 'Includes' : 'Plus'} {item.taxBps / 100}% tax</small></div>
            <div className="product-action"><span>{usd(item.unitMinor)}</span><button aria-label={`Add ${item.label}`} className="secondary" disabled={busy || !!requestId} onClick={() => void run('add', { sku: item.sku }, () => setMessage(`${item.label} added`))}>Add</button></div>
          </li>)}</ul>
          {!variants.length && <p className="empty-state">No matching products. Try a product name or SKU.</p>}
        </section>
        <section className="basket-panel"><div className="section-heading"><h2>Cart</h2><small>{state.cart.length} lines</small></div>
          {state.cart.length === 0 && <div className="empty-state"><strong>Cart is empty</strong><span>Scan a barcode or add a product to begin.</span></div>}
          {state.cart.length > 0 && <div className="cart-columns" aria-hidden="true"><span>Item</span><span>Qty</span><span>Amount</span></div>}
          {state.cart.map(line => <div key={line.id} className="cart-line">
            <div className="cart-product"><strong>{line.quote.label}</strong><small>{line.quote.parentId} · {usd(line.quote.unitMinor)} each · Tax {usd(line.taxMinor)}{line.discount && ` · Discount ${usd(line.discount.amount)}`}</small></div>
            <label className="cart-quantity"><span className="quantity-caption">Qty</span><select aria-label={`Quantity for ${line.quote.sku}`} value={line.quantity} disabled={busy || !!requestId}
              onChange={e => void run('quantity', { id: line.id, quantity: Number(e.target.value) })}>
              {Array.from({ length: 9 }, (_, n) => <option key={n} value={n}>{n || 'Remove'}</option>)}
            </select></label>
            <span className="line-amount">{usd(line.totalMinor)}</span>
          </div>)}
          <div id="payment" className="payment-summary" tabIndex={-1} aria-label="Payment summary">
          <Amounts subtotal={state.totals.basisMinor} tax={state.totals.taxMinor} total={state.totals.totalMinor} />
          <form className="payment-form" onSubmit={checkout}>
            <MoneyInput label="Cash received (USD)" disabled={!!requestId && !editableCheckout} value={cash} onChange={e => setCash(e.target.value)} required />
            <button disabled={busy || !state.cart.length || (!!requestId && !editableCheckout)}>Finalize cash sale</button>
            {state.paymentsEnabled&&<button className="secondary" type="button" disabled={busy||!state.cart.length||!!requestId||!!activePayments.length}
              onClick={()=>identified('card-start',{},paymentResult)}>Charge card reader</button>}
          </form>
          <p className="change"><span>Change due</span><strong>{usd(Math.max(0, currencyPreview(cash) - state.totals.totalMinor))}</strong></p>
          </div>
          {state.cart.length > 0 && <details><summary>Authorized line discount</summary>
            <form className="form-grid" onSubmit={e => finishForm(e, 'discount')}>
              <label>Discount line<select name="id">{state.cart.map(line => <option key={line.id} value={line.id}>{line.quote.label}</option>)}</select></label>
              <MoneyInput label="Discount amount (USD)" name="amount" required />
              <label>Discount reason<input name="reason" required /></label>
              <label>Supervisor PIN<input name="pin" type="password" required /></label>
              <button disabled={busy || !!requestId}>Apply discount</button>
            </form>
          </details>}
        </section>
      </div></>}
      {(screen === 'receipts' || screen === 'register') && <section><h2>Original receipt</h2>
        <form onSubmit={event => {
          const data = formData(event);
          void run('receipt', { id: data.get('receipt') }, setReceiptResult);
        }}>
          <label>Receipt or checkout request ID<input name="receipt" value={lookup} onChange={event => setLookup(event.target.value)} required /></label>
          <button disabled={busy}>Find receipt</button>
          <button className="secondary" type="button" disabled={busy || !localStorage.getItem(savedCheckout)}
            onClick={recoverCheckout}>Recover last checkout</button>
          {receipt && <button type="button" className="secondary" disabled={busy}
            onClick={() => identified('reprint', { id: receipt.receiptId }, setReceiptResult, 'commandId', receipt.receiptId)}>Reprint original</button>}
        </form>
        {receipt ? <ReceiptView receipt={receipt} outcome={state.outbox.find(row => row.event_id === receipt.eventId)} /> : <p className="muted">Find an original receipt to review, reprint or start a return.</p>}
      </section>}
      {screen === 'receipts' && paymentPanel}
      {shiftOpen && screen === 'receipts' && <>
        <section><h2>Cash return</h2><p>Online supervisor authorization is required. An uncertain payout stays held for reconciliation.</p>
          <form className="form-grid" onSubmit={e => finishForm(e, 'reserve-return', data => {
            const quote = (data as { reservation: { basisMinor: number; taxMinor: number } }).reservation;
            setMessage(`Refund reserved ${usd(quote.basisMinor + quote.taxMinor)} · Tax ${usd(quote.taxMinor)}`);
          })}>
            <input type="hidden" name="returnId" value={returnId} /><input type="hidden" name="attemptId" value={attemptId} />
            <label>Original receipt ID<input name="receiptId" value={lookup} onChange={event => setLookup(event.target.value)} required /></label>
            {receipt?.lines ? <label>Original receipt line<select name="lineId" required>{receipt.lines.map(line => <option key={line.id} value={line.id}>{state.catalog.find(item => item.sku === line.sku)?.label ?? line.sku}</option>)}</select></label> :
              <label>Original line ID<input name="lineId" required /><small>Find the receipt above to choose its product line.</small></label>}
            <label>Return quantity<input name="quantity" type="number" min="1" defaultValue="1" required /></label>
            <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Reserve return</button>
            <button type="button" className="secondary" disabled={busy || state.refunds.some(refund => ['RESERVED','UNCERTAIN'].includes(refund.state))} onClick={() => {
              localStorage.removeItem('omnipoint-return'); localStorage.removeItem('omnipoint-attempt');
              setReturnId(crypto.randomUUID()); setAttemptId(crypto.randomUUID());
            }}>New return request</button>
          </form>
          {state.refunds.map((refund, index) => <details key={refund.return_id} open={['RESERVED','UNCERTAIN'].includes(refund.state)}><summary>Return {state.refunds.length - index} · {refund.state === 'UNCERTAIN' ? 'Cash payout uncertain — do not pay again' : refund.state === 'RESERVED' ? 'Reserved for payout' : refund.state === 'CONFIRMED' ? 'Payout confirmed' : refund.state}</summary>
            <Evidence title="Return identity">{refund.return_id}</Evidence>
            {refund.state === 'RESERVED' && <button disabled={busy} onClick={() => void run('begin-payout', { id: refund.return_id },
              data => setMessage(`Hand out ${usd((data as { amountMinor: number }).amountMinor)} once, then confirm payout`))}>Begin payout</button>}
            {refund.state === 'UNCERTAIN' && <form onSubmit={e => finishForm(e, 'confirm-payout', setReceiptResult)}>
              <input type="hidden" name="id" value={refund.return_id} />
              <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Confirm cash paid</button>
            </form>}
            {(refund.state === 'RESERVED' || refund.state === 'UNCERTAIN') && <form onSubmit={e => finishForm(e, 'release-return')}>
              <input type="hidden" name="id" value={refund.return_id} />
              <label>Nonexecution evidence<input name="evidence" required /></label>
              <label>Supervisor PIN<input name="pin" type="password" required /></label><button className="danger" disabled={busy}>Release verified unpaid return</button>
            </form>}
          </details>)}
        </section>
      </>}
      {shiftOpen && screen === 'shift' && <>
        <section><h2>Drop cash</h2><form className="form-grid" onSubmit={event => {
          const data = formData(event);
          identified('drop', { amount: parseCurrency(String(data.get('amount'))), destinationId: data.get('destinationId'), pin: data.get('pin') });
        }}>
          <label>Destination cash location ID<input name="destinationId" required /></label>
          <MoneyInput label="Drop amount (USD)" name="amount" required />
          <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Record verified drop</button>
        </form></section>
        <section><h2>Blind drawer close</h2>
          <p>Enter the number of each note and coin. Expected cash is revealed only after you commit the count. Uncertain payouts must be resolved before closing.</p>
          <BlindCount disabled={busy} onCount={count => identified('close', { count })} />
        </section>
      </>}
      {state.close && screen === 'shift' && <section><h2>Supervisor close revision</h2>
        <BlindCount disabled={busy} previous={state.close.event_id}
          onCount={(count, reason, pin) => identified('revise', { previousId: state.close?.event_id, count, reason, pin })} />
      </section>}
    </>;
  }
  return <><a className="skip-link" href="#main">Skip to content</a><header><div className="brand"><span className="brand-mark" aria-hidden="true">O</span><div><h1>OmniPoint</h1><small>Point of sale</small></div></div>
    <div className="status-strip"><Status tone={state?.cloud === 'OFFLINE' ? 'warning' : 'neutral'}>Cloud {state?.cloud === 'UNKNOWN' || !state ? 'not checked' : state.cloud}</Status><Status>{pending} awaiting sync</Status></div>
    {state && <nav className="app-nav" aria-label="Register navigation">
      {(Object.entries(destinations) as Array<[Screen,string]>).map(([key,label]) => <button key={key} aria-current={screen === key ? 'page' : undefined} onClick={() => navigate(key)}>{label}</button>)}
      <button className="sync-button" disabled={busy} onClick={() => void run('sync', {}, data => setMessage(syncMessage(data)))}>Sync next</button>
    </nav>}</header><main id="main" tabIndex={-1} aria-busy={busy}><p ref={noticeRef} tabIndex={-1} className={'notice' + (failed ? ' error' : '')} role={failed ? 'alert' : 'status'}>{busy ? 'Working… Keep this transaction open.' : message}</p>
    {state && requestId && <section className="recovery-banner"><h2>Checkout needs recovery</h2><p>The response was not confirmed. Check the original receipt before collecting payment again. Your basket remains fenced.</p><div className="row"><button disabled={busy} onClick={recoverCheckout}>Check original checkout</button>
      <button className="secondary" disabled={busy || !localStorage.getItem('omnipoint-pending-tender')} onClick={() => void run('checkout', { id: requestId, tenderMinor: Number(localStorage.getItem('omnipoint-pending-tender')) }, data => {
        setReceiptResult(data); if (data) { localStorage.removeItem(pendingCheckout); localStorage.removeItem('omnipoint-pending-tender'); setRequestId(''); }
      })}>Retry original cash checkout</button></div><Evidence title="Checkout identity">{requestId}</Evidence></section>}
    {state && screen !== 'workflows' && readRequest(localStorage, 'omni-pending-workflow') && <section className="recovery-banner"><h2>Workflow needs recovery</h2><p>An original workflow action is awaiting confirmation. Review it before repeating work or collecting another payment for that order.</p><button onClick={() => navigate('workflows')}>Review workflow recovery</button></section>}
    {!!activePayments.length && screen !== 'receipts' && screen !== 'diagnostics' && <section className="recovery-banner"><h2>Card payment needs attention</h2><p>Check the original attempt. A lost response can still mean captured funds.</p><button onClick={() => navigate('receipts')}>Review card recovery</button></section>}
    {state?.refunds.some(refund => refund.state === 'UNCERTAIN') && screen !== 'receipts' && <section className="recovery-banner"><h2>Cash payout uncertain</h2><p>Do not hand out cash again. Drawer close stays blocked until supervised reconciliation.</p><button onClick={() => navigate('receipts')}>Review return payout</button></section>}
    {state && screen === 'workflows' ? <ModulePanel catalog={state.catalog} onRegisterChange={() => run('state')} /> : content}</main></>;
}

createRoot(document.getElementById('app')!).render(location.pathname === '/kitchen' ? <KitchenDisplay /> : <App />);
