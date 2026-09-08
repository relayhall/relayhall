-- 076_service_registry.sql
-- RH-P2.1 (task a4af8cf2): the Service and Connector registry with versioned
-- capability descriptors (strategy 4e40f06f §2.1; vocabulary D-5, D-15).
--
-- A Service is a registered external system. A Connector is a KIND of Service
-- — one that pulls and executes work (D-5: one registry, one table, kind =
-- connector). A Service declares its selectable execution options in a
-- capability descriptor; descriptor versions are IMMUTABLE (§2.1), so a task
-- assignment can pin the exact version its execution profile was validated
-- against and a pulling harness can revalidate against the same bytes.
--
-- Deliberate contract seams stored as data, machinery landing later (the C5
-- pattern): runtime_mode 'brokered' is refused by the write surface at v1
-- (per-request mint machinery is post-v1); delivery_* is dispatched by the
-- Phase-3 delivery worker; telemetry_tier is consumed by the Phase-3 ingest;
-- visibility_tier is enforced by the Phase-2 shared predicate and the
-- Phase-3 feed. The columns ship now because they are part of the versioned
-- registration contract the strategy ratifies.
--
-- Schema only. No seed rows: registries start empty and estate services are
-- registered element-by-element at cutover, never via repo migrations (the
-- A14.4 precedent).
--
-- Fresh-replay doctrine: database/init.sql is untouched; a fresh install
-- reaches this schema via the migration chain, and this file is idempotent
-- (CREATE IF NOT EXISTS throughout) so re-running it is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name TEXT NOT NULL CHECK (length(name) > 0 AND length(name) <= 128),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4096),
  -- D-5: Connector is a kind of Service; a plain registered system is a Service.
  kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'connector')),
  -- §2.1 per-service runtime mode. 'brokered' is a contract seam: the CHECK
  -- admits it so the registration contract is stable, but the v1 write
  -- surface refuses it (no brokered machinery ships in v1 — C5).
  runtime_mode TEXT NOT NULL DEFAULT 'direct' CHECK (runtime_mode IN ('direct', 'brokered')),
  -- Declared subset of the §4.2 registry lifecycle vocabulary. 'review' is
  -- deliberately unused here: the human review gate is Skills-registry
  -- machinery (C2), not a Service concept.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  -- §2.9 F6: how much of the board a service sees; assigned-only is the safe
  -- default for new registrations. Enforcement lands with the shared
  -- authorization predicate; stored here as registration data.
  visibility_tier TEXT NOT NULL DEFAULT 'assigned-only'
    CHECK (visibility_tier IN ('assigned-only', 'unrestricted')),
  -- §2.6.4: delivery is registry data — but the endpoint AND the mode switch
  -- are subscription-class, writable only through the owner plane (root at
  -- v1), never via agent-plane services:write.
  delivery_mode TEXT NOT NULL DEFAULT 'none' CHECK (delivery_mode IN ('webhook', 'poll', 'none')),
  delivery_endpoint TEXT,
  delivery_poll_interval_seconds INTEGER CHECK (
    delivery_poll_interval_seconds IS NULL OR delivery_poll_interval_seconds >= 30
  ),
  -- §2.6.5: declared telemetry tier, consumed by the Phase-3 ingest.
  telemetry_tier TEXT NOT NULL DEFAULT 'none' CHECK (telemetry_tier IN ('none', 'presence', 'full')),
  current_descriptor_version INTEGER CHECK (
    current_descriptor_version IS NULL OR current_descriptor_version >= 1
  ),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  created_by_principal_id TEXT,
  updated_by_principal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);

-- Append-only, immutable capability-descriptor versions (§2.1). No UPDATE
-- path exists for descriptor/content_hash/version at the service layer;
-- version-level retirement (retired_at) stops new consumers while existing
-- pins keep resolving (§4.2), and retired pins fail dispatch closed at the
-- execution-profile paths (RH-DESIGN.5 R5, wired by RH-P2.2).
CREATE TABLE IF NOT EXISTS service_descriptor_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  descriptor JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_principal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  UNIQUE (service_id, version)
);

CREATE INDEX IF NOT EXISTS idx_services_kind ON services(kind);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
CREATE INDEX IF NOT EXISTS idx_service_descriptor_versions_service
  ON service_descriptor_versions(service_id, version DESC);

COMMENT ON TABLE services IS
  'Service and Connector registry (RH-P2.1): registered external systems; kind=connector pulls and executes work (D-5). Delivery/visibility/telemetry fields are registration data whose enforcement machinery lands in Phase 2/3 per the C5 seam pattern.';
COMMENT ON TABLE service_descriptor_versions IS
  'Immutable capability-descriptor versions (strategy §2.1): append-only; execution profiles pin a version; retirement stops new consumers while existing pins keep resolving.';
COMMENT ON COLUMN services.delivery_endpoint IS
  'Subscription-class data (§2.6.4): settable only through the owner plane, never agent-plane services:write — a prompt-injected connector must not repoint its own delivery.';
