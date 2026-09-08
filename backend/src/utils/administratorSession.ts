/**
 * WHO IS AN ADMINISTRATOR, AND WHAT MAKES A REQUEST AN ADMINISTRATOR SESSION.
 *
 * Owner ruling `60307311` (2026-09-04) §1.1/§1.2, on the observation that the
 * week's permission trouble was BOOTSTRAPPING: `root` was the legacy password
 * login with no principal, every SSO login landed as `user`, and no act
 * promoted anyone. This module is the one place both halves of the answer are
 * written down, so the first-run detector, the role-change act, the CLI and
 * the Access manager cannot drift apart about them.
 *
 * ── ADMINISTRATOR_ROLES — what "an administrator exists" means ──
 *
 * §1.1's first-run step exists exactly while no administrator Account does.
 * An administrator is an ACTIVE, PARENTLESS, HUMAN Account whose
 * `principals.role` is `admin` or `operator`: the two roles the human
 * vocabulary of migration `062` gives administrative standing. The seeded
 * `dashboard_user` row is deliberately NOT one of them — it is `orchestrator`
 * (`062:81`), the automation-vocabulary token the break-glass door resolves
 * to, and treating it as an administrator would make the first-run step
 * unreachable on every deployment that has ever existed, which is the state
 * the ruling was written to end.
 *
 * ── ROLE_ACT_ISSUER_ROLES — who may perform the role-change act ──
 *
 * A superset by ONE token: `orchestrator`. It is not a widening. `orchestrator`
 * and `admin` derive the SAME ceiling — `scopesForRole` returns `['root']` for
 * both (`utils/identityScopes.ts:38-40`) — so an orchestrator session can
 * already create Accounts at `POST /principals` and already mint `root`
 * credentials onto any principal through `resolveIssuerAuthority`. Refusing it
 * here would withhold nothing it does not already hold, and would cost the
 * ruling its CLI verb: `relayhall login` posts the break-glass password to
 * `POST /auth/login` and caches the returned JWT (`cli/relayhall:253-271`),
 * which resolves to `orchestrator` — there is no cookie-session client in the
 * CLI at all. What the issuer may ASSIGN is bounded separately and unchanged,
 * by `canAssignRole`: an `orchestrator` issuer cannot assign `admin` or
 * `orchestrator`, so this door confers no path to the elevated pair.
 *
 * ── THE AUTHENTICATION-KIND DISPATCH ──
 *
 * "Performable only from an administrator SESSION, never a bearer credential"
 * is spelled here exactly as the owner plane already spells it in
 * the Access-surface arm (`services/AccessSurfaceService.armDecision`, clause
 * 5 — card `d0f030a9` moved it there from a private wrapper in
 * `middleware/sharedAuthorization`, so the arm and the Settings menu ask it
 * once between them),
 * in `routes/warrants.ts` and `routes/delegation.ts`, and in words at
 * `routes/auth.ts:108-117`: a login session is a board session cookie OR the
 * dashboard JWT, which is the break-glass door's own credential; an `rh_`
 * principal credential is refused outright (AZ-18), and so is every other
 * machine credential — the legacy `x-api-key` service key and the
 * reports-read key are not sessions either, and they fall in the same
 * refusal rather than in a gap.
 */

/** `principals.role` values that make an Account an administrator (§1.1). */
export const ADMINISTRATOR_ROLES: readonly string[] = ['admin', 'operator'];

/** Resolved roles whose LOGIN SESSION may perform the role-change act (§1.2). */
export const ROLE_ACT_ISSUER_ROLES: readonly string[] = ['admin', 'operator', 'orchestrator'];

/**
 * The request facts the dispatch reads. Structural rather than `AuthRequest`
 * so the predicate can be exercised without an Express request and without
 * importing the authentication middleware into a util.
 */
export interface AdministratorSessionInput {
  /** `req.authMethod` — server-derived, never a header. */
  authMethod?: string;
  /** `req.userId` — the resolved handle. */
  handle?: string;
  /** `principals.role` for the resolved principal. */
  principalRole?: string | null;
  /** `auth_sessions.role_snapshot` when the request arrived on a session. */
  sessionRole?: string | null;
}

export type AdministratorSessionOutcome =
  | { ok: true; issuerRole: string }
  | { ok: false; status: number; code: string; message: string };

/** The named refusals, exported so tests, the CLI and other seams name them too. */
export const REQUIRES_LOGIN_SESSION = 'REQUIRES_LOGIN_SESSION';
export const ROLE_ACT_REQUIRES_SESSION = 'ROLE_ACT_REQUIRES_SESSION';
export const ROLE_ACT_REQUIRES_ADMINISTRATOR = 'ROLE_ACT_REQUIRES_ADMINISTRATOR';
export const PASSWORD_ACT_REQUIRES_SESSION = 'PASSWORD_ACT_REQUIRES_SESSION';
export const PASSWORD_ACT_REQUIRES_ADMINISTRATOR = 'PASSWORD_ACT_REQUIRES_ADMINISTRATOR';

/**
 * ONE CLASSIFICATION, MORE THAN ONE ACT (card bc5cd9f0).
 *
 * `administratorSessionOf` below answers a question — "did this request arrive
 * on the login session of somebody with administrative standing?" — that is not
 * about roles at all; the role act was simply its first caller. The second is
 * the password act, and it needs its OWN code in the ledger, because a refusal
 * indistinguishable from another act's refusal is a refusal nobody can trace.
 *
 * The alternative was a second copy of the predicate carrying different
 * constants, which is exactly the drift this module exists to prevent — its own
 * header says a sentence written three times is a sentence that can come to
 * mean three things. So the predicate stays single and the CODES become a
 * parameter.
 *
 * `ROLE_ACT` is the default, and its two codes and both its sentences are
 * unchanged to the byte: every existing caller, test and CLI hint keeps reading
 * exactly what it read before.
 */
export interface AdministratorAct {
  /** The act, as the refusal sentence names it: "Changing a role is …". */
  description: string;
  /** Refused because the request is not a login session at all. */
  requiresSession: string;
  /** Refused because the session is not an administrator's. */
  requiresAdministrator: string;
}

export const ROLE_ACT: AdministratorAct = {
  description: 'Changing a role',
  requiresSession: ROLE_ACT_REQUIRES_SESSION,
  requiresAdministrator: ROLE_ACT_REQUIRES_ADMINISTRATOR,
};

export const PASSWORD_ACT: AdministratorAct = {
  description: "Setting another Account's password",
  requiresSession: PASSWORD_ACT_REQUIRES_SESSION,
  requiresAdministrator: PASSWORD_ACT_REQUIRES_ADMINISTRATOR,
};

/**
 * THE CLASSIFICATION, AND THE ONLY COPY OF IT.
 *
 * "This request arrived on a LOGIN SESSION and presents no bearer credential."
 * Three surfaces need exactly this sentence — the Access-surface arm's
 * authentication-kind stage, this wave's role-change act, and (parked) the
 * rule-4 arm and the LENSES steward — and a sentence written three times is a
 * sentence that can come to mean three things. `middleware/sharedAuthorization`
 * delegates here rather than keeping the private copy it used to have.
 *
 * The two admitted values are the two doors a PERSON comes through: the board
 * session cookie, and the dashboard JWT the break-glass door mints. Everything
 * else is a machine credential — `principal_api_key` above all, but also the
 * legacy `x-api-key` service key and the reports-read key — and machine
 * credentials do not perform session acts (AZ-18). The test is on the
 * SERVER-DERIVED `req.authMethod` and never on a header.
 */
export function isLoginSessionKind(authMethod: string | undefined): boolean {
  return authMethod === 'session' || authMethod === 'dashboard_jwt';
}

/**
 * THE OTHER HALF: is this request PRESENTING a bearer credential?
 *
 * Not simply the negation of the above. Three owner-plane surfaces branch on it
 * POSITIVELY — `POST /delegation/agent-mints` sends a bearer caller down the
 * approval/warrant path rather than refusing it — and a question asked in the
 * affirmative deserves its own name instead of a negation that happens to
 * coincide while there are exactly two credential families.
 */
export function isBearerCredentialKind(authMethod: string | undefined): boolean {
  return authMethod === 'principal_api_key';
}

/** The classification with its refusal attached, for a handler that reports one. */
export function classifyLoginSession(
  authMethod: string | undefined,
  act: string,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (isLoginSessionKind(authMethod)) return { ok: true };
  return {
    ok: false,
    status: 403,
    code: REQUIRES_LOGIN_SESSION,
    message: `${act} is a login-session act (AZ-18): bearer credentials never perform it.`,
  };
}

/**
 * Resolve the calling identity's standing for the role-change act.
 *
 * `resolveActorRole` is passed in rather than imported so this module stays a
 * pure policy statement; every call site hands it the same function.
 */
export function administratorSessionOf(
  input: AdministratorSessionInput,
  resolveRole: (i: { handle: string; principalRole?: string | null; sessionRole?: string | null }) => string,
  act: AdministratorAct = ROLE_ACT,
): AdministratorSessionOutcome {
  if (!isLoginSessionKind(input.authMethod)) {
    // The act's OWN code, so a refused act is distinguishable in the ledger
    // from every other seam that shares the classification.
    return {
      ok: false,
      status: 403,
      code: act.requiresSession,
      message:
        `${act.description} is a login-session act (AZ-18; owner ruling 60307311 §1.2): `
        + 'sign in at the dashboard, or run `relayhall login`. Bearer credentials never perform it.',
    };
  }
  const issuerRole = resolveRole({
    handle: input.handle ?? '',
    principalRole: input.principalRole ?? null,
    sessionRole: input.sessionRole ?? null,
  });
  if (!ROLE_ACT_ISSUER_ROLES.includes(issuerRole)) {
    return {
      ok: false,
      status: 403,
      code: act.requiresAdministrator,
      message: `${act.description} requires an administrator session; this session resolves to '${issuerRole}'.`,
    };
  }
  return { ok: true, issuerRole };
}
