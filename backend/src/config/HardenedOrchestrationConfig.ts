export interface HardenedOrchestrationConfig {
  reviewerHeartbeatEnabled: boolean;
  reviewerHeartbeatIntervalMs: number;
  reviewTimeoutMs: number;
  reviewerHeartbeatStateFile: string;
  /**
   * Optional installation-wide policy bounds on concurrently active leases
   * (card 590c638a, owner ruling 2026-08-30 §2). `null` = UNLIMITED, the
   * default: capacity is the harnesses' concern under the pull-only
   * doctrine; leases bound squatting and rate limits bound API abuse.
   */
  maxActiveGlobal: number | null;
  maxActivePerProject: number | null;
  leaseTtlMs: number;
  notificationBaseBackoffMs: number;
  notificationMaxBackoffMs: number;
  hermesQaRepo?: string;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Deployment tuning is named `RELAYHALL_*`. Earlier releases read the same
 * settings under a former product prefix; those names are still honoured, read
 * only when the `RELAYHALL_*` name is unset or empty, and each use is reported
 * ONCE at boot as a deprecation (names only, never values). The `.env.example`
 * documents the current names only.
 */
const SETTINGS = {
  notificationBaseBackoffMs: { name: 'RELAYHALL_NOTIFICATION_BASE_BACKOFF_MS', deprecated: 'CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS' },
  notificationMaxBackoffMs: { name: 'RELAYHALL_NOTIFICATION_MAX_BACKOFF_MS', deprecated: 'CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS' },
  maxActiveGlobal: { name: 'RELAYHALL_MAX_ACTIVE_GLOBAL', deprecated: 'CLAWBEAT_MAX_ACTIVE_GLOBAL' },
  maxActivePerProject: { name: 'RELAYHALL_MAX_ACTIVE_PER_PROJECT', deprecated: 'CLAWBEAT_MAX_ACTIVE_PER_PROJECT' },
  leaseTtlMs: { name: 'RELAYHALL_LEASE_TTL_MS', deprecated: 'CLAWBEAT_LEASE_TTL_MS' },
  qaRepo: { name: 'RELAYHALL_QA_REPO', deprecated: 'CLAWBEAT_HERMES_QA_REPO' },
} as const;

type Setting = typeof SETTINGS[keyof typeof SETTINGS];

/** One deprecation notice per boot: it lists every former name that is in use. */
export type DeprecationWarn = (message: string) => void;

/**
 * The name of the variable a setting is read from (what an error message must
 * name): the current name first, then the former name. An empty value counts as
 * unset (as it always did here), so an empty current name falls through to a
 * former one. A former name that is set is appended to `used`, whether it is
 * read or shadowed by the current name.
 */
function resolveName(env: Env, setting: Setting, used: string[]): string {
  const current = env[setting.name];
  const former = env[setting.deprecated];
  const formerSet = former !== undefined && former !== '';
  if (current !== undefined && current !== '') {
    if (formerSet) used.push(`${setting.deprecated} (ignored, ${setting.name} is set)`);
    return setting.name;
  }
  if (formerSet) {
    used.push(`${setting.deprecated} (use ${setting.name})`);
    return setting.deprecated;
  }
  return setting.name;
}

function parseBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be exactly true or false`);
}

function parseInteger(env: Env, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/** An OPTIONAL bound: unset or empty means no bound at all (`null`), never 1. */
function parseOptionalBound(env: Env, name: string, maximum: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  return parseInteger(env, name, 1, 1, maximum);
}

export function loadHardenedOrchestrationConfig(
  env: Env = process.env,
  warn: DeprecationWarn = (message) => console.warn(message),
): HardenedOrchestrationConfig {
  const reviewerHeartbeatEnabled = parseBoolean(env, 'TASK_REVIEWER_HEARTBEAT_ENABLED', false);
  // The Verifier switch remains fail-closed until the DB-backed review
  // controller is complete. The transactional lease/claim surface has NO
  // switch (card 590c638a, ruling 1): the rollout it guarded closed with
  // Phase 3, and a board that cannot hand out work is not a product mode. A
  // deployment cannot be born with the surface off.
  if (reviewerHeartbeatEnabled) {
    throw new Error('TASK_REVIEWER_HEARTBEAT_ENABLED=true is unavailable until the DB-backed Verifier controller is implemented');
  }

  const deprecatedInUse: string[] = [];
  const baseBackoffName = resolveName(env, SETTINGS.notificationBaseBackoffMs, deprecatedInUse);
  const maxBackoffName = resolveName(env, SETTINGS.notificationMaxBackoffMs, deprecatedInUse);
  const maxActiveGlobalName = resolveName(env, SETTINGS.maxActiveGlobal, deprecatedInUse);
  const maxActivePerProjectName = resolveName(env, SETTINGS.maxActivePerProject, deprecatedInUse);
  const leaseTtlName = resolveName(env, SETTINGS.leaseTtlMs, deprecatedInUse);
  const qaRepoName = resolveName(env, SETTINGS.qaRepo, deprecatedInUse);

  const baseBackoff = parseInteger(env, baseBackoffName, 60_000, 1_000, 3_600_000);
  const maxBackoff = parseInteger(env, maxBackoffName, 900_000, 1_000, 86_400_000);
  if (maxBackoff < baseBackoff) {
    throw new Error(`${maxBackoffName} must be greater than or equal to ${baseBackoffName}`);
  }

  const maxActiveGlobal = parseOptionalBound(env, maxActiveGlobalName, 64);
  const maxActivePerProject = parseOptionalBound(env, maxActivePerProjectName, 64);
  if (maxActiveGlobal !== null && maxActivePerProject !== null && maxActivePerProject > maxActiveGlobal) {
    throw new Error(`${maxActivePerProjectName} cannot exceed ${maxActiveGlobalName}`);
  }

  const hermesQaRepo = env[qaRepoName]?.trim() || env.DEPLOYED_REPO_PATH?.trim() || undefined;
  if (hermesQaRepo && !hermesQaRepo.startsWith('/')) {
    throw new Error(`${SETTINGS.qaRepo.name}/DEPLOYED_REPO_PATH must be an absolute path`);
  }

  const leaseTtlMs = parseInteger(env, leaseTtlName, 900_000, 30_000, 3_600_000);
  const reviewerHeartbeatIntervalMs = parseInteger(env, 'REVIEWER_HEARTBEAT_INTERVAL_MS', 15_000, 1_000, 3_600_000);
  const reviewTimeoutMs = parseInteger(env, 'TASK_REVIEW_TIMEOUT_MS', 300_000, 1_000, 3_600_000);

  // Reported only once the whole configuration has been accepted, so a refusal
  // is the only message a failing boot prints.
  if (deprecatedInUse.length > 0) {
    warn(`[config] deprecated environment variable name(s) in use: ${deprecatedInUse.join(', ')}. The former names still work for now; rename them.`);
  }

  return {
    reviewerHeartbeatEnabled,
    reviewerHeartbeatIntervalMs,
    reviewTimeoutMs,
    reviewerHeartbeatStateFile: env.REVIEWER_HEARTBEAT_STATE_FILE?.trim() || '/data/reviewer-heartbeat-state.json',
    maxActiveGlobal,
    maxActivePerProject,
    leaseTtlMs,
    notificationBaseBackoffMs: baseBackoff,
    notificationMaxBackoffMs: maxBackoff,
    hermesQaRepo,
  };
}
