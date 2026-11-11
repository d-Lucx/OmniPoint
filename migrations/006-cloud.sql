ALTER TABLE omni.retail_lines ALTER COLUMN position_id DROP NOT NULL;
ALTER TABLE omni.retail_postings DROP CONSTRAINT retail_postings_account_check;
ALTER TABLE omni.retail_postings ADD CHECK (account IN ('Cash','Revenue','SalesTax','TipsPayable'));
CREATE TABLE omni.module_tenders (
  tenant_id uuid,
  event_id uuid,
  aggregate_id uuid NOT NULL,
  check_no integer NOT NULL CHECK (check_no BETWEEN 0 AND 5),
  before_minor integer NOT NULL CHECK (before_minor >= 0),
  paid_minor integer NOT NULL CHECK (paid_minor > 0),
  plan_digest text NOT NULL,
  facts jsonb NOT NULL,
  PRIMARY KEY (tenant_id,event_id),
  UNIQUE (tenant_id,aggregate_id,check_no,before_minor),
  FOREIGN KEY (tenant_id,event_id) REFERENCES omni.retail_events
);
ALTER TABLE omni.module_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni.module_tenders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON omni.module_tenders USING
 (tenant_id=nullif(current_setting('omni.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('omni.tenant_id',true),'')::uuid);
