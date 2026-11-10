CREATE TABLE omni.tenants (tenant_id uuid PRIMARY KEY);
CREATE TABLE omni.stores (
  tenant_id uuid REFERENCES omni.tenants, store_id uuid,
  PRIMARY KEY (tenant_id, store_id)
);
CREATE TABLE omni.terminals (
  tenant_id uuid, store_id uuid, terminal_id uuid, terminal_generation integer CHECK (terminal_generation > 0),
  PRIMARY KEY (tenant_id, terminal_id, terminal_generation),
  UNIQUE (tenant_id, store_id, terminal_id, terminal_generation),
  FOREIGN KEY (tenant_id, store_id) REFERENCES omni.stores
);
CREATE TABLE omni.cashiers (
  tenant_id uuid, store_id uuid, cashier_id uuid,
  PRIMARY KEY (tenant_id, store_id, cashier_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES omni.stores
);
CREATE TABLE omni.stock (
  tenant_id uuid, store_id uuid, sku text, on_hand integer NOT NULL CHECK (on_hand >= 0),
  PRIMARY KEY (tenant_id, store_id, sku),
  FOREIGN KEY (tenant_id, store_id) REFERENCES omni.stores
);
CREATE TABLE omni.sales (
  tenant_id uuid, sale_id uuid, store_id uuid NOT NULL, terminal_id uuid NOT NULL,
  terminal_generation integer NOT NULL, local_sequence_no integer NOT NULL CHECK (local_sequence_no > 0),
  cashier_id uuid NOT NULL, request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  currency text NOT NULL CHECK (currency = 'USD'),
  total_minor integer NOT NULL CHECK (total_minor > 0), cash_minor integer NOT NULL CHECK (cash_minor = total_minor),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, sale_id),
  UNIQUE (tenant_id, sale_id, store_id),
  CONSTRAINT sales_terminal_sequence UNIQUE (tenant_id, terminal_id, terminal_generation, local_sequence_no),
  FOREIGN KEY (tenant_id, store_id, terminal_id, terminal_generation) REFERENCES omni.terminals
    (tenant_id, store_id, terminal_id, terminal_generation),
  FOREIGN KEY (tenant_id, store_id, cashier_id) REFERENCES omni.cashiers
);
CREATE TABLE omni.receipts (
  tenant_id uuid, receipt_id uuid, sale_id uuid NOT NULL, printable text NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id), UNIQUE (tenant_id, sale_id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES omni.sales
);
CREATE TABLE omni.sale_lines (
  tenant_id uuid, line_id uuid, sale_id uuid NOT NULL, store_id uuid NOT NULL, sku text NOT NULL,
  label text NOT NULL, quantity integer NOT NULL CHECK (quantity = 1),
  unit_minor integer NOT NULL CHECK (unit_minor > 0),
  PRIMARY KEY (tenant_id, line_id), UNIQUE (tenant_id, sale_id),
  FOREIGN KEY (tenant_id, sale_id, store_id) REFERENCES omni.sales (tenant_id, sale_id, store_id),
  FOREIGN KEY (tenant_id, store_id, sku) REFERENCES omni.stock
);
CREATE TABLE omni.stock_movements (
  tenant_id uuid, line_id uuid, delta integer NOT NULL CHECK (delta = -1),
  PRIMARY KEY (tenant_id, line_id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES omni.sale_lines
);
CREATE TABLE omni.journals (
  tenant_id uuid, sale_id uuid, currency text NOT NULL CHECK (currency = 'USD'),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (tenant_id, sale_id),
  UNIQUE (tenant_id, sale_id, amount_minor),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES omni.sales
);
CREATE TABLE omni.journal_lines (
  tenant_id uuid, sale_id uuid, account text, side text NOT NULL, amount_minor integer NOT NULL,
  PRIMARY KEY (tenant_id, sale_id, account),
  CHECK ((account = 'Cash' AND side = 'DR') OR (account = 'Revenue' AND side = 'CR')),
  FOREIGN KEY (tenant_id, sale_id, amount_minor) REFERENCES omni.journals (tenant_id, sale_id, amount_minor)
);
CREATE TABLE omni.outcomes (
  tenant_id uuid, sale_id uuid, ack_id uuid NOT NULL, body bytea NOT NULL,
  PRIMARY KEY (tenant_id, sale_id), UNIQUE (tenant_id, ack_id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES omni.sales
);
CREATE TABLE omni.vouchers (
  tenant_id uuid, sale_id uuid, key_id text NOT NULL, signature text NOT NULL,
  PRIMARY KEY (tenant_id, sale_id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES omni.outcomes
);

CREATE INDEX sales_terminal_fk ON omni.sales (tenant_id, store_id, terminal_id, terminal_generation);
CREATE INDEX sales_cashier_fk ON omni.sales (tenant_id, store_id, cashier_id);
CREATE INDEX sale_lines_stock_fk ON omni.sale_lines (tenant_id, store_id, sku);

DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'tenants', 'stores', 'terminals', 'cashiers', 'stock', 'sales', 'receipts',
    'sale_lines', 'stock_movements', 'journals', 'journal_lines', 'outcomes', 'vouchers'
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
