CREATE TABLE terminal (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  tenant_id TEXT NOT NULL, store_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
  generation INTEGER NOT NULL, cashier_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
) STRICT;
CREATE TABLE catalog (
  sku TEXT PRIMARY KEY, label TEXT NOT NULL, currency TEXT NOT NULL,
  unit_minor INTEGER NOT NULL CHECK (unit_minor > 0),
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0)
) STRICT;
CREATE TABLE sales (
  sale_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
  local_sequence_no INTEGER NOT NULL UNIQUE, cashier_id TEXT NOT NULL,
  currency TEXT NOT NULL, total_minor INTEGER NOT NULL, cash_minor INTEGER NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;
CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY, sale_id TEXT NOT NULL UNIQUE REFERENCES sales,
  printable TEXT NOT NULL
) STRICT;
CREATE TABLE sale_lines (
  line_id TEXT PRIMARY KEY, sale_id TEXT NOT NULL UNIQUE REFERENCES sales,
  sku TEXT NOT NULL REFERENCES catalog, quantity INTEGER NOT NULL CHECK (quantity = 1),
  label TEXT NOT NULL, unit_minor INTEGER NOT NULL
) STRICT;
CREATE TABLE stock_movements (
  line_id TEXT PRIMARY KEY REFERENCES sale_lines, delta INTEGER NOT NULL CHECK (delta = -1)
) STRICT;
CREATE TABLE outbox (
  sale_id TEXT PRIMARY KEY REFERENCES sales, event_bytes BLOB NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('PENDING','IN_FLIGHT','RETRY_WAIT','SYNCED','CONFLICT_HELD')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  ack_id TEXT,
  CHECK ((state = 'IN_FLIGHT') = (lease_until IS NOT NULL)),
  CHECK ((state IN ('SYNCED','CONFLICT_HELD')) = (ack_id IS NOT NULL))
) STRICT;
CREATE TABLE outbox_attempts (
  sale_id TEXT NOT NULL REFERENCES outbox, attempt INTEGER NOT NULL,
  started_at INTEGER NOT NULL, result TEXT,
  PRIMARY KEY (sale_id, attempt)
) STRICT;
