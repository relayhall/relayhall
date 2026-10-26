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
export const APPROVAL_DECIDE_REQUIRES_SESSION = 'APPROVAL_DECIDE_REQUIRES_SESSION';
export const APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR = 'APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR';

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
 * AZ-A9 clause 6 (ratified 2026-10-10 (E43), card 785e1eed; owner rulings
 * E15 and E43 Q1): deciding an Approval of ANY kind decided on /approvals —
 * `agent-mint`, `grant`, `credential` and each AZ-A9 follow-on kind — is open
 * to root OR an administrator login session, each with the single-use step-up
 * bound to (`approval.decide`, approval id). The administrator half is THIS
 * predicate with this act's own codes, so a refused decision is told apart in
 * the ledger from a refused role or password act. For `agent-mint`, §6.1's
 * deciders (the owning Account over its own subtree, and root) stay beside the
 * administrator arm; only grant and credential items (and the follow-on kinds)
 * reach this act's refusal, so its description names them.
 */
export const APPROVAL_DECIDE_ACT: AdministratorAct = {
  description: 'Deciding a grant or credential request',
  requiresSession: APPROVAL_DECIDE_REQUIRES_SESSION,
  requiresAdministrator: APPROVAL_DECIDE_REQUIRES_ADMINISTRATOR,
};

export const CHANGE_REQUEST_REQUIRES_SESSION = 'CHANGE_REQUEST_REQUIRES_SESSION';
export const CHANGE_REQUEST_REQUIRES_ADMINISTRATOR = 'CHANGE_REQUEST_REQUIRES_ADMINISTRATOR';

/**
 * Card 502fb19e (change-request design section 4.1, ratified by owner ruling
 * E325): the FILING tier of a login session. An administrator login session
 * may ask for anything a root session could apply (E309, "administrator
 * anything but root"), naming any Account or Group; this predicate with this
 * act's own codes is what tells it apart from an ordinary user's session. It
 * decides nothing: a filing is decided on /approvals by APPROVAL_DECIDE_ACT and
 * the ordered predicate of section 5.1.
 */
export const CHANGE_REQUEST_ACT: AdministratorAct = {
  description: 'Filing a change request for another Account or Group',
  requiresSession: CHANGE_REQUEST_REQUIRES_SESSION,
  requiresAdministrator: CHANGE_REQUEST_REQUIRES_ADMINISTRATOR,
};

export const SHARED_WRITER_REQUIRES_SESSION = 'SHARED_WRITER_REQUIRES_SESSION';
export const SHARED_WRITER_REQUIRES_ADMINISTRATOR = 'SHARED_WRITER_REQUIRES_ADMINISTRATOR';

/**
 * Card 549cc51f (owner rulings E298 Q2 (a) and E299, the F1 repair): changing
 * a knowledge source's shared-area writer list is open to root OR an
 * administrator login session, each with the single-use step-up bound to
 * (`knowledge.shared-writer.add` or `.remove`, the Account id). The
 * administrator half is THIS predicate with this act's own codes, so a refused
 * change is told apart in the ledger from every other act. No Access profile
 * reaches it: its surface is always-self and the handler decides.
 */
export const SHARED_WRITER_ACT: AdministratorAct = {
  description: 'Changing the shared-area writer list',
  requiresSession: SHARED_WRITER_REQUIRES_SESSION,
  requiresAdministrator: SHARED_WRITER_REQUIRES_ADMINISTRATOR,
};

export const AUTHORITY_EDIT_REQUIRES_SESSION = 'AUTHORITY_EDIT_REQUIRES_SESSION';
export const AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR = 'AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR';

/**
 * AUTHZ amendment AZ-A13 clause 4 (ratified 2026-10-11, E95; card 1a38270d):
 * editing a Connector credential or a warrant IN PLACE. An administrator login
 * session may save a NARROWING directly (clause 4a) and perform the one-act
 * WIDENING with a step-up bound to the object (clause 4b), under D-10's
 * act-scoped declaration of §5.2 rule 4. Root and the owning Account are
 * admitted by the edit routes beside this arm; everyone else is refused with
 * this act's own codes, so a refused edit is told apart in the ledger from a
 * refused role, password or decide act. Grants stay root-only (clause 4a).
 */
export const AUTHORITY_EDIT_ACT: AdministratorAct = {
  description: 'Editing a connection credential or a warrant in place',
  requiresSession: AUTHORITY_EDIT_REQUIRES_SESSION,
  requiresAdministrator: AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR,
};

export const GROUP_OWNER_SESSION_ONLY = 'GROUP_OWNER_SESSION_ONLY';
export const GROUP_OWNER_REQUIRES_ADMINISTRATOR = 'GROUP_OWNER_REQUIRES_ADMINISTRATOR';

/**
 * AUTHZ amendment AZ-A12 clause 9(e) (ratified 2026-10-10, E72; rulings E58
 * and E59; card 311229fd): every transfer of an object's ownership INTO, OUT
 * OF or BETWEEN Groups is open to root OR an administrator login session, each
 * with the single-use step-up bound to (`ownership.transfer`, object id). The
 * administrator half is THIS predicate with this act's own codes (E59 (a): the
 * existing administrator set, through the existing check), so a refused
 * transfer is told apart in the ledger from every other act. It is the one
 * act-scoped administrator exception clause 14 declares on §5.2 rule 4's scope
 * sentence; Group-role appointment and Group-principal enable/disable stay
 * root login-session acts (DD-12).
 */
export const GROUP_OWNERSHIP_TRANSFER_ACT: AdministratorAct = {
  description: "Transferring an object's ownership to, from or between Groups",
  requiresSession: GROUP_OWNER_SESSION_ONLY,
  requiresAdministrator: GROUP_OWNER_REQUIRES_ADMINISTRATOR,
};

export const PLUGIN_ADMIN_REQUIRES_SESSION = 'PLUGIN_ADMIN_REQUIRES_SESSION';
export const PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR = 'PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR';

/**
 * Card bedf50cc (plugin availability and settings, owner ruling E380, design
 * section 7, choices C5 and C11): setting a plugin's availability, its
 * deployment values and locks, and cleaning up stale values is an
 * administrator LOGIN-SESSION act. THIS predicate with this act's own codes,
 * and the plugin routes then also require the resolved role to be one of
 * ADMINISTRATOR_ROLES (`admin`, `operator`) as the design names them. Each
 * write burns a single-use step-up bound to (`plugin.admin`, plugin name).
 * Root BEARERS are refused (C11): plugin policy is a human-plane act, and a
 * bearer never reaches the role question.
 */
export const PLUGIN_ADMIN_ACT: AdministratorAct = {
  description: "Changing a plugin's availability or deployment settings",
  requiresSession: PLUGIN_ADMIN_REQUIRES_SESSION,
  requiresAdministrator: PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR,
};

export const KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION = 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION';
export const KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR = 'KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR';

/**
 * Card 08792425 (member N6, the core half of two-way registration; the
 * default-store design's choice C7): registering a knowledge source from an
 * installer's bundle on the Services page is open to root OR an administrator
 * LOGIN SESSION, each with the single-use step-up bound to
 * (`knowledge.source.register`, the bundle's certificate fingerprint). Every
 * bearer credential, a root bearer included, and every API key is refused with
 * this act's own session code, so the act is never reachable over MCP; the
 * administrator half is THIS predicate with this act's own codes, so a refused
 * registration is told apart in the ledger from every other act.
 */
export const KNOWLEDGE_SOURCE_REGISTER_ACT: AdministratorAct = {
  description: 'Registering a knowledge source',
  requiresSession: KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION,
  requiresAdministrator: KNOWLEDGE_SOURCE_REGISTER_REQUIRES_ADMINISTRATOR,
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
  return isStoredLoginSessionKind(authMethod) || authMethod === 'dashboard_jwt';
}

/** The cookie-backed family whose authority can be re-read in auth_sessions.
 * A dashboard JWT remains a login kind, but is not a stored session. */
export function isStoredLoginSessionKind(authMethod: string | undefined): boolean {
  return authMethod === 'session';
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
