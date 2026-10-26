// stepUpMethods.ts — which step-up proofs an Account can give (card
// a3e76724), shared by `GET /auth/step-up/methods` and the SU-14 challenge
// (card 72b8fb97), so the two can never answer differently.
//
//   * `password` — the Account holds a live password credential, or it is
//     the named local administrator and the deployment hash is configured
//     (the break-glass fallback `passwordMatchesAccount` honours);
//   * `sso` — the Account holds a proven Identity link at the enabled
//     Identity provider, whose step-up policy does not disable step-up
//     (`stepUpProviderFor`, the same decision `startStepUp` makes).
//
// The session's own Identity provider changes which provider is ASKED, never
// whether `sso` is in the set: at most one provider is enabled at a time
// (`ux_identity_providers_single_active`) and `stepUpProviderFor` only ever
// admits an enabled one. So a caller that has no session in hand (a refused
// consumer) computes the same set with `sessionIdentityProviderId` null.
import { pool } from '../db/connection';
import { accountPasswordService } from './AccountPasswordService';
import { ssoAuthenticationService } from './identity/SsoAuthenticationService';
import { localAdministratorHandle } from '../config/localAdministrator';

export type StepUpMethod = 'password' | 'sso';

export interface StepUpMethodsInput {
  principalId: string;
  /** The Account's handle when the caller already holds it; read from the
   * principal row otherwise, and only when the break-glass hash is set. */
  handle?: string | null;
  sessionIdentityProviderId?: string | null;
  /** Whether the deployment's local-administrator password hash is set. */
  localAdministratorPasswordConfigured: boolean;
  /** Card 72b8fb97 (review r1): a step-up consumer's HELD client. Every read
   * then runs on it, in order, so a refused act never waits for a second
   * pool connection while it holds its own and its row locks. */
  queryable?: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };
}

export interface StepUpMethods {
  methods: StepUpMethod[];
  hasPassword: boolean;
  sso: boolean;
}

export async function stepUpMethodsFor(input: StepUpMethodsInput): Promise<StepUpMethods> {
  const on = input.queryable ? [input.queryable] as const : [] as const;
  const hasPassword = await accountPasswordService.has(input.principalId, ...on);
  const ssoProvider = await ssoAuthenticationService.stepUpProviderFor(
    input.principalId, input.sessionIdentityProviderId ?? null, ...on);
  let localAdministratorFallback = false;
  if (input.localAdministratorPasswordConfigured) {
    let handle = input.handle ?? null;
    if (handle === null) {
      const row = await (input.queryable ?? pool).query('SELECT handle FROM principals WHERE id = $1', [input.principalId]);
      handle = row.rows[0]?.handle ?? null;
    }
    localAdministratorFallback = handle === localAdministratorHandle();
  }
  const methods: StepUpMethod[] = [];
  if (hasPassword || localAdministratorFallback) methods.push('password');
  if (ssoProvider) methods.push('sso');
  return { methods, hasPassword, sso: Boolean(ssoProvider) };
}
