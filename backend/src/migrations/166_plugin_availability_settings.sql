-- 166_plugin_availability_settings.sql — plugin availability and layered
-- plugin settings, stage 1 (card bedf50cc; design ratified by owner ruling
-- E380). Reserved in backend/src/migrations/RESERVED in the same commit
-- (ruling 0464ad54 section 2); 165 is held there by a parallel lane.
--
-- Four changes, one implicit transaction, no COMMIT. Every statement is
-- replay-safe: re-running this file against a database that already has it
-- changes nothing. database/init.sql is untouched.
--
-- The plugin installation file stays the authority for WHICH Account may see a
-- plugin and which capabilities it holds. These tables only NARROW that: an
-- availability state can hide what the file allows, and never grants anything.
-- No table has a foreign key to an installation (installations live in a file,
-- not in the database), so rows of a plugin removed from the file are kept and
-- apply again when it is installed again.
--
-- ── 1. plugin_policies ──
--
-- One row per installed plugin the administrators have set a state for. No row
-- means `default_on`, today's behaviour, so nothing disappears on upgrade.
--
--   availability  required | default_on | available | disabled
--   version       the row revision the If-Match contract compares (an absent
--                 row is revision 0; the first write stores 1)
--
-- A later Group stage adds a scope column here: that is a schema change.
CREATE TABLE IF NOT EXISTS plugin_policies (
  plugin_name TEXT PRIMARY KEY CHECK (plugin_name ~ '^[a-z][a-z0-9-]{1,63}$'),
  availability TEXT NOT NULL DEFAULT 'default_on'
    CONSTRAINT plugin_policies_availability
    CHECK (availability IN ('required', 'default_on', 'available', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1 CONSTRAINT plugin_policies_version CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. plugin_settings ──
--
-- One row per (plugin, layer, owner): the administrators' deployment values
-- and locks (layer `deployment`, no owner), or one Account's own values
-- (layer `account`, owner = the Account). The `group` layer is reserved for a
-- later stage and refused by the layer CHECK until then. That the owner is an
-- Account-layer principal is enforced by the service: no foreign key can
-- require the layer.
--
-- `settings_values` holds values only, never secrets: the service refuses a
-- credential-shaped value and every value of a `secret` setting before it
-- writes. NULLS NOT DISTINCT makes the deployment row unique per plugin
-- (PostgreSQL 15 and later).
CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_name TEXT NOT NULL CHECK (plugin_name ~ '^[a-z][a-z0-9-]{1,63}$'),
  layer TEXT NOT NULL CONSTRAINT plugin_settings_layer CHECK (layer IN ('deployment', 'account')),
  account_principal_id UUID REFERENCES principals(id) ON DELETE CASCADE,
  settings_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  locked_keys TEXT[] NOT NULL DEFAULT '{}'::text[],
  version INTEGER NOT NULL DEFAULT 1 CONSTRAINT plugin_settings_version CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plugin_settings_owner_matches_layer
    CHECK ((layer = 'deployment') = (account_principal_id IS NULL)),
  CONSTRAINT plugin_settings_locks_deployment_only
    CHECK (layer = 'deployment' OR cardinality(locked_keys) = 0),
  CONSTRAINT plugin_settings_values_object
    CHECK (jsonb_typeof(settings_values) = 'object'),
  CONSTRAINT plugin_settings_one_row_per_owner
    UNIQUE NULLS NOT DISTINCT (plugin_name, layer, account_principal_id)
);

-- ── 3. plugin_account_choices ──
--
-- One Account's own on/off for one plugin. It is honoured only while the
-- state is `default_on` or `available`; it is kept (never deleted) while the
-- state is `required` or `disabled`, and applies again when the state returns.
CREATE TABLE IF NOT EXISTS plugin_account_choices (
  plugin_name TEXT NOT NULL CHECK (plugin_name ~ '^[a-z][a-z0-9-]{1,63}$'),
  account_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CONSTRAINT plugin_account_choices_version CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plugin_account_choices_pkey PRIMARY KEY (plugin_name, account_principal_id)
);

CREATE INDEX IF NOT EXISTS ix_plugin_account_choices_account
  ON plugin_account_choices (account_principal_id);

-- ── 4. The retry contract gains the five plugin acts ──
--
-- `PUT /plugin-host/:name/settings/account`, `PUT /plugin-host/:name/choice`,
-- `PUT /plugin-admin/:name/policy`, `PUT /plugin-admin/:name/settings` and
-- `POST /plugin-admin/:name/settings/cleanup` mount the shared retry middleware
-- (middleware/idempotency.ts) as `plugin.settings.account.put`,
-- `plugin.choice.put`, `plugin.policy.put`, `plugin.settings.deployment.put`
-- and `plugin.settings.cleanup`. Each is CREDENTIAL-scoped by ruling 3's
-- default for an operation added after the closed set: every one of them is a
-- login-session act decided in the handler (the user's own session, or an
-- administrator's session with a step-up), which the guard chain does not
-- decide, so a second identity of the same principal must never be served the
-- first one's answer; a login session scopes as `user:<handle>`. Replay
-- `return`: the stored answer is a receipt (the plugin, the new revision and
-- the changed keys), never a setting value.
--
-- The two named CHECKs are the closed SQL binding of the declaration table;
-- they are redefined here verbatim from 164 plus the five operations, the
-- forward-amend precedent of 133, 138, 147, 156, 157 and 164. Each
-- redefinition replaces the whole CHECK, so this one carries every operation
-- 164 holds. The operations are new, so no existing row is affected.
-- DROP ... IF EXISTS keeps a replay of this file a no-op.
ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_policy;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_policy
  CHECK (
    (operation IN ('task.create', 'task.stream.append', 'task.reference.create',
                   'task.note.append', 'task.patch', 'report.create',
                   'project.create', 'project.resource.create', 'phase.create',
                   'knowledge.note.commit', 'project.groupowned.create',
                   'knowledge.sharedwriter.add', 'knowledge.sharedwriter.remove',
                   'task.subtask.create', 'task.subtask.reorder', 'task.subtask.text',
                   'plugin.settings.account.put', 'plugin.choice.put', 'plugin.policy.put',
                   'plugin.settings.deployment.put', 'plugin.settings.cleanup')
     AND replay_policy = 'return')
    OR
    (operation IN ('agent.mint.request', 'agent.mint.collect', 'task.report.save')
     AND replay_policy = 'refuse')
  );

ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_scope;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_scope
  CHECK (
    (operation IN ('task.create', 'task.patch', 'task.stream.append',
                   'agent.mint.request', 'agent.mint.collect', 'phase.create', 'task.report.save',
                   'knowledge.note.commit', 'project.groupowned.create',
                   'knowledge.sharedwriter.add', 'knowledge.sharedwriter.remove',
                   'task.subtask.create', 'task.subtask.reorder', 'task.subtask.text',
                   'plugin.settings.account.put', 'plugin.choice.put', 'plugin.policy.put',
                   'plugin.settings.deployment.put', 'plugin.settings.cleanup')
     AND split_part(scope, ':', 1) IN ('cred', 'user'))
    OR
    (operation IN ('task.reference.create', 'task.note.append', 'report.create',
                   'project.create', 'project.resource.create')
     AND split_part(scope, ':', 1) IN ('prin', 'user'))
  );
