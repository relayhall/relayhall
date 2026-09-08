/**
 * Role precedence (CB-2 [3], spec b48bb799 §2.2): session snapshot →
 * non-NULL principal role → today's handle switch, verbatim. The wrapper
 * must stay byte-identical to the pre-identity resolveTaskAutomationRole —
 * the seed principals with a deliberately NULL role must keep resolving
 * through the switch (CB-1 review constraint 1). The dormant journal_publisher
 * seed (retired with the Journal plugin, P1.3 ruling A7) still exists in every
 * deployed DB and must keep resolving through the same default-agent
 * fallthrough — it is pinned below for exactly that reason.
 */
import { resolveActorRole, resolveTaskAutomationRole } from '../utils/taskAutomationRole';

describe('resolveActorRole precedence', () => {
  it('session role snapshot wins over everything', () => {
    expect(resolveActorRole({ handle: 'dashboard_user', principalRole: 'agent', sessionRole: 'operator' })).toBe('operator');
  });

  it('an empty session snapshot fails closed instead of falling through to a privileged principal role', () => {
    expect(resolveActorRole({ handle: 'dashboard_user', principalRole: 'orchestrator', sessionRole: '' })).toBe('');
  });

  it('principal role wins over the handle switch', () => {
    expect(resolveActorRole({ handle: 'dashboard_user', principalRole: 'agent' })).toBe('agent');
  });

  it('NULL principal role falls through to the switch — seed parity for the NULL-role seeds', () => {
    // journal_publisher is the dormant seed row of the extracted Journal
    // feature (migrations are immutable): it must never resolve above agent.
    for (const handle of ['system', 'journal_publisher', 'reports_reader']) {
      expect(resolveActorRole({ handle, principalRole: null })).toBe('agent');
    }
    expect(resolveActorRole({ handle: 'dashboard_user', principalRole: null })).toBe('orchestrator');
  });
});

describe('resolveTaskAutomationRole stays byte-identical', () => {
  const CASES: Array<[unknown, string]> = [
    ['dashboard_user', 'orchestrator'],
    ['DASHBOARD_USER', 'orchestrator'],
    ['  dashboard_user  ', 'orchestrator'],
    ['clawbeat_reviewer', 'reviewer'],
    ['hermes_qa_reviewer', 'reviewer'],
    ['clawbeat_qa', 'qa'],
    ['hermes_qa', 'qa'],
    ['journal_publisher', 'agent'],
    ['reports_reader', 'agent'],
    ['service_account', 'agent'],
    ['system', 'agent'],
    ['anything_else', 'agent'],
    [undefined, 'agent'],
    [null, 'agent'],
    ['', 'agent'],
  ];

  it.each(CASES)('%p → %s', (input, expected) => {
    expect(resolveTaskAutomationRole(input)).toBe(expected);
  });
});
