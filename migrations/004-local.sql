CREATE TABLE payment_intents (
  intent_id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES retail_shifts, sale BLOB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PREPARED','MAY_HAVE_SENT','DECLINED','CAPTURED','SIGNING','FINALIZED','REFUND_PREPARED','REFUND_PENDING','REFUNDED')),
  attempt_id TEXT NOT NULL, capture TEXT, refund TEXT, refund_approval TEXT, fiscal_intent TEXT, reason TEXT,
  reported INTEGER NOT NULL DEFAULT 0 CHECK(reported IN (0,1))
) STRICT;
CREATE UNIQUE INDEX one_active_payment ON payment_intents ((1))
  WHERE state NOT IN ('DECLINED','FINALIZED','REFUNDED');
CREATE TABLE payment_attempts (
  attempt_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES payment_intents,
  operation TEXT NOT NULL, previous_attempt TEXT REFERENCES payment_attempts, reason TEXT, approval TEXT,
  sent_at INTEGER, lease_until INTEGER
) STRICT;
CREATE TABLE payment_evidence (
  event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES payment_attempts,
  digest TEXT NOT NULL, state TEXT NOT NULL, packet TEXT NOT NULL
) STRICT;
CREATE TABLE payment_incidents (
  event_id TEXT NOT NULL REFERENCES payment_evidence, alternative_digest TEXT NOT NULL,
  PRIMARY KEY(event_id,alternative_digest)
) STRICT;
CREATE TABLE fiscal_local_receipts (
  intent_id TEXT PRIMARY KEY REFERENCES payment_intents, proof TEXT NOT NULL, grant_packet TEXT NOT NULL
) STRICT;
