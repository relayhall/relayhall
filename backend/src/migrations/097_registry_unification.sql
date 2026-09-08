-- 097_registry_unification.sql
-- RH-P3.AZ-S3 (card 25e5fb92): Connector registry unification (AUTHZ
-- design 4d961e37 §2 A17.2, §10; contiguous with 096 — AZ-S3 owns both).
--
-- A Connector is BOTH the services-registry object and a delegated
-- identity (A17.2, D-5 preserved): connector-kind registry rows gain a
-- REQUIRED principal_id FK, and from this migration on the row and its
-- Connector principal are created and revoked together in ONE transaction
-- (service-layer, ServiceRegistry). Plain 'service'-kind rows are
-- registered systems, not identities — their principal_id stays NULL.
--
-- BACKFILL (AZ-35, §10): existing connector-kind rows are backfilled with
-- minted principals. Pre-096 Connectors have no owning Account to parent
-- them to, so the backfilled principals are PARENTLESS service rows marked
-- legacy_identity=TRUE with a remediation-queue purpose — preserved,
-- audited, frozen out of the new machinery, re-parented by the owner at
-- the Phase-5 estate transition. Fresh replay backfills zero rows (no
-- pre-existing connectors exist on a fresh install).

ALTER TABLE services ADD COLUMN IF NOT EXISTS principal_id UUID REFERENCES principals(id);

-- Backfill connector-kind rows lacking a principal.
DO $$
DECLARE
  svc RECORD;
  new_principal UUID;
BEGIN
  FOR svc IN SELECT id, slug, name FROM services WHERE kind = 'connector' AND principal_id IS NULL LOOP
    -- Handle derivation shared with ServiceRegistry.connectorHandleFor:
    -- plain 'connector-<slug>' when it fits VARCHAR(64), else a
    -- deterministic truncate+md5 form. COLLISION SAFETY (review ab857740
    -- B1): the backfill NEVER links a pre-existing Principal — a handle
    -- collision with any prior row (whatever its kind or provenance) falls
    -- back to a per-service remediation handle derived from the service id
    -- (unique by construction); if even that collides, the migration
    -- ABORTS loudly for owner disposition rather than binding registry
    -- deletion semantics to an unrelated identity.
    DECLARE
      derived_handle TEXT;
    BEGIN
      IF length('connector-' || svc.slug) <= 64 THEN
        derived_handle := 'connector-' || svc.slug;
      ELSE
        derived_handle := 'connector-' || left(svc.slug, 45) || '-' || left(md5(svc.slug), 8);
      END IF;
      IF EXISTS (SELECT 1 FROM principals WHERE handle = derived_handle) THEN
        derived_handle := 'connector-' || left(svc.slug, 36) || '-r-' || left(md5(svc.id::text), 8);
      END IF;
      IF EXISTS (SELECT 1 FROM principals WHERE handle = derived_handle) THEN
        RAISE EXCEPTION '097 registry unification: remediation handle % already exists for service % — owner disposition required (A17.2 one-to-one pairing)',
          derived_handle, svc.slug;
      END IF;
      INSERT INTO principals (kind, handle, display_name, status, purpose, legacy_identity)
      VALUES ('service', derived_handle, svc.name, 'active',
              'LEGACY - registry backfill pending owner review', TRUE)
      RETURNING id INTO new_principal;
      UPDATE services SET principal_id = new_principal WHERE id = svc.id;
    END;
  END LOOP;
END $$;

-- The REQUIRED pairing (A17.2): every connector-kind row names its
-- principal. (Plain service rows carry no identity.)
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_connector_principal_required;
ALTER TABLE services ADD CONSTRAINT services_connector_principal_required
  CHECK (kind <> 'connector' OR principal_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS ix_services_principal ON services(principal_id);

COMMENT ON COLUMN services.principal_id IS
  'A17.2 (AZ-S3): the Connector''s delegated-identity principal — REQUIRED for connector-kind rows; created and revoked with the registry row in one transaction. NULL for plain service-kind rows (systems, not identities).';
