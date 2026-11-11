CREATE TABLE module_tenders (
  tender_id TEXT PRIMARY KEY REFERENCES retail_events(event_id),
  aggregate_id TEXT NOT NULL,
  check_no INTEGER NOT NULL CHECK(check_no BETWEEN 0 AND 5),
  request_digest TEXT NOT NULL,
  facts TEXT NOT NULL
) STRICT;
CREATE INDEX module_tender_order ON module_tenders(aggregate_id);
