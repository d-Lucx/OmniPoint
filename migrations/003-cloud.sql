CREATE TABLE omni.retail_catalogs (
  tenant_id uuid, version integer, store_id uuid NOT NULL, body bytea NOT NULL,
  PRIMARY KEY (tenant_id, version), FOREIGN KEY (tenant_id, store_id) REFERENCES omni.stores
);
CREATE TABLE omni.retail_positions (
  tenant_id uuid, position_id uuid, PRIMARY KEY (tenant_id, position_id),
  FOREIGN KEY (tenant_id, position_id) REFERENCES omni.stock_positions
);
CREATE TABLE omni.retail_shifts (
  tenant_id uuid, shift_id uuid, store_id uuid NOT NULL, terminal_id uuid NOT NULL, generation integer NOT NULL,
  cashier_id uuid NOT NULL, drawer_id uuid NOT NULL, closed boolean NOT NULL DEFAULT false, source_no integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, shift_id),
  FOREIGN KEY (tenant_id, store_id, terminal_id, generation) REFERENCES omni.terminals (tenant_id, store_id, terminal_id, terminal_generation),
  FOREIGN KEY (tenant_id, store_id, cashier_id) REFERENCES omni.cashiers
);
CREATE UNIQUE INDEX retail_drawer_open ON omni.retail_shifts(tenant_id, store_id, drawer_id) WHERE NOT closed;
CREATE UNIQUE INDEX retail_terminal_open ON omni.retail_shifts(tenant_id, terminal_id, generation) WHERE NOT closed;
CREATE TABLE omni.retail_events (
  tenant_id uuid, event_id uuid, shift_id uuid NOT NULL, source_no integer NOT NULL, kind text NOT NULL,
  body bytea NOT NULL, digest text NOT NULL, ack bytea NOT NULL,
  PRIMARY KEY (tenant_id, event_id), UNIQUE (tenant_id, shift_id, source_no),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES omni.retail_shifts
);
CREATE TABLE omni.retail_vouchers (
  tenant_id uuid, event_id uuid, key_id text NOT NULL, signature text NOT NULL,
  PRIMARY KEY (tenant_id, event_id), FOREIGN KEY (tenant_id, event_id) REFERENCES omni.retail_events
);
CREATE TABLE omni.retail_receipts (
  tenant_id uuid, receipt_id uuid, event_id uuid NOT NULL, original_receipt_id uuid, printable text NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id), UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES omni.retail_events,
  FOREIGN KEY (tenant_id, original_receipt_id) REFERENCES omni.retail_receipts
);
CREATE TABLE omni.retail_lines (
  tenant_id uuid, line_id uuid, event_id uuid NOT NULL, position_id uuid NOT NULL, sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 8), basis_minor integer NOT NULL CHECK (basis_minor >= 0),
  tax_minor integer NOT NULL CHECK (tax_minor >= 0), facts jsonb NOT NULL,
  PRIMARY KEY (tenant_id, line_id), UNIQUE (tenant_id, line_id, position_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES omni.retail_events,
  FOREIGN KEY (tenant_id, position_id) REFERENCES omni.retail_positions
);
CREATE INDEX retail_lines_sale ON omni.retail_lines (tenant_id, event_id);
CREATE TABLE omni.retail_allocations (
  tenant_id uuid, position_id uuid, grant_id uuid, slice_id uuid, line_id uuid NOT NULL,
  fulfilled boolean NOT NULL, winner_line_id uuid NOT NULL,
  order_no bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (tenant_id, position_id, grant_id, slice_id),
  FOREIGN KEY (tenant_id, position_id, grant_id, slice_id) REFERENCES omni.quota_grant_units,
  FOREIGN KEY (tenant_id, line_id, position_id) REFERENCES omni.retail_lines (tenant_id, line_id, position_id),
  FOREIGN KEY (tenant_id, winner_line_id, position_id) REFERENCES omni.retail_lines (tenant_id, line_id, position_id),
  CHECK ((line_id=winner_line_id)=fulfilled)
);
CREATE UNIQUE INDEX retail_slice_winner ON omni.retail_allocations (tenant_id, position_id, slice_id) WHERE fulfilled;
CREATE INDEX retail_allocations_line ON omni.retail_allocations (tenant_id, line_id);
CREATE TABLE omni.retail_shortfalls (
  tenant_id uuid, line_id uuid, quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 8),
  PRIMARY KEY (tenant_id, line_id), FOREIGN KEY (tenant_id, line_id) REFERENCES omni.retail_lines
);
CREATE TABLE omni.retail_cash (
  tenant_id uuid, event_id uuid, shift_id uuid NOT NULL, kind text NOT NULL, signed_minor integer NOT NULL,
  destination_id uuid, PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES omni.retail_events,
  FOREIGN KEY (tenant_id, shift_id) REFERENCES omni.retail_shifts
);
CREATE INDEX retail_cash_shift ON omni.retail_cash (tenant_id, shift_id);
CREATE TABLE omni.retail_postings (
  tenant_id uuid, event_id uuid, account text CHECK (account IN ('Cash','Revenue','SalesTax')),
  signed_minor integer NOT NULL CHECK (signed_minor <> 0), PRIMARY KEY (tenant_id, event_id, account),
  FOREIGN KEY (tenant_id, event_id) REFERENCES omni.retail_events
);
CREATE TABLE omni.retail_closes (
  tenant_id uuid, event_id uuid, shift_id uuid NOT NULL, previous_id uuid, covered_no integer NOT NULL,
  counted_minor integer NOT NULL, expected_minor integer NOT NULL, variance_minor integer NOT NULL, delta_minor integer NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES omni.retail_events,
  FOREIGN KEY (tenant_id, shift_id) REFERENCES omni.retail_shifts,
  FOREIGN KEY (tenant_id, previous_id) REFERENCES omni.retail_closes
);
CREATE INDEX retail_closes_shift ON omni.retail_closes (tenant_id, shift_id, covered_no);
CREATE TABLE omni.retail_refunds (
  tenant_id uuid, return_id uuid, attempt_id uuid NOT NULL, line_id uuid NOT NULL, shift_id uuid NOT NULL,
  store_id uuid NOT NULL, terminal_id uuid NOT NULL, generation integer NOT NULL, original_receipt_id uuid NOT NULL,
  body jsonb NOT NULL, ordinals integer[] NOT NULL, basis_minor integer NOT NULL, tax_minor integer NOT NULL,
  state text NOT NULL CHECK (state IN ('RESERVED','PAYOUT_PENDING','CONFIRMED','RELEASED')),
  payout_event_id uuid, release_evidence text,
  PRIMARY KEY (tenant_id, return_id), UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES omni.retail_lines,
  FOREIGN KEY (tenant_id, shift_id) REFERENCES omni.retail_shifts,
  FOREIGN KEY (tenant_id, original_receipt_id) REFERENCES omni.retail_receipts,
  FOREIGN KEY (tenant_id, payout_event_id) REFERENCES omni.retail_events
);
CREATE INDEX retail_refunds_line ON omni.retail_refunds (tenant_id, line_id);
CREATE INDEX retail_refunds_shift ON omni.retail_refunds (tenant_id, shift_id);
CREATE TABLE omni.retail_stock_changes (
  tenant_id uuid, evidence_id uuid, position_id uuid NOT NULL, kind text NOT NULL,
  delta integer NOT NULL, provenance text NOT NULL, return_id uuid,
  PRIMARY KEY (tenant_id, evidence_id), UNIQUE (tenant_id, kind, provenance), UNIQUE (tenant_id, return_id),
  FOREIGN KEY (tenant_id, position_id) REFERENCES omni.retail_positions,
  FOREIGN KEY (tenant_id, return_id) REFERENCES omni.retail_refunds
);
CREATE INDEX retail_stock_changes_position ON omni.retail_stock_changes (tenant_id, position_id);
CREATE TABLE omni.retail_counts (
  tenant_id uuid, count_id uuid, position_id uuid NOT NULL, cutoff timestamptz NOT NULL,
  observed integer NOT NULL CHECK (observed >= 0), actor_id uuid NOT NULL, witness text NOT NULL,
  book_on_hand integer NOT NULL, movement_cut text NOT NULL, open_slices jsonb NOT NULL,
  PRIMARY KEY (tenant_id, count_id),
  FOREIGN KEY (tenant_id, position_id) REFERENCES omni.retail_positions
);
CREATE TABLE omni.retail_count_decisions (
  tenant_id uuid, decision_id uuid, count_id uuid NOT NULL, previous_id uuid, actor_id uuid NOT NULL,
  observed integer NOT NULL, corrected_book integer NOT NULL, delta integer NOT NULL,
  evidence text NOT NULL, recorded_no bigint GENERATED ALWAYS AS IDENTITY, PRIMARY KEY (tenant_id, decision_id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, count_id, previous_id),
  FOREIGN KEY (tenant_id, count_id) REFERENCES omni.retail_counts,
  FOREIGN KEY (tenant_id, previous_id) REFERENCES omni.retail_count_decisions
);

DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'retail_catalogs','retail_positions','retail_shifts','retail_events','retail_vouchers','retail_receipts','retail_lines',
    'retail_allocations','retail_shortfalls','retail_cash','retail_postings','retail_closes','retail_refunds',
    'retail_stock_changes','retail_counts','retail_count_decisions'
  ] LOOP
    EXECUTE format('ALTER TABLE omni.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE omni.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY tenant_scope ON omni.%I USING
      (tenant_id = nullif(current_setting(''omni.tenant_id'', true), '''')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting(''omni.tenant_id'', true), '''')::uuid)', relation);
  END LOOP;
END
$policies$;

ALTER VIEW omni.quota_inventory RENAME TO quota_inventory_v2;
CREATE VIEW omni.quota_inventory WITH (security_invoker = true) AS
SELECT q.tenant_id,q.position_id,q.store_id,q.sku,q.location_id,q.opening_on_hand,q.on_hand,
  q.rebuilt_on_hand - sold.units + changes.delta AS rebuilt_on_hand,
  q.encumbered - sold.units AS encumbered,
  q.in_transit,
  q.available + sold.units AS available
FROM omni.quota_inventory_v2 q
CROSS JOIN LATERAL (
  SELECT count(*)::int AS units FROM omni.retail_allocations a
  WHERE (a.tenant_id,a.position_id)=(q.tenant_id,q.position_id) AND a.fulfilled
) sold
CROSS JOIN LATERAL (
  SELECT coalesce(sum(c.delta),0)::int AS delta FROM omni.retail_stock_changes c
  WHERE (c.tenant_id,c.position_id)=(q.tenant_id,q.position_id)
) changes;
