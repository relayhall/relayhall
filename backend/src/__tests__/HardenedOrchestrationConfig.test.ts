import { loadHardenedOrchestrationConfig } from '../config/HardenedOrchestrationConfig';

describe('loadHardenedOrchestrationConfig', () => {
  it('defaults: Verifier off, bounded tuning values, and NO concurrency bound (unlimited)', () => {
    // Card 590c638a ruling 2: unset = unlimited. `null` here, never 1.
    expect(loadHardenedOrchestrationConfig({})).toEqual({
      reviewerHeartbeatEnabled: false,
      reviewerHeartbeatIntervalMs: 15_000,
      reviewTimeoutMs: 300_000,
      reviewerHeartbeatStateFile: '/data/reviewer-heartbeat-state.json',
      maxActiveGlobal: null,
      maxActivePerProject: null,
      leaseTtlMs: 900_000,
      notificationBaseBackoffMs: 60_000,
      notificationMaxBackoffMs: 900_000,
      hermesQaRepo: undefined,
    });
  });

  it('an empty value is unset, not a bound', () => {
    const config = loadHardenedOrchestrationConfig({ CLAWBEAT_MAX_ACTIVE_GLOBAL: '', CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '' });
    expect(config.maxActiveGlobal).toBeNull();
    expect(config.maxActivePerProject).toBeNull();
  });

  it('parses bounded tuning values and an optional policy bound', () => {
    const config = loadHardenedOrchestrationConfig({
      TASK_REVIEWER_HEARTBEAT_ENABLED: 'false',
      REVIEWER_HEARTBEAT_INTERVAL_MS: '2000',
      TASK_REVIEW_TIMEOUT_MS: '45000',
      CLAWBEAT_MAX_ACTIVE_GLOBAL: '4',
      CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '2',
      CLAWBEAT_LEASE_TTL_MS: '60000',
      CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS: '2000',
      CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS: '4000',
      DEPLOYED_REPO_PATH: '/deployed-repo',
    });
    expect(config.reviewerHeartbeatEnabled).toBe(false);
    expect(config.maxActiveGlobal).toBe(4);
    expect(config.maxActivePerProject).toBe(2);
    expect(config.hermesQaRepo).toBe('/deployed-repo');
  });

  it.each([
    [{ CLAWBEAT_MAX_ACTIVE_GLOBAL: '3' }, 3, null],
    [{ CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '5' }, null, 5],
  ])('either bound may be set alone; the other stays unlimited %#', (env, global, perProject) => {
    const config = loadHardenedOrchestrationConfig(env);
    expect(config.maxActiveGlobal).toBe(global);
    expect(config.maxActivePerProject).toBe(perProject);
  });

  it('the retired switch is not read: its name in the environment changes nothing', () => {
    // Ruling 1: the claim/lease surface has no switch. A leftover value in an
    // estate env-file is inert - neither honoured nor refused.
    const withStale = loadHardenedOrchestrationConfig({ CLAWBEAT_HARDENED_ORCHESTRATION_ENABLED: 'false' } as Record<string, string>);
    expect(withStale).toEqual(loadHardenedOrchestrationConfig({}));
    expect(Object.keys(withStale)).not.toContain('hardenedOrchestrationEnabled');
  });

  it.each([
    [{ TASK_REVIEWER_HEARTBEAT_ENABLED: 'yes' }, /exactly true or false/],
    [{ REVIEWER_HEARTBEAT_INTERVAL_MS: '999' }, /between 1000/],
    [{ CLAWBEAT_MAX_ACTIVE_GLOBAL: '0' }, /between 1 and 64/],
    [{ CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '65' }, /between 1 and 64/],
    [{ CLAWBEAT_MAX_ACTIVE_GLOBAL: 'unlimited' }, /must be an integer/],
    [{ CLAWBEAT_MAX_ACTIVE_GLOBAL: '1', CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '2' }, /cannot exceed/],
    [{ CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS: '5000', CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS: '4000' }, /greater than or equal/],
    [{ CLAWBEAT_HERMES_QA_REPO: 'relative/path' }, /absolute path/],
  ])('fails closed for invalid configuration %#', (env, expected) => {
    expect(() => loadHardenedOrchestrationConfig(env)).toThrow(expected);
  });

  it.each([
    [{ TASK_REVIEWER_HEARTBEAT_ENABLED: 'true' }, /DB-backed Verifier controller is implemented/],
  ])('rejects opt-in to an unavailable controller %#', (env, expected) => {
    expect(() => loadHardenedOrchestrationConfig(env)).toThrow(expected);
  });
});
