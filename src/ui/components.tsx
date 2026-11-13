import { useId, useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { parseCurrency, usd } from './money.ts';

export function MoneyInput({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  const [error, setError] = useState('');
  return <label className="money-field" htmlFor={id}>{label}<span className="money-input"><span aria-hidden="true">$</span>
    <input {...props} id={id} type="text" inputMode="decimal" maxLength={12} pattern="[0-9]+(\.[0-9]{1,2})?"
      aria-invalid={error ? true : undefined} aria-describedby={error ? id + '-error' : undefined}
      onChange={event => { event.currentTarget.setCustomValidity(''); setError('');
        if (event.target.value) { try { parseCurrency(event.target.value); }
          catch (e) { event.currentTarget.setCustomValidity((e as Error).message); } }
        props.onChange?.(event); }}
      onInvalid={event => { const message = 'Enter dollars with up to two decimal places, for example 5.00';
        event.currentTarget.setCustomValidity(message); setError(message); }}
      onBlur={event => { if (!event.target.value) return; try { parseCurrency(event.target.value); }
        catch (e) { const message = (e as Error).message; event.currentTarget.setCustomValidity(message); setError(message); } }} />
  </span>{error && <span className="field-error" id={id + '-error'}>{error}</span>}</label>;
}

export function Evidence({ children, title = 'Technical details' }: { children: ReactNode; title?: string }) {
  return <details className="evidence"><summary>{title}</summary>{children}</details>;
}

export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' | 'success' }) {
  return <span className={'badge ' + tone}>{children}</span>;
}

export function ReceiptView({ receipt, outcome }: { receipt: { receiptId: string; printable: string }; outcome?: {
  state: string; lines?: Array<{ lineId: string; fulfilled: number; backordered: number }>;
} }) {
  const backordered = outcome?.lines?.reduce((n, line) => n + line.backordered, 0) ?? 0;
  const cloudLabel = !outcome ? 'Not shown here' : outcome.state === 'SYNCED' ? 'Cloud confirmed' : outcome.state.includes('HELD') ? 'Held for review' : 'Awaiting confirmation';
  return <article className="receipt-view"><div className="section-heading"><h3>Saved receipt</h3><Status tone="success">Saved on this register</Status></div>
    <dl className="receipt-facts"><div><dt>Local receipt</dt><dd>Saved</dd></div><div><dt>Cloud synchronization</dt><dd>{cloudLabel}</dd></div>
      <div><dt>Inventory fulfillment</dt><dd>{backordered ? `${backordered} backordered` : outcome?.lines ? 'Outcome recorded' : 'Not verified here'}</dd></div></dl>
    <p>{!outcome ? 'Cloud status is not available in this recent-event view. Check Diagnostics or ask support.' : outcome.state === 'SYNCED' ? 'Cloud confirmed.' : outcome.state.includes('HELD') ?
      'Synchronization held. Ask a supervisor to review the evidence in Diagnostics.' : 'Awaiting verified cloud confirmation.'}{' '}
      {backordered ? `${backordered} item(s) backordered. Arrange fulfillment with the inventory operator.` :
        outcome?.lines ? 'Inventory outcome recorded below.' : 'Inventory fulfillment has not been verified here.'}</p>
    {outcome?.lines?.map((line, index) => <p key={line.lineId}>Line {index + 1}: fulfilled {line.fulfilled} · backordered {line.backordered}</p>)}
    <pre aria-label="Printable receipt">{receipt.printable}</pre>
    <Evidence title="Receipt identity"><code>{receipt.receiptId}</code></Evidence>
  </article>;
}

export function Amounts({ subtotal, tax, total }: { subtotal: number; tax: number; total: number }) {
  return <dl className="totals"><div><dt>Subtotal after discounts</dt><dd>{usd(subtotal)}</dd></div>
    <div><dt>Tax</dt><dd>{usd(tax)}</dd></div><div className="grand-total"><dt>Total</dt><dd>{usd(total)}</dd></div></dl>;
}
