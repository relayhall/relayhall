/**
 * c2WebhookEventCensus.test.ts — RH-P3.C2: the registrable event set cannot
 * drift out of truth, and the retired emitter path cannot come back.
 *
 * Two standing regressions:
 *
 *  1. **Census.** Every dotted name the tree can emit into the feed must be
 *     registrable, and every registrable name must be producible. A set that
 *     omits a real name silently drops it from every subscription; a set that
 *     invents one promises events that structurally cannot arrive. Both are
 *     invisible in ordinary testing, which is why this is a census over the
 *     source rather than a fixed list compared against itself.
 *
 *  2. **No emitter path.** The pre-C2 delivery path dispatched object CONTENT
 *     from route handlers. It was removed; this asserts no route re-acquires
 *     one, because re-adding it would reopen the content leak without
 *     touching anything the delivery tests cover.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WEBHOOK_EVENTS, isRegistrableWebhookEvent } from '../services/WebhookService';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The six object types the feed accepts (091 CHECK, FeedEventService). */
const FEED_OBJECT_TYPES = ['task', 'phase', 'project', 'report', 'skill', 'personality'];

/**
 * Every dotted name the tree can emit into the feed:
 *  - literal `name: 'x.y'` at a feedEventService.emit call site, and
 *  - GrantService's computed `resourceType + '.acl_changed'`, which produces
 *    one name per feed object type.
 */
function emittableFeedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('feedEventService.emit')) continue;
    for (const match of source.matchAll(/name:\s*'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g)) {
      names.add(match[1]);
    }
    if (source.includes(".acl_changed'")) {
      for (const type of FEED_OBJECT_TYPES) names.add(`${type}.acl_changed`);
    }
  }
  return names;
}

describe('C2 registrable event census', () => {
  test('every feed-emittable name is registrable', () => {
    const missing = [...emittableFeedNames()].filter((name) => !isRegistrableWebhookEvent(name)).sort();
    expect(missing).toEqual([]);
  });

  test('every registrable name is feed-emittable — no promised-but-impossible events', () => {
    const emittable = emittableFeedNames();
    const impossible = WEBHOOK_EVENTS.filter((name) => !emittable.has(name)).sort();
    expect(impossible).toEqual([]);
  });

  test('the set is enumerated, and membership is exact rather than pattern-matched', () => {
    // Runbook §2 rejection class: enumerated sets, never wildcard regexes.
    expect(isRegistrableWebhookEvent('task.created')).toBe(true);
    for (const near of [
      'task.createdX', 'Task.created', 'task.create', ' task.created', 'task.created ',
      'task.*', '.*', 'task', 'skill.version.created', 'report.archived',
    ]) {
      expect(isRegistrableWebhookEvent(near)).toBe(false);
    }
  });

  test('names conform to vocabulary b94dd86e §6: dotted <singular>.<past-tense>', () => {
    for (const name of WEBHOOK_EVENTS) {
      // Two segments exactly — the same shape the 091 CHECK enforces on the
      // feed, which is why three-segment skill.version.* names cannot be here.
      expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  test('task.ready is registrable — the name this candidate adds', () => {
    expect(isRegistrableWebhookEvent('task.ready')).toBe(true);
  });
});

describe('C2 retired the content-bearing emitter path', () => {
  test('no route handler emits webhooks directly', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'routes'))) {
      const source = readFileSync(file, 'utf8');
      if (/webhookService\s*\.\s*emitEvent/.test(source) || /from '\.\.\/services\/WebhookService'/.test(source.replace(/import \{[^}]*WEBHOOK_EVENTS[^}]*\}[^;]*;/g, ''))) {
        // routes/webhooks.ts legitimately imports the event set for validation.
        if (!file.endsWith(join('routes', 'webhooks.ts'))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('WebhookService exposes no fire-and-forget emitter and holds no database handle', () => {
    const source = readFileSync(join(SRC, 'services', 'WebhookService.ts'), 'utf8');
    // emitEvent() was the content-leak entry point: any caller could hand it
    // an arbitrary object and it went out over the wire.
    expect(source).not.toContain('emitEvent');
    // No pool: the service cannot advance a cursor or mutate a subscription
    // as a side effect of building a payload.
    expect(source).not.toContain('db/connection');
  });

  test('delivery is driven by the feed cursor, not the task EventEmitter', () => {
    const source = readFileSync(join(SRC, 'services', 'WebhookService.ts'), 'utf8');
    expect(source).not.toContain('taskManagerDB.on');
    const worker = readFileSync(join(SRC, 'services', 'WebhookDeliveryWorker.ts'), 'utf8');
    expect(worker).toContain('listSince');
  });
});

describe('C2 subscription plane stays anti-beacon', () => {
  test('/webhooks resolves to the root sentinel, like /notification-endpoints', () => {
    const scopeMap = readFileSync(join(SRC, 'utils', 'scopeMap.ts'), 'utf8');
    expect(scopeMap).toMatch(/\{\s*pattern:\s*\/\^\\\/webhooks\(\\\/\|\$\)\/,\s*scope:\s*'root'\s*\}/);
  });

  test('migration 101 makes unattributed ACTIVE subscriptions unrepresentable', () => {
    const migration = readFileSync(join(SRC, 'migrations', '101_webhook_subscriptions.sql'), 'utf8');
    expect(migration).toContain('webhooks_active_requires_subscriber');
    expect(migration).toContain(
      `CHECK (NOT active OR (subscriber_principal_id IS NOT NULL
                        AND subscriber_credential_id IS NOT NULL))`);
    // Legacy rows are deactivated rather than adopted into the new contract.
    expect(migration).toContain('UPDATE webhooks\n   SET active = FALSE');
  });

  test('migration 101 leaves an ACTIVE subscription no URL of its own (ruling ccd53781 R1)', () => {
    const migration = readFileSync(join(SRC, 'migrations', '101_webhook_subscriptions.sql'), 'utf8');
    // The single-source rule: endpoint and mode are read from the subscriber
    // Connector's registry row, so a subscription cannot carry a second,
    // divergent address.
    expect(migration).toContain('webhooks_active_carries_no_url');
    expect(migration).toContain('CHECK (NOT active OR url IS NULL)');
    // The column is KEPT for the deactivated pre-C2 rows — stored legacy
    // bytes are held, reported and never dropped (the house rule, migration
    // 077) — which is why NOT NULL has to be relaxed rather than the column
    // removed.
    expect(migration).toContain('ALTER TABLE webhooks ALTER COLUMN url DROP NOT NULL');
    expect(migration).not.toContain('DROP COLUMN url');
  });

  test('migration 101 makes an unsigned webhook-mode Connector unrepresentable', () => {
    const migration = readFileSync(join(SRC, 'migrations', '101_webhook_subscriptions.sql'), 'utf8');
    // Signing moved to the registry with the endpoint: one endpoint, one
    // secret. `length(...) > 0`, not merely NOT NULL — an empty string is NOT
    // NULL, so a NULL-only CHECK would leave a webhook-mode Connector that
    // can never sign and therefore never deliver, with the invariant reading
    // as held while delivery was quietly bricked (pre-review F5).
    expect(migration).toContain('services_webhook_requires_signing');
    expect(migration).toContain(
      `CHECK (delivery_mode <> 'webhook'
         OR (delivery_endpoint IS NOT NULL AND length(delivery_endpoint) > 0
             AND delivery_secret IS NOT NULL AND length(delivery_secret) > 0))`);
    // Pre-existing webhook-mode rows are demoted, never issued a generated
    // secret their receiver has never seen and could not verify.
    expect(migration).toContain("SET delivery_mode = 'none'");
  });

  test('migration 101 keeps go signals off the observation plane (ruling ccd53781 R1)', () => {
    const migration = readFileSync(join(SRC, 'migrations', '101_webhook_subscriptions.sql'), 'utf8');
    expect(migration).toContain('webhooks_observation_excludes_go_signals');
    expect(migration).toContain("CHECK (NOT active OR NOT ('task.ready' = ANY(events)))");
    // Existing rows that registered it are cleaned rather than left to trip
    // the constraint on their next update.
    expect(migration).toContain("array_remove(events, 'task.ready')");
  });

  test('the work plane has per-ASSIGNEE delivery state, keyed by the registry row', () => {
    const migration = readFileSync(join(SRC, 'migrations', '101_webhook_subscriptions.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS connector_delivery_state');
    expect(migration).toContain('service_id UUID PRIMARY KEY REFERENCES services(id)');
    // A Connector first seen by the worker starts at the feed HEAD, never at
    // 0 — cursor 0 would replay the whole retained history as doorbells.
    expect(migration).toContain('SELECT COALESCE(MAX(cursor), 0) FROM feed_events');
  });
});

/**
 * The candidate was cut when 099 was the next free slot. AZ-S7 took 099
 * (assignment_access_vehicles) and AZ-A3 took 100 (warrant_ceiling_unification)
 * while C2 was parked in review, so the C2 migration renumbered to 101 on the
 * rebase onto that main (run packet b92846fb §2 item 2).
 *
 * The renumber is the kind of change that half-lands: the file moves and a
 * reference does not, and nothing notices until a deploy dies on a missing
 * path or a duplicate ledger number. These are the two static guards.
 */
describe('the C2 migration holds the next free forward slot', () => {
  const MIGRATIONS = join(SRC, 'migrations');

  test('101_webhook_subscriptions.sql sits immediately after 100, and only C4\'s 102 follows it', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('099_'))).toEqual(['099_assignment_access_vehicles.sql']);
    expect(files.filter((f) => f.startsWith('100_'))).toEqual(['100_warrant_ceiling_unification.sql']);
    expect(files.filter((f) => f.startsWith('101_'))).toEqual(['101_webhook_subscriptions.sql']);
    // RH-P3.C4 subtask [1] claimed 102 at ITS integration time, which is how
    // migration numbers are allocated here (run packet 1b75dca2 trap T5).
    expect(files.filter((f) => Number(f.slice(0, 3)) > 101))
      .toEqual([
        '102_mcp_bootstrap_records.sql',
        '103_oauth_authorization_server.sql',
        // RH-P5.SSO.W2 — the relying-party substrate (annex e6dcadb9 §11 SS-W2).
        '104_sso_relying_party.sql',
        // RH-P5.SSO.W3 — the SSO-R4 login group whitelist (annex e6dcadb9 §11 SS-W3).
        '105_sso_login_group_whitelist.sql',
        // RH-P5.SSO.W4 candidate A — the inbound SCIM provisioning substrate
        // (A24 / AZ-A4 clause 3; wave brief 4bbfe967 §2.1-§2.3).
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
        // RH-KW1 candidate A — the owner-plane knowledge configuration.
        // 113 is RESERVED to rh-beac9c79-tw1a and not yet written; the
        // ledger, not this list, is where a gap is legitimised.
        '114_knowledge_source_plane.sql',
        // RH-KW1 candidate B — the §5.2 jti seen-set. 116 stays reserved.
        '115_knowledge_assertion_jti.sql',
        '116_knowledge_board_source_and_audit.sql',
        // RH-AZ.PROJ-a (card b363a38c) - reserved slot 117 under owner ruling
        // PARALLEL-WRITERS 0464ad54 §2: the gap below 117 is other lanes'
        // reservations, and backend/src/migrations/RESERVED is its authority.
        '117_task_restricted_access.sql',
        '121_blueprint_registry.sql',
        '122_blueprint_provenance.sql',
        // RH-FEAT-A (card 7d38a6e0) - reserved slot 124 under owner ruling
        // PARALLEL-WRITERS 0464ad54 §2: the gap below it is other lanes'
        // reservations, and backend/src/migrations/RESERVED is its authority.
        '124_task_due_date.sql',
        // RH-AZ.PROJ-b (card 95572530) - reserved slot 125, the fourth
        // selector form. 118-124 are other lanes' reservations.
        '125_project_bounded_selector_form.sql',
        // RH-LENSES-a (card 74e02a05): directory group references and their
        // carriage. 127, because four lanes claimed 126 independently -- see
        // backend/src/migrations/RESERVED -- 124 and 125 belong to other lanes.
        '127_directory_group_references.sql',
        '128_lenses_featured_home_group_grant_origin.sql',
        // SCALE-5K (card 590e88cc) - reserved slot 126, the two
        // child-lookup indexes the init.sql baseline lost.
        '129_task_child_lookup_indexes.sql',
        '130_personality_versions.sql',
        '131_pristine_install_identity_cleanup.sql',
      ]);
    // A forward migration is executed, never stamped: an entry in either
    // manifest would silently skip the whole C2 schema on a fresh install.
    expect(readFileSync(join(MIGRATIONS, 'BASELINE'), 'utf8')).not.toContain('webhook_subscriptions');
    expect(readFileSync(join(MIGRATIONS, 'RETIRED'), 'utf8')).not.toContain('webhook_subscriptions');
  });

  test('no source, test or QA byte still points at the pre-rebase 099 filename', () => {
    // Assembled rather than written out, so this file is not its own offender.
    const OLD_NAME = '0' + '99_webhook_subscriptions';
    const roots = [SRC, join(SRC, '..', '..', 'qa')];
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { scan(full); continue; }
        if (!/\.(ts|tsx|sql|mjs|js|md)$/.test(entry)) continue;
        if (readFileSync(full, 'utf8').includes(OLD_NAME)) offenders.push(full);
      }
    };
    for (const root of roots) scan(root);
    expect(offenders).toEqual([]);
  });
});
