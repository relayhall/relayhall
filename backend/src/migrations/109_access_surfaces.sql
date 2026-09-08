-- 109: RH-DESIGN.SETGOV candidate A — Access surfaces, Access bundles, and the
-- `surface` resource type.
--
-- Contract: design `7a9317b2` v3.3 §3.1, §3.1a, §3.2, §3.4, §4 (RATIFIED
-- 2026-09-02, record `83defda6`); vocabulary amendment **A25** (companion
-- `0c321078`) A25.1/A25.2/A25.5/A25.7a; AUTHZ amendment **AZ-A5** (`4d961e37`)
-- clauses 1, 3, 8; acceptance annex `85a2218d` D1, D3, D14, D19, D20; run
-- packet `ba2e9e59` §3.1 items 1, 2, 3, 7.
--
-- The migration number was READ FROM THE TREE at branch time (head was 108,
-- `108_sso_directory_mode_enableable.sql`), never hardcoded from the packet.
--
-- ── WHAT THIS ADDS, AND WHY IT IS NOT A PARALLEL ACL STORE ──
--
-- Three catalogue tables and one enum value. `access_surfaces` says WHERE
-- authority applies; `access_bundles` and `access_bundle_members` say WHAT
-- belongs together. None of the three carries a principal, a grantee, a verb or
-- a level — no column that names WHO — and the evaluator never reads the two
-- bundle tables. Authority lives in `grants` and `access_profile_rules`,
-- exactly as it does for every other object type. That is design §3.2's
-- NEVER-GRANTS criterion and its MONOTONICITY COROLLARY, and annex D1 drills
-- both halves by truncating and rewriting all three tables.
--
-- ── WHAT IS DELIBERATELY *NOT* A DATABASE CONSTRAINT ──
--
-- AZ-A5 clause 3 closes `resource_type='surface'` twice: refused at every write
-- surface, and IGNORED BY THE EVALUATOR. It is deliberately NOT closed by a
-- CHECK on `grants` or `access_profile_rules`, because the annex's own drills
-- require the bypassing row to be INSERTABLE: D19 inserts a NULL-`resource_id`
-- surface grant "directly in SQL, bypassing that refusal" and asserts every
-- decision is byte-identical, and D3(b) inserts an `all-of-type` surface rule
-- "directly in SQL" and asserts the evaluator ignores it. A CHECK here would
-- make both drills unrunnable — the v2.0 mistake annex D1 was rewritten to
-- avoid (round 2 B8: it asked for a DELETE the 095 immutability triggers
-- forbid). The closure is where the design puts it: `GrantService.create`,
-- `validateRules`/`createVersion`, and the two evaluator seams.
--
-- ── SEED (§4.4, §3.1a, AZ-A5 clause 8) ──
--
-- Thirteen core Access surfaces (the §1.1 inventory's classed rows: eight `G`
-- of which #28 "Plugin surfaces" is registered per plugin and therefore seeds
-- nothing here, four `S`, two `L`), the three predefined Access bundles with
-- their `access_bundle_members` rows, and six Access profiles — Personal's and
-- Operational's two each publishing with ZERO rules (the I5 shape). **No
-- `access_profile_assignments` row is seeded at all**: the Personal floor is
-- the `always-self` CLASS (I3), never a row. Seeding any Administrative
-- assignment is annex D14's red mutation.
--
-- Additive (no existing row can fail a new constraint: `surface` widens two
-- CHECKs and no row carries it), replay-safe (`IF NOT EXISTS`, `ON CONFLICT`,
-- and a guarded seed block), `database/init.sql` untouched.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · `surface` joins the grantable resource types (A25.5, AZ-A5 clause 1)
--
-- `078_grants_substrate.sql` and `095_access_profiles.sql` are SHIPPED HISTORY
-- and are not edited; the CHECK is replaced here, taking the ratified
-- eight-value list to nine. `078`'s own header declares this list is where
-- future object types land — "'phase' and 'plugin' are seam values (their
-- tables land later in Phase 2 / Phase 4)".
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_resource_type_check;
ALTER TABLE grants ADD CONSTRAINT grants_resource_type_check
  CHECK (resource_type IN
    ('task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin', 'surface'));

ALTER TABLE access_profile_rules DROP CONSTRAINT IF EXISTS access_profile_rules_resource_type_check;
ALTER TABLE access_profile_rules ADD CONSTRAINT access_profile_rules_resource_type_check
  CHECK (resource_type IN
    ('task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin', 'surface'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · The Access-surface catalogue (design §3.2, A25.1)
--
-- A family is spelled `"<METHOD> <mounted path>"` — `GET /webhooks`,
-- `POST /webhooks`. It carries its METHOD because the tree forces it:
-- `routes/webhooks.ts` serves `GET /` and `POST /` on the SAME path and
-- `routes/litellmAdmin.ts` serves `GET /models` and `POST /models` on the same
-- path, so under a path-only family neither surface could carry a read family
-- at all and sitting ruling I-10 (`use` is READ-ONLY; annex D2(vii)) would be
-- unenforceable rather than merely unenforced. `utils/routeFamilies.ts` is the
-- one enumeration a family is measured against.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS access_surfaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  governance TEXT NOT NULL CHECK (governance IN ('governable', 'always-self', 'locked')),
  -- The ratified sentence a lock cites, recorded on the row (A25.1: "a lock
  -- without such a citation is a naming defect"). NOT NULL exactly when locked.
  locked_reference TEXT,
  read_families TEXT[] NOT NULL DEFAULT '{}',
  write_families TEXT[] NOT NULL DEFAULT '{}',
  -- [{ "family": "<METHOD /path>", "requirement": "<ratified scopeMap requirement>" }]
  -- Families this surface's page calls that the arm does NOT govern, each with
  -- the requirement that does. NOT authority data: it names no principal and
  -- confers nothing. It is the censused statement of what `none` leaves
  -- reachable (§3.5, I-7); D2(v) validates each stored requirement against
  -- `requiredScopeFor` at boot, so the census fails the moment a route-map
  -- change makes a stored requirement stale.
  excluded_families JSONB NOT NULL DEFAULT '[]'::jsonb,
  menu_path TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('core', 'plugin')),
  plugin_name TEXT,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT access_surfaces_locked_reference_required
    CHECK ((governance = 'locked') = (locked_reference IS NOT NULL)),
  CONSTRAINT access_surfaces_plugin_name_required
    CHECK ((origin = 'plugin') = (plugin_name IS NOT NULL)),
  CONSTRAINT access_surfaces_excluded_families_shape
    CHECK (jsonb_typeof(excluded_families) = 'array')
);

CREATE INDEX IF NOT EXISTS ix_access_surfaces_live
  ON access_surfaces(governance) WHERE retired_at IS NULL;

COMMENT ON TABLE access_surfaces IS
  'A25.1 Access surface: one governable unit of the product with the closed set of route families that serve it. Catalogue metadata — no column names WHO, and design 7a9317b2 §3.2 states the never-grants + monotonicity criterion (annex 85a2218d D1).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · The Access-bundle object and its membership (design §3.1a, A25.2)
--
-- Both tables are catalogue metadata: no principal, verb or level column, and
-- THE EVALUATOR NEVER READS THEM. The profile pair an Access bundle owns is a
-- PROJECTION of the membership onto its `governable` members only (§3.4); an
-- `always-self` member projects to nothing because the arm is never consulted
-- for it, and a `locked` surface is never a member (D9, D2).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS access_bundles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  use_profile_id UUID NOT NULL UNIQUE REFERENCES access_profiles(id),
  configure_profile_id UUID NOT NULL UNIQUE REFERENCES access_profiles(id),
  predefined BOOLEAN NOT NULL DEFAULT false,
  -- §2.3: Access bundles are RETIRED, never hard-deleted — the pinned
  -- substrate refuses to delete a published profile (`PROFILE_HAS_VERSIONS`)
  -- and 095 makes versions and rules immutable. This is that stamp's target.
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT access_bundles_distinct_profile_pair CHECK (use_profile_id <> configure_profile_id)
);

CREATE TABLE IF NOT EXISTS access_bundle_members (
  bundle_id UUID NOT NULL REFERENCES access_bundles(id),
  surface_id UUID NOT NULL REFERENCES access_surfaces(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bundle_id, surface_id)
);

CREATE INDEX IF NOT EXISTS ix_access_bundle_members_surface
  ON access_bundle_members(surface_id);

COMMENT ON TABLE access_bundles IS
  'A25.2 Access bundle: a named, deployment-defined set of Access surfaces, owning the two Access profiles each (Access bundle, level) pair is realised as. Catalogue metadata; the evaluator never reads it (design 7a9317b2 §3.1a, I-9).';
COMMENT ON TABLE access_bundle_members IS
  'A25.2 Access-bundle membership. May name governable and always-self surfaces, NEVER locked (D9, D2). The profile pair is the projection of this onto the governable members only (design 7a9317b2 §3.4, annex D20).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Seed (§4, §4.4). Guarded: seeded once, on an empty catalogue.
-- ─────────────────────────────────────────────────────────────────────────────

DO $seed$
DECLARE
  bundle_key TEXT;
  bundle_label TEXT;
  level TEXT;
  profile_id UUID;
  version_id UUID;
  use_profile UUID;
  configure_profile UUID;
  bundle_id UUID;
  governable_ids UUID[];
BEGIN
  IF EXISTS (SELECT 1 FROM access_surfaces) OR EXISTS (SELECT 1 FROM access_bundles) THEN
    RAISE NOTICE '109: Access-surface catalogue already seeded; leaving it untouched.';
    RETURN;
  END IF;

  -- ── 4a · The thirteen core Access surfaces (§1.1) ──
  INSERT INTO access_surfaces
    (key, label, governance, locked_reference, read_families, write_families, excluded_families, menu_path, origin)
  VALUES
    -- #11 About — always-self. Its other two reads (`GET /` at the API root and
    -- the static `/release-manifest.json`) are outside the protected funnel
    -- entirely and are therefore not families of any registration.
    ('settings.about', 'About', 'always-self', NULL,
     '{}', '{}',
     '[{"family": "GET /appearance/info", "requirement": "authenticated"}]'::jsonb,
     '/about', 'core'),

    -- #12 Preferences — always-self (AZ-A5 clause 5: "TWO ROUTES, NO IDENTIFIER").
    ('settings.preferences', 'Preferences', 'always-self', NULL,
     ARRAY['GET /preferences'],
     ARRAY['PUT /preferences'],
     '[]'::jsonb, '/preferences', 'core'),

    -- #13 Settings shell — always-self, a frontend grouping with no backend
    -- family of its own. Its two self endpoints are recorded as EXCLUDED at the
    -- `authenticated` ceiling `D-5` moves them to, so reverting that ceiling
    -- fails the boot census (D2(v)) instead of passing unnoticed.
    ('settings.shell', 'Settings shell', 'always-self', NULL,
     '{}', '{}',
     '[{"family": "GET /principals/me", "requirement": "authenticated"},
       {"family": "GET /principals/me/effective-access", "requirement": "authenticated"}]'::jsonb,
     '/settings', 'core'),

    -- #14 Appearance — governable. Governable families are everything except
    -- `GET /appearance` and `GET /appearance/info`, both `authenticated` and the
    -- second of them public pre-login (the login page renders the logo from it).
    ('settings.appearance', 'Appearance', 'governable', NULL,
     ARRAY['GET /appearance/asset-history/:kind',
           'GET /appearance/asset-versions/:id',
           'GET /appearance/versions'],
     ARRAY['POST /appearance/assets/:kind',
           'POST /appearance/reset',
           'POST /appearance/versions/:versionNo/revert',
           'PUT /appearance'],
     '[{"family": "GET /appearance", "requirement": "authenticated"},
       {"family": "GET /appearance/info", "requirement": "authenticated"}]'::jsonb,
     '/settings/appearance', 'core'),

    -- #15 Access grants — governable; root on every method.
    ('settings.access-grants', 'Access grants', 'governable', NULL,
     ARRAY['GET /grants'],
     ARRAY['POST /grants', 'DELETE /grants/:id'],
     '[]'::jsonb, '/settings/access', 'core'),

    -- #16 Access manager (self scope) — always-self; the AZ-S4 human surfaces
    -- with their in-handler self-scope and step-up arms.
    ('settings.access-manager', 'Access manager', 'always-self', NULL,
     ARRAY['GET /warrants',
           'GET /warrants/:id',
           'GET /warrants/:id/dependent-tasks',
           'GET /warrants/:id/linkage',
           'GET /warrants/suggestions',
           'GET /approvals',
           'GET /approvals/:id',
           'GET /delegation/agent-mints/:approvalId',
           'GET /delegation/warrants'],
     ARRAY['POST /warrants',
           'POST /warrants/:id/resume',
           'POST /warrants/:id/revoke',
           'PATCH /warrants/:id',
           'POST /approvals/:id/approve',
           'POST /approvals/:id/deny',
           'POST /delegation/agent-mints',
           'POST /delegation/agent-mints/:approvalId/collect',
           'POST /credentials/:id/reveal',
           'POST /credentials/:id/revoke'],
     '[]'::jsonb, '/settings/access-manager', 'core'),

    -- #17 Identities — governable, and its ONE governable family is the
    -- remediation queue. `GET /principals` stays `principals:read` and principal
    -- mutation stays `principals:admin`; both are the ratified identity plane
    -- and an Access bundle must not take them away (I-7).
    ('settings.identities', 'Identities', 'governable', NULL,
     ARRAY['GET /principals/remediation-queue'],
     '{}',
     '[{"family": "GET /principals", "requirement": "principals:read"},
       {"family": "POST /principals", "requirement": "principals:admin"},
       {"family": "PATCH /principals/:id", "requirement": "principals:admin"}]'::jsonb,
     '/settings/principals', 'core'),

    -- #18 Access profiles + Groups — governable, no menu entry of its own.
    ('settings.access-profiles-groups', 'Access profiles and Groups', 'governable', NULL,
     ARRAY['GET /access-profiles/what-if',
           'GET /access-profiles/:id/events',
           'GET /groups/directory-sync'],
     ARRAY['POST /access-profiles',
           'PATCH /access-profiles/:id',
           'DELETE /access-profiles/:id',
           'POST /access-profiles/:id/versions',
           'POST /access-profiles/:id/publish',
           'POST /access-profiles/:id/assignments',
           'DELETE /access-profiles/:id/assignments/:assignmentId',
           'POST /groups',
           'PATCH /groups/:id',
           'DELETE /groups/:id',
           'POST /groups/:id/members',
           'DELETE /groups/:id/members/:principalId'],
     '[{"family": "GET /access-profiles", "requirement": "principals:read"},
       {"family": "GET /access-profiles/:id", "requirement": "principals:read"},
       {"family": "GET /access-profiles/:id/versions", "requirement": "principals:read"},
       {"family": "GET /access-profiles/:id/assignments", "requirement": "principals:read"},
       {"family": "GET /groups", "requirement": "principals:read"},
       {"family": "GET /groups/:id", "requirement": "principals:read"},
       {"family": "GET /groups/:id/members", "requirement": "principals:read"}]'::jsonb,
     NULL, 'core'),

    -- #19 Identity providers — LOCKED. A23.1/A23.6: mutation is root and no
    -- scope family is minted; the whole family including its reads is root.
    ('settings.identity-providers', 'Identity providers', 'locked', 'A23.1',
     ARRAY['GET /identity-providers',
           'GET /identity-providers/:id',
           'GET /identity-providers/:id/invitations',
           'GET /identity-providers/:id/links',
           'GET /identity-providers/:id/login-groups'],
     ARRAY['POST /identity-providers',
           'PATCH /identity-providers/:id',
           'DELETE /identity-providers/:id',
           'POST /identity-providers/:id/invitations',
           'POST /identity-providers/:id/login-groups',
           'DELETE /identity-providers/:id/login-groups/:groupId',
           'POST /identity-providers/:id/test-connection',
           'PUT /identity-providers/:id/scim-client',
           'DELETE /identity-providers/:id/scim-client',
           'DELETE /identity-providers/links/:linkId'],
     '[]'::jsonb, NULL, 'core'),

    -- #20 Notification endpoints — LOCKED. A17.8: "RULED permanently root …
    -- that IS its ratified home".
    ('settings.notification-endpoints', 'Notification endpoints', 'locked', 'A17.8',
     ARRAY['GET /notification-endpoints'],
     ARRAY['PUT /notification-endpoints', 'DELETE /notification-endpoints/:id'],
     '[]'::jsonb, NULL, 'core'),

    -- #21 Webhooks — governable.
    ('settings.webhooks', 'Webhooks', 'governable', NULL,
     ARRAY['GET /webhooks'],
     ARRAY['POST /webhooks', 'PATCH /webhooks/:id', 'DELETE /webhooks/:id'],
     '[]'::jsonb, NULL, 'core'),

    -- #22 Model catalogue admin — governable.
    ('settings.model-catalogue', 'Model catalogue admin', 'governable', NULL,
     ARRAY['GET /litellm/models',
           'GET /litellm/keys',
           'GET /litellm/spend',
           'GET /litellm/health'],
     ARRAY['POST /litellm/models',
           'DELETE /litellm/models/:id',
           'POST /litellm/keys',
           'DELETE /litellm/keys/:id'],
     '[]'::jsonb, NULL, 'core'),

    -- #23 Connector owner plane — governable, and its ONE governable family is
    -- the owner plane itself; the rest of `/services` stays `services:*`.
    ('settings.connector-owner-plane', 'Connector owner plane', 'governable', NULL,
     '{}',
     ARRAY['PATCH /services/:id/owner-plane'],
     '[]'::jsonb, NULL, 'core');

  -- ── 4b · The three predefined Access bundles and their six profiles ──
  --
  -- Each Access bundle owns two profiles named `access-bundle:<key>:<level>`
  -- (A25.7a). Every profile publishes a version; Personal's and Operational's
  -- carry ZERO rules (the I5 shape — an empty Access bundle is representable
  -- and grants nothing), and 095 requires no CHECK that a version hold a rule.
  FOR bundle_key, bundle_label IN
    SELECT * FROM (VALUES
      ('personal', 'Personal'),
      ('operational', 'Operational'),
      ('administrative', 'Administrative')
    ) AS predefined(k, l)
  LOOP
    use_profile := NULL;
    configure_profile := NULL;

    -- OWNER RULING `70af4d82` §1.1 (2026-09-02) on escalation `94c77997`:
    -- Administrative is REDUCED to its four non-authority-mutation members.
    -- #15 Access grants, #17 Identities and #18 Access profiles + Groups stay
    -- registered `governable` and belong to NO Access bundle until the
    -- rule-4 arm exists (design card `3e76cfcc`, AUTHZ amendment AZ-A7).
    -- Measured over HTTP on a real PostgreSQL: `routes/grants.ts`,
    -- `routes/groups.ts` and `routes/accessProfiles.ts` carry NO rule-4 arm
    -- — their whole gate is the root ceiling THIS design’s arm substitutes
    -- for — so an Account at Administrative `configure` was a second owner
    -- plane. Design §4.3’s “rule-4 bounded: yes” for those three rows is
    -- CORRECTED by record `70af4d82`; annex `85a2218d` D21 is rescoped to
    -- match, and `utils/authorityMutationSurfaces.ts` is the closure that
    -- keeps them out of every Access bundle, both authority stores and the
    -- arm itself.
    SELECT array_agg(s.id ORDER BY s.key) INTO governable_ids
      FROM access_surfaces s
     WHERE s.governance = 'governable'
       AND s.retired_at IS NULL
       AND bundle_key = 'administrative'
       AND s.key IN ('settings.appearance', 'settings.webhooks',
                     'settings.model-catalogue', 'settings.connector-owner-plane');

    FOREACH level IN ARRAY ARRAY['use', 'configure']
    LOOP
      INSERT INTO access_profiles (name, description)
      VALUES (
        format('access-bundle:%s:%s', bundle_key, level),
        format('The %s access level of the %s Access bundle (SETGOV design 7a9317b2 §3.4; A25.7a). Maintained by the matrix; its single rule is the projection of access_bundle_members onto the bundle''s governable members.', level, bundle_label)
      )
      RETURNING id INTO profile_id;

      INSERT INTO access_profile_versions (profile_id, version_number)
      VALUES (profile_id, 1)
      RETURNING id INTO version_id;

      IF governable_ids IS NOT NULL AND array_length(governable_ids, 1) >= 1 THEN
        INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
        VALUES (
          version_id, 'surface', 'exact', governable_ids,
          CASE WHEN level = 'use' THEN ARRAY['read'] ELSE ARRAY['read', 'write'] END
        );
      END IF;

      UPDATE access_profiles SET published_version_id = version_id WHERE id = profile_id;

      INSERT INTO access_profile_events (profile_id, version_id, action, actor_handle, metadata)
      VALUES
        (profile_id, NULL, 'profile.created', 'system', jsonb_build_object('migration', '109', 'accessBundle', bundle_key)),
        (profile_id, version_id, 'version.created', 'system', jsonb_build_object('migration', '109')),
        (profile_id, version_id, 'profile.published', 'system', jsonb_build_object('migration', '109'));

      IF level = 'use' THEN use_profile := profile_id; ELSE configure_profile := profile_id; END IF;
    END LOOP;

    INSERT INTO access_bundles (key, label, use_profile_id, configure_profile_id, predefined)
    VALUES (bundle_key, bundle_label, use_profile, configure_profile, true)
    RETURNING id INTO bundle_id;

    -- ── 4c · Membership (§3.1a, §4.1–§4.3) ──
    -- Personal: the four `always-self` rows. Operational: empty at this pin —
    -- plugin surfaces join it at registration. Administrative: the FOUR
    -- non-authority-mutation governable core rows (#14, #21, #22, #23) per
    -- owner ruling `70af4d82` above. A `locked` surface is never a member,
    -- and #15/#17/#18 are members of nothing at all until `3e76cfcc` lands.
    IF bundle_key = 'personal' THEN
      INSERT INTO access_bundle_members (bundle_id, surface_id)
        SELECT bundle_id, s.id FROM access_surfaces s
         WHERE s.key IN ('settings.about', 'settings.preferences',
                         'settings.shell', 'settings.access-manager');
    ELSIF bundle_key = 'administrative' THEN
      INSERT INTO access_bundle_members (bundle_id, surface_id)
        SELECT bundle_id, s.id FROM access_surfaces s
         WHERE s.key IN ('settings.appearance', 'settings.webhooks',
                         'settings.model-catalogue', 'settings.connector-owner-plane');
    END IF;
  END LOOP;

  -- NO `access_profile_assignments` ROW IS SEEDED. §4.4: the Personal floor is
  -- the `always-self` class (I3), not a row, and every `G` surface is root-gated
  -- today — so "no assignment" reproduces the pin byte-for-byte for every
  -- non-root caller. Seeding an Administrative assignment is D14's red mutation.
END
$seed$;
