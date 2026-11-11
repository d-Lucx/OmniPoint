CREATE TABLE omni.treasury_accounts (
  tenant_id uuid REFERENCES omni.tenants, account_id uuid, taxpayer text NOT NULL,
  remitter text NOT NULL, opening_minor integer NOT NULL CHECK(opening_minor>=0),
  actor uuid NOT NULL, PRIMARY KEY(tenant_id,account_id)
);
CREATE TABLE omni.treasury_attempts (
  tenant_id uuid, account_id uuid, attempt uuid, operation uuid NOT NULL, predecessor uuid,
  kind text NOT NULL CHECK(kind IN ('FILING','FUNDING')), subject uuid NOT NULL, minor integer NOT NULL CHECK(minor>=0),
  request bytea NOT NULL, digest text NOT NULL, state text NOT NULL CHECK(state IN ('MAY_HAVE_SENT','TRANSMITTED','REJECTED')),
  PRIMARY KEY(tenant_id,account_id,attempt), UNIQUE NULLS NOT DISTINCT(tenant_id,account_id,operation,predecessor),
  UNIQUE(tenant_id,account_id,predecessor),
  FOREIGN KEY(tenant_id,account_id) REFERENCES omni.treasury_accounts,
  FOREIGN KEY(tenant_id,account_id,predecessor) REFERENCES omni.treasury_attempts(tenant_id,account_id,attempt)
);
CREATE INDEX treasury_attempt_subject ON omni.treasury_attempts(tenant_id,account_id,kind,subject);
CREATE TABLE omni.treasury_facts (
  tenant_id uuid, account_id uuid, source text CHECK(source IN ('bank','agency')), id uuid,
  kind text NOT NULL, lineage uuid NOT NULL, source_cut integer NOT NULL CHECK(source_cut>0),
  business_at timestamptz NOT NULL, body bytea NOT NULL, digest text NOT NULL CHECK(length(digest)=64),
  packet jsonb NOT NULL, facts jsonb NOT NULL, PRIMARY KEY(tenant_id,account_id,source,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES omni.treasury_accounts
);
CREATE INDEX treasury_fact_kind ON omni.treasury_facts(tenant_id,account_id,kind,source_cut);
CREATE TABLE omni.treasury_collisions (
  tenant_id uuid, account_id uuid, source text, id uuid, digest text, original_digest text NOT NULL,
  body bytea NOT NULL, packet jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,source,id,digest),
  FOREIGN KEY(tenant_id,account_id,source,id) REFERENCES omni.treasury_facts(tenant_id,account_id,source,id)
);
CREATE TABLE omni.treasury_positions (
  tenant_id uuid, account_id uuid, kind text, id uuid, remaining integer NOT NULL CHECK(remaining>=0),
  state text NOT NULL, facts jsonb NOT NULL, PRIMARY KEY(tenant_id,account_id,kind,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES omni.treasury_accounts
);
CREATE TABLE omni.treasury_effects (
  tenant_id uuid, account_id uuid, effect text, evidence uuid NOT NULL, journal uuid,
  facts jsonb NOT NULL, PRIMARY KEY(tenant_id,account_id,effect),
  FOREIGN KEY(tenant_id,account_id) REFERENCES omni.treasury_accounts,
  FOREIGN KEY(tenant_id,journal) REFERENCES omni.governed_adjustments(tenant_id,id)
);
DO $schema$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['treasury_accounts','treasury_attempts','treasury_facts','treasury_collisions','treasury_positions','treasury_effects'] LOOP
    EXECUTE format('ALTER TABLE omni.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE omni.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY tenant_scope ON omni.%I USING
      (tenant_id=nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)
      WITH CHECK (tenant_id=nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)',relation);
  END LOOP;
END
$schema$;
