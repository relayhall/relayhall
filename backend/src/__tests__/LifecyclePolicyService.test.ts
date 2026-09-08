import fs from 'fs';
import path from 'path';
import {
  AdvisoryLifecyclePolicyEvaluator,
  AllowAllLifecyclePolicyEvaluator,
  LifecyclePolicyDeniedError,
  LifecyclePolicyEvaluator,
  LifecyclePolicyService,
  LifecyclePolicyDecisionRecord,
  LifecyclePolicyDecisionStore,
  PostgresLifecyclePolicyDecisionStore,
} from '../services/LifecyclePolicyService';

class MemoryStore implements LifecyclePolicyDecisionStore {
  transactional: LifecyclePolicyDecisionRecord[] = [];
  independent: LifecyclePolicyDecisionRecord[] = [];

  async record(_queryable: any, decision: LifecyclePolicyDecisionRecord): Promise<void> {
    this.transactional.push(decision);
  }

  async recordIndependent(decision: LifecyclePolicyDecisionRecord): Promise<void> {
    this.independent.push(decision);
  }
}

const queryable = { query: jest.fn(async () => ({ rows: [] })) };
const baseInput = {
  action: 'project.archive',
  subject: { kind: 'project', id: 'project-1', revision: 'revision-1' },
  current: { status: 'active', privateMarker: 'must-not-persist' },
  proposed: { status: 'archived' },
};

function service(
  evaluator: LifecyclePolicyEvaluator,
  store: MemoryStore,
  mode: 'off' | 'observe' | 'enforce',
  extra: Record<string, unknown> = {},
): LifecyclePolicyService {
  return new LifecyclePolicyService(evaluator, store, {
    mode,
    environment: 'test',
    policyId: 'relayhall.contract-test',
    policyVersion: '1',
    ...extra,
  });
}

describe('LifecyclePolicyService contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing in off mode', async () => {
    const evaluator = { id: 'test.off', version: '1', evaluate: jest.fn() };
    const store = new MemoryStore();
    await service(evaluator, store, 'off').evaluate(queryable, baseInput);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(store.transactional).toHaveLength(0);
    expect(store.independent).toHaveLength(0);
  });

  it('records allow and advisory decisions in the caller transaction', async () => {
    for (const evaluator of [new AllowAllLifecyclePolicyEvaluator(), new AdvisoryLifecyclePolicyEvaluator()]) {
      const store = new MemoryStore();
      await service(evaluator, store, 'observe').evaluate(queryable, baseInput);
      expect(store.transactional).toHaveLength(1);
      expect(store.independent).toHaveLength(0);
      expect(store.transactional[0]).toMatchObject({
        action: 'project.archive',
        subjectKind: 'project',
        subjectId: 'project-1',
        effectiveDecision: 'allow',
        mode: 'observe',
      });
      expect(JSON.stringify(store.transactional[0])).not.toContain('must-not-persist');
    }
  });

  it('persists an enforced denial independently before throwing the bounded error', async () => {
    const store = new MemoryStore();
    const evaluator: LifecyclePolicyEvaluator = {
      id: 'test.deny',
      version: '2',
      evaluate: () => ({
        decision: 'deny',
        controlIds: ['change.freeze'],
        reasonIds: ['window.closed'],
        remediation: 'Wait for the approved change window',
      }),
    };
    await expect(service(evaluator, store, 'enforce').evaluate(queryable, baseInput))
      .rejects.toMatchObject({
        name: 'LifecyclePolicyDeniedError',
        code: 'LIFECYCLE_POLICY_DENIED',
        status: 409,
        action: 'project.archive',
      });
    expect(store.transactional).toHaveLength(0);
    expect(store.independent[0]).toMatchObject({
      decision: 'deny',
      effectiveDecision: 'deny',
      evaluatorId: 'test.deny',
      evaluatorVersion: '2',
      controlIds: ['change.freeze'],
    });
  });

  it('keeps observe mode advisory even when the evaluator returns deny', async () => {
    const store = new MemoryStore();
    const evaluator: LifecyclePolicyEvaluator = {
      id: 'test.observe-deny',
      version: '1',
      evaluate: () => ({ decision: 'deny', controlIds: ['change.freeze'], reasonIds: ['window.closed'] }),
    };
    await service(evaluator, store, 'observe').evaluate(queryable, baseInput);
    expect(store.transactional[0]).toMatchObject({ decision: 'deny', effectiveDecision: 'allow' });
  });

  it('applies only unexpired exceptions covering every denying control', async () => {
    const evaluator: LifecyclePolicyEvaluator = {
      id: 'test.exception',
      version: '1',
      evaluate: () => ({
        decision: 'deny',
        controlIds: ['change.freeze', 'backup.required'],
        reasonIds: ['window.closed'],
      }),
    };
    const validStore = new MemoryStore();
    await service(evaluator, validStore, 'enforce', { now: () => new Date('2026-08-14T10:00:00Z') }).evaluate(queryable, {
      ...baseInput,
      exception: {
        id: '11111111-1111-4111-8111-111111111111',
        owner: 'wadera',
        expiresAt: '2026-08-14T11:00:00Z',
        controlIds: ['backup.required', 'change.freeze'],
      },
    });
    expect(validStore.transactional[0]).toMatchObject({
      effectiveDecision: 'allow',
      exceptionDisposition: 'applied',
      exceptionOwner: 'wadera',
    });

    for (const exception of [
      {
        id: '22222222-2222-4222-8222-222222222222', owner: 'wadera',
        expiresAt: '2026-08-14T09:59:59Z', controlIds: ['change.freeze', 'backup.required'],
      },
      {
        id: '33333333-3333-4333-8333-333333333333', owner: 'wadera',
        expiresAt: '2026-08-14T11:00:00Z', controlIds: ['change.freeze'],
      },
    ]) {
      const store = new MemoryStore();
      await expect(service(evaluator, store, 'enforce', { now: () => new Date('2026-08-14T10:00:00Z') })
        .evaluate(queryable, { ...baseInput, exception }))
        .rejects.toBeInstanceOf(LifecyclePolicyDeniedError);
      expect(store.independent[0].exceptionDisposition).not.toBe('applied');
    }
  });

  it.each([
    {
      name: 'timeout',
      evaluator: {
        id: 'test.timeout', version: '1',
        evaluate: () => new Promise(() => undefined),
      } as LifecyclePolicyEvaluator,
      timeoutMs: 5,
      reason: 'evaluator.timeout-or-failure',
    },
    {
      name: 'malformed output',
      evaluator: {
        id: 'test.malformed', version: '1',
        evaluate: () => ({ decision: 'allow', controlIds: 'wrong', reasonIds: [] } as any),
      } as LifecyclePolicyEvaluator,
      timeoutMs: 100,
      reason: 'evaluator.malformed',
    },
  ])('fails closed in enforce mode on $name', async ({ evaluator, timeoutMs, reason }) => {
    const store = new MemoryStore();
    await expect(service(evaluator, store, 'enforce', { timeoutMs }).evaluate(queryable, baseInput))
      .rejects.toBeInstanceOf(LifecyclePolicyDeniedError);
    expect(store.independent[0]).toMatchObject({
      decision: 'deny',
      effectiveDecision: 'deny',
      controlIds: ['relayhall.evaluator-health'],
      reasonIds: [reason],
    });
  });

  it('gives the evaluator a deeply frozen copy and rejects secret-shaped output structures', async () => {
    const store = new MemoryStore();
    const evaluator: LifecyclePolicyEvaluator = {
      id: 'test.frozen',
      version: '1',
      evaluate: (input) => {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.current as object)).toBe(true);
        return {
          decision: 'allow',
          controlIds: [],
          reasonIds: [],
          metadata: { nested: { secret: 'not allowed' } } as any,
        };
      },
    };
    await expect(service(evaluator, store, 'enforce').evaluate(queryable, baseInput))
      .rejects.toBeInstanceOf(LifecyclePolicyDeniedError);
    expect(JSON.stringify(store.independent[0])).not.toContain('not allowed');
  });

  it('bounds evaluator input before invocation', async () => {
    const evaluator = { id: 'test.input-bound', version: '1', evaluate: jest.fn() };
    const store = new MemoryStore();
    await expect(service(evaluator, store, 'observe').evaluate(queryable, {
      ...baseInput,
      current: { oversized: 'x'.repeat(65537) },
    })).rejects.toThrow('policy input exceeds 64 KiB');
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('uses the dedicated evidence pool for independent denials', async () => {
    const independent = {
      on: jest.fn(),
      query: jest.fn(async () => ({ rows: [] })),
    };
    const store = new PostgresLifecyclePolicyDecisionStore(independent as any);
    const decision: LifecyclePolicyDecisionRecord = {
      action: 'project.archive', subjectKind: 'project', subjectId: 'project-1', subjectRevision: null,
      environment: 'test', mode: 'enforce', decision: 'deny', effectiveDecision: 'deny',
      evaluatorId: 'test.deny', evaluatorVersion: '1', policyId: 'test.policy', policyVersion: '1',
      controlIds: ['change.freeze'], reasonIds: ['window.closed'], remediation: null,
      exceptionId: null, exceptionOwner: null, exceptionExpiresAt: null, exceptionDisposition: 'none', metadata: {},
    };
    await store.recordIndependent(decision);
    expect(independent.query).toHaveBeenCalledTimes(1);
    expect(queryable.query).not.toHaveBeenCalled();
  });
});

describe('lifecycle policy evidence migration', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/090_lifecycle_policy_decisions.sql'), 'utf8');

  it('is append-only and stores decisions without object snapshots or credentials', () => {
    expect(sql).toMatch(/CREATE TABLE lifecycle_policy_decisions/i);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON lifecycle_policy_decisions/i);
    expect(sql).toMatch(/BEFORE TRUNCATE ON lifecycle_policy_decisions/i);
    expect(sql).toMatch(/ENABLE ALWAYS TRIGGER trg_lifecycle_policy_decisions_no_update_delete/i);
    expect(sql).not.toMatch(/^\s*(?:current_(?:state|object)|proposed_(?:state|object)|credential|secret)\s+/im);
  });
});
