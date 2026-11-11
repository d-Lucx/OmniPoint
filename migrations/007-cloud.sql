CREATE TABLE omni.ledger_lines (
  tenant_id uuid REFERENCES omni.tenants, line_id text, journal_id text NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  business_at timestamptz NOT NULL, account text NOT NULL, minor integer NOT NULL CHECK (minor <> 0),
  PRIMARY KEY (tenant_id,line_id)
);
CREATE INDEX ledger_period ON omni.ledger_lines(tenant_id,period,journal_id,line_id);
CREATE TABLE omni.period_seals (
  tenant_id uuid REFERENCES omni.tenants, period text CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), seal_id uuid NOT NULL,
  previous_id uuid, manifest bytea NOT NULL, packet jsonb NOT NULL, objects jsonb NOT NULL,
  PRIMARY KEY(tenant_id,period), UNIQUE(tenant_id,seal_id),
  UNIQUE NULLS NOT DISTINCT(tenant_id,previous_id),
  FOREIGN KEY (tenant_id,previous_id) REFERENCES omni.period_seals(tenant_id,seal_id)
);
CREATE TABLE omni.late_ledger_holds (
  tenant_id uuid REFERENCES omni.tenants, digest text CHECK(length(digest)=64), route text NOT NULL,
  body bytea NOT NULL, PRIMARY KEY(tenant_id,digest)
);
CREATE TABLE omni.governed_adjustments (
  tenant_id uuid REFERENCES omni.tenants, id uuid, business_at timestamptz NOT NULL,
  account text NOT NULL, counteraccount text NOT NULL CHECK (counteraccount<>account),
  minor integer NOT NULL CHECK (minor<>0), evidence uuid NOT NULL, actor uuid NOT NULL,
  family text NOT NULL, effect text NOT NULL, reference text,
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE omni.cash_custody (
  tenant_id uuid REFERENCES omni.tenants, id uuid, kind text CHECK(kind IN
    ('VAULT_RECEIVE','DEPOSIT_SEND','DEPOSIT_RECEIVE','VAULT_COUNT','VAULT_WITNESS','DRAWER_RETAIN','DRAWER_VARIANCE')),
  source uuid NOT NULL, vault uuid NOT NULL, destination uuid, minor integer NOT NULL,
  actor uuid NOT NULL, evidence uuid NOT NULL, facts jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,kind,source)
);
CREATE INDEX cash_custody_vault ON omni.cash_custody(tenant_id,vault);
CREATE TABLE omni.report_plans (
  tenant_id uuid REFERENCES omni.tenants, id uuid, lineage uuid NOT NULL, predecessor uuid,
  seal_id uuid NOT NULL, facts jsonb NOT NULL, packet jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE NULLS NOT DISTINCT(tenant_id,lineage,predecessor),
  FOREIGN KEY(tenant_id,predecessor) REFERENCES omni.report_plans(tenant_id,id),
  FOREIGN KEY(tenant_id,seal_id) REFERENCES omni.period_seals(tenant_id,seal_id)
);
CREATE TABLE omni.report_exports (
  tenant_id uuid, plan_id uuid, id uuid NOT NULL, bytes bytea NOT NULL, packet jsonb NOT NULL,
  PRIMARY KEY(tenant_id,plan_id), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,plan_id) REFERENCES omni.report_plans(tenant_id,id)
);
CREATE TABLE omni.report_withdrawals (
  tenant_id uuid, plan_id uuid, evidence uuid NOT NULL, actor uuid NOT NULL,
  PRIMARY KEY(tenant_id,plan_id), FOREIGN KEY(tenant_id,plan_id) REFERENCES omni.report_plans(tenant_id,id)
);

CREATE FUNCTION omni.ledger_month(at_time timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT to_char(at_time AT TIME ZONE 'UTC','YYYY-MM') $$;
CREATE FUNCTION omni.ledger_lock(tenant uuid) RETURNS void
LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended(tenant::text,607001)) $$;
CREATE FUNCTION omni.ledger_lock_shared(tenant uuid) RETURNS void
LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock_shared(hashtextextended(tenant::text,607001)) $$;
CREATE FUNCTION omni.ledger_event_time(body bytea) RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE event jsonb := convert_from(body,'UTF8')::jsonb; wire text;
BEGIN
  IF event->>'version'='4' THEN
    wire := event->>'saleBody';
    event := convert_from(decode(translate(wire,'-_','+/')||repeat('=',(4-length(wire)%4)%4),'base64'),'UTF8')::jsonb;
  END IF;
  RETURN (event->>'occurredAt')::timestamptz;
END
$$;
CREATE FUNCTION omni.ledger_open(tenant uuid, month text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM omni.ledger_lock_shared(tenant);
  IF EXISTS(SELECT 1 FROM omni.period_seals WHERE tenant_id=tenant AND period>=month) THEN
    RAISE EXCEPTION 'PERIOD_SEALED' USING ERRCODE='OP601';
  END IF;
END
$$;

-- The migration owner reads historical source rows only inside this migration transaction.
ALTER TABLE omni.sales NO FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.journal_lines NO FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.retail_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.retail_postings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.payment_postings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.payment_provider_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.payment_cases NO FORCE ROW LEVEL SECURITY;
INSERT INTO omni.ledger_lines
SELECT l.tenant_id,'legacy:'||l.sale_id||':'||l.account,'legacy:'||l.sale_id,
  omni.ledger_month(s.occurred_at),s.occurred_at,l.account,CASE l.side WHEN 'DR' THEN l.amount_minor ELSE -l.amount_minor END
FROM omni.journal_lines l JOIN omni.sales s USING(tenant_id,sale_id);
INSERT INTO omni.ledger_lines
SELECT p.tenant_id,'retail:'||p.event_id||':'||p.account,'retail:'||p.event_id,
  omni.ledger_month(d.at_time),d.at_time,p.account,p.signed_minor
FROM omni.retail_postings p JOIN omni.retail_events e USING(tenant_id,event_id)
CROSS JOIN LATERAL (SELECT omni.ledger_event_time(e.body) AS at_time) d;
INSERT INTO omni.ledger_lines
SELECT p.tenant_id,'payment:'||p.intent_id||':'||p.effect||':'||p.account,'payment:'||p.intent_id||':'||p.effect,
  omni.ledger_month(d.at_time),d.at_time,p.account,p.signed_minor
FROM omni.payment_postings p
CROSS JOIN LATERAL (
 SELECT CASE WHEN p.effect='APPLY' THEN (
   SELECT omni.ledger_event_time(r.body)
   FROM omni.payment_cases c JOIN omni.retail_events r ON (r.tenant_id,r.event_id)=(c.tenant_id,c.sale_id)
   WHERE (c.tenant_id,c.intent_id)=(p.tenant_id,p.intent_id)
 ) ELSE min((convert_from(e.body,'UTF8')::jsonb->>'occurredAt')::timestamptz) END AS at_time
 FROM omni.payment_provider_events e WHERE (e.tenant_id,e.intent_id)=(p.tenant_id,p.intent_id)
 AND e.state=CASE p.effect WHEN 'REFUND' THEN 'REFUNDED' ELSE 'CAPTURED' END
) d;
ALTER TABLE omni.sales FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.journal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.retail_events FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.retail_postings FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.payment_postings FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.payment_provider_events FORCE ROW LEVEL SECURITY;
ALTER TABLE omni.payment_cases FORCE ROW LEVEL SECURITY;

CREATE FUNCTION omni.ledger_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,omni AS $$
DECLARE at_time timestamptz; entry text; amount integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Ledger source rows are append-only' USING ERRCODE='OP601'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('omni.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Ledger tenant scope required' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME IN ('journals','journal_lines') THEN
    SELECT occurred_at INTO STRICT at_time FROM omni.sales WHERE (tenant_id,sale_id)=(NEW.tenant_id,NEW.sale_id);
    entry := 'legacy:'||NEW.sale_id;
    IF TG_TABLE_NAME='journal_lines' THEN amount := CASE NEW.side WHEN 'DR' THEN NEW.amount_minor ELSE -NEW.amount_minor END; END IF;
  ELSIF TG_TABLE_NAME='retail_postings' THEN
    SELECT omni.ledger_event_time(body) INTO STRICT at_time
    FROM omni.retail_events WHERE (tenant_id,event_id)=(NEW.tenant_id,NEW.event_id);
    entry := 'retail:'||NEW.event_id;
    amount := NEW.signed_minor;
  ELSIF TG_TABLE_NAME='payment_postings' THEN
    IF NEW.effect='APPLY' THEN
      SELECT omni.ledger_event_time(r.body) INTO at_time
      FROM omni.payment_cases c JOIN omni.retail_events r ON (r.tenant_id,r.event_id)=(c.tenant_id,c.sale_id)
      WHERE (c.tenant_id,c.intent_id)=(NEW.tenant_id,NEW.intent_id);
    ELSE
      SELECT min((convert_from(body,'UTF8')::jsonb->>'occurredAt')::timestamptz) INTO at_time
      FROM omni.payment_provider_events WHERE (tenant_id,intent_id)=(NEW.tenant_id,NEW.intent_id)
      AND state=CASE NEW.effect WHEN 'REFUND' THEN 'REFUNDED' ELSE 'CAPTURED' END;
    END IF;
    entry := 'payment:'||NEW.intent_id||':'||NEW.effect;
    amount := NEW.signed_minor;
  ELSE
    at_time := NEW.business_at;
    entry := 'adjustment:'||NEW.id;
    amount := NEW.minor;
  END IF;
  IF at_time IS NULL THEN RAISE EXCEPTION 'Missing ledger source date'; END IF;
  PERFORM omni.ledger_open(NEW.tenant_id,omni.ledger_month(at_time));
  IF amount IS NOT NULL THEN
    INSERT INTO omni.ledger_lines VALUES(NEW.tenant_id,entry||':'||NEW.account,entry,omni.ledger_month(at_time),at_time,NEW.account,amount);
    IF TG_TABLE_NAME='governed_adjustments' THEN
      INSERT INTO omni.ledger_lines VALUES(NEW.tenant_id,entry||':'||NEW.counteraccount,entry,
        omni.ledger_month(at_time),at_time,NEW.counteraccount,-amount);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION omni.ledger_record() FROM PUBLIC;
CREATE FUNCTION omni.cash_cut_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM omni.ledger_lock_shared(NEW.tenant_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER cash_cut_lock BEFORE INSERT ON omni.retail_cash FOR EACH ROW EXECUTE FUNCTION omni.cash_cut_lock();
CREATE TRIGGER cash_cut_lock BEFORE INSERT ON omni.retail_closes FOR EACH ROW EXECUTE FUNCTION omni.cash_cut_lock();
DO $schema$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['journals','journal_lines','retail_postings','payment_postings','governed_adjustments'] LOOP
    EXECUTE format('CREATE TRIGGER ledger_record BEFORE INSERT OR UPDATE OR DELETE ON omni.%I
      FOR EACH ROW EXECUTE FUNCTION omni.ledger_record()',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['ledger_lines','period_seals','governed_adjustments','cash_custody',
    'report_plans','report_exports','report_withdrawals','late_ledger_holds'] LOOP
    EXECUTE format('ALTER TABLE omni.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE omni.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY tenant_scope ON omni.%I USING
      (tenant_id=nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)
      WITH CHECK (tenant_id=nullif(current_setting(''omni.tenant_id'',true),'''')::uuid)',relation);
  END LOOP;
END
$schema$;
