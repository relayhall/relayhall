-- 081_appearance.sql
-- RH-UI.4 (task d6ca7a05): the deployment Appearance object, its append-only
-- version history, and its asset store.
-- Ratified contract: RH-DESIGN.6 §5.1 and §7 (report 9f01ba4b), vocabulary A16.
-- Design note: report f33f5bc7.
--
-- Slot 081 is the next free number behind 080 (RH-DESIGN.5 R2: migration numbers
-- are taken at implementation, never reserved ahead of the work).
--
-- WHY ONE FILE FOR THREE TABLES. They are one logical change — a singleton with
-- its history and its asset store — and they reference each other. Split across
-- three slots, a fresh replay could stop between two halves of one invariant and
-- leave a database that satisfies no version of the contract. The spec's
-- "next-free slots" is descriptive, not a requirement of one slot per table.
--
-- WHY THE SINGLETON IS ENFORCED IN THE SCHEMA. `appearances` is plural per the
-- §6 house rule and holds exactly one row. That is expressed as a CHECKed,
-- UNIQUE boolean rather than as a convention every future writer has to
-- remember: "there is only one" is an invariant, and an invariant the database
-- does not hold is a comment.

CREATE TABLE IF NOT EXISTS appearances (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The singleton latch. UNIQUE plus CHECK (singleton) means a second row is
    -- impossible: it would either duplicate `true` or set `false` and fail the
    -- check. No trigger, no advisory lock, no application-side discipline.
    singleton         BOOLEAN NOT NULL DEFAULT TRUE UNIQUE,

    -- Every field is optional. Unset means "serve the built-in default", which
    -- is the behaviour §5.1 requires at every level, including for a missing or
    -- corrupt row. A DEFAULT here would bake this release's wording into the
    -- database and make a later change to the built-in invisible.
    display_name      TEXT,
    login_title       TEXT,
    login_subtitle    TEXT,

    -- The three built-in Themes and nothing else. `system` is deliberately NOT
    -- accepted: it is a PRINCIPAL-level resolution directive (A16), and a
    -- deployment default meaning "follow each visitor's operating system" would
    -- make §5.5's resolution chain circular — the deployment link exists
    -- precisely to answer the case where the principal expressed no preference.
    default_theme     TEXT CHECK (default_theme IN ('relay-dark', 'relay-light', 'high-contrast')),

    -- Canonical lowercase #rrggbb, enforced HERE and not only at output time.
    -- S-F7 requires every interpolated value to be canonically re-serialized;
    -- making canonical form a storage invariant means a value that reached the
    -- column by any path is already safe to interpolate, so the guarantee does
    -- not depend on every future writer remembering to normalise.
    accent_color      TEXT CHECK (accent_color ~ '^#[0-9a-f]{6}$'),

    -- Deployment info (§6). Authenticated-only on the read side; the public
    -- payload never carries these.
    description       TEXT,
    links             JSONB NOT NULL DEFAULT '[]'::jsonb,
    team_markdown     TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by        UUID REFERENCES principals(id) ON DELETE SET NULL
);

-- WHY VERSIONS ARE APPEND-ONLY (the Charter pattern, S-F4).
-- Save, revert AND reset all APPEND. Reverting to version n writes a new version
-- carrying n's snapshot; resetting writes a defaults-version. Nothing is ever
-- deleted, so "what did this deployment look like on the third" always has an
-- answer, and a reset cannot be used to erase the evidence of what preceded it.
CREATE TABLE IF NOT EXISTS appearance_versions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_no        INTEGER NOT NULL UNIQUE,
    snapshot          JSONB NOT NULL,
    asset_refs        JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason            TEXT NOT NULL CHECK (reason IN ('save', 'revert', 'reset')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by        UUID REFERENCES principals(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_appearance_versions_created_at
    ON appearance_versions (created_at DESC);

-- WHY CORE STORES THESE BYTES AT ALL.
-- Strategy §2.12's "artifacts by reference, never bytes" governs WORK artifacts
-- and is unamended. Appearance assets are deployment-configuration bytes — a
-- distinct class licensed by owner ruling D6 — size-capped at 512 KB, served by
-- one dedicated route, and the only media bytes core stores. The static-mount
-- ban and the `noStaticMediaMounts` pin are untouched: this is a table, not a
-- directory.
CREATE TABLE IF NOT EXISTS appearance_assets (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              TEXT NOT NULL CHECK (kind IN ('logo', 'favicon', 'mark')),

    -- Stored bytes are ALWAYS the stripped re-serialization, never the upload
    -- as received (§7, S-F1). The column name says bytes; the contract says
    -- public-safe bytes, and nothing writes here except the path that strips.
    bytes             BYTEA NOT NULL,
    mime              TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    width             INTEGER NOT NULL CHECK (width > 0 AND width <= 2048),
    height            INTEGER NOT NULL CHECK (height > 0 AND height <= 2048),
    byte_size         INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 524288),

    -- Content hash: the ETag, and the cache key that makes immutable caching
    -- safe (§5.6). Superseding an asset changes the URL rather than asking a
    -- cache to forget something.
    sha256            TEXT NOT NULL,

    -- History lives in this table; only one row per kind is servable. The
    -- superseded rows are root-only and never reachable from the public route
    -- (§7 acceptance: an unauth or non-root fetch of a superseded version is
    -- 403/404).
    active            BOOLEAN NOT NULL DEFAULT TRUE,

    uploaded_by       UUID REFERENCES principals(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One ACTIVE row per kind, held by the database. A partial unique index states
-- exactly the rule — "at most one active per kind" — while leaving the history
-- rows unconstrained. Enforcing this in the service instead would make it true
-- only for as long as every writer went through that service.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appearance_assets_one_active_per_kind
    ON appearance_assets (kind) WHERE active;

CREATE INDEX IF NOT EXISTS idx_appearance_assets_kind_created
    ON appearance_assets (kind, created_at DESC);
