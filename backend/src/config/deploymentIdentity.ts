/**
 * Server fail-closed identity (card 7f0c84f0, owner ruling D33).
 *
 * WHAT "RESOLVED DEPLOYMENT IDENTITY" MEANS. A deployment acts as ONE named
 * Account: the local administrator of `config/localAdministrator.ts`. Its
 * handle is `RELAYHALL_LOCAL_ADMIN_HANDLE` or, when that is unset, the 062
 * seed `dashboard_user` (display name "Owner", the `bootstrap` installation
 * owner of docs/principals.md). It is the Account the break-glass door
 * (`POST /auth/login` in `routes/auth.ts`) signs in, the one whose role and
 * password no act may change (`routes/principals.ts`), and its role carries
 * the ROOT sentinel: `scopesForRole('admin' | 'orchestrator')` is `['root']`.
 *
 * The identity is RESOLVED when all five hold, checked before the HTTP
 * listener opens:
 *
 *   1. configuration names a handle - `RELAYHALL_LOCAL_ADMIN_HANDLE` is
 *      unset, empty, or a handle `localAdministratorHandle()` accepts rather
 *      than silently replacing with the seed;
 *   2. an Account row holds that handle;
 *   3. that Account is `active`;
 *   4. it is a parentless `human` Account, the only shape an elevated role
 *      may be given (the ELEVATED_ROLES rule in `routes/principals.ts`);
 *   5. the role the request path derives for it -
 *      `scopesForRole(resolveActorRole({ handle, principalRole }))`, the same
 *      two calls `middleware/auth.ts` makes - includes the root sentinel.
 *
 * Any failure is reported as ONE line naming the failed condition by code. It
 * never carries a secret, and never the raw configured value: a malformed
 * value is exactly the one an operator may have pasted into the wrong
 * variable. Condition 1 needs no database, so boot-check mode (which has none
 * by contract) checks it too; 2-5 read one row.
 *
 * WHAT THIS DOES NOT CHANGE. `localAdministratorHandle()`, the login
 * handler's runtime fallback to the seed, the token mint, the handle switch
 * and every existing startup gate are untouched. The row is read with this
 * module's own query - not through `PrincipalService`, whose cache would
 * carry a boot-time read into the request path - and nothing is written.
 */
import { DEFAULT_LOCAL_ADMINISTRATOR_HANDLE, localAdministratorHandle } from './localAdministrator';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { scopesForRole } from '../utils/identityScopes';
import { ROOT_SCOPE } from '../utils/scopeMap';

/** Every line this check writes starts with this tag. */
export const DEPLOYMENT_IDENTITY_LOG_TAG = '[DeploymentIdentity]';

export type DeploymentIdentityRefusalCode =
  | 'LOCAL_ADMIN_HANDLE_MALFORMED'
  | 'LOCAL_ADMINISTRATOR_ACCOUNT_MISSING'
  | 'LOCAL_ADMINISTRATOR_ACCOUNT_NOT_ACTIVE'
  | 'LOCAL_ADMINISTRATOR_NOT_A_PERSON'
  | 'LOCAL_ADMINISTRATOR_LACKS_ROOT';

export interface DeploymentIdentityRefusal {
  ok: false;
  code: DeploymentIdentityRefusalCode;
  /** Names the failed piece. Built only from handles and enumerated column values. */
  reason: string;
}

export interface DeploymentIdentityConfiguration {
  ok: true;
  handle: string;
  /** `configured`: RELAYHALL_LOCAL_ADMIN_HANDLE names it; `seed`: it is unset or empty. */
  source: 'configured' | 'seed';
}

export interface ResolvedDeploymentIdentity extends DeploymentIdentityConfiguration {
  principalId: string;
  /** The role the request path derives for this Account. */
  role: string;
}

/** The one read this check makes. Any `pg` Pool or client satisfies it. */
export interface DeploymentIdentityQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const DEPLOYMENT_IDENTITY_SQL =
  'SELECT id, kind, status, role, parent_principal_id FROM principals WHERE handle = $1';

function refusal(code: DeploymentIdentityRefusalCode, reason: string): DeploymentIdentityRefusal {
  return { ok: false, code, reason };
}

/**
 * Condition 1, with no database. Read at call time, like
 * `localAdministratorHandle()`, which it defers to for the handle rule so the
 * two can never disagree about what a well-formed handle is.
 */
export function deploymentIdentityConfiguration(): DeploymentIdentityConfiguration | DeploymentIdentityRefusal {
  const raw = process.env.RELAYHALL_LOCAL_ADMIN_HANDLE;
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  // Compose forwards an unset variable as an empty string, and
  // `localAdministratorHandle()` has always read empty as unset.
  if (!normalized) return { ok: true, handle: DEFAULT_LOCAL_ADMINISTRATOR_HANDLE, source: 'seed' };
  const handle = localAdministratorHandle();
  if (handle !== normalized) {
    return refusal('LOCAL_ADMIN_HANDLE_MALFORMED',
      'RELAYHALL_LOCAL_ADMIN_HANDLE is set but is not a valid Account handle, so it names no Account '
      + '(value not printed; unset it to use the seeded dashboard_user)');
  }
  return { ok: true, handle, source: 'configured' };
}

/** Conditions 1-5. A query failure is thrown to the caller, never read as a miss. */
export async function resolveDeploymentIdentity(
  db: DeploymentIdentityQueryable,
): Promise<ResolvedDeploymentIdentity | DeploymentIdentityRefusal> {
  const configured = deploymentIdentityConfiguration();
  if (!configured.ok) return configured;
  const { handle, source } = configured;
  const named = source === 'configured'
    ? `the local administrator handle '${handle}' (RELAYHALL_LOCAL_ADMIN_HANDLE)`
    : `the local administrator handle '${handle}' (the seeded default; RELAYHALL_LOCAL_ADMIN_HANDLE is unset)`;

  const result = await db.query(DEPLOYMENT_IDENTITY_SQL, [handle]);
  const row = result.rows[0];
  if (!row) return refusal('LOCAL_ADMINISTRATOR_ACCOUNT_MISSING', `no Account has ${named}`);
  if (row.status !== 'active') {
    return refusal('LOCAL_ADMINISTRATOR_ACCOUNT_NOT_ACTIVE',
      `the Account with ${named} is ${String(row.status)}, not active`);
  }
  if (row.kind !== 'human' || row.parent_principal_id !== null) {
    return refusal('LOCAL_ADMINISTRATOR_NOT_A_PERSON',
      `the Account with ${named} is not a parentless human Account (kind ${String(row.kind)}`
      + `${row.parent_principal_id === null ? '' : ', has a parent'})`);
  }
  const role = resolveActorRole({ handle, principalRole: typeof row.role === 'string' ? row.role : null });
  if (!scopesForRole(role).includes(ROOT_SCOPE)) {
    return refusal('LOCAL_ADMINISTRATOR_LACKS_ROOT',
      `the Account with ${named} resolves to role '${role}', which does not carry the root sentinel`);
  }
  return { ok: true, handle, source, principalId: String(row.id), role };
}

/** The single refusal line. */
export function formatDeploymentIdentityRefusal(outcome: DeploymentIdentityRefusal): string {
  return `🛑 ${DEPLOYMENT_IDENTITY_LOG_TAG} refusing to serve, the deployment identity is not resolved: `
    + `${outcome.code}: ${outcome.reason} (card 7f0c84f0; docs/principals.md)`;
}

/** The single success line. */
export function formatDeploymentIdentityResolved(identity: ResolvedDeploymentIdentity): string {
  return `✅ ${DEPLOYMENT_IDENTITY_LOG_TAG} resolved: local administrator '${identity.handle}' `
    + `(${identity.source === 'configured' ? 'RELAYHALL_LOCAL_ADMIN_HANDLE' : 'seeded default'}) `
    + 'is an active human Account holding the root sentinel';
}
