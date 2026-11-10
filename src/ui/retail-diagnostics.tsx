import type { FormEvent } from 'react';

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
    <section><h2>Outbox and verified outcomes</h2><button disabled={busy} onClick={onSync}>Retry next event</button>
      <ul>{state.outbox.map(row => <li key={row.event_id}>{row.kind} · {row.state} · {row.result ?? 'Pending'} · attempts {row.attempts}
        {row.ack_id && <div>ACK {row.ack_id}</div>}
        {row.lines?.map(line => <div key={line.lineId}>Line {line.lineId} · fulfilled {line.fulfilled} · backordered {line.backordered}</div>)}
      </li>)}</ul>
    </section>
    <section><h2>Device attempts</h2><button disabled={busy} onClick={onDispatch}>Dispatch next unsent command</button>
      <ul>{state.devices.map(device => <li key={device.command_id}>{device.kind} · {device.state} · {device.detail ?? 'Pending'} · {device.command_id}
        {device.state === 'UNCERTAIN' && <form onSubmit={e => submit(e, device.command_id)}>
          <label>Operator check evidence<input name="evidence" required /></label>
          <label>Supervisor PIN<input name="pin" type="password" required /></label><button disabled={busy}>Record operator check</button>
        </form>}
      </li>)}</ul>
    </section>
    <section><h2>Quota and custody</h2><ul>{state.quota.map(grant => <li key={grant.grant_id}>{grant.sku} · {grant.unspent} unspent ·
      {grant.awaiting_custody} awaiting custody · expires {grant.expires_at}</li>)}</ul></section>
    <section><h2>Refund holds</h2><ul>{state.refunds.map(refund => <li key={refund.return_id}>{refund.return_id} · {refund.state}</li>)}</ul></section>
  </>;
}
