// routes/delegation.ts — the ONE mint route, dispatched by authentication
// kind (RH-P3.AZ-S4, card aa48fb12; AUTHZ design 4d961e37 §6, §9.2 —
// sol r5-F1; AZ-28; T2/T4/T17/T18/T21/T27).
//
// POST /delegation/agent-mints
//   BEARER CREDENTIAL (a Connector): performs the §6.1 approval REQUEST
//   (inputs: targetTaskId, requestedScopes/requestedRules → response: the
//   pending Approval id) or the §6.2–6.3 WARRANT-MINT (inputs additionally
//   warrantId, or via:'warrant' for unique-warrant auto-select → response:
//   the pack). With no warrantId, `via` selects: 'approval' forces the
//   request path; 'warrant' (or omitted-with-a-unique-warrant) mints.
//   Dispatch is DETERMINISTIC: omitted `via` mints when exactly one live
//   warrant contains the target, requests approval when none does, and
//   refuses on multiplicity (sol M8) rather than guessing.
//   AGENT-layer credentials refuse (AZ-28): a sub-worker is a sibling
//   minted by the Connector.
//
//   LOGIN SESSION + step-up (a human Account): performs the §6.1a ATOMIC
//   session mint (inputs: targetTaskId, requestedScopes/requestedRules,
//   stepUpToken bound to ('agent.mint', targetTaskId) → response: the
//   pack, rendered once to the session).
//
// POST /delegation/agent-mints/:approvalId/collect — credential-bound
//   COLLECT (§6.1): the SAME connector credential that requested, single
//   use, TTL 24h, complete revalidation in one transaction (T27).
//
// GET /delegation/agent-mints/:approvalId — requester-plane status (the
//   §9.3 status surface, REST form): the bound credential's principal
//   only; 404-concealed otherwise.
import { Router, Response } from 'express';
import { idempotent } from '../middleware/idempotency';
import { AuthRequest } from '../middleware/auth';
import { approvalService, ApprovalError } from '../services/ApprovalService';
import { warrantService, WarrantError } from '../services/WarrantService';
import { AgentMintError, validateRequestedScopes } from '../services/AgentMintService';
import { validateRules, AccessProfileError } from '../services/AccessProfileService';
import { stepUpService, StepUpError } from '../services/StepUpService';
import { auditActorFromRequest } from '../utils/auditActor';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { pool } from '../db/connection';
import { boardEndpointFor, composeOnboardingPack } from '../utils/onboardingPack';
import { generateTaskPromptWithSkills } from '../utils/promptTemplate';
import { taskManagerDB } from '../services/TaskManagerDB';
import { actorFromRequest, filterAuthorizedResources } from '../middleware/sharedAuthorization';
import type { MintedAgentPack } from '../services/AgentMintService';
import { isBearerCredentialKind, isLoginSessionKind } from '../utils/administratorSession';

const router = Router();

/**
 * §7.4/§8.5 (RH-P3.AZ-S5): the AGENT pack rides the mint/collect/session
 * response together with the COMPILED BRIEF — rendered exactly once, never
 * stored. The Brief compiles BEFORE the mint executes and FAILS CLOSED
 * (the C5 doctrine: a Brief silently missing its Charter/Phase/references
 * must not ship), so a compile failure refuses the whole mint with
 * nothing created. The compile is a disclosure act by the CALLING
 * principal (strategy §2.3): referenced-report inlining follows the
 * caller's grants, and the caller is who receives the pack.
 */
type BriefCompile =
  | { ok: true; brief: string }
  /** The target names no row. A SEPARATE outcome from a compile failure,
   *  because each dispatch below has to answer it the way that dispatch
   *  answers "you have no authority over this target" — see `TASK_ABSENT`. */
  | { ok: false; absent: true }
  | { ok: false; absent: false; status: number; code: string; message: string };

/**
 * The ONE refusal an absent target and an unauthorized target both receive
 * (card `45e7110a`).
 *
 * Spelling it once, and sending it from both places, is the point: two
 * refusals written separately drift, and the drift IS the disclosure — a
 * caller that can tell "no such Task" from "a Task you may not have" can test
 * any id for existence.
 */
const TASK_ABSENT = { error: 'Refused', code: 'TASK_NOT_FOUND', message: 'target task resolves to no row' };

/** Canonical-form check before the id reaches an authorization query; a
 *  malformed id is a request-shape refusal, which the services below make. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function compileBriefForMint(req: AuthRequest, taskId: string): Promise<BriefCompile> {
  const task = await taskManagerDB.getTask(taskId);
  if (!task) return { ok: false, absent: true };
  try {
    const brief = await generateTaskPromptWithSkills(task, { actor: actorFromRequest(req) });
    return { ok: true, brief };
  } catch (e) {
    const errorId = logCaughtFailure('[Delegation API] Brief compile failed before mint:', e);
    return {
      ok: false, absent: false, status: 503, code: 'BRIEF_COMPILE_FAILED',
      message: `The Agent pack could not compile its Brief (fail closed — nothing was minted). errorId=${errorId}`,
    };
  }
}

function packResponse(req: AuthRequest, pack: MintedAgentPack, brief: string): MintedAgentPack & { onboarding: ReturnType<typeof composeOnboardingPack> } {
  return {
    ...pack,
    onboarding: composeOnboardingPack({
      endpoint: boardEndpointFor(req),
      credential: {
        credentialId: pack.credentialId,
        keyId: pack.keyId,
        secretOnce: pack.secretOnce,
        expiresAt: pack.expiresAt,
        transport: pack.transport,
      },
      scopes: pack.scopes,
      rules: pack.rules,
      boundTaskId: pack.boundTaskId,
      brief,
    }),
  };
}

function sendMintError(res: Response, e: unknown): boolean {
  if (e instanceof ApprovalError || e instanceof WarrantError || e instanceof AgentMintError
    || e instanceof StepUpError || e instanceof AccessProfileError) {
    res.status(e.status).json({ error: 'Refused', code: e.code, message: e.message });
    return true;
  }
  return false;
}

// POST /delegation/agent-mints — the one mint operation (sol r5-F1).
router.post('/agent-mints', idempotent('agent.mint.request'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.principal?.id) {
      res.status(403).json({ error: 'Forbidden', code: 'PRINCIPAL_REQUIRED', message: 'Minting requires a resolved principal identity' });
      return;
    }
    const targetTaskId = typeof req.body?.targetTaskId === 'string' ? req.body.targetTaskId : '';
    const viaBearer = isBearerCredentialKind(req.authMethod);
    const sessionLike = isLoginSessionKind(req.authMethod);

    if (viaBearer) {
      const via = req.body?.via;
      const warrantId = typeof req.body?.warrantId === 'string' ? req.body.warrantId : null;
      if (via !== undefined && via !== 'approval' && via !== 'warrant') {
        res.status(422).json({ error: 'Unprocessable Entity', code: 'INVALID_MINT_REQUEST', message: "via must be 'approval' or 'warrant' when given" });
        return;
      }
      if (via === 'approval' && warrantId) {
        res.status(422).json({ error: 'Unprocessable Entity', code: 'INVALID_MINT_REQUEST', message: "via:'approval' and warrantId are mutually exclusive" });
        return;
      }
      if (via === 'approval') {
        const approval = await approvalService.request({
          requesterPrincipalId: req.principal.id,
          requestingCredentialId: req.credentialId ?? '',
          targetTaskId,
          requestedScopes: req.body?.requestedScopes,
          requestedRules: req.body?.requestedRules,
        }, auditActorFromRequest(req));
        res.status(202).json({ success: true, path: 'approval', approval });
        return;
      }
      // Warrant path — named, or auto-selected/dispatched. AZ-28: the
      // agent-layer refusal lives in the services (approval request) and
      // in mintUnderWarrant's chain validation (an agent principal's mint
      // dies at assertRequesterLive → chain shape / requester checks).
      const scopes = validateRequestedScopes(req.body?.requestedScopes);
      const rules = req.body?.requestedRules === undefined || req.body?.requestedRules === null
        ? []
        : (Array.isArray(req.body.requestedRules) && req.body.requestedRules.length === 0 ? [] : validateRules(req.body.requestedRules));
      if (req.principal.kind === 'agent') {
        // AZ-28 (T11 shape): mint is Connector/Account-plane.
        res.status(422).json({ error: 'Refused', code: 'AGENT_PLANE_REFUSED', message: 'Agent-layer credentials never mint (AZ-28): a sub-worker is a sibling minted by the Connector' });
        return;
      }
      try {
        // §7.4: the Brief compiles FIRST and fails closed — a mint whose
        // pack cannot carry its Brief never happens.
        const compiled = await compileBriefForMint(req, targetTaskId);
        if (!compiled.ok) {
          if (compiled.absent) {
            // A Task that does not exist is contained in NO warrant, so
            // absence and non-containment are the same authority outcome —
            // and answering them differently told any Connector whether an
            // arbitrary id named a Task (card 45e7110a). Raising the
            // containment refusal here rather than a 404 puts absence back on
            // the ordinary dispatch: the `catch` below still converts it into
            // the §6.1 approval request when `via` was omitted, exactly as it
            // does for an existing Task no warrant of this holder contains.
            throw new WarrantError(409, 'NO_CONTAINING_WARRANT',
              'no live warrant of this holder contains the target task (§6.3)');
          }
          res.status(compiled.status).json({ error: 'Refused', code: compiled.code, message: compiled.message });
          return;
        }
        const pack = await warrantService.mintUnderWarrant({
          actingPrincipalId: req.principal.id,
          actingCredentialScopes: req.scopes ?? [],
          targetTaskId,
          warrantId,
          authority: { scopes, rules },
          label: typeof req.body?.label === 'string' ? req.body.label.slice(0, 128) : null,
        }, auditActorFromRequest(req));
        res.status(201).json({ success: true, path: 'warrant', selectedWarrantId: pack.mintedUnderWarrantId, pack: packResponse(req, pack, compiled.brief) });
        return;
      } catch (warrantErr) {
        // Omitted `via` + no containing warrant → the §6.1 request path.
        if (!warrantId && via === undefined && warrantErr instanceof WarrantError && warrantErr.code === 'NO_CONTAINING_WARRANT') {
          const approval = await approvalService.request({
            requesterPrincipalId: req.principal.id,
            requestingCredentialId: req.credentialId ?? '',
            targetTaskId,
            requestedScopes: req.body?.requestedScopes,
            requestedRules: req.body?.requestedRules,
          }, auditActorFromRequest(req));
          res.status(202).json({ success: true, path: 'approval', approval });
          return;
        }
        throw warrantErr;
      }
    }

    if (sessionLike) {
      // §6.1a: the atomic session mint. The step-up token binds to
      // ('agent.mint', targetTaskId) and burns INSIDE this dispatch.
      const stepUpToken = typeof req.body?.stepUpToken === 'string' ? req.body.stepUpToken : '';
      const stepUp = await stepUpService.consume(pool, {
        token: stepUpToken,
        principalId: req.principal.id,
        action: 'agent.mint',
        targetId: targetTaskId,
      });
      // §5.2 rule 1 names this ceiling: "base = the Account's OWN effective
      // authority; step-up authorized the ACT and never widened the ceiling."
      // `sessionMint` enforced that for the requested SCOPES and for the
      // requested object RULES, and for nothing about the TARGET — so a
      // signed-in Account could mint an Agent bound to a Task `GET /tasks/:id`
      // refuses it, and receive that Task's compiled Brief in the pack. A
      // step-up token is no help: `/auth/step-up` mints one for any target id
      // on password re-entry alone, and is deliberately not an authority check.
      //
      // The target goes through the SAME shared predicate the rest of the Task
      // family uses, on the caller's own request — never a filter over an
      // answer already built. A Task this Account may not read is refused with
      // the SAME words as one that does not exist, so closing the bypass does
      // not open an existence oracle in its place.
      // ONE actor object, resolved once and used by BOTH the concealed
      // refusal here and the re-check inside the mint transaction, so the two
      // decisions cannot drift on who is asking (review P2).
      const authorizationActor = req.authorizationActor ?? actorFromRequest(req);
      if (UUID_PATTERN.test(targetTaskId)) {
        const readable = await filterAuthorizedResources(
          req, 'read', [targetTaskId], (id: string) => ({ type: 'task', id }),
        );
        if (readable.length === 0) {
          res.status(404).json(TASK_ABSENT);
          return;
        }
      }
      const compiled = await compileBriefForMint(req, targetTaskId);
      if (!compiled.ok) {
        // Reachable for a caller the predicate admits without a row lookup (an
        // administrator resolves as allowed before existence is ever asked), so
        // absence still has to answer here — in the same words as above.
        if (compiled.absent) {
          res.status(404).json(TASK_ABSENT);
          return;
        }
        res.status(compiled.status).json({ error: 'Refused', code: compiled.code, message: compiled.message });
        return;
      }
      const minted = await approvalService.sessionMint({
        accountPrincipalId: req.principal.id,
        sessionScopes: req.scopes ?? [],
        targetTaskId,
        requestedScopes: req.body?.requestedScopes,
        requestedRules: req.body?.requestedRules,
        label: req.body?.label,
        stepUp,
        authorizationActor,
      }, auditActorFromRequest(req));
      res.status(201).json({ success: true, path: 'session', approval: minted.approval, pack: packResponse(req, minted.pack, compiled.brief) });
      return;
    }

    res.status(403).json({ error: 'Forbidden', code: 'UNSUPPORTED_AUTH_KIND', message: 'Minting dispatches by authentication kind (§9.2): a Connector bearer credential or an authenticated login session' });
  } catch (e) {
    if (sendMintError(res, e)) return;
    const errorId = logCaughtFailure('[Delegation API] mint failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'AGENT_MINT_FAILED', message: 'Failed to process the mint operation', errorId });
  }
});

// POST /delegation/agent-mints/:approvalId/collect — §6.1 collect.
router.post('/agent-mints/:approvalId/collect', idempotent('agent.mint.collect'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!isBearerCredentialKind(req.authMethod) || !req.principal?.id || !req.credentialId) {
      res.status(403).json({ error: 'Forbidden', code: 'CREDENTIAL_BOUND', message: 'Collect is credential-bound (§6.1): present the SAME connector credential that requested' });
      return;
    }
    // The Approval names the target task; the Brief compiles first and
    // fails closed (§7.4). Concealment: an unknown/foreign approval still
    // answers through the service below, so only resolve the task AFTER
    // the binding is known to hold for THIS credential.
    const binding = await approvalService.get(req.params.approvalId).catch(() => null);
    if (!binding || binding.requestingCredentialId !== req.credentialId) {
      res.status(404).json({ error: 'Refused', code: 'APPROVAL_NOT_FOUND', message: 'No such approval' });
      return;
    }
    const compiled = await compileBriefForMint(req, binding.targetTaskId);
    if (!compiled.ok) {
      // No narrowing here, and none is owed: the target is named by the
      // APPROVAL this caller has just proven it holds, never by the request,
      // so absence tells it only that the Task it was approved for is gone.
      if (compiled.absent) {
        res.status(404).json(TASK_ABSENT);
        return;
      }
      res.status(compiled.status).json({ error: 'Refused', code: compiled.code, message: compiled.message });
      return;
    }
    const pack = await approvalService.collect({
      approvalId: req.params.approvalId,
      presentingCredentialId: req.credentialId,
      presentingPrincipalId: req.principal.id,
      presentingEffectiveScopes: req.scopes ?? [],
    }, auditActorFromRequest(req));
    res.status(201).json({ success: true, pack: packResponse(req, pack, compiled.brief) });
  } catch (e) {
    if (sendMintError(res, e)) return;
    const errorId = logCaughtFailure('[Delegation API] collect failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'AGENT_COLLECT_FAILED', message: 'Failed to collect the approval', errorId });
  }
});

// GET /delegation/warrants — the HOLDER-plane warrant view (§9.3
// relayhall_warrant_list, RH-P3.AZ-S5): a bearer Connector lists the live
// warrants it may mint under — held by itself, or by its parent service
// Account (exercised through its Connectors, AZ-RT5). The management
// registry stays session-only on /warrants; this discloses only the
// caller's own standing authorizations, decider identities excluded.
router.get('/warrants', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!isBearerCredentialKind(req.authMethod) || !req.principal?.id) {
      res.status(403).json({ error: 'Forbidden', code: 'CREDENTIAL_BOUND', message: 'The holder-plane warrant view is the bearer plane (§9.3); the management registry lives at /warrants' });
      return;
    }
    const result = await pool.query(
      `SELECT w.id, w.name, w.description, w.status, w.holder_principal_id,
              w.ceiling_profile_version_id, w.ceiling_rules, w.ceiling_scopes,
              w.expires_at, w.transport_pin, w.agent_max_age_hours,
              w.max_concurrent, w.max_total, w.minted_total
         FROM warrants w
        WHERE w.holder_principal_id = $1
           OR w.holder_principal_id IN (
             SELECT p.parent_principal_id FROM principals p
              WHERE p.id = $1 AND p.parent_principal_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM principals acct
                             WHERE acct.id = p.parent_principal_id
                               AND acct.kind = 'service' AND acct.parent_principal_id IS NULL))
        ORDER BY w.created_at DESC`,
      [req.principal.id],
    );
    res.json({
      success: true,
      warrants: result.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        description: String(row.description ?? ''),
        status: row.status,
        heldByParentAccount: String(row.holder_principal_id) !== req.principal!.id,
        ceilingProfileVersionId: row.ceiling_profile_version_id ? String(row.ceiling_profile_version_id) : null,
        ceilingRules: typeof row.ceiling_rules === 'string' ? JSON.parse(row.ceiling_rules) : row.ceiling_rules,
        ceilingScopes: typeof row.ceiling_scopes === 'string' ? JSON.parse(row.ceiling_scopes) : row.ceiling_scopes,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        transportPin: row.transport_pin,
        agentMaxAgeHours: row.agent_max_age_hours === null ? null : Number(row.agent_max_age_hours),
        maxConcurrent: row.max_concurrent === null ? null : Number(row.max_concurrent),
        maxTotal: row.max_total === null ? null : Number(row.max_total),
        mintedTotal: Number(row.minted_total ?? 0),
      })),
    });
  } catch (e) {
    if (sendMintError(res, e)) return;
    const errorId = logCaughtFailure('[Delegation API] holder warrant list failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'WARRANT_HOLDER_LIST_FAILED', message: 'Failed to list held warrants', errorId });
  }
});

// GET /delegation/agent-mints/:approvalId — requester-plane status.
router.get('/agent-mints/:approvalId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!isBearerCredentialKind(req.authMethod) || !req.principal?.id) {
      res.status(403).json({ error: 'Forbidden', code: 'CREDENTIAL_BOUND', message: 'Mint status is the requester plane: present the requesting connector credential (the human queue lives at /approvals)' });
      return;
    }
    const approval = await approvalService.get(req.params.approvalId);
    if (approval.requesterPrincipalId !== req.principal.id) {
      res.status(404).json({ error: 'Refused', code: 'APPROVAL_NOT_FOUND', message: 'No such approval' });
      return;
    }
    // The requester sees its own item's lifecycle — never the decider's
    // identity or step-up evidence.
    res.json({
      success: true,
      approval: {
        id: approval.id,
        status: approval.status,
        targetTaskId: approval.targetTaskId,
        requestedScopes: approval.requestedScopes,
        requestedRules: approval.requestedRules,
        approvedScopes: approval.approvedScopes,
        approvedRules: approval.approvedRules,
        requestedAt: approval.requestedAt,
        pendingExpiresAt: approval.pendingExpiresAt,
        collectExpiresAt: approval.collectExpiresAt,
        lapseReason: approval.lapseReason,
      },
    });
  } catch (e) {
    if (sendMintError(res, e)) return;
    const errorId = logCaughtFailure('[Delegation API] status failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'AGENT_MINT_STATUS_FAILED', message: 'Failed to read the mint status', errorId });
  }
});

export default router;
