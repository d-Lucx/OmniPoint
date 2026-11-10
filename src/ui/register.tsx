import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { denominations } from '../retail-money.ts';
import type { LineMoney, Quote } from '../retail-money.ts';
import { Diagnostics } from './retail-diagnostics.tsx';
import type { DiagnosticsState } from './retail-diagnostics.tsx';

type Receipt = { receiptId: string; eventId: string; printable: string; lines?: Array<{ id: string; sku: string }> };
type Cart = LineMoney & { id: string; quote: Quote; quantity: number; discount: { amount: number } | null };
type State = DiagnosticsState & {
  shift?: { shift_id: string; state: string }; catalog: Quote[]; cart: Cart[]; totals: LineMoney;
  pendingCount: number;
  close?: { event_id: string; counted_minor: number; expected_minor: number; variance_minor: number; delta_minor: number };
};
type Api = { data: unknown; state?: State; error?: string };
const savedCheckout = 'omnipoint-last-checkout';
const pendingCheckout = 'omnipoint-pending-checkout';
const usd = (value: number) => `$${(value / 100).toFixed(2)}`;

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
  return <form onSubmit={event => {
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
  const [screen, setScreen] = useState<'register' | 'diagnostics'>('register');
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState('');
  const [cash, setCash] = useState('');
  const [lookup, setLookup] = useState('');
  const [requestId, setRequestId] = useState(() => localStorage.getItem(pendingCheckout) ?? '');
  const [returnId, setReturnId] = useState(() => localStorage.getItem('omnipoint-return') ?? crypto.randomUUID());
  const [attemptId, setAttemptId] = useState(() => localStorage.getItem('omnipoint-attempt') ?? crypto.randomUUID());

  useEffect(() => {
    let current = true;
    void api('state').then(data => { if (current) setState(data.state); }).catch(() => {});
    return () => { current = false; };
  }, []);

  async function run(action: string, input: object = {}, done?: (data: unknown) => void) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await api(action, input);
      if (response.state) setState(response.state);
      if (response.error) throw new Error(response.error);
      done?.(response.data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Register operation held');
    } finally {
      setBusy(false);
    }
  }

  function identified(action: string, input: object, done?: (data: unknown) => void, field = 'id', subject = '') {
    const key = `omnipoint-operation:${action}:${subject}`;
    const id = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, id);
    void run(action, { ...input, [field]: id }, data => {
      sessionStorage.removeItem(key);
      done?.(data);
    });
  }

  function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run('scan', { code: scan }, () => { setScan(''); setMessage('Item added'); });
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
    const id = requestId || crypto.randomUUID();
    localStorage.setItem(savedCheckout, id);
    localStorage.setItem(pendingCheckout, id);
    setRequestId(id);
    void run('checkout', { id, tenderMinor: Number(cash) }, data => {
      setReceiptResult(data);
      setMessage('Checkout committed');
      localStorage.removeItem(pendingCheckout);
      setRequestId('');
      setCash('');
    });
  }

  function finishForm(event: FormEvent<HTMLFormElement>, action: string, handler?: (data: unknown) => void) {
    const data = formData(event);
    const input = Object.fromEntries([...data.entries()].map(([key, value]) => [key,
      key === 'quantity' || key === 'amount' ? Number(value) : value]));
    if (action === 'reserve-return') {
      localStorage.setItem('omnipoint-return', returnId);
      localStorage.setItem('omnipoint-attempt', attemptId);
    }
    void run(action, input, handler);
  }

  const pending = state?.pendingCount ?? 0;
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
    content = <Diagnostics state={state} busy={busy} onSync={() => void run('sync', {}, data => setMessage(String(data)))}
      onDispatch={() => void run('dispatch')} onCheck={(id, evidence, pin) => void run('check-device', { id, evidence, pin })} />;
  } else {
    const shiftOpen = state.shift?.state === 'OPEN';
    const variants = state.catalog.filter(v => `${v.label} ${v.parentId} ${v.sku}`.toLowerCase().includes(search.toLowerCase()));
    content = <>
      <section><h2>Cash shift</h2>
        {shiftOpen ? <p>Shift open <span className="badge">{state.shift?.shift_id}</span></p> :
          <form onSubmit={event => {
            const data = formData(event);
            identified('open', { floatMinor: Number(data.get('float')) });
          }}>
            <label>Opening float in cents<input name="float" type="number" min="0" step="1" defaultValue="5000" required /></label>
            <button disabled={busy}>Open shift</button>
          </form>}
        {state.close && <p>Counted {usd(state.close.counted_minor)} · Expected {usd(state.close.expected_minor)} · Variance {usd(state.close.variance_minor)}</p>}
      </section>
      {shiftOpen && <div className="columns">
        <section><h2>Catalog</h2>
          <form onSubmit={submitScan}>
            <label>Barcode scanner<input value={scan} onChange={event => setScan(event.target.value)} inputMode="numeric"
              autoComplete="off" maxLength={40} placeholder="Focus, scan, then Enter" /></label>
            <button disabled={busy}>Add barcode</button>
          </form>
          <label>Catalog search<input value={search} onChange={event => setSearch(event.target.value)} /></label>
          <ul>{variants.map(item => <li key={item.sku}>{item.label} · {item.sku} · {usd(item.unitMinor)}{' '}
            <button className="secondary" disabled={busy} onClick={() => void run('add', { sku: item.sku })}>Add {item.sku}</button>
          </li>)}</ul>
          {variants[0] && <button className="secondary" disabled={busy} onClick={() => void run('scan', { code: variants[0].barcode })}>Simulate scanner</button>}
        </section>
        <section><h2>Cart</h2>
          {state.cart.length === 0 && <p>Cart is empty</p>}
          {state.cart.map(line => <div key={line.id} className="row">
            <span>{line.quote.label} · {usd(line.totalMinor)}{line.discount && ` · Discount ${usd(line.discount.amount)}`}</span>
            <label>Quantity for {line.quote.sku}<select value={line.quantity} disabled={busy}
              onChange={e => void run('quantity', { id: line.id, quantity: Number(e.target.value) })}>
              {Array.from({ length: 9 }, (_, n) => <option key={n} value={n}>{n || 'Remove'}</option>)}
            </select></label>
          </div>)}
          <p>Tax {usd(state.totals.taxMinor)} · <strong>Total {usd(state.totals.totalMinor)}</strong></p>
          <form onSubmit={checkout}>
            <label>Cash tender in cents<input type="number" min="1" value={cash} onChange={e => setCash(e.target.value)} required /></label>
            <button disabled={busy || !state.cart.length}>Finalize cash sale</button>
          </form>
          <p>Change {usd(Math.max(0, Number(cash) - state.totals.totalMinor))}</p>
          {state.cart.length > 0 && <details><summary>Authorized line discount</summary>
            <form onSubmit={e => finishForm(e, 'discount')}>
              <label>Discount line<select name="id">{state.cart.map(line => <option key={line.id} value={line.id}>{line.quote.sku}</option>)}</select></label>
              <label>Discount cents<input type="number" name="amount" min="1" required /></label>
              <label>Discount reason<input name="reason" required /></label>
              <label>Supervisor PIN<input name="pin" type="password" required /></label>
              <button disabled={busy}>Apply discount</button>
            </form>
          </details>}
        </section>
      </div>}
      <section><h2>Original receipt</h2>
        <form onSubmit={event => {
          const data = formData(event);
          void run('receipt', { id: data.get('receipt') }, setReceiptResult);
        }}>
          <label>Receipt or checkout request ID<input name="receipt" value={lookup} onChange={event => setLookup(event.target.value)} required /></label>
          <button disabled={busy}>Find receipt</button>
          <button className="secondary" type="button" disabled={busy || !localStorage.getItem(savedCheckout)}
            onClick={() => void run('receipt', { id: localStorage.getItem(savedCheckout) }, data => {
              setReceiptResult(data);
              if (data) {
                localStorage.removeItem(pendingCheckout);
                setRequestId('');
              }
            })}>Recover last checkout</button>
          {receipt && <button type="button" className="secondary" disabled={busy}
            onClick={() => identified('reprint', { id: receipt.receiptId }, setReceiptResult, 'commandId', receipt.receiptId)}>Reprint original</button>}
        </form>
        {receipt && <><pre aria-label="Printable receipt">{receipt.printable}</pre>
          {receipt.lines && <ul aria-label="Receipt line IDs">{receipt.lines.map(line => <li key={line.id}>{line.sku} · {line.id}</li>)}</ul>}</>}
      </section>
      {shiftOpen && <>
        <section><h2>Cash return</h2><p>Online supervisor authorization is required. An uncertain payout stays held for reconciliation.</p>
          <form onSubmit={e => finishForm(e, 'reserve-return', data => {
            const quote = (data as { reservation: { basisMinor: number; taxMinor: number } }).reservation;
            setMessage(`Refund reserved ${usd(quote.basisMinor + quote.taxMinor)} · Tax ${usd(quote.taxMinor)}`);
          })}>
            <input type="hidden" name="returnId" value={returnId} /><input type="hidden" name="attemptId" value={attemptId} />
            <label>Original receipt ID<input name="receiptId" required /></label>
            <label>Original line ID<input name="lineId" required /></label>
            <label>Return quantity<input name="quantity" type="number" min="1" defaultValue="1" required /></label>
            <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Reserve return</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => {
              localStorage.removeItem('omnipoint-return'); localStorage.removeItem('omnipoint-attempt');
              setReturnId(crypto.randomUUID()); setAttemptId(crypto.randomUUID());
            }}>New return request</button>
          </form>
          {state.refunds.map(refund => <details key={refund.return_id}><summary>{refund.return_id} · {refund.state}</summary>
            {refund.state === 'RESERVED' && <button disabled={busy} onClick={() => void run('begin-payout', { id: refund.return_id },
              data => setMessage(`Hand out ${usd((data as { amountMinor: number }).amountMinor)} once, then confirm payout`))}>Begin payout</button>}
            {refund.state === 'UNCERTAIN' && <form onSubmit={e => finishForm(e, 'confirm-payout', setReceiptResult)}>
              <input type="hidden" name="id" value={refund.return_id} />
              <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Confirm cash paid</button>
            </form>}
            {(refund.state === 'RESERVED' || refund.state === 'UNCERTAIN') && <form onSubmit={e => finishForm(e, 'release-return')}>
              <input type="hidden" name="id" value={refund.return_id} />
              <label>Nonexecution evidence<input name="evidence" required /></label>
              <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Release verified unpaid return</button>
            </form>}
          </details>)}
        </section>
        <section><h2>Drop cash</h2><form onSubmit={event => {
          const data = formData(event);
          identified('drop', { amount: Number(data.get('amount')), destinationId: data.get('destinationId'), pin: data.get('pin') });
        }}>
          <label>Destination cash location ID<input name="destinationId" required /></label>
          <label>Drop amount in cents<input name="amount" type="number" min="1" required /></label>
          <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Record verified drop</button>
        </form></section>
        <section><h2>Blind drawer close</h2>
          <BlindCount disabled={busy} onCount={count => identified('close', { count })} />
        </section>
      </>}
      {state.close && <section><h2>Supervisor close revision</h2>
        <BlindCount disabled={busy} previous={state.close.event_id}
          onCount={(count, reason, pin) => identified('revise', { previousId: state.close?.event_id, count, reason, pin })} />
      </section>}
    </>;
  }
  return <><header><div><h1>OmniPoint Retail</h1><span className="badge">Cloud {state?.cloud ?? 'UNKNOWN'} · {pending} pending sync</span></div>
    {state && <nav className="row" aria-label="Register navigation">
      <button className="secondary" onClick={() => setScreen('register')}>Register</button>
      <button className="secondary" onClick={() => setScreen('diagnostics')}>Diagnostics</button>
      <button disabled={busy} onClick={() => void run('sync', {}, data => setMessage(String(data)))}>Sync next</button>
    </nav>}</header><main><p className="notice" aria-live="polite">{message}</p>{content}</main></>;
}

createRoot(document.getElementById('app')!).render(<App />);
