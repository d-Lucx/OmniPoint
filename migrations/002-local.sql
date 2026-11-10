CREATE TABLE quota_position (
  sku TEXT PRIMARY KEY REFERENCES catalog, position_id TEXT NOT NULL UNIQUE, location_id TEXT NOT NULL
) STRICT;
CREATE TABLE quota_grants (
  grant_id TEXT PRIMARY KEY, position_id TEXT NOT NULL REFERENCES quota_position(position_id),
  body BLOB NOT NULL, digest TEXT NOT NULL, key_id TEXT NOT NULL, signature TEXT NOT NULL,
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, transfer_id TEXT
) STRICT;
CREATE TABLE quota_units (
  grant_id TEXT REFERENCES quota_grants, slice_id TEXT,
  PRIMARY KEY (grant_id, slice_id)
) STRICT;
CREATE TABLE custody_receipts (
  leg_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES quota_grants,
  body BLOB NOT NULL, key_id TEXT NOT NULL, signature TEXT NOT NULL,
  UNIQUE (grant_id, leg_id)
) STRICT;
CREATE TABLE custody_units (
  grant_id TEXT, slice_id TEXT, leg_id TEXT NOT NULL,
  PRIMARY KEY (grant_id, slice_id),
  FOREIGN KEY (grant_id, slice_id) REFERENCES quota_units,
  FOREIGN KEY (grant_id, leg_id) REFERENCES custody_receipts (grant_id, leg_id)
) STRICT;
CREATE TABLE quota_spends (
  grant_id TEXT, slice_id TEXT, sale_id TEXT NOT NULL UNIQUE REFERENCES sales,
  PRIMARY KEY (grant_id, slice_id),
  FOREIGN KEY (grant_id, slice_id) REFERENCES quota_units
) STRICT;
CREATE UNIQUE INDEX quota_spend_once_per_slice ON quota_spends (slice_id);
