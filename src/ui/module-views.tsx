import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Capabilities } from '../module-cloud.ts';
import { Evidence, MoneyInput, Status } from './components.tsx';
import { parseCurrency, usd } from './money.ts';
import { readRequest, rememberRequest } from './pending-request.ts';
import type { Quote } from '../retail-money.ts';

type Revision<T> = { id: string; revision: number; data: T; receipts: string[] };
type ModuleState = { profile: Capabilities; connectivity: string; parts: string[];
  order?: Revision<Order> & { checks?: Check[] };
  appointment?: Revision<{ status: string; staff: string }>;
  work?: Revision<{ stage: string }> & { estimate?: { totalMinor: number; taxMinor: number } } };
type Order = { table: string; seats: number; tickets: { id: string; sku: string; station: string; status: string }[] };
type Check = { index: number; totalMinor: number; taxMinor: number; balance: number };
type Receipt = { receiptId: string; printable: string };
type FleetStatus = { active: { background: number; booking: number; settlement: number }; rejected: number; queueLimit: number };
type DisplayRevision = { orderId: string; table: string; revision: number;
  tickets: { id: string; sku: string; seat: number; modifier: string; status: string }[] };
type DisplayPage = { cursor: number; revisions: DisplayRevision[] };
class RejectedRequest extends Error {}
const pendingWorkflow = 'omni-pending-workflow';

async function request<T>(path: string, input: object, token?: string): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: {
    'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}),
  }, body: JSON.stringify(input), signal: AbortSignal.timeout(4000) });
  if (!response.ok && (path !== '/api/register' || response.status === 401))
    throw new RejectedRequest(response.status === 401 ? 'Sign-in required' : 'Request held');
  const body = await response.json();
  if (body.error) throw new RejectedRequest(body.error);
  return (path === '/api/register' ? body.data : body) as T;
}

export function ModulePanel({ catalog = [], onRegisterChange }: { catalog?: Quote[]; onRegisterChange?: () => Promise<void> }) {
  const [state, setState] = useState<ModuleState>();
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<Receipt>();
  const [fleet, setFleet] = useState<FleetStatus>();
  const [busy, setBusy] = useState(false);
  const fence = useRef(false);
  const [pending, setPending] = useState(() => readRequest(localStorage, pendingWorkflow));
  const [retryPin, setRetryPin] = useState('');
  const [failed, setFailed] = useState(false);
  const notice = useRef<HTMLParagraphElement>(null);
  const [sku, setSku] = useState('toast');
  useEffect(() => {
    let active = true;
    void request<ModuleState>('/api/register', { action: 'module-state' }).then(value => {
      if (active) setState(value);
    }).catch(() => { if (active) setMessage('Module status unavailable'); });
    return () => { active = false; };
  }, []);

  async function run(work: () => Promise<void>) {
    if (fence.current) return;
    fence.current = true;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try { await work(); setMessage('Workflow action recorded. Review the updated state below.'); }
    catch (error) {
      setFailed(true);
      const message = error instanceof Error ? error.message : 'Module action held';
      setMessage(message === 'Stale module revision' ? 'This order changed at another station. Review the latest state, then repeat your intended action.' :
        message === 'APPOINTMENT_CONFLICT' ? 'That appointment time is no longer available. Keep the draft and choose another time.' : message);
    } finally {
      const current = await request<ModuleState>('/api/register', { action: 'module-state' }).catch(() => undefined);
      if (current) setState(current);
      // Event-driven read refresh only: never creates an operation or retry identity.
      await onRegisterChange?.();
      fence.current = false;
      setBusy(false);
    }
  }

  const { order, appointment, work } = state ?? {};
  useEffect(() => { if (failed) notice.current?.focus(); }, [failed, message]);

  function execute(input: Record<string, unknown>) {
    if (fence.current) return;
    const original = rememberRequest(localStorage, pendingWorkflow, input);
    setPending(readRequest(localStorage, pendingWorkflow));
    void run(async () => {
      try {
        const result = await request<Receipt>('/api/register', original);
        if (original.action === 'module-tender') setReceipt(result);
        localStorage.removeItem(pendingWorkflow); setPending(undefined); setRetryPin('');
      } catch (error) {
        if (error instanceof RejectedRequest) { localStorage.removeItem(pendingWorkflow); setPending(undefined); }
        throw error;
      }
    });
  }

  function act(action: string, input: object = {}) {
    if (pending) return;
    execute({ action, operationId: crypto.randomUUID(), ...input });
  }

  function seat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    act('seat-table', { id: crypto.randomUUID(), table: form.get('table'), seats: Number(form.get('seats')) });
  }

  function dispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!order) return;
    act('dispatch-ticket', { id: order.id, revision: order.revision,
      seat: Number(form.get('seat')), sku, modifier: form.get('modifier') });
  }

  function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const start = new Date(String(form.get('start')) + 'Z');
    act('appointment-draft', { id:crypto.randomUUID(), staff:form.get('staff'),
      minutes:Number(form.get('minutes')), start:start.toISOString() });
  }

  function pay(aggregate: string, revision: number, check: number, before: number, paid: number, tip: number) {
    const key = 'omni-module:' + [aggregate,revision,check,before,paid,tip].join(':');
    const id = localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? crypto.randomUUID();
    localStorage.setItem(key,id);
    if (pending) return;
    execute({ action:'module-tender',id,aggregate,revision,check,before,paid,tip });
  }

  function recover(id: string) {
    void run(async () => setReceipt(await request<Receipt>('/api/register', { action:'receipt',id })));
  }

  return <section className="workflow-panel"><h2>Workflows</h2>
    <p>Capability profile {state?.profile.version ?? 'unavailable'} · Authority {state?.connectivity ?? 'UNKNOWN'}</p>
    <div className="row">
    <button className="secondary" disabled={busy} onClick={() => void run(async () => setState(
      await request<ModuleState>('/api/register', { action: 'module-refresh' })))}>Refresh capabilities</button>
    <button className="secondary" disabled={busy} onClick={() => void run(async () => {
      setFleet(undefined);
      setFleet(await request<FleetStatus>('/api/register',{action:'module-diagnostics'}));
    })}>Inspect fleet pressure</button></div>
    {fleet && <p>Active background {fleet.active.background} · bookings {fleet.active.booking} ·
      settlements {fleet.active.settlement} · rejected {fleet.rejected} · queue limit {fleet.queueLimit}</p>}
    <p className={'notice' + (failed ? ' error' : '')} ref={notice} tabIndex={-1} role={failed ? 'alert' : 'status'}>{busy ? 'Working… Keep the original action open.' : message}</p>
    {pending && !busy && <section className="recovery-banner"><h3>Workflow response uncertain</h3><p>Retry the saved action before creating another. Its original identity and inputs are retained across reload.</p>
      {pending.action === 'work-authorize' && <label>Recovery supervisor PIN<input type="password" value={retryPin} onChange={event => setRetryPin(event.target.value)} /></label>}
      <button disabled={busy || (pending.action === 'work-authorize' && !retryPin)} onClick={() => execute({ ...pending, ...(retryPin ? { pin: retryPin } : {}) })}>Retry original workflow action</button>
      <Evidence>{String(pending.action)} · {String(pending.operationId)}</Evidence></section>}
    <fieldset className="workflow-fields" aria-label="Enabled workflows" disabled={busy || !!pending}>
    {state?.profile.hospitality && <section className="workflow-section"><h3>Tables and kitchen</h3>
      <form onSubmit={seat}><label>Table<select name="table"><option>T1</option><option>T2</option></select></label>
        <label>Guests<input name="seats" type="number" min="1" max="6" defaultValue="2" required /></label>
        <button disabled={busy}>Seat guests</button></form>
      {order && <><h4>Table {order.data.table}</h4>{!order.checks && <form onSubmit={dispatch}>
        <label>Seat<input name="seat" type="number" min="1" max={order.data.seats} defaultValue="1" required /></label>
        <label>Menu item<select value={sku} onChange={event => setSku(event.target.value)}>
          <option value="toast">Toast</option><option value="salad">Salad</option></select></label>
        <label>Modifier<select key={sku} name="modifier">{(sku === 'toast' ? ['butter','jam'] : ['plain','dressing'])
          .map(value => <option key={value}>{value}</option>)}</select></label>
        <button disabled={busy}>Dispatch to kitchen</button></form>}
        <ul>{order.data.tickets.map(ticket => <li key={ticket.id}>{ticket.sku} · {ticket.station}<Status>{ticket.status === 'READY' ? 'Ready' : ticket.status === 'CANCELLED' ? 'Cancelled' : 'Queued'}</Status></li>)}</ul>
        {!order.checks && order.data.tickets.some(ticket => ticket.status !== 'CANCELLED') &&
          <form onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const mode = form.get('split');
            act('split-checks', { id:order.id, revision:order.revision,
              split:{ mode, selected:mode === 'selected' ? form.getAll('selected') : [] } });
          }}>
            <label>Split method<select name="split"><option value="equal">Equal halves</option>
              <option value="seat">By seat</option><option value="selected">Selected lines</option></select></label>
            {order.data.tickets.filter(ticket => ticket.status !== 'CANCELLED').map(ticket =>
              <label key={ticket.id}><input type="checkbox" name="selected" value={ticket.id} />{ticket.sku}</label>)}
            <button disabled={busy}>Freeze checks</button>
          </form>}
        {order.checks?.map(check => <section key={check.index}>
          <h5>Check {check.index + 1}</h5>
          <p>{usd(check.totalMinor)} gross · {usd(check.taxMinor)} tax · {usd(check.balance)} due</p>
          {check.balance > 0 && <form key={check.balance} onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            pay(order.id,order.revision,check.index,check.totalMinor-check.balance,parseCurrency(String(form.get('paid'))),parseCurrency(String(form.get('tip'))));
          }}>
            <MoneyInput label="Cash payment (USD)" name="paid" defaultValue={(check.balance / 100).toFixed(2)} required />
            <MoneyInput label="Tip (USD)" name="tip" defaultValue="0.00" required />
            <button disabled={busy}>Tender check {check.index + 1}</button>
          </form>}
        </section>)}
        <div className="row">{order.receipts.map((id,index) => <button className="secondary" key={id} disabled={busy} onClick={() => recover(id)}>Recover check receipt {index + 1}</button>)}</div>
      </>}
      <a href="/kitchen" target="_blank" rel="noreferrer">Open kitchen display</a>
    </section>}
    {state?.profile.services && <section className="workflow-section"><h3>Appointments</h3><form onSubmit={propose}>
      <label>Staff<select name="staff"><option value="alex">Alex</option><option value="sam">Sam</option></select></label>
      <label>Start (UTC)<input name="start" type="datetime-local" required /></label>
      <label>Duration in minutes<input name="minutes" type="number" min="15" max="120" defaultValue="30" required /></label>
      <button disabled={busy}>Save appointment draft</button></form>
      {appointment && <p>Appointment {appointment.data.status === 'CONFIRMED' ? 'confirmed' : 'draft'}{' '}
        {appointment.data.status === 'DRAFT' && <button disabled={busy}
          onClick={() => act('appointment-book',{id:appointment.id})}>Confirm appointment</button>}</p>}
      <h3>Work order</h3>
      <button disabled={busy} onClick={() => act('work-intake',{id:crypto.randomUUID(),
        booking:appointment?.data.status === 'CONFIRMED' ? appointment.id : null, technician:appointment?.data.staff ?? 'alex'})}>
        Start intake
      </button>
      {work && <>
        <p>Work order {work.receipts.length ? 'invoiced' : ({ INTAKE: 'intake', ESTIMATE: 'estimate awaiting approval', APPROVED: 'approved', WORK: 'in progress' } as Record<string,string>)[work.data.stage] ?? work.data.stage}</p>
        <p>Estimate changes invalidate earlier approval. Record customer consent for the current revision before starting work.</p>
        {work.estimate && <p>{usd(work.estimate.totalMinor)} estimate · {usd(work.estimate.taxMinor)} tax · Revision {work.revision}</p>}
        {!work.receipts.length && <form onSubmit={event => {
          event.preventDefault();
          act('work-estimate',{id:work.id,revision:work.revision,sku:new FormData(event.currentTarget).get('part')});
        }}>
          <label>Part<select name="part">{state.parts.map(part => <option key={part} value={part}>{catalog.find(item => item.sku === part)?.label ?? part}</option>)}</select></label>
          <button className="secondary" disabled={busy}>Save estimate</button>
        </form>}
        {work.data.stage === 'ESTIMATE' && <form onSubmit={event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          act('work-authorize',{id:work.id,revision:work.revision,consent:form.get('consent'),pin:form.get('pin')});
        }}>
          <label>Customer consent reference<input name="consent" required /></label>
          <label>Supervisor PIN<input name="pin" type="password" required /></label>
          <button disabled={busy}>Authorize estimate</button>
        </form>}
        {work.data.stage === 'APPROVED' && <button disabled={busy} onClick={() =>
          act('work-start',{id:work.id,revision:work.revision})}>Start work</button>}
        {work.data.stage === 'WORK' && work.estimate && !work.receipts.length && <button disabled={busy}
          onClick={() => pay(work.id,work.revision,0,0,work.estimate!.totalMinor,0)}>Invoice and tender {usd(work.estimate.totalMinor)}</button>}
        <div className="row">{work.receipts.map(id => <button className="secondary" key={id} disabled={busy} onClick={() => recover(id)}>Recover invoice receipt</button>)}</div>
      </>}
    </section>}
    </fieldset>
    {receipt && <section><h3>Saved workflow receipt</h3><p>Saved on this register. Review cloud confirmation and inventory fulfillment separately in Diagnostics.</p><pre aria-label="Workflow printable receipt">{receipt.printable}</pre><Evidence title="Receipt identity">{receipt.receiptId}</Evidence></section>}
  </section>;
}

export function KitchenDisplay() {
  const [token, setToken] = useState('');
  const [revisions, setRevisions] = useState<Record<string, DisplayRevision>>({});
  const [connection, setConnection] = useState('Disconnected');
  const [problem, setProblem] = useState('');
  const [lastUpdate, setLastUpdate] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const fence = useRef(false);
  const pendingKey = 'omni-kitchen-pending';
  const [pending, setPending] = useState(() => readRequest(localStorage, pendingKey));
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const fresh = connection === 'Connected' && lastUpdate !== undefined && now - lastUpdate < 5000;

  useEffect(() => {
    if (!token) return;
    let cursor = 0;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await request<DisplayPage>('/api/kitchen', { action: 'feed', cursor }, token);
        if (!active) return;
        cursor = result.cursor;
        setConnection('Connected');
        setLastUpdate(Date.now()); setNow(Date.now());
        setProblem(current => current.startsWith('Ticket action recorded.') ? '' : current);
        setRevisions(current => {
          const next = { ...current };
          for (const revision of result.revisions) {
            if (revision.revision > (next[revision.orderId]?.revision ?? 0)) next[revision.orderId] = revision;
          }
          return next;
        });
      } catch { if (active) setConnection('Disconnected · tickets may be stale'); }
      if (active) timer = setTimeout(poll, 800);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [token]);

  async function update(order: DisplayRevision, ticketId: string, action: 'ready' | 'cancel') {
    if (fence.current || !fresh) return;
    const original = rememberRequest(localStorage, pendingKey, { action, id: order.orderId, revision: order.revision, ticketId,
      operationId: crypto.randomUUID() });
    await sendUpdate(original);
  }

  async function sendUpdate(original: Record<string, unknown>) {
    if (fence.current || !fresh) return;
    fence.current = true; setBusy(true); setPending(readRequest(localStorage, pendingKey));
    try {
      setProblem('');
      await request('/api/kitchen', original, token);
      localStorage.removeItem(pendingKey); setPending(undefined);
      setProblem('Ticket action recorded. Waiting for the refreshed station feed.');
    } catch (error) {
      if (error instanceof RejectedRequest) { localStorage.removeItem(pendingKey); setPending(undefined); }
      setProblem('Ticket changed or station unavailable. Check the current ticket; retry the original action if its response is uncertain.');
    } finally { fence.current = false; setBusy(false); }
  }

  return <main><h1>Kitchen display</h1><p role="status"><Status tone={fresh ? 'success' : 'warning'}>{fresh ? 'Connected' : 'Disconnected · tickets may be stale'}</Status></p>
    <p className="muted">{lastUpdate ? `Last station update: ${new Date(lastUpdate).toLocaleTimeString()}` : 'No station update received.'} Actions are available only on a fresh connection.</p><p role="status">{problem}</p>
    {!token ? <form onSubmit={event => {
      event.preventDefault();
      setToken(String(new FormData(event.currentTarget).get('token')));
      event.currentTarget.reset();
    }}><label>Station token<input type="password" name="token" required /></label><button>Connect display</button></form>
    : <button onClick={() => { setToken(''); setConnection('Disconnected'); setLastUpdate(undefined); setRevisions({}); }}>Disconnect display</button>}
    {pending && !busy && <section className="recovery-banner"><h2>Ticket action needs recovery</h2><p>Reconnect to the original station and retry its saved action.</p><button disabled={busy || !fresh} onClick={() => void sendUpdate(pending)}>Retry original ticket action</button></section>}
    {token && !Object.keys(revisions).length && <p className="empty-state">No tickets received for this station.</p>}
    {Object.values(revisions).map(order => <section key={order.orderId}><h2>Table {order.table}</h2>
      <ul className="kitchen-list">{order.tickets.map(ticket => <li key={ticket.id}><p>Seat {ticket.seat} · {ticket.sku} · {ticket.modifier} · {ticket.status}</p>
        {ticket.status === 'QUEUED' && <div className="row"><button disabled={busy || !fresh || !!pending} onClick={() => void update(order, ticket.id, 'ready')}>Ready</button>
          <button className="danger" disabled={busy || !fresh || !!pending} onClick={() => void update(order, ticket.id, 'cancel')}>Cancel ticket</button></div>}</li>)}</ul>
    </section>)}
  </main>;
}
