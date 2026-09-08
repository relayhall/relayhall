import fs from 'fs';
import path from 'path';
import { LIFECYCLE_POLICY_COVERAGE } from '../utils/lifecyclePolicyCoverage';
import { lifecyclePolicyDenialEnvelope, LifecyclePolicyDeniedError } from '../services/LifecyclePolicyService';

function methodBody(source: string, method: string): string {
  const pattern = new RegExp(`\\n  async ${method}\\s*\\(`, 'm');
  const match = pattern.exec(source);
  if (!match) throw new Error(`Missing covered method ${method}`);
  const start = match.index;
  const next = source.slice(start + match[0].length).search(/\n  (?:async |private async |public async )/);
  return next < 0 ? source.slice(start) : source.slice(start, start + match[0].length + next);
}

describe('closed lifecycle-policy mutation coverage', () => {
  it('has unique action and source/method bindings', () => {
    const actions = LIFECYCLE_POLICY_COVERAGE.map((item) => item.action);
    const methods = LIFECYCLE_POLICY_COVERAGE.map((item) => `${item.source}:${item.method}`);
    expect(new Set(actions).size).toBe(actions.length);
    expect(new Set(methods).size).toBe(methods.length);
  });

  it.each(LIFECYCLE_POLICY_COVERAGE)('$source::$method invokes $action before returning', ({ source, method, action }) => {
    const text = fs.readFileSync(path.join(__dirname, '../services', source), 'utf8');
    const body = methodBody(text, method);
    expect(body).toContain('lifecyclePolicyService.evaluate(client');
    expect(body).toContain(`action: '${action}'`);
  });

  it('keeps the scope separate from authorization and history append operations', () => {
    const actions = LIFECYCLE_POLICY_COVERAGE.map((item) => item.action).join('\n');
    expect(actions).not.toMatch(/auth|authorize|grant|audit|history|notification/);
  });
});

describe('bounded denial envelope', () => {
  it('returns stable policy fields without subject ids, object state, evaluator metadata or free-form remediation', () => {
    const envelope = lifecyclePolicyDenialEnvelope(new LifecyclePolicyDeniedError(
      'project.archive',
      { kind: 'project', id: 'private-project-id', revision: 'private-revision' },
      ['change.freeze'],
      ['window.closed'],
      'Retry private-project-id: private-object-marker',
    ));
    expect(envelope).toEqual({
      status: 409,
      code: 'LIFECYCLE_POLICY_DENIED',
      message: 'The lifecycle policy denied this operation',
      details: {
        action: 'project.archive',
        subjectKind: 'project',
        controlIds: ['change.freeze'],
        reasonIds: ['window.closed'],
        remediation: 'Contact an administrator with the control and reason identifiers',
      },
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /private-project-id|private-revision|private-object-marker|credential|secret/,
    );
  });
});
