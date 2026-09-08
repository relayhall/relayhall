// Principal + credential management (spec b48bb799 §3.3).
// Phase 1 (CB-2) delivered the read endpoints the board UI consumes; CB-5 adds
// issuance, rotation and revocation — the capability-contract primitive.
import { auditChainFor } from '../utils/auditChain';
import { pool } from '../db/connection';
import { auditService } from '../services/AuditService';
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { principalService, isMissingRelationError, type Principal } from '../services/PrincipalService';
import { grantService, GrantError } from '../services/GrantService';
import { accessProfileService } from '../services/AccessProfileService';
import { credentialLifecycleService, CredentialLifecycleError } from '../services/CredentialLifecycleService';
import { accountPasswordService } from '../services/AccountPasswordService';
import { CredentialPolicyError } from '../services/PrincipalService';
import { auditActorFromRequest } from '../utils/auditActor';
import { resolveActorRole } from '../utils/taskAutomationRole';
import {
  ASSIGNABLE_ROLES,
  ELEVATED_ROLES,
  canAssignRole,
  refusesCredentials,
  resolveIssuerAuthority,
  validateNewHandle,
  validateRequestedScopes,
} from '../utils/credentialAuthority';
import {
  PASSWORD_ACT, administratorSessionOf, classifyLoginSession, isLoginSessionKind,
} from '../utils/administratorSession';
import { homeGroupService, HomeGroupError } from '../services/HomeGroupService';
import { sendApiError } from '../utils/apiErrors';
import { delegableScopesForCaller } from '../utils/identityScopes';
import { localAdministratorHandle } from '../config/localAdministrator';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { boardEndpointFor, composeOnboardingPack } from '../utils/onboardingPack';
// 653be44f: the own-chain read model behind My connections (§3.1).
import { ownConnectorsService } from '../services/OwnConnectorsService';
import { directoryCarriageService } from '../services/DirectoryCarriageService';
import {
  compileSessionBrief, parseBriefInlineOptions, ReportReferenceLookupError,
} from '../utils/promptTemplate';
import { recordBootstrap } from '../services/McpBootstrapService';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { authorizationService } from '../services/AuthorizationService';
import { accessSurfaceService } from '../services/AccessSurfaceService';
import { ROOT_SCOPE } from '../utils/scopeMap';

/** Authority of the calling identity — see utils/credentialAuthority. */
function issuerAuthority(req: AuthRequest) {
  return resolveIssuerAuthority({
    scopes: req.scopes,
    role: resolveActorRole({
      handle: req.userId || '',
      principalRole: req.principal?.role ?? null,
      sessionRole: req.sessionRole ?? null,
    }),
  });
}

/** Guard shared by every management route; responds and returns false on deny. */
function requireManageAuthority(req: AuthRequest, res: Response) {
  const authority = issuerAuthority(req);
  if (!authority.canManage) {
    res.status(403).json({ error: 'Forbidden', message: authority.reason || 'Not permitted' });
    return null;
  }
  return authority;
}

const router = Router();

/**
 * What stands in for the credential in RE-SHOWN instructions (owner record
 * 99d6b0ad §3.1). The onboarding pack itself is one-time and never stored
 * (§7.4), so the copy block a person re-opens is rendered by the same code
 * with this literal where the token was. It is deliberately not a valid
 * credential shape: nothing can mistake it for one, and a person who pastes
 * it unchanged gets an authentication refusal rather than a silent failure.
 */
const CREDENTIAL_PLACEHOLDER = '<paste your connection credential here>';

/** The seam every role-act audit row names, success or refusal. */
const ROLE_ACT_SEAM = 'POST /principals/:id/role';

/** Public shape: never expose metadata (it can carry spawn session keys). */
function toApiPrincipal(p: {
  id: string;
  kind: string;
  handle: string;
  displayName: string | null;
  status: string;
  role: string | null;
  harness: string | null;
  personalityId: string | null;
  parentPrincipalId: string | null;
  lastSeenAt: string | null;
  metadata?: Record<string, unknown>;
}) {
  const provenance = p.metadata?.configured === true
    ? 'environment'
    : p.metadata?.bootstrap === true
      ? 'bootstrap'
      : 'managed';
  return {
    id: p.id,
    kind: p.kind,
    handle: p.handle,
    displayName: p.displayName,
    status: p.status,
    role: p.role,
    harness: p.harness,
    personalityId: p.personalityId,
    parentPrincipalId: p.parentPrincipalId,
    lastSeenAt: p.lastSeenAt,
    provenance,
  };
}

// GET /principals — list configured principals. Hidden compatibility rows are
// available only to callers with management authority.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const includeHidden = req.query.includeHidden === 'true' || req.query.includeHidden === '1';
    if (includeHidden && !requireManageAuthority(req, res)) return;
    const principals = await principalService.listPrincipals(includeHidden);
    res.json({ success: true, principals: principals.map(toApiPrincipal) });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] Error listing principals:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'PRINCIPALS_READ_FAILED', message: 'Failed to list principals', errorId });
  }
});

// GET /principals/me — the caller's resolved principal. Legacy identities that
// have no principal row (unknown-handle JWTs, pre-migration DB) get a 404, not
// an error: absence is a valid, expected state until CB-8 flips
// RELAYHALL_AUTH_REQUIRE_PRINCIPAL.
router.get('/me', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }

  // Card `d0f030a9`. WHICH SETTINGS NAVIGATION ENTRIES THIS SESSION MAY SEE,
  // decided by the Access-surface arm itself (`armDecision`) and not by any
  // rule the frontend keeps. It rides on this route rather than on one of its
  // own for the same reason `delegableScopes` does: the shell already reads
  // `/principals/me` on mount, and a second definition of an authorization
  // predicate is the thing being avoided.
  //
  // A FAILURE HERE MUST NOT 500 THIS ROUTE. `/principals/me` is what the whole
  // authenticated app boots on, and an unreachable catalogue must degrade to a
  // signed-in board, not to a login loop. `null` is the documented "the board
  // did not answer" shape — the shell then falls back to the pre-SETGOV
  // root gate, which is strictly NARROWER than the arm on every entry, so the
  // degraded direction is the closed one.
  let settingsSurfaces: Awaited<ReturnType<typeof accessSurfaceService.settingsSurfaces>> | null = null;
  // The correlation id of a degraded answer. `logCaughtFailure` mints one and
  // the request path may not DISCARD it (review `3db17273` r3 B2/B3): a
  // degraded field with no id is a support ticket nobody can trace. It rides
  // in the envelope beside the `null` it explains, and is `null` whenever the
  // menu resolved — so its presence IS the statement that this answer is
  // degraded, rather than a comment claiming it might be.
  let settingsSurfacesErrorId: string | null = null;
  try {
    settingsSurfaces = await accessSurfaceService.settingsSurfaces({
      principalId: req.principal.id,
      authMethod: req.authMethod,
      // The ROUTE STAGE's own decision, asked of the same service the stage
      // asks — never re-derived from `scopes.includes('root')` here.
      rootAuthorized: authorizationService.authorizeRoute(actorFromRequest(req), ROOT_SCOPE).allowed,
    });
  } catch (e) {
    settingsSurfacesErrorId = logCaughtFailure('[Principals API] settings-surface menu not resolved:', e);
  }

  res.json({
    settingsSurfaces,
    settingsSurfacesErrorId,
    success: true,
    principal: toApiPrincipal(req.principal),
    scopes: req.scopes ?? null,
    // Card 6e25ae48. `scopes` is what this caller may REACH; this is what it
    // may hand to a bearer credential, and for an administrator the two differ
    // by the whole flow: `root` is reachable and never delegable. Answered by
    // the server so the connection surfaces do not have to mirror the scope
    // catalogue to work it out.
    //
    // It reads the AUTHENTICATION KIND and not only the scope set (round-1
    // finding B3, verdict `7cce6577`): this route answers bearer callers too,
    // and neither issuance surface will take one that does not hold `root`. A
    // field naming what a caller may delegate must be empty when the answer is
    // nothing — see `utils/identityScopes.delegableScopesForCaller`.
    delegableScopes: delegableScopesForCaller(req.authMethod, req.scopes),
  });
});

// GET /principals/me/effective-access — the SELF preview (AZ-S2, design
// 4d961e37 §9.2/§9.5): the caller's own object-authority sources —
// direct grants, group grants, and published profile rules reached
// directly or through group assignment. Agent-plane by the /principals/me
// principals:read rule; the cross-principal what-if lives on
// /access-profiles/what-if (owner plane).
/**
 * POST /principals/me/brief — the SESSION ALTITUDE of the Brief family
 * (vocabulary `b94dd86e` §3; strategy `4e40f06f` §2.10; RH-P3.C4 subtask [2]).
 *
 * Returns the complete working context for the identity this credential acts
 * as — personality inlined, the bound Task's attached Reports, the granted
 * skill index and the board-workflow doctrine — assembled server-side as ONE
 * payload.
 *
 * IT IS ALSO THE ONE PLACE THE BOOTSTRAP RECORD IS WRITTEN. The MCP bootstrap
 * verb composes this route rather than reimplementing it, so "has bootstrapped"
 * means exactly one thing on both surfaces: this identity was handed its
 * working context. Recording it anywhere else would let the two drift, and a
 * gate whose precondition can be satisfied two ways is a gate with two
 * definitions.
 *
 * The record is written AFTER the compile succeeds. A Brief that failed closed
 * was never delivered, and marking a credential bootstrapped on a payload it
 * did not receive would turn the control into a formality.
 */
router.post('/me/brief', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal || !req.credentialId) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }
  const parsed = parseBriefInlineOptions(req.body);
  if (!parsed.ok) {
    res.status(400).json({ success: false, code: parsed.code, error: parsed.error });
    return;
  }
  try {
    const found = await principalService.getCredentialWithPrincipal(req.credentialId);
    if (!found) {
      res.status(404).json({ error: 'Not Found', message: 'No credential resolved for this identity' });
      return;
    }
    const brief = await compileSessionBrief(
      {
        principal: req.principal,
        credential: {
          id: req.credentialId,
          scopes: Array.isArray(req.scopes) ? req.scopes : [],
          transport: String(found.credential.transport ?? 'any'),
          expiresAt: found.credential.expiresAt ? String(found.credential.expiresAt) : null,
        },
      },
      {
        actor: req.authorizationActor ?? actorFromRequest(req),
        inlineReports: parsed.inlineReports,
        tokenBudget: parsed.tokenBudget,
      },
    );
    const record = await recordBootstrap(req.credentialId);
    res.json({
      success: true,
      brief,
      principalId: req.principal.id,
      credentialId: req.credentialId,
      bootstrappedUntil: record.expiresAt,
      tokenEstimate: Math.ceil(brief.length / 4),
    });
  } catch (err) {
    if (err instanceof ReportReferenceLookupError) {
      // The same fail-closed contract the task altitude carries: a Brief
      // silently missing references the caller is entitled to is not a
      // success, and a credential is not marked bootstrapped on one.
      const errorId = logCaughtFailure('[Principals API] Referenced-report lookup failed while compiling a session brief:', err);
      res.status(503).json({
        success: false,
        errorId,
        error: 'The Brief could not establish this identity\'s attached reports',
        code: 'REPORT_REFERENCE_LOOKUP_FAILED',
        message: 'The Brief could not establish this identity\'s attached reports; refusing to compile without them',
      });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] session brief failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'SESSION_BRIEF_FAILED', message: 'Failed to compile the session brief', errorId });
  }
});

router.get('/me/effective-access', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }
  try {
    const access = await accessProfileService.effectiveAccess(req.principal.id);
    res.json({ success: true, access });
  } catch (e) {
    const errorId = logCaughtFailure('[Principals API] effective-access failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'EFFECTIVE_ACCESS_FAILED', message: 'Failed to compute effective access', errorId });
  }
});


// ── RH-LENSES-b (card 4287af8a) · THE HOME GROUP ────────────────────────────
//
// Design 96f0bd3d s7.2. The stored row is a POINTER; `homeGroup(a)` is DERIVED
// at read (derivation D-L2) and resolves only while the Group is `featured`,
// the Account is a member of it, and the Account is `active`. There is no
// cleanup trigger, so an unresolving pointer SURVIVES and starts resolving
// again the moment the condition that broke it is restored - with no re-write.
//
// These routes are registered ABOVE the `/principals/:id` family below so the
// literal `me` segment never resolves as a principal id.

function sendHomeGroupError(res: Response, e: unknown): boolean {
  if (e instanceof HomeGroupError) {
    sendApiError(res, e.status, e.code, e.message, undefined, e.field ? { field: e.field } : undefined);
    return true;
  }
  return false;
}

/** GET /principals/me/home-group - the RESOLVED value, the raw pointer, and
 *  why it does not resolve when it does not (`authenticated`). */
router.get('/me/home-group', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }
  try {
    res.json({ success: true, homeGroup: await homeGroupService.view(req.principal.id) });
  } catch (e) {
    if (sendHomeGroupError(res, e)) return;
    const errorId = logCaughtFailure('[Principals API] read home group failed:', e);
    sendApiError(res, 500, 'HOME_GROUP_READ_FAILED', 'Failed to read the home group', undefined, { errorId });
  }
});

/** PUT /principals/me/home-group - the person chooses among their featured
 *  groups (owner decision 3). Writes `source='self'`; confers nothing. */
router.put('/me/home-group', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (key !== 'groupId') {
        sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' - accepted fields are: groupId`);
        return;
      }
    }
    const homeGroup = await homeGroupService.set(
      req.principal.id, body.groupId, 'self', auditActorFromRequest(req));
    res.json({ success: true, homeGroup });
  } catch (e) {
    if (sendHomeGroupError(res, e)) return;
    const errorId = logCaughtFailure('[Principals API] set home group failed:', e);
    sendApiError(res, 500, 'HOME_GROUP_SET_FAILED', 'Failed to set the home group', undefined, { errorId });
  }
});

/** DELETE /principals/me/home-group - clears the pointer. Clearing an absent
 *  pointer is a no-op, not a 404: the caller's stated end state is reached. */
router.delete('/me/home-group', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }
  try {
    const homeGroup = await homeGroupService.clear(req.principal.id, auditActorFromRequest(req));
    res.json({ success: true, homeGroup });
  } catch (e) {
    if (sendHomeGroupError(res, e)) return;
    const errorId = logCaughtFailure('[Principals API] clear home group failed:', e);
    sendApiError(res, 500, 'HOME_GROUP_CLEAR_FAILED', 'Failed to clear the home group', undefined, { errorId });
  }
});

/**
 * PUT /principals/{id}/home-group - an administrator sets it FOR an Account
 * (owner decision 3). Writes `source='admin'`.
 *
 * CEILING: `principals:admin` from the `/principals` family rule, NARROWED here
 * to a ROOT LOGIN SESSION. Both resolved root and the login-session kind
 * are enforced below. The design writes this route's ceiling as
 * "principals:admin + root session (rule 4)"; the rule-4 arm is parked post-v1
 * (owner ruling 60307311 s1.4), but the session-versus-bearer classification is
 * not parked - it LANDED at `utils/administratorSession.ts` and is IMPORTED
 * here, never re-implemented (obligation B-L19's direction of reuse). Requiring
 * a login session can only narrow this surface, never widen it, and a bearer
 * credential setting another person's home group is exactly the machine act
 * AZ-18 refuses.
 */
router.put('/:id/home-group', async (req: AuthRequest, res: Response): Promise<void> => {
  const session = classifyLoginSession(req.authMethod, "Setting another Account's home group");
  if (!session.ok) {
    sendApiError(res, session.status, session.code, session.message);
    return;
  }
  if (!req.scopes?.includes('root')) {
    sendApiError(res, 403, 'ROOT_SESSION_REQUIRED', "Setting another Account's home group requires a root login session");
    return;
  }
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (key !== 'groupId') {
        sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' - accepted fields are: groupId`);
        return;
      }
    }
    const homeGroup = await homeGroupService.set(
      req.params.id, body.groupId, 'admin', auditActorFromRequest(req));
    res.json({ success: true, homeGroup });
  } catch (e) {
    if (sendHomeGroupError(res, e)) return;
    const errorId = logCaughtFailure('[Principals API] set home group (admin) failed:', e);
    sendApiError(res, 500, 'HOME_GROUP_SET_FAILED', 'Failed to set the home group', undefined, { errorId });
  }
});
// GET /principals/me/directory-group-references — the caller's OWN carriage
// (RH-LENSES-a, card 74e02a05; design 07764243 §5.3, owner record 99d6b0ad
// §4's "Directory groups (N)" on a person's profile).
//
// Concealment is STRUCTURAL, exactly as it is for `/me/connectors` below:
// the route takes no id, so there is nothing to guess, and the query is
// anchored on the caller's own principal. Members never learn other
// people's group lists, which is the second half of owner decision 5.
//
// It confers nothing and discloses nothing new about authority: a carriage
// row is an observation the Identity provider made about this very person,
// and whether it reaches a Group is already visible to them in their own
// group memberships.
router.get('/me/directory-group-references', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }
  try {
    const references = await directoryCarriageService.listOwnCarriage(req.principal.id);
    res.json({ success: true, references });
  } catch (e) {
    const errorId = logCaughtFailure('[Principals API] own directory group references failed:', e);
    res.status(500).json({
      error: 'Internal Server Error',
      code: 'DIRECTORY_GROUP_REFERENCES_FAILED',
      message: 'Failed to read your directory group references',
      errorId,
    });
  }
});

// GET /principals/me/connectors — the caller's OWN Connector chain (card
// 653be44f; owner design record 99d6b0ad §3.1; AUTHZ 4d961e37 §9.2).
//
// The read model behind "My connections" and the day-one flow's empty state:
// every Connector this Account created, its credentials (never a secret), and
// the Agents minted beneath each. It adds NO authority — the rows are the same
// ones `GET /principals` and the AZ-S4 own-subtree credential listing already
// disclose to a `principals:read` caller; this route only narrows them to the
// caller's own subtree and joins the paired registry row.
//
// Concealment is STRUCTURAL: the route takes no id, so there is nothing to
// guess, and the query is anchored on `parent_principal_id = <the caller>`.
// Another Account's Connectors, Agents and Warrants are unreachable here by
// construction rather than by a check that could be forgotten.
//
// The re-showable instructions ride along (owner record §3.1: "endpoints and
// instructions re-shown any time (not secret)"). They are composed by the SAME
// renderer that builds the one-time onboarding pack (§7.4), with the credential
// replaced by a named placeholder — so the instructions a person re-reads can
// never drift from the ones the pack handed them, and the secret is not in the
// response.
router.get('/me/connectors', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.principal) {
    res.status(404).json({ error: 'Not Found', message: 'No principal resolved for this identity' });
    return;
  }
  try {
    const connectors = await ownConnectorsService.listForAccount(req.principal.id);
    const endpoint = boardEndpointFor(req);
    const instructionPack = composeOnboardingPack({
      endpoint,
      credential: {
        credentialId: '',
        keyId: '',
        secretOnce: CREDENTIAL_PLACEHOLDER,
        expiresAt: null,
        transport: 'any',
      },
      scopes: [],
      rules: [],
    });
    res.json({
      success: true,
      connectors,
      instructions: {
        boardEndpoint: instructionPack.boardEndpoint,
        bootstrapLine: instructionPack.bootstrapLine,
        mcpConfig: instructionPack.mcpConfig,
        cliEnv: instructionPack.cliEnv,
        previewPath: instructionPack.previewPath,
        credentialPlaceholder: CREDENTIAL_PLACEHOLDER,
      },
    });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] own-connector listing failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'OWN_CONNECTORS_READ_FAILED', message: 'Failed to list your connectors', errorId });
  }
});

// GET /principals/remediation-queue — the §10 Access-manager remediation
// queue (AZ-S4, design 4d961e37 §10, sol M9; owner plane — root by the
// scope map): every legacy_identity row (frozen out of the new machinery,
// evaluated under the Phase-2 arms until the owner-executed Phase-5
// transition) and every parentless service Account still carrying the
// 'LEGACY - pending owner review' purpose backfill, with live-credential
// counts so the owner can sequence the replacement work.
router.get('/remediation-queue', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    // AZ-30 / AZ-A4 clause 2 (RH-P5.SSO.W4): the deprovision-detected flag is
    // "surfaced in the Access manager", and this queue is where the Access
    // manager surfaces what needs a human. A directory-provisioned Account
    // whose Identity provider signalled deprovision joins it, with the signal
    // named, until the directory re-enables it or the owner acts.
    const result = await pool.query(
      `SELECT p.id, p.kind, p.handle, p.display_name, p.status, p.role, p.purpose,
              p.legacy_identity, p.parent_principal_id, p.created_at,
              d.deprovision_signal, d.deprovisioned_at, d.identity_provider_id,
              (SELECT COUNT(*)::int FROM principal_credentials c
                WHERE c.principal_id = p.id AND c.revoked_at IS NULL
                  AND (c.expires_at IS NULL OR c.expires_at > NOW())) AS live_credentials
         FROM principals p
         LEFT JOIN directory_provisioned_accounts d ON d.account_principal_id = p.id
        WHERE p.legacy_identity = TRUE
           OR (p.parent_principal_id IS NULL AND p.kind = 'service'
               AND p.purpose = 'LEGACY - pending owner review')
           OR d.deprovision_signal IS NOT NULL
        ORDER BY p.legacy_identity DESC, d.deprovisioned_at DESC NULLS LAST, p.created_at ASC`,
    );
    res.json({
      success: true,
      queue: result.rows.map((row) => ({
        principalId: String(row.id),
        kind: row.kind,
        handle: String(row.handle),
        displayName: row.display_name ?? null,
        status: row.status,
        role: row.role ?? null,
        purpose: row.purpose ?? null,
        legacyIdentity: Boolean(row.legacy_identity),
        parented: Boolean(row.parent_principal_id),
        liveCredentials: Number(row.live_credentials ?? 0),
        deprovisionSignal: row.deprovision_signal ?? null,
        deprovisionedAt: row.deprovisioned_at ? new Date(row.deprovisioned_at).toISOString() : null,
        identityProviderId: row.identity_provider_id ? String(row.identity_provider_id) : null,
        reason: row.deprovision_signal
          ? `deprovision detected by the directory (${String(row.deprovision_signal)}): the Account was auto-disabled (AZ-A4 clause 2) — confirm the offboarding, or re-enable the person at the Identity provider`
          : row.legacy_identity
            ? 'legacy_identity: pre-096 shape on the §10 compatibility arm — replace with a login session or a delegated Connector at the Phase-5 transition'
            : 'purpose backfill pending owner review (sol M9)',
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] remediation queue failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'REMEDIATION_QUEUE_FAILED', message: 'Failed to read the remediation queue', errorId });
  }
});

// ── Management (CB-5) ───────────────────────────────────────────────────────

// POST /principals — create a human, service, or agent identity.
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireManageAuthority(req, res)) return;
  try {
    const handleCheck = validateNewHandle(req.body?.handle);
    if (!handleCheck.ok) {
      res.status(400).json({ error: 'Bad Request', message: handleCheck.error });
      return;
    }
    const kind = req.body?.kind;
    if (kind !== 'human' && kind !== 'service' && kind !== 'agent') {
      res.status(400).json({ error: 'Bad Request', message: "kind must be 'human', 'service' or 'agent'" });
      return;
    }
    if (kind === 'agent') {
      // A17.3/AZ-S3: Agent identities are task-bounded layer-3 rows minted
      // ONLY through the delegation machinery (AZ-S5); POST /principals
      // creates Accounts. Under scoping note 1 this refusal IS the S3 T11
      // defense, so it is a mint refusal governed by §5.2 rule 8 and is
      // durably audited — the attempt creates no row to chain to, so the
      // acting actor and the requested handle are recorded (review
      // 70aca6f8 B1).
      await auditService.record({
        action: 'credential.mint', actor: auditActorFromRequest(req), outcome: 'denied',
        resourceType: 'principal', resourceId: null,
        metadata: { refusal: 'AGENT_MINT_ONLY', requestedHandle: req.body?.handle ?? null, requestedKind: 'agent', chain: [] },
      }).catch(() => undefined);
      res.status(422).json({ error: 'Unprocessable Entity', code: 'AGENT_MINT_ONLY', message: 'Agent identities arrive through the delegation machinery (design 4d961e37 §3); POST /principals creates Accounts' });
      return;
    }
    const purpose = typeof req.body?.purpose === 'string' ? req.body.purpose.trim() : '';
    if (kind === 'service' && !purpose) {
      // A17.1: service Accounts MUST declare a purpose at creation.
      res.status(422).json({ error: 'Unprocessable Entity', code: 'PURPOSE_REQUIRED', message: 'service Accounts must declare a purpose at creation (design 4d961e37 A17.1)' });
      return;
    }
    if (purpose.length > 500) {
      res.status(422).json({ error: 'Unprocessable Entity', code: 'INVALID_PURPOSE', message: 'purpose must be at most 500 characters' });
      return;
    }
    // Role is the other escalation axis: resolveActorRole reads
    // principals.role, so creating an admin principal and issuing it a key
    // would route around the scope ceiling entirely.
    const requestedRole = typeof req.body?.role === 'string' ? req.body.role : null;
    const issuerRole = resolveActorRole({
      handle: req.userId || '',
      principalRole: req.principal?.role ?? null,
      sessionRole: req.sessionRole ?? null,
    });
    if (!canAssignRole(issuerRole, requestedRole)) {
      res.status(400).json({
        error: 'Bad Request',
        message: `Cannot assign role '${requestedRole}' — unknown role, or above your own authority`,
      });
      return;
    }

    const created = await principalService.createPrincipal({
      purpose: purpose || null,
      handle: handleCheck.handle,
      kind,
      displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : null,
      role: requestedRole,
    });
    if (!created) {
      res.status(409).json({ error: 'Conflict', message: 'A principal with that handle already exists' });
      return;
    }
    res.status(201).json({ success: true, principal: toApiPrincipal(created) });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] create failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'PRINCIPAL_CREATE_FAILED', message: 'Failed to create principal', errorId });
  }
});

// PATCH /principals/:id — display name and enable/disable.
// Disabling is the kill switch: authenticateCbKey already refuses any
// credential whose principal is not active, so this invalidates every key the
// principal holds without touching the credential rows.
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireManageAuthority(req, res)) return;
  try {
    const status = req.body?.status;
    if (status !== undefined && status !== 'active' && status !== 'disabled') {
      res.status(400).json({ error: 'Bad Request', message: "status must be 'active' or 'disabled'" });
      return;
    }
    const target = await principalService.getPrincipalById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Not Found', message: 'Principal not found' });
      return;
    }
    if (target.handle === 'system' && status === 'disabled') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'The system principal cannot be disabled — internal writes depend on it',
      });
      return;
    }
    // Now that disable is enforced on the JWT path too, disabling the owner's
    // identity would lock her out of the dashboard with no in-band way back.
    // Locking the owner out is the worst outcome this lane can produce (R11),
    // so it is not reachable through the API; it remains possible directly in
    // the database if it is ever genuinely wanted.
    if (target.handle === 'dashboard_user' && status === 'disabled') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'The owner principal cannot be disabled through the API — this is the dashboard login identity',
      });
      return;
    }
    const updated = await principalService.updatePrincipal(req.params.id, {
      displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : undefined,
      status,
    });
    res.json({ success: true, principal: updated ? toApiPrincipal(updated) : null });
  } catch (err) {
    const errorId = logCaughtFailure('[Principals API] update failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'PRINCIPAL_UPDATE_FAILED', message: 'Failed to update principal', errorId });
  }
});

/**
 * THE ROLE-CHANGE ACT — POST /principals/:id/role
 * (owner ruling `60307311` §1.2; absorbs card `f98ed951`).
 *
 * An audited owner-plane act that changes ONE principal's role, and the only
 * one: `PATCH /principals/:id` deliberately still accepts `displayName` and
 * `status` and nothing else, so the role axis has exactly one door and that
 * door is this one.
 *
 * ── WHO ──
 *
 * An ADMINISTRATOR SESSION, never a bearer credential (AZ-18). The predicate
 * is `administratorSessionOf`, shared with the CLI's error text and the
 * Access manager's control, and it is the same authentication-kind dispatch
 * the owner plane already uses in `middleware/sharedAuthorization.ts`,
 * `routes/warrants.ts` and `routes/delegation.ts`. An `rh_` principal
 * credential — root-scoped or not — is refused by name, and so is the legacy
 * service key and the reports-read key: they are not sessions.
 *
 * This is deliberately NOT `requireManageAuthority`. That guard demands the
 * `root` scope, which `operator` does not hold, and the ruling names operators
 * as administrators. What an operator may ASSIGN is bounded below.
 *
 * ── WHAT ──
 *
 * `canAssignRole` — the SAME ceiling `POST /principals` applies at creation
 * (`credentialAuthority.ts:30-39`), not a second ordering invented here — so
 * the two doors onto the role axis can never disagree. It refuses every value
 * outside `ASSIGNABLE_ROLES`, which is how "never `root`" is enforced: `root`
 * is the global SCOPE sentinel and not a role at all, and the two roles that
 * DERIVE it (`admin`, `orchestrator`) are assignable only by an `admin`
 * issuer.
 *
 * Four further refusals, each because the state it prevents is worse than the
 * convenience it costs:
 *
 *  - THE ACTOR'S OWN ROW. No self-promotion, and no self-demotion either: the
 *    second is how an administrator locks the deployment out of its own
 *    Access manager in one request.
 *  - THE `system` PRINCIPAL, the request-less internal actor that already
 *    holds no credential and cannot be disabled (`refusesCredentials`).
 *  - THE NAMED LOCAL ADMINISTRATOR. `PATCH /principals/:id` already refuses to
 *    DISABLE it, because "locking the owner out is the worst outcome this lane
 *    can produce (R11)"; demoting it to `viewer` is the same outcome by a
 *    different verb, since the break-glass token's authority resolves through
 *    `principals.role`. Fixed here for the same reason and by symmetry.
 *  - AN ELEVATED ROLE ON ANYTHING BUT A PARENTLESS HUMAN ACCOUNT. Migration
 *    `096`'s CHECK already refuses a parented one; the kind test is the half
 *    the schema does not carry. Without it, an administrator could promote a
 *    legacy parentless SERVICE row — one that DOES hold `rh_` bearer keys — to
 *    `admin`, and every key it holds would derive the `root` sentinel on the
 *    next request. That is a bearer credential with owner authority, which is
 *    precisely what AUTHZ §7.1 forbids.
 *
 * ── WHEN IT BITES ──
 *
 * Immediately: on the target's NEXT REQUEST, not at their next login.
 * `auth_sessions.role_snapshot` is declared RETAINED, UNUSED (migration
 * `062:61`) and a repo-wide census finds no writer, so `resolveActorRole`
 * falls through to `principals.role` for every live session. The one thing
 * that could delay it is `PrincipalService`'s 60-second read cache, which
 * `updatePrincipal` refreshes as it writes. The response says so rather than
 * leaving the caller to guess.
 */
router.post('/:id/role', async (req: AuthRequest, res: Response): Promise<void> => {
  const deny = async (status: number, code: string, message: string, targetId: string | null): Promise<void> => {
    await auditService.record({
      action: 'principal.role.changed', actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: 'principal', resourceId: targetId,
      metadata: { refusal: code, requestedRole: typeof req.body?.role === 'string' ? req.body.role : null, seam: ROLE_ACT_SEAM },
    }).catch(() => undefined);
    res.status(status).json({ error: status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : status === 422 ? 'Unprocessable Entity' : 'Forbidden', code, message });
  };

  try {
    const session = administratorSessionOf({
      authMethod: req.authMethod,
      handle: req.userId,
      principalRole: req.principal?.role ?? null,
      sessionRole: req.sessionRole ?? null,
    }, resolveActorRole);
    if (!session.ok) {
      await deny(session.status, session.code, session.message, null);
      return;
    }

    // The identifier is caller data on a route whose column is a canonical
    // `uuid`: a malformed value is a 404, never a driver error.
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      await deny(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found', null);
      return;
    }

    const requestedRole = typeof req.body?.role === 'string' ? req.body.role.trim() : '';
    if (!requestedRole) {
      await deny(400, 'ROLE_REQUIRED', 'role is required', req.params.id);
      return;
    }
    if (!ASSIGNABLE_ROLES.has(requestedRole)) {
      await deny(400, 'UNKNOWN_ROLE',
        `'${requestedRole}' is not a role. Assignable roles: ${[...ASSIGNABLE_ROLES].sort().join(', ')}.`,
        req.params.id);
      return;
    }

    const target = await principalService.getPrincipalById(req.params.id);
    if (!target) {
      await deny(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found', req.params.id);
      return;
    }

    if (req.principal?.id && req.principal.id === target.id) {
      await deny(403, 'SELF_ROLE_CHANGE_REFUSED',
        'An administrator does not change their own role — ask another administrator.',
        target.id);
      return;
    }
    if (refusesCredentials(target.handle)) {
      await deny(422, 'PRINCIPAL_REFUSES_ROLE_CHANGE',
        `'${target.handle}' is the request-less internal actor and carries no assignable role`,
        target.id);
      return;
    }
    if (target.handle === localAdministratorHandle()) {
      await deny(422, 'LOCAL_ADMINISTRATOR_ROLE_FIXED',
        'The named local administrator is the break-glass identity; its role is fixed so the deployment always has a way back in (the same rule that refuses to disable it).',
        target.id);
      return;
    }
    if (!canAssignRole(session.issuerRole, requestedRole)) {
      await deny(403, 'ROLE_ABOVE_YOUR_AUTHORITY',
        `Cannot assign role '${requestedRole}' — it is above your own authority ('${session.issuerRole}').`,
        target.id);
      return;
    }
    if (ELEVATED_ROLES.has(requestedRole) && (target.kind !== 'human' || target.parentPrincipalId !== null)) {
      await deny(422, 'ELEVATED_ROLE_REQUIRES_ACCOUNT',
        `An elevated role belongs only to a parentless human Account; '${target.handle}' is a ${target.kind}${target.parentPrincipalId ? ' with a parent' : ''} (design 4d961e37 §7.1; migration 096 principals_elevated_parentless).`,
        target.id);
      return;
    }

    const previousRole = target.role;

    // THE WRITE AND ITS LEDGER ROW COMMIT TOGETHER, OR NEITHER DOES (review
    // verdict 2c284891 B2). Before this, the UPDATE autocommitted and the audit
    // row followed on its own connection: a ledger that rejected left the role
    // CHANGED and told the caller the act had failed — the worst of both, and a
    // direct contradiction of the promise in `docs/principals.md` that every
    // attempt is audited. The first-run act next door was already written this
    // way; this is the same discipline, applied where it was missing.
    //
    // The REFUSALS above deliberately keep their fire-and-forget audit: they
    // change nothing, so a ledger outage must not convert a refusal into a 500 —
    // the caller is refused either way, which is the safe direction.
    const client = await pool.connect();
    let updated: Principal | undefined;
    try {
      await client.query('BEGIN');
      updated = await principalService.updatePrincipal(target.id, { role: requestedRole }, client);
      if (!updated) {
        await client.query('ROLLBACK');
        await deny(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found', target.id);
        return;
      }
      await auditService.record({
        action: 'principal.role.changed', actor: auditActorFromRequest(req),
        resourceType: 'principal', resourceId: updated.id,
        metadata: {
          targetHandle: updated.handle,
          before: previousRole,
          after: updated.role,
          issuerRole: session.issuerRole,
          seam: ROLE_ACT_SEAM,
        },
      }, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    // Only now: the row is committed, so publishing it cannot advertise a
    // change that rolled back.
    principalService.cachePrincipal(updated);

    res.json({
      success: true,
      principal: toApiPrincipal(updated),
      previousRole,
      // Stated because the obvious guess is wrong in both directions: it is
      // not "at next login" (no login path writes a role snapshot) and it is
      // not "instantly for requests already in flight".
      effectiveFrom: 'next-request',
      note: `${updated.handle} carries the role '${updated.role}' from their next request; no re-login is required.`,
    });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] role change failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'ROLE_CHANGE_FAILED', message: 'Failed to change the role', errorId });
  }
});

// GET /principals/:id/credentials — never includes secrets. A caller may
// introspect its OWN grants with principals:read (A12.5 / §5.2: introspection
// is agent-plane-readable); listing another principal's credentials remains a
// management action.
router.get('/:id/credentials', async (req: AuthRequest, res: Response): Promise<void> => {
  const isOwn = req.principal?.id != null && req.principal.id === req.params.id;
  // AZ-S4 (design §9.2 self-service subtree; review 1897c959 B3): an
  // authenticated LOGIN SESSION introspects the credentials of its OWN
  // descendant subtree — the owning Account sees its Connectors' and
  // Agents' rows (secrets excluded; reveal keeps its own step-up gate).
  // Bearer callers keep the pre-S4 own/manage split.
  const inSubtree = !isOwn && isLoginSessionKind(req.authMethod) && req.principal?.id != null
    && /^[0-9a-f-]{36}$/i.test(req.params.id)
    && await credentialLifecycleService.isDescendant(req.principal.id, req.params.id);
  if (!isOwn && !inSubtree && !requireManageAuthority(req, res)) return;
  try {
    const credentials = await principalService.listCredentials(req.params.id);
    res.json({ success: true, credentials });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] credential list failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'CREDENTIALS_READ_FAILED', message: 'Failed to list credentials', errorId });
  }
});

// GET /principals/:id/grants — a principal's object-level grants (RH-P2.3).
// Same introspection split as credentials: OWN grants at principals:read
// (A12.5 — introspection is agent-plane-readable), another principal's
// grants behind the manage gate. Grant MUTATION never lives here — it is
// owner-plane on /grants (§2.9).
router.get('/:id/grants', async (req: AuthRequest, res: Response): Promise<void> => {
  const isOwn = req.principal?.id != null && req.principal.id === req.params.id;
  if (!isOwn && !requireManageAuthority(req, res)) return;
  try {
    const grants = await grantService.grantsFor(req.params.id);
    res.json({ success: true, grants });
  } catch (err) {
    if (err instanceof GrantError) {
      res.status(err.status).json({ error: 'Bad Request', message: err.message });
      return;
    }
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Grants substrate is not migrated yet' });
      return;
    }
    // Secret-safe sink (P2.1/P2.2 standard): fixed text + bounded category.
    const errorId = logCaughtFailure('[Principals API] grant introspection failed', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'GRANTS_READ_FAILED', message: 'Failed to list grants', errorId });
  }
});

// POST /principals/:id/credentials — mint a key. The full key appears in this
// response and nowhere else, ever: not in a log line, not in any later read.
router.post('/:id/credentials', async (req: AuthRequest, res: Response): Promise<void> => {
  const authority = requireManageAuthority(req, res);
  if (!authority) return;
  try {
    const target = await principalService.getPrincipalById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Not Found', message: 'Principal not found' });
      return;
    }
    // The three refusals (spec §3.3) — each audited as a denied
    // credential.mint with the affected chain (§5.2 rule 8, review
    // 731415a7 B4).
    const auditMintDenial = async (refusal: string): Promise<void> => {
      await auditService.record({
        action: 'credential.mint', actor: auditActorFromRequest(req), outcome: 'denied',
        resourceType: 'principal', resourceId: target.id,
        metadata: { refusal, chain: await auditChainFor(pool, target.id) },
      }).catch(() => undefined);
    };
    if (refusesCredentials(target.handle)) {
      await auditMintDenial('SYSTEM_PRINCIPAL');
      res.status(400).json({ error: 'Bad Request', message: 'The system principal cannot hold credentials' });
      return;
    }
    if (target.status !== 'active') {
      await auditMintDenial('PRINCIPAL_NOT_ACTIVE');
      res.status(400).json({ error: 'Bad Request', message: 'Cannot issue credentials for a disabled principal' });
      return;
    }
    const scopeCheck = validateRequestedScopes(req.body?.scopes, authority);
    if (!scopeCheck.ok) {
      await auditMintDenial('INVALID_SCOPES');
      res.status(400).json({ error: 'Bad Request', message: scopeCheck.error });
      return;
    }

    let expiresAt: Date | null = null;
    if (req.body?.expiresAt) {
      const parsed = new Date(req.body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: 'Bad Request', message: 'expiresAt must be an ISO timestamp' });
        return;
      }
      if (parsed.getTime() <= Date.now()) {
        await auditMintDenial('INVALID_EXPIRY');
        res.status(400).json({ error: 'Bad Request', message: 'expiresAt must be in the future' });
        return;
      }
      expiresAt = parsed;
    }

    const transport = req.body?.transport === undefined ? 'any' : req.body.transport;
    if (!['any', 'mcp', 'api'].includes(transport)) {
      await auditMintDenial('INVALID_TRANSPORT');
      res.status(400).json({ error: 'Bad Request', message: "transport must be 'any', 'mcp' or 'api' (§7.5)" });
      return;
    }
    const issued = await principalService.issueCredential({
      principalId: target.id,
      scopes: scopeCheck.scopes,
      label: typeof req.body?.label === 'string' ? req.body.label : null,
      expiresAt,
      transport,
      createdByPrincipalId: req.principal?.id ?? null,
    }, auditActorFromRequest(req));

    // Deliberately no logging of issued.fullKey on any path.
    console.log(`[Principals API] issued credential ${issued.keyId} for ${target.handle} (${scopeCheck.scopes.join(', ')})`);
    // §7.4 (RH-P3.AZ-S5, sol m11): a CONNECTOR credential issuance carries
    // the one-time onboarding pack — board endpoint, MCP snippets, the
    // §2.10 bootstrap line, CLI env and the authority summary. Rendered
    // once, never stored.
    const isConnector = target.kind === 'service' && Boolean(target.parentPrincipalId);
    res.status(201).json({
      success: true,
      id: issued.credentialId,
      keyId: issued.keyId,
      scopes: scopeCheck.scopes,
      secretOnce: issued.fullKey,
      warning: 'This is the only time the full key is shown. Store it now.',
      ...(isConnector ? {
        onboarding: composeOnboardingPack({
          endpoint: boardEndpointFor(req),
          credential: {
            credentialId: issued.credentialId,
            keyId: issued.keyId,
            secretOnce: issued.fullKey,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            transport,
          },
          scopes: scopeCheck.scopes,
          rules: [],
        }),
      } : {}),
    });
  } catch (err) {
    if (err instanceof CredentialPolicyError) {
      res.status(err.status).json({ error: 'Refused', code: err.code, message: err.message });
      return;
    }
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] issuance failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'CREDENTIAL_ISSUE_FAILED', message: 'Failed to issue credential', errorId });
  }
});

// ── SS-W1 · the per-Account login password (design d95136d7 §8.1) ─────────
//
// A password is NOT a bearer credential and does not travel through the
// issuance route above: AUTHZ 4d961e37 §7.1 forbids bearer keys on Accounts
// and, in the same sentence, names passwords as how Accounts authenticate.
// So these two routes are the whole surface, and neither returns a secret.
//
// Authority: root manages any Account's password (the manage gate every
// other route on this mount uses); an Account may set its OWN. When the
// caller is setting their own and one already exists, the current password
// must be re-entered — otherwise a stolen session could lock its owner out
// of their own Account in one call.

/** True when the request is the named Account acting on itself. */
function isSelf(req: AuthRequest, targetId: string): boolean {
  return Boolean(req.principal?.id) && req.principal?.id === targetId;
}

/** The seam every password-act audit row names, success or refusal. */
const PASSWORD_ACT_SEAM = 'principals/:id/password';

/**
 * THE PASSWORD ACT — WHO MAY TOUCH AN ACCOUNT'S PASSWORD (card `bc5cd9f0`).
 *
 * ── WHAT WAS MISSING ──
 *
 * BETA-SMOKE created a second human Account on a fresh install with SSO off and
 * found no shipped way to let that person sign in. `PUT /:id/password` has
 * existed since SS-W1 and works; it simply had no caller. The Identities row
 * offered only "Disable", the CLI had no verb, `relayhall invitation mint`
 * needs an Identity provider a fresh install does not have, and the first-run
 * act is closed after the first administrator (409 FIRST_RUN_CLOSED). Onboarding
 * a colleague meant hand-written HTTP. This commit gives the route the smallest
 * complete surface — an Access manager control and a CLI verb — and, because a
 * surface is where authority actually gets exercised, states what the route
 * admits instead of leaving it on a gate written for credential management.
 *
 * ── WHO, AND WHY IT IS NARROWER THAN IT WAS ──
 *
 * An ADMINISTRATOR SESSION, never a bearer credential, through the same
 * predicate the role act uses (`administratorSessionOf`, carrying the password
 * act's own codes so the two are distinguishable in the ledger). This
 * deliberately replaces `requireManageAuthority`, and moves in two directions:
 *
 *  - It NARROWS. That guard admits any caller presenting the `root` scope,
 *    an `rh_` bearer credential included. Giving a human Account a password is
 *    how a person comes to hold a login session, so a machine credential able
 *    to do it is a machine credential able to manufacture a human identity for
 *    whoever holds the key — the shape AZ-18 forbids, on the axis AUTHZ §7.1
 *    reserves for login sessions. The SELF arm is inside the same rule rather
 *    than an exception to it: an Account is keyless (§7.1), so a bearer caller
 *    there could only be a Connector or an Agent, which `AccountPasswordService`
 *    already refuses by name (PASSWORD_IS_FOR_HUMANS) — closing it here means
 *    the refusal no longer depends on that later check being the one that fires.
 *  - It WIDENS by one role. `operator` holds every mintable scope but not
 *    `root`, so the old gate refused it, while owner ruling `60307311` §1.1
 *    names operators as administrators. What an operator may actually reach is
 *    bounded below by the same function that bounds the role axis.
 *
 * ── WHAT, AND WHY `canAssignRole` AND NOT A NEW ORDERING ──
 *
 * NON-ESCALATION: an issuer may act on an Account whose role it could itself
 * ASSIGN. `canAssignRole` is the ceiling `POST /principals` applies at creation
 * and the role act applies at change; a second ordering invented here would be
 * a second answer to "who is above whom", and two answers drift.
 *
 * It is also how "never `root`" is enforced, by the same mechanism the role act
 * uses: `root` is the global SCOPE sentinel and not a role, so it is absent
 * from `ASSIGNABLE_ROLES` and refused outright, and the two roles that DERIVE
 * it — `admin`, `orchestrator` — are reachable only by an `admin` issuer. An
 * operator therefore cannot give itself an administrator's login by setting one.
 *
 * THE NAMED LOCAL ADMINISTRATOR is refused, by symmetry with the role act and
 * for its reason: its authentication is the deployment's way back in, and this
 * is not where that is changed.
 *
 * ── WHY CLEARING IS HERE TOO ──
 *
 * `DELETE /:id/password` retires an Account's password, which is how a person
 * loses their way in. Leaving it on the old gate while this one tightens would
 * have left a machine credential able to lock every human out of a board it
 * cannot itself sign into — a worse hole than the one being closed, opened by
 * the act of closing it. One guard, both verbs.
 */
interface PasswordActAuthority {
  ok: boolean;
  self: boolean;
}

async function authorizePasswordAct(req: AuthRequest, res: Response): Promise<PasswordActAuthority> {
  const self = isSelf(req, req.params.id);
  const deny = async (status: number, code: string, message: string, targetId: string | null): Promise<PasswordActAuthority> => {
    // Fire-and-forget, exactly as the role act's refusals are: a refusal
    // changes nothing, so a ledger outage must not turn one into a 500.
    await auditService.record({
      action: 'credential.password.set', actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: 'principal', resourceId: targetId,
      metadata: { refusal: code, seam: PASSWORD_ACT_SEAM },
    }).catch(() => undefined);
    res.status(status).json({
      error: status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Entity' : 'Forbidden',
      code,
      message,
    });
    return { ok: false, self };
  };

  if (self) {
    // A bearer credential never performs this act, its own row included.
    if (!isLoginSessionKind(req.authMethod)) {
      return deny(403, PASSWORD_ACT.requiresSession,
        'Setting your own password is a login-session act (AZ-18): sign in at the dashboard, or run `relayhall login`. Bearer credentials never perform it.',
        req.params.id);
    }
    return { ok: true, self };
  }

  const session = administratorSessionOf({
    authMethod: req.authMethod,
    handle: req.userId,
    principalRole: req.principal?.role ?? null,
    sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, PASSWORD_ACT);
  if (!session.ok) return deny(session.status, session.code, session.message, null);

  // Caller data on a route whose column is a canonical `uuid`: a malformed
  // value is a 404, never a driver error.
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return deny(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found', null);
  }
  const target = await principalService.getPrincipalById(req.params.id);
  if (!target) return deny(404, 'PRINCIPAL_NOT_FOUND', 'Principal not found', req.params.id);
  if (target.handle === localAdministratorHandle()) {
    return deny(422, 'LOCAL_ADMINISTRATOR_PASSWORD_FIXED',
      'The named local administrator is the break-glass identity; its password is not set from here, so the deployment always has a way back in (the same rule that refuses to disable it or change its role).',
      target.id);
  }
  if (!canAssignRole(session.issuerRole, target.role)) {
    return deny(403, 'PASSWORD_ABOVE_YOUR_AUTHORITY',
      `Cannot manage the password of an Account carrying the role '${target.role ?? 'none'}' — it is above your own authority ('${session.issuerRole}').`,
      target.id);
  }
  return { ok: true, self };
}

router.put('/:id/password', async (req: AuthRequest, res: Response): Promise<void> => {
  const authority = await authorizePasswordAct(req, res);
  if (!authority.ok) return;
  const self = authority.self;
  try {
    const { password, currentPassword } = (req.body ?? {}) as Record<string, unknown>;
    if (self && (await accountPasswordService.has(req.params.id))) {
      const target = req.principal;
      const proven = target
        ? await accountPasswordService.verify(target.handle, currentPassword)
        : undefined;
      if (!proven || proven.principal.id !== req.params.id) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'CURRENT_PASSWORD_REQUIRED',
          message: 'Re-enter your current password to change it',
        });
        return;
      }
    }
    await accountPasswordService.set(req.params.id, password, auditActorFromRequest(req));
    res.json({
      success: true,
      // Said out loud because the obvious guess splits both ways and the answer
      // matters: somebody replacing a password they believe another person
      // knows needs to be told it does not sign that person out.
      //
      // Not an omission. `auth_sessions` enumerates its revoke reasons in
      // migration `062:70` — logout, idp_backchannel, disabled_user, admin,
      // expired_sweep — and none of them means "the password changed"; the only
      // callers of `revokeAllForPrincipal` today are self-logout and SCIM
      // deprovisioning. Revoking under a borrowed reason would put a misleading
      // word in a ledger this product treats as evidence, and adding an honest
      // one is a migration this lane has not reserved. So it is stated rather
      // than silently done or silently skipped.
      sessionsRevoked: false,
      note: self
        ? 'Your password is set. Your other sign-ins are not ended by this.'
        : 'The password is set and can be used to sign in now. Any sessions that Account already has stay signed in — setting a password does not end them.',
    });
  } catch (err) {
    if (err instanceof CredentialPolicyError) {
      res.status(err.status).json({ error: 'Refused', code: err.code, message: err.message });
      return;
    }
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] set password failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'PASSWORD_SET_FAILED', message: 'Failed to set the password', errorId });
  }
});

router.delete('/:id/password', async (req: AuthRequest, res: Response): Promise<void> => {
  // The same guard, for the reason in its header: clearing a password is how a
  // person loses their way in, and a verb that only tightened one direction
  // would open a bigger hole than it closed.
  const authority = await authorizePasswordAct(req, res);
  if (!authority.ok) return;
  try {
    const cleared = await accountPasswordService.clear(req.params.id, auditActorFromRequest(req));
    res.json({ success: true, cleared });
  } catch (err) {
    if (isMissingRelationError(err)) {
      res.status(503).json({ error: 'Service Unavailable', message: 'Identity substrate is not migrated yet' });
      return;
    }
    const errorId = logCaughtFailure('[Principals API] clear password failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'PASSWORD_CLEAR_FAILED', message: 'Failed to clear the password', errorId });
  }
});

// POST /principals/:id/terminate — irreversible offboarding (A17.10, T24):
// the target and its whole descendant subtree get the durable terminated
// status and every credential in the subtree is revoked permanently.
// Idempotent. Owner-plane by the manage gate (root).
function sendCredentialLifecycleError(res: Response, e: unknown): boolean {
  if (e instanceof CredentialLifecycleError) {
    res.status(e.status).json({ error: 'Refused', code: e.code, message: e.message });
    return true;
  }
  return false;
}

router.post('/:id/terminate', async (req: AuthRequest, res: Response): Promise<void> => {
  if (!requireManageAuthority(req, res)) return;
  try {
    const result = await credentialLifecycleService.terminate(req.params.id, auditActorFromRequest(req));
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendCredentialLifecycleError(res, err)) return;
    const errorId = logCaughtFailure('[Principals API] terminate failed:', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'TERMINATE_FAILED', message: 'Failed to terminate the principal', errorId });
  }
});

export default router;
