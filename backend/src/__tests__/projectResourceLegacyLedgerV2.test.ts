import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const FILE = '089_legacy_resource_ledger_v2.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');
const code = sql
  .split('\n')
  .map((line) => {
    const commentStart = line.indexOf('--');
    return commentStart === -1 ? line : line.slice(0, commentStart);
  })
  .join('\n');

describe('089 forward-ledger position and immutable history', () => {
  it('claims exactly the next slot after 088 and remains executable', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.filter((f) => f.startsWith('089_'))).toEqual([FILE]);
    expect(files.some((f) => f.startsWith('088_'))).toBe(true);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 89)).toEqual([
      '090_lifecycle_policy_decisions.sql',
      '091_feed_events.sql',
      '092_telemetry_frames.sql',
      '093_notification_endpoints.sql',
      '094_groups.sql',
      '095_access_profiles.sql',
      '096_delegation_substrate.sql',
      '097_registry_unification.sql',
      '098_warrants_approvals.sql',
      '099_assignment_access_vehicles.sql',
      '100_warrant_ceiling_unification.sql',
      '101_webhook_subscriptions.sql',
      '102_mcp_bootstrap_records.sql',
      '103_oauth_authorization_server.sql',
      '104_sso_relying_party.sql',
      '105_sso_login_group_whitelist.sql',
      '106_scim_directory_provisioning.sql',
      // RH-P5.SSO.W4 candidate B — the lifecycle rung and the push heartbeat
      // (AZ-A4 clauses 2 and 4; owner ruling 6bdcc16c; wave brief 4bbfe967 §2.4-§2.7).
      '107_scim_lifecycle_heartbeat.sql',
      // RH-P5.SSO.W4 candidate C — SS-22 lifted: directory mode enableable where its SCIM client is named.
      '108_sso_directory_mode_enableable.sql',
      '109_access_surfaces.sql',
      // Card fb06c930 — the retry contract. 109 landed with the
      // settings-governance lane while this candidate was in review,
      // so the ledger is contiguous again; `RESERVED` remains the
      // authority on any gap a still-unintegrated lane leaves.
      '110_operation_idempotency_records.sql',
      '111_telemetry_envelope_foundation.sql',
      '112_telemetry_receiver_limits.sql',
      '113_telemetry_side_channel_governance.sql',
      // RH-KW1 candidate A — 114, reserved to rh-0b4b779b-kw1.
      '114_knowledge_source_plane.sql',
      // RH-KW1 candidate B — the §5.2 jti seen-set. 116 stays reserved.
      '115_knowledge_assertion_jti.sql',
      '116_knowledge_board_source_and_audit.sql',
      // RH-AZ.PROJ-a (card b363a38c) - reserved slot 117 under owner ruling
      // PARALLEL-WRITERS 0464ad54 §2; RESERVED is the authority on the gap.
      '117_task_restricted_access.sql',
      '121_blueprint_registry.sql',
      '122_blueprint_provenance.sql',
      // RH-FEAT-A (card 7d38a6e0) - reserved slot 124; the gap below it is
      // other lanes' reservations, and src/migrations/RESERVED is its authority.
      '124_task_due_date.sql',
      // RH-AZ.PROJ-b (card 95572530) - reserved slot 125, the fourth
      // selector form. 118-124 are other lanes' reservations.
      '125_project_bounded_selector_form.sql',
      // RH-LENSES-a (card 74e02a05): directory group references and their
      // carriage. 127, because four lanes claimed 126 independently -- see backend/src/migrations/RESERVED
      // -- 124 and 125 belong to other lanes.
      '127_directory_group_references.sql',
      '128_lenses_featured_home_group_grant_origin.sql',
      // SCALE-5K (card 590e88cc) - reserved slot 126, the two
      // child-lookup indexes the init.sql baseline lost.
      '129_task_child_lookup_indexes.sql',
      '130_personality_versions.sql',
        '131_pristine_install_identity_cleanup.sql',
    ]);
    expect(fs.readFileSync(path.join(MIGRATIONS_DIR, 'BASELINE'), 'utf8')).not.toContain(FILE);
    expect(fs.readFileSync(path.join(MIGRATIONS_DIR, 'RETIRED'), 'utf8')).not.toContain(FILE);
    expect(code).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it('does not rewrite historical 067 or the prior 088 tip', () => {
    const sha = (name: string) => crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(MIGRATIONS_DIR, name)))
      .digest('hex');
    expect(sha('067_project_resource_contract.sql')).toBe(
      '210b8f5b0fe6d9560fde6ace469698a98e6200b9f047375a7df90bfa67b00c02',
    );
    expect(sha('088_report_handover.sql')).toBe(
      'e859e86a1fe65c99a592f4999ff8bd098da69ff1a266ba835382c1c53eb6aceb',
    );
  });
});

describe('089 complete delta inventory', () => {
  it('uses JSON-array segments for unknown roots and known-parent children', () => {
    expect(code).toMatch(/jsonb_each\(proj\.resources\)/);
    expect(code).toMatch(/jsonb_each\(proj\.resources->'repositories'\)/);
    expect(code).toMatch(/jsonb_each\(proj\.resources->'environments'\)/);
    expect(code).toMatch(/jsonb_each\(proj\.resources->'localPaths'\)/);
    expect(code).toMatch(/jsonb_each\(proj\.resources->'notebooks'\)/);
    expect(code).toContain(`'unknown:' || jsonb_build_array(legacy.key)::TEXT`);
    expect(code).toContain(`jsonb_build_array('repositories', legacy.key)::TEXT`);
    expect(code).toContain(`jsonb_build_array('environments', legacy.key)::TEXT`);
    expect(code).toContain(`jsonb_build_array('localPaths', legacy.key)::TEXT`);
    expect(code).toContain(`jsonb_build_array('notebooks', legacy.key)::TEXT`);
    expect(code).toContain(`encode(digest(legacy.value::TEXT, 'sha256'), 'hex')`);
  });

  it('splits notebook config by member and holds malformed entries atomically', () => {
    expect(code).toContain(`'notebooks.' || v_key || '.config:' || jsonb_build_array(legacy.key)::TEXT`);
    expect(code).toMatch(/jsonb_typeof\(proj\.resources->'notebooks'->v_key\) != 'object'/);
    expect(code).toContain(`'held', 'container failed validation'`);
    expect(code).toContain(`'notebook configuration is compatibility-held'`);
    expect(code).toMatch(/WHERE key <> 'url'/);
  });

  it('corrects JSON-null notebook members with null bytes and reason', () => {
    expect(code).toMatch(/v_url := proj\.resources->'notebooks'->'additional'->>v_key::INTEGER/);
    expect(code).toMatch(/IF v_url IS NULL THEN[\s\S]*?encode\(digest\('null', 'sha256'\), 'hex'\)[\s\S]*?'null value'/);
  });
});

describe('089 provenance repair and safety', () => {
  it('adds an explicit supersession marker and preserves v1 rows', () => {
    expect(code).toContain('superseded_by_migration_version INTEGER');
    expect(code).toMatch(/superseded_by_migration_version > migration_version/);
    expect(code).toMatch(/UPDATE project_resource_migration_items old[\s\S]*?old\.migration_version = 1/);
    expect(code).not.toMatch(/DELETE\s+FROM\s+project_resource_migration_items/i);
  });

  it('writes a v2 receipt and makes completed raw replay a no-op', () => {
    expect(code).toMatch(/INSERT INTO project_resource_migration_runs[\s\S]*?v_installation, proj\.id, 2/);
    expect(code).toMatch(/WHERE NOT EXISTS \([\s\S]*?r\.migration_version = 2/);
    expect(code).toContain('planned_items, mapped_items, held_items');
    expect(code).toMatch(/v_planned, 0, v_planned/);
  });

  it('checks v1 snapshot, v2 items and v2 receipt before apply', () => {
    const failures = code.match(/RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT/g) ?? [];
    expect(failures).toHaveLength(3);
    const firstFailure = code.indexOf("RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT");
    const apply = code.indexOf('INSERT INTO project_resource_migration_items');
    expect(firstFailure).toBeGreaterThan(-1);
    expect(firstFailure).toBeLessThan(apply);
  });

  it('preserves legacy bytes and never recreates canonical resources', () => {
    expect(code).not.toMatch(/UPDATE\s+(projects|project_links)\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+(projects|project_links)\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+project_resources\b/i);
    expect(code).not.toMatch(/UPDATE\s+project_resources\b/i);
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it('holds source and ledger locks through the implicit transaction', () => {
    expect(code).toContain('LOCK TABLE projects IN SHARE MODE');
    expect(code).toContain('LOCK TABLE project_links IN SHARE MODE');
    expect(code).toContain('LOCK TABLE project_resource_migration_items IN SHARE ROW EXCLUSIVE MODE');
    expect(code).toContain('LOCK TABLE project_resource_migration_runs IN SHARE ROW EXCLUSIVE MODE');
  });
});
