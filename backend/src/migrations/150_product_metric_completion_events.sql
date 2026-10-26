-- E210: Account-owned task completion is the first verified product event.
-- Existing completed tasks are deliberately not backfilled: their historical
-- transition time and uniqueness cannot be established from current state.
CREATE TABLE product_metric_coverage (
  source text PRIMARY KEY,
  recording_since timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO product_metric_coverage(source) VALUES ('task_completions');

CREATE TABLE product_metric_retention (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  detail_days integer NOT NULL DEFAULT 90 CHECK (detail_days BETWEEN 1 AND 3650),
  daily_months integer NOT NULL DEFAULT 13 CHECK (daily_months BETWEEN 1 AND 120),
  last_pruned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO product_metric_retention(singleton) VALUES (true);

-- Lifetime dedupe tombstones carry no Account or task identifier. Their HMAC
-- key is generated once and kept in the database across restarts/backups.
-- Deleting an Account removes its readable metrics, not these opaque keys.
CREATE TABLE product_metric_dedupe_secret (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  secret_key bytea NOT NULL CHECK (octet_length(secret_key) = 32)
);
INSERT INTO product_metric_dedupe_secret(singleton, secret_key)
  VALUES (true, gen_random_bytes(32));
CREATE FUNCTION product_metric_source_hash(event_source text, event_id uuid)
RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT hmac(convert_to(event_source || ':' || event_id::text, 'UTF8'), secret_key, 'sha256')
    FROM product_metric_dedupe_secret WHERE singleton = true
$$;
CREATE TABLE product_metric_dedupe_keys (
  source_hash bytea PRIMARY KEY CHECK (octet_length(source_hash) = 32)
);

CREATE TABLE product_metric_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source = 'task_completion'),
  source_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX product_metric_events_account_time
  ON product_metric_events(account_id, source, occurred_at);
CREATE INDEX product_metric_events_time ON product_metric_events(occurred_at);

CREATE TABLE product_metric_daily (
  account_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source = 'task_completion'),
  utc_day date NOT NULL,
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY(account_id, source, utc_day)
);
CREATE TABLE product_metric_cumulative (
  account_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source = 'task_completion'),
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY(account_id, source)
);

CREATE FUNCTION product_metric_prune(retained_at timestamptz DEFAULT clock_timestamp())
RETURNS void LANGUAGE plpgsql AS $$
DECLARE policy product_metric_retention%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM product_metric_retention WHERE singleton = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'product metric retention policy missing'; END IF;
  DELETE FROM product_metric_events
    WHERE occurred_at < retained_at - make_interval(days => policy.detail_days);
  DELETE FROM product_metric_daily
    WHERE utc_day < ((retained_at AT TIME ZONE 'UTC')::date - make_interval(months => policy.daily_months))::date;
  UPDATE product_metric_retention SET last_pruned_at = retained_at WHERE singleton = true;
END $$;

CREATE FUNCTION product_metric_dedupe_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inserted_hash bytea;
BEGIN
  INSERT INTO product_metric_dedupe_keys(source_hash)
    VALUES (product_metric_source_hash(NEW.source, NEW.source_id))
    ON CONFLICT (source_hash) DO NOTHING RETURNING source_hash INTO inserted_hash;
  IF inserted_hash IS NULL THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_metric_event_dedupe
BEFORE INSERT ON product_metric_events FOR EACH ROW EXECUTE FUNCTION product_metric_dedupe_event();

CREATE FUNCTION product_metric_aggregate_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO product_metric_daily(account_id, source, utc_day, value)
    VALUES (NEW.account_id, NEW.source, (NEW.occurred_at AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (account_id, source, utc_day) DO UPDATE SET value = product_metric_daily.value + 1;
  INSERT INTO product_metric_cumulative(account_id, source, value)
    VALUES (NEW.account_id, NEW.source, 1)
    ON CONFLICT (account_id, source) DO UPDATE SET value = product_metric_cumulative.value + 1;
  IF EXISTS (SELECT 1 FROM product_metric_retention
             WHERE singleton = true AND last_pruned_at < clock_timestamp() - interval '1 day') THEN
    PERFORM product_metric_prune();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_metric_event_aggregate
AFTER INSERT ON product_metric_events FOR EACH ROW EXECUTE FUNCTION product_metric_aggregate_event();

CREATE FUNCTION product_metric_capture_task_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'completed' OR NEW.completed_at IS NULL
    OR NEW.account_owner_principal_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.status = 'completed' OR OLD.completed_at IS NOT NULL) THEN RETURN NEW; END IF;
  INSERT INTO product_metric_events(source, source_id, account_id, occurred_at)
    VALUES ('task_completion', NEW.id, NEW.account_owner_principal_id, clock_timestamp())
    ON CONFLICT (source, source_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER product_metric_task_completion_insert
AFTER INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION product_metric_capture_task_completion();
CREATE TRIGGER product_metric_task_completion_update
AFTER UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION product_metric_capture_task_completion();
