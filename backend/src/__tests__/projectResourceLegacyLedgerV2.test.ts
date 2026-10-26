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
        // P02: Account-scoped quota snapshots and observed service metrics.
        '132_usage_quota_snapshots.sql',
        // Planning MCP: credential-scoped Phase creation retry.
        '133_operation_idempotency_phase_create.sql',
        '134_flat_task_review_attempts.sql',
        '135_native_verification_requests.sql',
        '136_native_execution_correlation.sql',
        '137_native_generation_coordination.sql',
        '138_task_report_workflow.sql',
      '139_account_resource_control.sql',
      // Card a3e76724 - step-up through the Identity provider (reserved 140).
      '140_sso_step_up_binding.sql',
      // Card b13e5ac9 - the per-Project inbox phase (reserved 141).
      '141_project_inbox_phase.sql',
      // Card 785e1eed P1-B - reserved slot 142: AZ-A9 grant requests (the approvals kind).
      '142_access_requests_grant_kind.sql',
      // Card 785e1eed P2-B - reserved slot 143: AZ-A10 clause 6, the assignment grant rows' expiry.
      '143_assignment_grant_expiry.sql',
      // Card b1e3b16d (hub lane L2) - reserved slot 144: per-Account notification read state.
      '144_notification_read_state.sql',
      // Card 785e1eed P1-B-2 - reserved slot 145: AZ-A9 credential requests (clause 13).
      '145_access_requests_credential_kind.sql',
      // Card 20f40e40 (AZ-A12 build 1) - reserved slot 146: the Group principal kind.
      '146_group_principal_kind.sql',
      // Card b796067e (RB-11 Governor v0 core door) - reserved slot 147: the knowledge write door.
      '147_knowledge_write_door.sql',
      // Card 1a38270d (AZ-A13 stage 2) - reserved slot 148: edit in place, the authority-edit kind.
      '148_authority_edit_in_place.sql',
      '149_az_a10_role_grants.sql',
      // Card c84ac03b - reserved slot 150: product metric completion events.
      '150_product_metric_completion_events.sql',
      // Card 68f9dffe (E108 3b) - reserved slot 151: the six writer-less Task columns retire.
      '151_retire_writerless_task_columns.sql',
      // Card 46cfbd1d (LENSES-c c1-A) - reserved slot 152 (149-151 are reserved to
      // lanes not yet on this line): group_stewards, the Group roles relation.
      '152_lenses_c_group_stewards.sql',
      // Card 7a99d63e (step-up re-authentication) - reserved slot 153: the Identity provider's step_up_policy.
      // 149-152 are other lanes' reservations; RESERVED is the authority on the gap.
      '153_identity_provider_step_up_policy.sql',
      // Card 41e24358 (default Verifier) - reserved slot 155 (154 is another lane's): the
      // Project and Phase default Verifier and tasks.verifier_source.
      '155_default_verifier.sql',
      // Card 311229fd (AZ-A12 build 3) - reserved slot 156: the Group-owned create's own retry operation.
      // 154 is a held slot (RESERVED is the authority on the gap); 155 is the default Verifier.
      '156_project_group_owned_create_retry.sql',
      // Card 549cc51f (shared-area writer list) - reserved slot 157: knowledge_shared_writers.
      // 154 is a held slot (RESERVED is the authority on the gap); 155 and 156 precede it.
      '157_knowledge_shared_writers.sql',
      // Card 502fb19e (the universal change request, E325) - reserved slot 158: kind change,
      // approval_change_objects and the core tables the lifecycle exporter reads.
      '158_universal_change_requests.sql',
      // Card 502fb19e (the universal change request, slice S2) - reserved slot 159: the session
      // door's and the preview's route families join settings.access-manager.
      '159_change_request_session_door.sql',
      // Card ab8f78e9 (the MCP action log, E91) - reserved slot 161 (160 is held for a
      // parallel lane; RESERVED is the authority on the gap): mcp_action_log.
      '161_mcp_action_log.sql',
      '162_skill_owner.sql',
      // Card dac2ca71 (RH-TW1b slice 1) - reserved slot 163 (162 is held for the parallel
      // lane d67e6990; RESERVED is the authority on the gap): the OTLP receiver-limit surfaces.
      '163_telemetry_otlp_rate_surfaces.sql',
      // Card 2bc7b303 (the MCP Subtask structure verbs, E374) - reserved slot 164 (162 and
      // 163 are held for parallel lanes; RESERVED is the authority on the gap): the
      // retry contract's closed operation set gains task.subtask.create/reorder/text.
      '164_subtask_structure_retry.sql',
      // Card 742fae98 (the Map's Reports display mode) - reserved slot 165: the
      // per-principal Collapsed | Expanded choice on principal_preferences.
      '165_principal_map_reports_mode.sql',
      // Card bedf50cc (plugin availability and settings, E380) - reserved slot 166:
      // plugin_policies, plugin_settings, plugin_account_choices and the retry
      // contract's five plugin operations.
      '166_plugin_availability_settings.sql',
      // Card 5854f0d6 (Notifications and Timeline, E394) - reserved slot 167:
      // the four Timeline indexes.
      '167_notifications_timeline_indexes.sql',
      // Card 08792425 (member N6, knowledge source registration) - reserved slot 168:
      // knowledge_source_registrations.
      '168_knowledge_source_registrations.sql',
      // Owner ruling E455 (the Action Center, card 5854f0d6): per-caller seen marks
      // on action items.
      '169_notification_action_seen.sql',
      // Owner ruling E462 S4b: the per-Task verification mode `none`.
      '170_task_verification_none.sql',
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
