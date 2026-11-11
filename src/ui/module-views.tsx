import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Capabilities } from '../module-cloud.ts';

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

async function request<T>(path: string, input: object, token?: string): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: {
    'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}),
  }, body: JSON.stringify(input), signal: AbortSignal.timeout(4000) });
  if (!response.ok && (path !== '/api/register' || response.status === 401))
    throw new Error(response.status === 401 ? 'Sign-in required' : 'Request held');
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  return (path === '/api/register' ? body.data : body) as T;
}

export function ModulePanel() {
  const [state, setState] = useState<ModuleState>();
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<Receipt>();
  const [fleet, setFleet] = useState<FleetStatus>();
  const [busy, setBusy] = useState(false);
  const [sku, setSku] = useState('toast');
  useEffect(() => {
    let active = true;
    void request<ModuleState>('/api/register', { action: 'module-state' }).then(value => {
      if (active) setState(value);
    }).catch(() => { if (active) setMessage('Module status unavailable'); });
    return () => { active = false; };
  }, []);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try { await work(); }
    catch (error) {
      setMessage(error instanceof Error ? error.message : 'Module action held');
    } finally {
      const current = await request<ModuleState>('/api/register', { action: 'module-state' }).catch(() => undefined);
      if (current) setState(current);
      setBusy(false);
    }
  }

  const { order, appointment, work } = state ?? {};

  function act(action: string, input: object = {}) {
    void run(async () => {
      await request('/api/register', { action, operationId: crypto.randomUUID(), ...input });
    });
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
    const id = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key,id);
    void run(async () => {
      setReceipt(await request<Receipt>('/api/register', { action:'module-tender',id,aggregate,revision,check,before,paid,tip }));
      sessionStorage.removeItem(key);
    });
  }

  function recover(id: string) {
    void run(async () => setReceipt(await request<Receipt>('/api/register', { action:'receipt',id })));
  }

  return <section><h2>Workflows</h2>
    <p>Capability profile {state?.profile.version ?? 'unavailable'} · Authority {state?.connectivity ?? 'UNKNOWN'}</p>
    <button disabled={busy} onClick={() => void run(async () => setState(
      await request<ModuleState>('/api/register', { action: 'module-refresh' })))}>Refresh capabilities</button>
    <button disabled={busy} onClick={() => void run(async () => {
      setFleet(undefined);
      setFleet(await request<FleetStatus>('/api/register',{action:'module-diagnostics'}));
    })}>Inspect fleet pressure</button>
    {fleet && <p>Active background {fleet.active.background} · bookings {fleet.active.booking} ·
      settlements {fleet.active.settlement} · rejected {fleet.rejected} · queue limit {fleet.queueLimit}</p>}
    <p aria-live="polite">{message}</p>
    {state?.profile.hospitality && <section><h3>Tables and kitchen</h3>
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
        <ul>{order.data.tickets.map(ticket => <li key={ticket.id}>{ticket.sku} · {ticket.station}</li>)}</ul>
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
          <p>{check.totalMinor}¢ gross · {check.taxMinor}¢ tax · {check.balance}¢ due</p>
          {check.balance > 0 && <form key={check.balance} onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            pay(order.id,order.revision,check.index,check.totalMinor-check.balance,Number(form.get('paid')),Number(form.get('tip')));
          }}>
            <label>Cash payment in cents<input name="paid" type="number" min="1" max={check.balance} defaultValue={check.balance} required /></label>
            <label>Tip in cents<input name="tip" type="number" min="0" defaultValue="0" required /></label>
            <button disabled={busy}>Tender check {check.index + 1}</button>
          </form>}
        </section>)}
        {order.receipts.map((id,index) => <button key={id} disabled={busy} onClick={() => recover(id)}>Recover check receipt {index + 1}</button>)}
      </>}
      <a href="/kitchen" target="_blank" rel="noreferrer">Open kitchen display</a>
    </section>}
    {state?.profile.services && <section><h3>Appointments</h3><form onSubmit={propose}>
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
        <p>Work order {work.receipts.length ? 'INVOICED' : work.data.stage}</p>
        {work.estimate && <p>{work.estimate.totalMinor}¢ estimate · {work.estimate.taxMinor}¢ tax</p>}
        {!work.receipts.length && <form onSubmit={event => {
          event.preventDefault();
          act('work-estimate',{id:work.id,revision:work.revision,sku:new FormData(event.currentTarget).get('part')});
        }}>
          <label>Part<select name="part">{state.parts.map(part => <option key={part}>{part}</option>)}</select></label>
          <button disabled={busy}>Save estimate</button>
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
          onClick={() => pay(work.id,work.revision,0,0,work.estimate!.totalMinor,0)}>Invoice and tender</button>}
        {work.receipts.map(id => <button key={id} disabled={busy} onClick={() => recover(id)}>Recover invoice receipt</button>)}
      </>}
    </section>}
    {receipt && <section><h3>Receipt {receipt.receiptId}</h3><pre>{receipt.printable}</pre></section>}
  </section>;
}

export function KitchenDisplay() {
  const [token, setToken] = useState('');
  const [revisions, setRevisions] = useState<Record<string, DisplayRevision>>({});
  const [connection, setConnection] = useState('Disconnected');
  const [problem, setProblem] = useState('');

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
    try {
      setProblem('');
      await request('/api/kitchen', { action, id: order.orderId, revision: order.revision, ticketId,
        operationId: crypto.randomUUID() }, token);
    } catch { setProblem('Ticket changed or station unavailable'); }
  }

  return <main><h1>Kitchen display</h1><p aria-live="polite">{connection}</p><p aria-live="polite">{problem}</p>
    {!token ? <form onSubmit={event => {
      event.preventDefault();
      setToken(String(new FormData(event.currentTarget).get('token')));
      event.currentTarget.reset();
    }}><label>Station token<input type="password" name="token" required /></label><button>Connect display</button></form>
    : <button onClick={() => { setToken(''); setConnection('Disconnected'); setRevisions({}); }}>Disconnect display</button>}
    {Object.values(revisions).map(order => <section key={order.orderId}><h2>Table {order.table}</h2>
      <ul>{order.tickets.map(ticket => <li key={ticket.id}>Seat {ticket.seat} · {ticket.sku} · {ticket.modifier} · {ticket.status}
        {ticket.status === 'QUEUED' && <><button onClick={() => void update(order, ticket.id, 'ready')}>Ready</button>
          <button onClick={() => void update(order, ticket.id, 'cancel')}>Cancel ticket</button></>}</li>)}</ul>
    </section>)}
  </main>;
}
