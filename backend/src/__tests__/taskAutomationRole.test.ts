import { resolveTaskAutomationRole, resolveTaskLifecycleRole } from '../utils/taskAutomationRole';

describe('task automation role authority', () => {
  // journal_publisher stays in this list as the dormant seed row of the
  // extracted Journal feature (P1.3 ruling A7) — it must keep failing closed
  // to agent like any other unprivileged identity.
  test.each([undefined, '', 'service_account', 'hermes_task_agent', 'openclaw_task_agent', 'journal_publisher'])(
    'fails unscoped identity %p closed to agent',
    (identity) => expect(resolveTaskAutomationRole(identity)).toBe('agent'),
  );

  test('recognizes server-issued human and Verifier identities', () => {
    expect(resolveTaskAutomationRole('dashboard_user')).toBe('orchestrator');
    expect(resolveTaskAutomationRole('clawbeat_reviewer')).toBe('reviewer');
    expect(resolveTaskAutomationRole('hermes_qa_reviewer')).toBe('reviewer');
    expect(resolveTaskAutomationRole('hermes_qa')).toBe('qa');
  });

  test('does not elevate an implementation identity based on a forged client claim', () => {
    const forgedHeader = 'orchestrator';
    expect(forgedHeader).toBe('orchestrator');
    expect(resolveTaskAutomationRole('hermes_task_agent')).toBe('agent');
  });
});

describe('Task lifecycle role authority', () => {
  test('the clean-install dashboard owner is the independent human Verifier', () => {
    expect(resolveTaskLifecycleRole({ handle: 'dashboard_user' })).toBe('reviewer');
    expect(resolveTaskAutomationRole('dashboard_user')).toBe('orchestrator');
  });

  test('spawned implementation identities remain agents', () => {
    expect(resolveTaskLifecycleRole({ handle: 'hermes_task_agent' })).toBe('agent');
    expect(resolveTaskLifecycleRole({ handle: 'anything', principalRole: 'agent' })).toBe('agent');
  });

  test('explicit qa and reviewer role tokens keep Verifier authority while unknown roles fail closed', () => {
    expect(resolveTaskLifecycleRole({ handle: 'x', principalRole: 'qa' })).toBe('qa');
    expect(resolveTaskLifecycleRole({ handle: 'x', principalRole: 'reviewer' })).toBe('reviewer');
    expect(resolveTaskLifecycleRole({ handle: 'x', principalRole: 'viewer' })).toBe('agent');
  });
});
