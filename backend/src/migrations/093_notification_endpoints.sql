-- 093_notification_endpoints.sql
-- RH-P3.C8 (strategy 4e40f06f §2.12, operational baseline): the human
-- notification path's per-person endpoint configuration.
--
-- SUBSCRIPTION-CLASS DATA (§2.6.4's rule applied to humans by §2.12): the
-- endpoint — and whether it is enabled — is settable only through the human
-- surface or the admin credential class, NEVER agent-plane writable, and
-- every change is audited. An agent-writable notification endpoint pointed
-- at an attacker URL would be a board-originated beacon; the whole
-- /notification-endpoints route family therefore sits behind the `root`
-- sentinel.
--
-- Single-human v1 baseline: UI notifications are the mandatory path; the
-- optional per-person channels here are webhook (dispatched ID-only —
-- authority always travels in the pull) and email (schema seat reserved;
-- dispatch arrives with a mail transport — the core ships none). The
-- mandatory-before-a-second-human rule is the C7 Phase-5 gate.

CREATE TABLE notification_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'email')),
  -- The delivery target (a URL for webhook, an address for email). Validated
  -- at the route; never interpolated into any executable context.
  target TEXT NOT NULL CHECK (char_length(target) BETWEEN 3 AND 2000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One endpoint per channel per person: changes are upserts, and the audit
  -- trail carries the history.
  CONSTRAINT uq_notification_endpoints_principal_kind UNIQUE (principal_id, kind)
);

CREATE INDEX ix_notification_endpoints_enabled
  ON notification_endpoints (kind) WHERE enabled;

COMMENT ON TABLE notification_endpoints IS
  'RH-P3.C8 human notification endpoints (strategy §2.12). Subscription-class data: root-sentinel writes only, audited; webhook dispatch is ID-only; email dispatch waits for a mail transport.';
