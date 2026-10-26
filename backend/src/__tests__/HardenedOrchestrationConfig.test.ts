import fs from 'fs';
import path from 'path';

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
    const config = loadHardenedOrchestrationConfig({ RELAYHALL_MAX_ACTIVE_GLOBAL: '', RELAYHALL_MAX_ACTIVE_PER_PROJECT: '' });
    expect(config.maxActiveGlobal).toBeNull();
    expect(config.maxActivePerProject).toBeNull();
  });

  it('parses bounded tuning values and an optional policy bound', () => {
    const config = loadHardenedOrchestrationConfig({
      TASK_REVIEWER_HEARTBEAT_ENABLED: 'false',
      REVIEWER_HEARTBEAT_INTERVAL_MS: '2000',
      TASK_REVIEW_TIMEOUT_MS: '45000',
      RELAYHALL_MAX_ACTIVE_GLOBAL: '4',
      RELAYHALL_MAX_ACTIVE_PER_PROJECT: '2',
      RELAYHALL_LEASE_TTL_MS: '60000',
      RELAYHALL_NOTIFICATION_BASE_BACKOFF_MS: '2000',
      RELAYHALL_NOTIFICATION_MAX_BACKOFF_MS: '4000',
      DEPLOYED_REPO_PATH: '/deployed-repo',
    });
    expect(config.reviewerHeartbeatEnabled).toBe(false);
    expect(config.maxActiveGlobal).toBe(4);
    expect(config.maxActivePerProject).toBe(2);
    expect(config.hermesQaRepo).toBe('/deployed-repo');
  });

  it.each([
    [{ RELAYHALL_MAX_ACTIVE_GLOBAL: '3' }, 3, null],
    [{ RELAYHALL_MAX_ACTIVE_PER_PROJECT: '5' }, null, 5],
  ])('either bound may be set alone; the other stays unlimited %#', (env, global, perProject) => {
    const config = loadHardenedOrchestrationConfig(env);
    expect(config.maxActiveGlobal).toBe(global);
    expect(config.maxActivePerProject).toBe(perProject);
  });

  it('the retired switch is not read: its name in the environment changes nothing', () => {
    // Ruling 1: the claim/lease surface has no switch. A leftover value in an
    // estate env-file is inert - neither honoured nor refused.
    const warn = jest.fn();
    const withStale = loadHardenedOrchestrationConfig({ CLAWBEAT_HARDENED_ORCHESTRATION_ENABLED: 'false' } as Record<string, string>, warn);
    expect(withStale).toEqual(loadHardenedOrchestrationConfig({}));
    expect(warn).not.toHaveBeenCalled();
    expect(Object.keys(withStale)).not.toContain('hardenedOrchestrationEnabled');
  });

  it.each([
    [{ TASK_REVIEWER_HEARTBEAT_ENABLED: 'yes' }, /exactly true or false/],
    [{ REVIEWER_HEARTBEAT_INTERVAL_MS: '999' }, /between 1000/],
    [{ RELAYHALL_MAX_ACTIVE_GLOBAL: '0' }, /between 1 and 64/],
    [{ RELAYHALL_MAX_ACTIVE_PER_PROJECT: '65' }, /between 1 and 64/],
    [{ RELAYHALL_MAX_ACTIVE_GLOBAL: 'unlimited' }, /must be an integer/],
    [{ RELAYHALL_MAX_ACTIVE_GLOBAL: '1', RELAYHALL_MAX_ACTIVE_PER_PROJECT: '2' }, /cannot exceed/],
    [{ RELAYHALL_NOTIFICATION_BASE_BACKOFF_MS: '5000', RELAYHALL_NOTIFICATION_MAX_BACKOFF_MS: '4000' }, /greater than or equal/],
    [{ RELAYHALL_QA_REPO: 'relative/path' }, /absolute path/],
  ])('fails closed for invalid configuration %#', (env, expected) => {
    expect(() => loadHardenedOrchestrationConfig(env)).toThrow(expected);
  });

  it.each([
    [{ TASK_REVIEWER_HEARTBEAT_ENABLED: 'true' }, /DB-backed Verifier controller is implemented/],
  ])('rejects opt-in to an unavailable controller %#', (env, expected) => {
    expect(() => loadHardenedOrchestrationConfig(env)).toThrow(expected);
  });
});

// The deployment settings are named RELAYHALL_*. The names of earlier releases
// are a read-only fallback: used when the current name is unset or empty, and
// reported ONCE per boot as a deprecation (names only, never values).
type Config = ReturnType<typeof loadHardenedOrchestrationConfig>;
describe('former variable names (deprecated fallback)', () => {
  // [current name, former name, a value valid for both, how it shows in the config, expected]
  const SETTINGS: Array<[string, string, string, (config: Config) => unknown, unknown]> = [
    ['RELAYHALL_MAX_ACTIVE_GLOBAL', 'CLAWBEAT_MAX_ACTIVE_GLOBAL', '37', (c) => c.maxActiveGlobal, 37],
    ['RELAYHALL_MAX_ACTIVE_PER_PROJECT', 'CLAWBEAT_MAX_ACTIVE_PER_PROJECT', '29', (c) => c.maxActivePerProject, 29],
    ['RELAYHALL_LEASE_TTL_MS', 'CLAWBEAT_LEASE_TTL_MS', '123457', (c) => c.leaseTtlMs, 123457],
    ['RELAYHALL_NOTIFICATION_BASE_BACKOFF_MS', 'CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS', '3571', (c) => c.notificationBaseBackoffMs, 3571],
    ['RELAYHALL_NOTIFICATION_MAX_BACKOFF_MS', 'CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS', '997001', (c) => c.notificationMaxBackoffMs, 997001],
    ['RELAYHALL_QA_REPO', 'CLAWBEAT_HERMES_QA_REPO', '/qa/checkout', (c) => c.hermesQaRepo, '/qa/checkout'],
  ];

  it.each(SETTINGS)('%s: the current name is read', (current, _former, value, pick, expected) => {
    const warn = jest.fn();
    expect(pick(loadHardenedOrchestrationConfig({ [current]: value }, warn))).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(SETTINGS)('%s: the former name %s is still read, with a deprecation notice', (current, former, value, pick, expected) => {
    const warn = jest.fn();
    expect(pick(loadHardenedOrchestrationConfig({ [former]: value }, warn))).toBe(expected);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(former);
    expect(warn.mock.calls[0][0]).toContain(current);
  });

  it.each(SETTINGS)('%s: the current name wins over %s, and the shadowed name is reported as ignored', (current, former, value, pick, expected) => {
    const other = value.startsWith('/') ? '/somewhere/else' : String(Number(value) + 1);
    const warn = jest.fn();
    expect(pick(loadHardenedOrchestrationConfig({ [current]: value, [former]: other }, warn))).toBe(expected);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`${former} (ignored, ${current} is set)`);
  });

  it('an EMPTY current name is unset, so the former name is read', () => {
    const warn = jest.fn();
    const config = loadHardenedOrchestrationConfig({ RELAYHALL_MAX_ACTIVE_GLOBAL: '', CLAWBEAT_MAX_ACTIVE_GLOBAL: '8' }, warn);
    expect(config.maxActiveGlobal).toBe(8);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports every former name in use in ONE notice, naming variables and never their values', () => {
    const warn = jest.fn();
    loadHardenedOrchestrationConfig({
      CLAWBEAT_MAX_ACTIVE_GLOBAL: '37',
      CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '29',
      CLAWBEAT_LEASE_TTL_MS: '123457',
      CLAWBEAT_HERMES_QA_REPO: '/qa/checkout',
    }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const message: string = warn.mock.calls[0][0];
    for (const name of ['CLAWBEAT_MAX_ACTIVE_GLOBAL', 'CLAWBEAT_MAX_ACTIVE_PER_PROJECT', 'CLAWBEAT_LEASE_TTL_MS', 'CLAWBEAT_HERMES_QA_REPO']) {
      expect(message).toContain(name);
    }
    for (const value of ['37', '29', '123457', '/qa/checkout']) expect(message).not.toContain(value);
  });

  it('says nothing when only current names, or nothing, are set', () => {
    const warn = jest.fn();
    loadHardenedOrchestrationConfig({}, warn);
    loadHardenedOrchestrationConfig({ RELAYHALL_MAX_ACTIVE_GLOBAL: '4', RELAYHALL_LEASE_TTL_MS: '60000' }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a refused configuration is the only message of a failing boot: no deprecation notice precedes it', () => {
    const warn = jest.fn();
    expect(() => loadHardenedOrchestrationConfig({ CLAWBEAT_MAX_ACTIVE_GLOBAL: '3', REVIEWER_HEARTBEAT_INTERVAL_MS: '999' }, warn)).toThrow(/between 1000/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an invalid value under a former name is refused naming THAT variable', () => {
    expect(() => loadHardenedOrchestrationConfig({ CLAWBEAT_MAX_ACTIVE_GLOBAL: '0' }, jest.fn())).toThrow(/CLAWBEAT_MAX_ACTIVE_GLOBAL must be between 1 and 64/);
    expect(() => loadHardenedOrchestrationConfig({ CLAWBEAT_MAX_ACTIVE_GLOBAL: '1', RELAYHALL_MAX_ACTIVE_PER_PROJECT: '2' }, jest.fn()))
      .toThrow(/RELAYHALL_MAX_ACTIVE_PER_PROJECT cannot exceed CLAWBEAT_MAX_ACTIVE_GLOBAL/);
    expect(() => loadHardenedOrchestrationConfig({ CLAWBEAT_HERMES_QA_REPO: 'relative/path' }, jest.fn())).toThrow(/absolute path/);
  });

  it('without a notice callback the deprecation goes to console.warn', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      loadHardenedOrchestrationConfig({ CLAWBEAT_LEASE_TTL_MS: '60000' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('CLAWBEAT_LEASE_TTL_MS');
    } finally {
      spy.mockRestore();
    }
  });

  it('.env.example documents the current names only', () => {
    const example = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
    expect(example).toMatch(/RELAYHALL_MAX_ACTIVE_GLOBAL/);
    expect(example).toMatch(/RELAYHALL_MAX_ACTIVE_PER_PROJECT/);
    expect(example).not.toMatch(/CLAWBEAT/);
  });
});
