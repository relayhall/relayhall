/**
 * The Phase object's ratified contract (RH-P2.4), pinned where it is cheapest
 * to regress: the lifecycle subset, the scope minting promise, the field
 * validation, and the Task-side phaseId write contract.
 */
import {
  PHASE_STATUSES,
  PHASE_SETTABLE_STATUSES,
  isPhaseBindingViolation,
} from '../services/PhaseService';
import { ALL_SCOPES, MINTABLE_SCOPES, isMintableScope } from '../utils/scopeMap';
import { normalizePhaseIdWrite, PhaseFieldError } from '../routes/tasks';

describe('lifecycle vocabulary (b94dd86e §4.1)', () => {
  it('uses exactly the ratified Phase subset — no invented tokens', () => {
    expect([...PHASE_STATUSES]).toEqual(['todo', 'in-progress', 'completed', 'archived']);
  });

  it('does not borrow tokens from the other work objects', () => {
    // `ideas`, `review` and `stuck` belong to Task; `empty`/`skipped` to
    // Subtask; `active` to Project and Report. A Phase carries none of them.
    for (const foreign of ['ideas', 'review', 'stuck', 'empty', 'skipped', 'active']) {
      expect(PHASE_STATUSES as readonly string[]).not.toContain(foreign);
    }
  });

  it('keeps archiving behind its own verb (§4.4 keeps the verbs distinct)', () => {
    expect(PHASE_SETTABLE_STATUSES).not.toContain('archived');
  });
});

describe('scope minting (A12.3: inert families become mintable when their objects land)', () => {
  it.each([
    ['phases:read'],
    ['phases:write'],
    ['phases:admin'],
  ])('%s is mintable now that the /phases surface exists', (scope) => {
    expect(isMintableScope(scope)).toBe(true);
  });

  it('mints nothing that is not ratified vocabulary', () => {
    for (const scope of MINTABLE_SCOPES) {
      expect(ALL_SCOPES).toContain(scope);
    }
  });

  it('leaves the still-inert families inert', () => {
    expect(isMintableScope('skills:use')).toBe(true);
    expect(isMintableScope('audit:read')).toBe(true);
    for (const scope of ['blueprints:read', 'blueprints:use', 'blueprints:write', 'blueprints:admin']) {
      expect(isMintableScope(scope)).toBe(true);
    }
    // The Blueprint surfaces are live; unrelated dormant families stay inert.
    for (const scope of ['personalities:use', 'tools:read', 'tools:invoke']) {
      expect(isMintableScope(scope)).toBe(false);
    }
  });
});

describe('phaseId on a Task write', () => {
  it('accepts a UUID', () => {
    expect(normalizePhaseIdWrite('11111111-1111-4111-8111-111111111111'))
      .toBe('11111111-1111-4111-8111-111111111111');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['the empty string', ''],
  ])('treats %s as the unphased backlog rather than an error', (_label, value) => {
    expect(normalizePhaseIdWrite(value)).toBeNull();
  });

  it.each([
    ['a non-uuid string', 'phase-4'],
    ['a number', 7],
    ['an object', { id: 'x' }],
    ['an array', ['11111111-1111-4111-8111-111111111111']],
  ])('refuses %s before it can reach the database', (_label, value) => {
    expect(() => normalizePhaseIdWrite(value)).toThrow(PhaseFieldError);
  });
});

describe('Project/Phase binding is a database fact, recognised by constraint name', () => {
  it('recognises the composite FK violation', () => {
    expect(isPhaseBindingViolation({ code: '23503', constraint: 'tasks_phase_project_fk' })).toBe(true);
  });

  it('recognises the CHECK that closes the MATCH SIMPLE null hole', () => {
    expect(isPhaseBindingViolation({ code: '23514', constraint: 'tasks_phase_requires_project' })).toBe(true);
  });

  it.each([
    ['another table\'s FK', { code: '23503', constraint: 'tasks_execution_service_fk' }],
    ['another CHECK', { code: '23514', constraint: 'tasks_priority_check' }],
    ['a unique violation', { code: '23505', constraint: 'tasks_phase_project_fk' }],
    ['a plain error', new Error('boom')],
    ['null', null],
  ])('does not claim %s as a phase-binding violation', (_label, value) => {
    expect(isPhaseBindingViolation(value)).toBe(false);
  });
});
