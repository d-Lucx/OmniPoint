CREATE TABLE omni.stock_positions (
  tenant_id uuid, position_id uuid, store_id uuid NOT NULL, sku text NOT NULL,
  location_id uuid NOT NULL, opening_on_hand integer NOT NULL CHECK (opening_on_hand >= 0),
  PRIMARY KEY (tenant_id, position_id),
  UNIQUE (tenant_id, store_id, sku), UNIQUE (tenant_id, position_id, store_id),
  FOREIGN KEY (tenant_id, store_id, sku) REFERENCES omni.stock
);
CREATE TABLE omni.quota_slices (
  tenant_id uuid, position_id uuid, slice_id uuid,
  PRIMARY KEY (tenant_id, position_id, slice_id),
  FOREIGN KEY (tenant_id, position_id) REFERENCES omni.stock_positions
);
CREATE TABLE omni.quota_grants (
  tenant_id uuid, grant_id uuid, position_id uuid NOT NULL, store_id uuid NOT NULL,
  terminal_id uuid NOT NULL, generation integer NOT NULL, body bytea NOT NULL,
  key_id text NOT NULL, signature text NOT NULL, transfer_id uuid, dispatch_leg_id uuid,
  PRIMARY KEY (tenant_id, grant_id),
  UNIQUE (tenant_id, position_id, grant_id), UNIQUE (tenant_id, transfer_id),
  UNIQUE (tenant_id, dispatch_leg_id),
  CHECK ((transfer_id IS NULL) = (dispatch_leg_id IS NULL)),
  FOREIGN KEY (tenant_id, position_id, store_id) REFERENCES omni.stock_positions (tenant_id, position_id, store_id),
  FOREIGN KEY (tenant_id, store_id, terminal_id, generation)
    REFERENCES omni.terminals (tenant_id, store_id, terminal_id, terminal_generation)
);
CREATE INDEX quota_grants_terminal ON omni.quota_grants (tenant_id, store_id, terminal_id, generation);
CREATE TABLE omni.quota_grant_units (
  tenant_id uuid, position_id uuid, grant_id uuid, slice_id uuid,
  PRIMARY KEY (tenant_id, position_id, grant_id, slice_id),
  FOREIGN KEY (tenant_id, position_id, grant_id) REFERENCES omni.quota_grants (tenant_id, position_id, grant_id),
  FOREIGN KEY (tenant_id, position_id, slice_id) REFERENCES omni.quota_slices
);
CREATE INDEX quota_grant_units_slice ON omni.quota_grant_units (tenant_id, position_id, slice_id);
CREATE TABLE omni.custody_receipts (
  tenant_id uuid, leg_id uuid, position_id uuid NOT NULL, grant_id uuid NOT NULL,
  body bytea NOT NULL, key_id text NOT NULL, signature text NOT NULL,
  PRIMARY KEY (tenant_id, leg_id),
  UNIQUE (tenant_id, position_id, grant_id, leg_id),
  FOREIGN KEY (tenant_id, position_id, grant_id) REFERENCES omni.quota_grants (tenant_id, position_id, grant_id)
);
CREATE TABLE omni.custody_units (
  tenant_id uuid, position_id uuid, grant_id uuid, slice_id uuid, leg_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, position_id, grant_id, slice_id),
  FOREIGN KEY (tenant_id, position_id, grant_id, slice_id) REFERENCES omni.quota_grant_units,
  FOREIGN KEY (tenant_id, position_id, grant_id, leg_id)
    REFERENCES omni.custody_receipts (tenant_id, position_id, grant_id, leg_id)
);
CREATE TABLE omni.quota_claims (
  tenant_id uuid, sale_id uuid, position_id uuid NOT NULL, grant_id uuid NOT NULL, slice_id uuid NOT NULL,
  event_bytes bytea NOT NULL, custody_leg_id uuid, custody_digest text,
  admission_no bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (tenant_id, sale_id),
  UNIQUE (tenant_id, position_id, slice_id, sale_id),
  UNIQUE (tenant_id, position_id, grant_id, slice_id),
  CHECK ((custody_leg_id IS NULL) = (custody_digest IS NULL)),
  FOREIGN KEY (tenant_id, position_id, grant_id, slice_id) REFERENCES omni.quota_grant_units,
  FOREIGN KEY (tenant_id, sale_id) REFERENCES omni.sales
);
CREATE INDEX quota_claims_custody ON omni.quota_claims (tenant_id, position_id, grant_id, custody_leg_id);
CREATE INDEX quota_claims_leg ON omni.quota_claims (tenant_id, custody_leg_id) WHERE custody_leg_id IS NOT NULL;
CREATE TABLE omni.quota_decisions (
  tenant_id uuid, sale_id uuid, position_id uuid NOT NULL, slice_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('COMMITTED', 'BACKORDER')),
  winner_sale_id uuid NOT NULL, order_no bigint GENERATED ALWAYS AS IDENTITY,
  rule text NOT NULL DEFAULT 'first-eligible-commit/v1' CHECK (rule = 'first-eligible-commit/v1'),
  PRIMARY KEY (tenant_id, sale_id),
  UNIQUE (tenant_id, position_id, sale_id),
  UNIQUE (tenant_id, position_id, slice_id, sale_id),
  CHECK ((disposition = 'COMMITTED') = (winner_sale_id = sale_id)),
  FOREIGN KEY (tenant_id, position_id, slice_id, sale_id)
    REFERENCES omni.quota_claims (tenant_id, position_id, slice_id, sale_id),
  FOREIGN KEY (tenant_id, position_id, slice_id, winner_sale_id)
    REFERENCES omni.quota_decisions (tenant_id, position_id, slice_id, sale_id)
);
CREATE UNIQUE INDEX quota_one_winner ON omni.quota_decisions (tenant_id, position_id, slice_id)
  WHERE disposition = 'COMMITTED';
CREATE TABLE omni.shortfalls (
  tenant_id uuid, sale_id uuid, position_id uuid NOT NULL, receipt_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity = 1),
  PRIMARY KEY (tenant_id, sale_id),
  UNIQUE (tenant_id, position_id, sale_id),
  FOREIGN KEY (tenant_id, position_id, sale_id) REFERENCES omni.quota_decisions (tenant_id, position_id, sale_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES omni.receipts
);
CREATE TABLE omni.replacement_units (
  tenant_id uuid, replacement_id uuid, position_id uuid NOT NULL,
  provenance text NOT NULL CHECK (length(provenance) BETWEEN 1 AND 120),
  PRIMARY KEY (tenant_id, replacement_id),
  UNIQUE (tenant_id, position_id, replacement_id),
  UNIQUE (tenant_id, provenance),
  FOREIGN KEY (tenant_id, position_id) REFERENCES omni.stock_positions
);
CREATE TABLE omni.shortfall_resolutions (
  tenant_id uuid, resolution_id uuid, position_id uuid NOT NULL, sale_id uuid NOT NULL, replacement_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, resolution_id),
  UNIQUE (tenant_id, sale_id), UNIQUE (tenant_id, replacement_id),
  FOREIGN KEY (tenant_id, position_id, sale_id) REFERENCES omni.shortfalls (tenant_id, position_id, sale_id),
  FOREIGN KEY (tenant_id, position_id, replacement_id)
    REFERENCES omni.replacement_units (tenant_id, position_id, replacement_id)
);
CREATE INDEX replacement_units_position ON omni.replacement_units (tenant_id, position_id);

DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'stock_positions', 'quota_slices', 'quota_grants', 'quota_grant_units', 'custody_receipts', 'custody_units',
    'quota_claims', 'quota_decisions', 'shortfalls', 'replacement_units', 'shortfall_resolutions'
  ] LOOP
    EXECUTE format('ALTER TABLE omni.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE omni.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON omni.%I USING
        (tenant_id = nullif(current_setting(''omni.tenant_id'', true), '''')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting(''omni.tenant_id'', true), '''')::uuid)',
      relation
    );
  END LOOP;
END
$policies$;

CREATE VIEW omni.quota_inventory WITH (security_invoker = true) AS
SELECT p.*, stock.on_hand,
  p.opening_on_hand + replacements.arrived - replacements.consumed - slices.consumed AS rebuilt_on_hand,
  slices.active + replacements.arrived - replacements.consumed AS encumbered,
  slices.in_transit,
  stock.on_hand - slices.active - replacements.arrived + replacements.consumed AS available
FROM omni.stock_positions p JOIN omni.stock stock USING (tenant_id, store_id, sku)
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE d.sale_id IS NULL)::int AS active,
    COALESCE(-sum(m.delta), 0)::int AS consumed,
    count(*) FILTER (WHERE d.sale_id IS NULL AND EXISTS (
      SELECT 1 FROM omni.quota_grant_units u JOIN omni.quota_grants g USING (tenant_id, position_id, grant_id)
      LEFT JOIN omni.custody_units c USING (tenant_id, position_id, grant_id, slice_id)
      WHERE (u.tenant_id, u.position_id, u.slice_id) = (s.tenant_id, s.position_id, s.slice_id)
        AND g.transfer_id IS NOT NULL AND c.leg_id IS NULL
    ))::int AS in_transit
  FROM omni.quota_slices s LEFT JOIN omni.quota_decisions d
    ON (d.tenant_id, d.position_id, d.slice_id) = (s.tenant_id, s.position_id, s.slice_id)
    AND d.disposition = 'COMMITTED'
  LEFT JOIN omni.sale_lines l ON l.tenant_id = d.tenant_id AND l.sale_id = d.sale_id
  LEFT JOIN omni.stock_movements m ON m.tenant_id = l.tenant_id AND m.line_id = l.line_id
  WHERE (s.tenant_id, s.position_id) = (p.tenant_id, p.position_id)
) slices
CROSS JOIN LATERAL (
  SELECT count(*)::int AS arrived, count(r.resolution_id)::int AS consumed
  FROM omni.replacement_units u LEFT JOIN omni.shortfall_resolutions r USING (tenant_id, replacement_id)
  WHERE (u.tenant_id, u.position_id) = (p.tenant_id, p.position_id)
) replacements;
