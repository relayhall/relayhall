/**
 * Who may manage principals and mint credentials (epic 60558599, spec §3.3).
 *
 * Every identity path now presents an explicit scope set. Credential
 * management requires root regardless of whether the caller arrived through
 * a JWT, session, legacy env key, or rh_ key. A missing set fails closed.
 */
import { ROOT_SCOPE, isScope, isMintableScope, Scope } from './scopeMap';

export interface IssuerAuthority {
  /** May create/modify principals and issue, rotate or revoke credentials. */
  canManage: boolean;
  /** Scopes this issuer may grant; null means "any" (explicit root holder). */
  grantableScopes: string[] | null;
  reason?: string;
}

/** The role vocabulary migration 062 allows on principals.role. */
export const ASSIGNABLE_ROLES = new Set([
  'admin', 'operator', 'editor', 'user', 'viewer',
  'orchestrator', 'reviewer', 'qa', 'agent',
]);

/**
 * The roles that DERIVE administrative authority.
 *
 * `scopesForRole` gives `admin` and `orchestrator` the `root` sentinel and
 * `operator` every mintable scope below it (`utils/identityScopes.ts:38-46`),
 * and migration `096`'s `principals_elevated_parentless` CHECK names exactly
 * this trio. Enumerated here so the role-change act and the CHECK cannot
 * disagree about which roles are the dangerous ones.
 */
export const ELEVATED_ROLES = new Set(['admin', 'operator', 'orchestrator']);

/**
 * Roles a manager may assign when creating a principal. The spec bounds scope
 * escalation but says nothing about the ROLE axis, and role decides authority
 * just as directly — resolveActorRole reads principals.role. Without a
 * ceiling, any manager could create an admin principal and issue keys to it.
 */
export function canAssignRole(issuerRole: string, requestedRole: string | null | undefined): boolean {
  if (!requestedRole) return true;
  if (!ASSIGNABLE_ROLES.has(requestedRole)) return false;
  // Only admin may mint admin- or orchestrator-level identities; an
  // orchestrator may create ordinary working identities.
  if (requestedRole === 'admin' || requestedRole === 'orchestrator') {
    return issuerRole === 'admin';
  }
  return true;
}


export function resolveIssuerAuthority(input: {
  scopes: string[] | null | undefined;
  role: string;
}): IssuerAuthority {
  if (Array.isArray(input.scopes)) {
    if (!input.scopes.includes(ROOT_SCOPE)) {
      return {
        canManage: false,
        grantableScopes: [],
        reason: 'Credential management requires the root scope',
      };
    }
    // A root key may grant anything it holds. Since root is the global
    // sentinel, that is every scope — but it is still bounded by its own key,
    // so revoking the key removes the ability.
    return { canManage: true, grantableScopes: null };
  }

  return {
    canManage: false,
    grantableScopes: [],
    reason: 'Credential management requires the root scope',
  };
}

/** Validates a requested scope list against the vocabulary and the issuer. */
export function validateRequestedScopes(
  requested: unknown,
  authority: IssuerAuthority
): { ok: true; scopes: Scope[] } | { ok: false; error: string } {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, error: 'scopes must be a non-empty array' };
  }
  const unknown = requested.filter((s) => !isScope(s));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown scope(s): ${unknown.map(String).join(', ')}` };
  }
  // Ratified-but-inert vocabulary cannot sit on a live key (A12.3): the
  // grantable table ships whole, minting is bounded to reachable surfaces.
  const inert = requested.filter((s) => isScope(s) && !isMintableScope(s));
  if (inert.length > 0) {
    return { ok: false, error: `Scope(s) not yet mintable (object lands in a later phase): ${inert.join(', ')}` };
  }
  const scopes = requested as Scope[];

  if (authority.grantableScopes !== null) {
    const excess = scopes.filter((s) => !authority.grantableScopes!.includes(s));
    if (excess.length > 0) {
      return { ok: false, error: `Cannot grant scope(s) you do not hold: ${excess.join(', ')}` };
    }
  }
  return { ok: true, scopes: Array.from(new Set(scopes)) };
}

/**
 * Handles that may never be created through the API.
 *
 * `system` is the request-less internal actor and the spec forbids credentials
 * for it outright. The other seeds already exist, so re-creation would fail on
 * the unique index anyway — naming them gives a clear error instead. The
 * `agent:` prefix is reserved because principalForSpawn derives spawn handles
 * from a task id, and a hand-made collision would silently capture another
 * task's attribution.
 */
const RESERVED_HANDLES = new Set([
  'system', 'dashboard_user', 'service_account',
  'reports_reader', 'hermes_task_agent', 'clawbeat_qa', 'clawbeat_reviewer',
  'hermes_qa', 'hermes_qa_reviewer',
]);

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/;

export function validateNewHandle(handle: unknown): { ok: true; handle: string } | { ok: false; error: string } {
  if (typeof handle !== 'string' || !handle.trim()) {
    return { ok: false, error: 'handle is required' };
  }
  const value = handle.trim();
  if (value.length > 64) {
    // principals.handle is varchar(64) and reports.author_actor_id is
    // varchar(100); a longer handle could never join.
    return { ok: false, error: 'handle must be 64 characters or fewer' };
  }
  if (value.startsWith('agent:')) {
    return { ok: false, error: 'The agent: prefix is reserved for spawn principals' };
  }
  if (RESERVED_HANDLES.has(value.toLowerCase())) {
    return { ok: false, error: `'${value}' is a reserved handle` };
  }
  if (!HANDLE_PATTERN.test(value)) {
    return {
      ok: false,
      error: 'handle must be lowercase alphanumeric with . _ - and start with a letter or digit',
    };
  }
  return { ok: true, handle: value };
}

/** The one principal that may never hold a credential (spec §3.3 refusals). */
export function refusesCredentials(handle: string): boolean {
  return handle === 'system';
}
