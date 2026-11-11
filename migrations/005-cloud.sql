CREATE TABLE omni.capability_profiles (
  tenant_id uuid REFERENCES omni.tenants,
  version integer CHECK (version > 0),
  retail boolean NOT NULL,
  hospitality boolean NOT NULL,
  services boolean NOT NULL,
  PRIMARY KEY (tenant_id, version)
);
CREATE TABLE omni.service_appointments (
  tenant_id uuid,
  booking_id uuid,
  store_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  generation integer NOT NULL,
  cashier_id uuid NOT NULL,
  profile_version integer NOT NULL,
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  staff text NOT NULL CHECK (staff IN ('alex', 'sam')),
  resource text NOT NULL CHECK (resource = 'bay'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  timezone text NOT NULL,
  PRIMARY KEY (tenant_id, booking_id),
  FOREIGN KEY (tenant_id, store_id, terminal_id, generation)
    REFERENCES omni.terminals(tenant_id,store_id,terminal_id,terminal_generation),
  FOREIGN KEY (tenant_id, store_id, cashier_id) REFERENCES omni.cashiers,
  FOREIGN KEY (tenant_id, profile_version) REFERENCES omni.capability_profiles
);
CREATE INDEX service_appointments_cut ON omni.service_appointments (tenant_id, store_id, starts_at);
DO $policies$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['capability_profiles','service_appointments'] LOOP
    EXECUTE format('ALTER TABLE omni.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE omni.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY tenant_scope ON omni.%I USING
      (tenant_id = nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)', relation);
  END LOOP;
END
$policies$;
