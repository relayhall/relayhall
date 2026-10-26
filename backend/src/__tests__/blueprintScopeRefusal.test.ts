/**
 * A Blueprint scope refusal says WHICH scope as data (card fbeb86f1, owner
 * ruling D6), under the same rule as the route ceiling: only when the absence
 * of that scope is the whole reason.
 *
 * `requireBlueprintScope` is the handler-level check the registry, capture,
 * instantiation, ledger and setup services share. Its status, code and prose
 * (`403 SCOPE_REQUIRED`, "Required scope: X") are unchanged; the error gains
 * `requiredScopes`, which `routes/blueprints.ts` serialises as
 * `details.requiredScopes` (measured over the wire in c4McpProtocol).
 */
jest.mock('../db/connection', () => ({ pool: { query: jest.fn() } }));

import { authorizationService, type AuthorizationActor } from '../services/AuthorizationService';
import { requireBlueprintScope, type BlueprintReader } from '../services/BlueprintRegistryService';
import { BlueprintError } from '../utils/blueprintDocument';

function reader(overrides: Partial<AuthorizationActor> = {}): BlueprintReader {
  return {
    actor: {
      principalId: '11111111-1111-4111-8111-111111111111', handle: 'worker', role: 'agent',
      scopes: ['principals:read', 'tasks:read'], authenticated: true, ...overrides,
    },
    audit: {} as BlueprintReader['audit'],
    rootSession: false,
  };
}

function refusal(caller: BlueprintReader, scope: Parameters<typeof requireBlueprintScope>[1]): BlueprintError {
  try {
    requireBlueprintScope(caller, scope);
  } catch (error) {
    expect(error).toBeInstanceOf(BlueprintError);
    return error as BlueprintError;
  }
  throw new Error('expected a refusal');
}

describe('requireBlueprintScope names the scope it checked, and only when the scope is the reason', () => {
  it('keeps status, code and prose, and carries the missing scope as data', () => {
    const error = refusal(reader(), 'blueprints:use');
    expect(error.status).toBe(403);
    expect(error.code).toBe('SCOPE_REQUIRED');
    expect(error.message).toBe('Required scope: blueprints:use');
    expect(error.requiredScopes).toEqual(['blueprints:use']);
  });

  it('names what the check needs, never what the credential holds', () => {
    const error = refusal(reader({ scopes: ['principals:read', 'tasks:read', 'reports:read'] }), 'blueprints:write');
    expect(error.requiredScopes).toEqual(['blueprints:write']);
    expect(JSON.stringify([error.message, error.requiredScopes])).not.toMatch(/principals:read|tasks:read|reports:read/);
  });

  it('does not refuse a credential that holds the scope, or root', () => {
    expect(() => requireBlueprintScope(reader({ scopes: ['blueprints:use'] }), 'blueprints:use')).not.toThrow();
    expect(() => requireBlueprintScope(reader({ scopes: ['root'] }), 'blueprints:admin')).not.toThrow();
  });

  it('names nothing for a role ceiling, even though the scope is held', () => {
    const viewer = reader({ role: 'viewer', scopes: ['blueprints:admin'] });
    // The premise, asserted rather than assumed: this refusal is not about the scope.
    expect(authorizationService.authorizeRoute(viewer.actor, 'blueprints:admin').denial).toBe('ROLE_CEILING');
    const error = refusal(viewer, 'blueprints:admin');
    expect(error.code).toBe('SCOPE_REQUIRED');
    expect(error.message).toBe('Required scope: blueprints:admin');
    expect(error.requiredScopes).toBeUndefined();
  });

  it('names nothing for an unauthenticated caller', () => {
    const anonymous = reader({ authenticated: false, scopes: null });
    expect(authorizationService.authorizeRoute(anonymous.actor, 'blueprints:read').denial).toBe('UNAUTHENTICATED');
    expect(refusal(anonymous, 'blueprints:read').requiredScopes).toBeUndefined();
  });
});
