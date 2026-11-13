import type { FormEvent } from 'react';
import { Evidence, Status } from './components.tsx';

export interface DiagnosticsState {
  cloud: string;
  outbox: Array<{ event_id: string; kind: string; state: string; attempts: number; result?: string; ack_id?: string;
    lines?: Array<{ lineId: string; fulfilled: number; backordered: number }> }>;
  devices: Array<{ command_id: string; kind: string; state: string; detail?: string }>;
  quota: Array<{ sku: string; grant_id: string; expires_at: string; unspent: number; awaiting_custody: number }>;
  refunds: Array<{ return_id: string; state: string }>;
}

export function Diagnostics({ state, busy, onSync, onDispatch, onCheck }: {
  state: DiagnosticsState; busy: boolean; onSync: () => void; onDispatch: () => void;
  onCheck: (id: string, evidence: string, pin: string) => void;
}) {
  function submit(e: FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault();
    const input = new FormData(e.currentTarget);
    onCheck(id, String(input.get('evidence')), String(input.get('pin')));
  }
  return <>
    <div className="section-heading"><h2>Register support</h2><Status tone={state.cloud === 'OFFLINE' ? 'warning' : 'neutral'}>Cloud {state.cloud === 'UNKNOWN' ? 'not checked' : state.cloud}</Status></div>
    <section><h2>Outbox and verified outcomes</h2><button disabled={busy} onClick={onSync}>Retry next event</button>
      <p>Retry sends the original stored event. A local receipt remains valid while cloud confirmation is pending. A confirmed event may still contain a backorder.</p>
      {!state.outbox.length && <p className="empty-state">No recorded events in this view.</p>}
      <ul className="record-list">{[...state.outbox].sort((a,b) => Number(b.state.includes('HELD')) - Number(a.state.includes('HELD'))).map((row, index) => <li key={row.event_id}>
        <strong>{row.kind === 'SALE' ? 'Sale' : row.kind === 'RETURN' ? 'Return' : 'Register event'} {index + 1}</strong>{' '}
        <Status tone={row.state.includes('HELD') ? 'warning' : row.state === 'SYNCED' ? 'success' : 'neutral'}>{row.state === 'SYNCED' ? 'Cloud confirmed' : row.state.includes('HELD') ? 'Held for review' : 'Awaiting cloud confirmation'}</Status>
        <p>{row.state.includes('HELD') ? 'Ask support to inspect the conflict and original evidence. Do not create a replacement sale.' :
          row.state === 'SYNCED' ? 'Verified acknowledgment saved. Review stock fulfillment below.' : 'Connect to the cloud and retry the next event.'}</p>
        {row.lines?.map((line, n) => <div key={line.lineId}>Line {n + 1} · fulfilled {line.fulfilled} · backordered {line.backordered}</div>)}
        <Evidence><p>Event {row.event_id} · {row.kind} · {row.state} · {row.result ?? 'Pending'} · attempts {row.attempts}</p>
          {row.ack_id && <p>ACK {row.ack_id}</p>}{row.lines?.map(line => <p key={line.lineId}>Line {line.lineId}</p>)}</Evidence>
      </li>)}</ul>
    </section>
    <section><h2>Device attempts</h2><button disabled={busy} onClick={onDispatch}>Dispatch next unsent command</button>
      <p>Check the physical device when delivery is uncertain. Dispatch only sends an unsent command; it does not repeat an uncertain drawer pulse or print.</p>
      {!state.devices.length && <p className="empty-state">No device commands recorded.</p>}
      <ul className="record-list">{[...state.devices].sort((a,b) => Number(b.state === 'UNCERTAIN') - Number(a.state === 'UNCERTAIN')).map(device => <li key={device.command_id}>
        <strong>{device.kind === 'PRINTER' ? 'Receipt printer' : device.kind === 'DRAWER' ? 'Cash drawer' : device.kind}</strong>{' '}
        <Status tone={device.state === 'UNCERTAIN' ? 'warning' : 'neutral'}>{device.state === 'UNCERTAIN' ? 'Delivery uncertain' : device.state === 'UNSENT' ? 'Waiting to dispatch' : device.state === 'CHECKED' ? 'Operator check recorded' : device.state === 'CONFIRMED' ? 'Device confirmed' : device.state}</Status>
        <Evidence><p>{device.command_id} · {device.state} · {device.detail ?? 'No additional evidence'}</p></Evidence>
        {device.state === 'UNCERTAIN' && <form onSubmit={e => submit(e, device.command_id)}>
          <label>Operator check evidence<input name="evidence" required /></label>
          <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Record operator check</button>
        </form>}
      </li>)}</ul>
    </section>
    <section><h2>Quota and custody</h2><p>Stock allocation and physical custody are separate. Ask the inventory operator to resolve expired grants or missing custody evidence; do not bypass the stock fence.</p>
      {!state.quota.length && <p>No stock grants installed.</p>}<ul className="record-list">{state.quota.map(grant => <li key={grant.grant_id}><strong>{grant.sku}</strong> · {grant.unspent} unspent ·
      {grant.awaiting_custody} awaiting custody · expires <time dateTime={grant.expires_at}>{new Date(grant.expires_at).toLocaleString()}</time><Evidence title="Grant identity">{grant.grant_id}</Evidence></li>)}</ul></section>
    <section><h2>Refund holds</h2><p>Resolve uncertain payouts in Receipts &amp; returns before closing the drawer. Confirm payment only after verifying that cash was handed out, or release with verified nonpayment evidence.</p>
      {!state.refunds.length && <p>No returns recorded.</p>}<ul className="record-list">{state.refunds.map((refund,index) => <li key={refund.return_id}>Return {state.refunds.length-index} · {refund.state === 'UNCERTAIN' ? 'Payout uncertain' : refund.state === 'CONFIRMED' ? 'Payout confirmed' : refund.state === 'RESERVED' ? 'Reserved for payout' : refund.state}<Evidence title="Return identity">{refund.return_id}</Evidence></li>)}</ul></section>
    <section><h2>Operator-led administration</h2><p>Inventory receiving and counts, treasury, period close and signed reporting use the authorized inventory and governance commands. Contact the enrolled operator. Cashier sign-in does not grant those permissions.</p></section>
  </>;
}
