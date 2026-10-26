-- P02: quota observations are a separate contract from token/cost event totals.
CREATE TABLE usage_quota_snapshots (
 account_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 connector_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,
 provider_account_id TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL,
 snapshot JSONB NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (account_id, connector_id, provider, provider_account_id),
 CHECK (octet_length(snapshot::text) <= 32768)
);
CREATE INDEX usage_quota_account_observed ON usage_quota_snapshots(account_id, observed_at DESC);

CREATE TABLE plugin_service_metrics (
 account_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 connector_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 source_product TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL,
 snapshot JSONB NOT NULL,
 PRIMARY KEY(account_id,connector_id,source_product),
 CHECK(octet_length(snapshot::text) <= 8192)
);
CREATE INDEX plugin_metrics_account_observed ON plugin_service_metrics(account_id,observed_at DESC);
