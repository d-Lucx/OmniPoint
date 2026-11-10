CREATE TABLE retail_catalogs (version INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
CREATE TABLE retail_positions (sku TEXT PRIMARY KEY REFERENCES quota_position) STRICT;
CREATE TABLE retail_shifts (
  shift_id TEXT PRIMARY KEY, drawer_id TEXT NOT NULL, opened_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED'))
) STRICT;
CREATE UNIQUE INDEX retail_single_open_shift ON retail_shifts (state) WHERE state='OPEN';
CREATE TABLE retail_cart_lines (
  id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES retail_shifts, quote TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 8), discount TEXT
) STRICT;
CREATE TABLE retail_events (
  event_id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES retail_shifts, source_no INTEGER NOT NULL,
  kind TEXT NOT NULL, event_bytes BLOB NOT NULL, digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','IN_FLIGHT','RETRY_WAIT','SYNCED','CONFLICT_HELD')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, result TEXT, ack BLOB, ack_id TEXT,
  UNIQUE (shift_id, source_no),
  CHECK ((state='IN_FLIGHT')=(lease_until IS NOT NULL))
) STRICT;
CREATE TABLE retail_attempts (
  event_id TEXT REFERENCES retail_events, attempt INTEGER, started_at INTEGER NOT NULL, result TEXT,
  PRIMARY KEY (event_id, attempt)
) STRICT;
CREATE TABLE retail_receipts (
  receipt_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES retail_events,
  original_receipt_id TEXT, printable TEXT NOT NULL
) STRICT;
CREATE TABLE retail_cash (
  event_id TEXT PRIMARY KEY REFERENCES retail_events, shift_id TEXT NOT NULL REFERENCES retail_shifts,
  kind TEXT NOT NULL, signed_minor INTEGER NOT NULL, destination_id TEXT
) STRICT;
CREATE INDEX retail_cash_shift ON retail_cash(shift_id);
CREATE TABLE retail_spends (
  slice_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, line_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES retail_events, FOREIGN KEY (grant_id, slice_id) REFERENCES quota_units
) STRICT;
CREATE TABLE retail_closes (
  event_id TEXT PRIMARY KEY REFERENCES retail_events, shift_id TEXT NOT NULL REFERENCES retail_shifts,
  previous_id TEXT REFERENCES retail_closes, counted_minor INTEGER NOT NULL, expected_minor INTEGER NOT NULL,
  covered_no INTEGER NOT NULL, variance_minor INTEGER NOT NULL, delta_minor INTEGER NOT NULL
) STRICT;
CREATE TABLE retail_devices (
  command_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('PRINTER','DRAWER')),
  event_id TEXT REFERENCES retail_events, return_id TEXT REFERENCES retail_refunds, payload TEXT,
  state TEXT NOT NULL CHECK (state IN ('UNSENT','IN_FLIGHT','SUCCEEDED','FAILED','UNCERTAIN','CHECKED','CANCELLED')),
  detail TEXT, check_evidence TEXT, CHECK ((event_id IS NULL) <> (return_id IS NULL))
) STRICT;
CREATE TABLE retail_refunds (
  return_id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES retail_shifts,
  attempt_id TEXT NOT NULL UNIQUE, reservation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RESERVED','UNCERTAIN','CONFIRMED','RELEASED'))
) STRICT;
