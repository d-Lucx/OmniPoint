CREATE TABLE omni.payment_cases (
  tenant_id uuid, intent_id uuid, store_id uuid NOT NULL, terminal_id uuid NOT NULL, generation integer NOT NULL,
  capture_attempt uuid NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor>0), basket_digest text NOT NULL,
  state text NOT NULL CHECK(state IN ('CAPTURED','APPLIED','REFUND_RESERVED','REFUNDED')),
  refund_attempt uuid, refund_reservation bytea, sale_id uuid,
  PRIMARY KEY(tenant_id,intent_id), UNIQUE(tenant_id,capture_attempt), UNIQUE(tenant_id,refund_attempt),
  FOREIGN KEY(tenant_id,store_id,terminal_id,generation)
    REFERENCES omni.terminals(tenant_id,store_id,terminal_id,terminal_generation),
  FOREIGN KEY(tenant_id,sale_id) REFERENCES omni.retail_events(tenant_id,event_id)
);
CREATE TABLE omni.payment_provider_events (
  tenant_id uuid, event_id uuid, intent_id uuid NOT NULL, attempt_id uuid NOT NULL, state text NOT NULL,
  digest text NOT NULL, body bytea NOT NULL, packet jsonb NOT NULL,
  PRIMARY KEY(tenant_id,event_id), FOREIGN KEY(tenant_id,intent_id) REFERENCES omni.payment_cases
);
CREATE INDEX payment_evidence_case ON omni.payment_provider_events(tenant_id,intent_id);
CREATE TABLE omni.payment_postings (
  tenant_id uuid, intent_id uuid, effect text CHECK(effect IN ('CAPTURE','APPLY','REFUND')),
  account text CHECK(account IN ('CardClearing','CapturedFunds','Revenue','SalesTax')),
  signed_minor integer NOT NULL CHECK(signed_minor<>0),
  PRIMARY KEY(tenant_id,intent_id,effect,account), FOREIGN KEY(tenant_id,intent_id) REFERENCES omni.payment_cases
);
CREATE TABLE omni.fiscal_epochs (
  tenant_id uuid, epoch_id uuid, store_id uuid NOT NULL, terminal_id uuid NOT NULL, generation integer NOT NULL,
  enrollment jsonb NOT NULL, genesis jsonb NOT NULL, head_sequence integer NOT NULL DEFAULT 0,
  head_digest text, retired_by uuid, PRIMARY KEY(tenant_id,epoch_id),
  FOREIGN KEY(tenant_id,store_id,terminal_id,generation)
    REFERENCES omni.terminals(tenant_id,store_id,terminal_id,terminal_generation),
  CHECK ((head_sequence=0)=(head_digest IS NULL))
);
CREATE UNIQUE INDEX fiscal_current_epoch ON omni.fiscal_epochs(tenant_id,terminal_id) WHERE retired_by IS NULL;
CREATE TABLE omni.fiscal_grants (
  tenant_id uuid, grant_id uuid, epoch_id uuid NOT NULL, packet jsonb NOT NULL, digest text NOT NULL,
  PRIMARY KEY(tenant_id,grant_id), FOREIGN KEY(tenant_id,epoch_id) REFERENCES omni.fiscal_epochs
);
CREATE TABLE omni.fiscal_observations (
  tenant_id uuid, epoch_id uuid, sequence integer, receipt_digest text, event_id uuid NOT NULL,
  event_digest text NOT NULL, body bytea NOT NULL, status text NOT NULL CHECK(status IN ('PENDING','APPLIED','FORK','LATE')),
  reason text, PRIMARY KEY(tenant_id,epoch_id,sequence,receipt_digest),
  FOREIGN KEY(tenant_id,epoch_id) REFERENCES omni.fiscal_epochs
);
CREATE UNIQUE INDEX fiscal_canonical_slot ON omni.fiscal_observations(tenant_id,epoch_id,sequence)
  WHERE status IN ('PENDING','APPLIED');
DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['payment_cases','payment_provider_events','payment_postings',
    'fiscal_epochs','fiscal_grants','fiscal_observations'] LOOP
    EXECUTE format('ALTER TABLE omni.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE omni.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY tenant_scope ON omni.%I USING
      (tenant_id=nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)
      WITH CHECK (tenant_id=nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)',relation);
  END LOOP;
END
$policies$;
