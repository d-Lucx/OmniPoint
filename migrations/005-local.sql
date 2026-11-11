CREATE TABLE module_profile (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  evidence TEXT NOT NULL
) STRICT;
CREATE TABLE module_events (
  cursor INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  aggregate_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL,
  body BLOB NOT NULL,
  digest TEXT NOT NULL,
  UNIQUE (aggregate_id, revision)
) STRICT;
CREATE INDEX module_events_stream ON module_events (kind, cursor);
