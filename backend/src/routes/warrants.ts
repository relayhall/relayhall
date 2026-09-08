// routes/warrants.ts — the /warrants surface (RH-P3.AZ-S4, card aa48fb12;
// AUTHZ design 4d961e37 §6.2–6.4, §9.1/§9.2; T3/T23).
//
// SESSION-ONLY (T3, §6.2): warrant creation — and this whole management
// surface — is the board's authenticated HUMAN plane. A bearer credential
// (any rh_ token) is refused outright: a Connector can never warrant
// itself, and the API attempt dies here with a durable denied audit.
//
// SELF-SCOPE ARM (§6.1/§9.1): a non-root session sees and manages only
// warrants whose HOLDER lies in its own subtree; anything else is
// 404-concealed. Root retains the full view.
//
// STEP-UP (§7.6): creation and resume-from-suspension consume a SINGLE-USE
// elevation token bound to the act (creation binds to the holder id — the
// object the act targets before the warrant exists; resume binds to the
// warrant id). Revocation is the protective direction and needs the
// session alone.
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { authorizedTaskNarrowing, filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { warrantService, WarrantError } from '../services/WarrantService';
import { accessVehicleService } from '../services/AccessVehicleService';
import { stepUpService, StepUpError } from '../services/StepUpService';
import { credentialLifecycleService } from '../services/CredentialLifecycleService';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { pool } from '../db/connection';
import { isLoginSessionKind } from '../utils/administratorSession';

const router = Router();

export interface SessionViewer {
  principalId: string;
  isRoot: boolean;
}

/** Classify the caller for this surface: an authenticated SESSION with a
 * resolved principal, or nothing. Bearer callers refuse with a durable
 * denied audit (T3). Exported for the /approvals router, which carries the
 * same arm. */
export async function requireSessionViewer(req: AuthRequest, res: Response, surface: string): Promise<SessionViewer | null> {
  // The classification is the shared seam's, not this file's (review
  // verdict 2c284891 B1): one question, one answer, everywhere.
  if (!isLoginSessionKind(req.authMethod)) {
    await auditService.record({
      action: `${surface}.refused`, actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: 'route', resourceId: null,
      metadata: { refusal: 'SESSION_ONLY', authMethod: req.authMethod ?? 'unknown' },
    }).catch(() => undefined);
    res.status(403).json({
      error: 'Forbidden', code: 'SESSION_ONLY',
      message: 'This is a board human-surface act (design 4d961e37 §6.1/§6.2): bearer credentials are refused — sign in',
    });
    return null;
  }
  if (!req.principal?.id) {
    res.status(403).json({ error: 'Forbidden', code: 'PRINCIPAL_REQUIRED', message: 'This surface requires a resolved principal identity' });
    return null;
  }
  return {
    principalId: req.principal.id,
    isRoot: Boolean(req.scopes?.includes('root')),
  };
}

function sendWarrantError(res: Response, e: unknown): boolean {
  if (e instanceof WarrantError || e instanceof StepUpError) {
    res.status(e.status).json({ error: 'Refused', code: e.code, message: e.message });
    return true;
  }
  return false;
}

/** Self-scope containment for a single warrant (§9.1): holder in the
 * viewer's subtree — 404-conceal otherwise. */
async function concealForeign(viewer: SessionViewer, holderPrincipalId: string): Promise<boolean> {
  if (viewer.isRoot) return false;
  if (holderPrincipalId === viewer.principalId) return false;
  return !(await credentialLifecycleService.isDescendant(viewer.principalId, holderPrincipalId));
}

// GET /warrants — the registry, self-scoped.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    res.json({ success: true, warrants: await warrantService.list(viewer) });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] list failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'WARRANT_LIST_FAILED', message: 'Failed to list warrants', errorId });
  }
});

// GET /warrants/:id — one warrant with anchors, minted identities (§6.4
// provenance registry) and its event ledger.
// GET /warrants/suggestions?phaseId= — RH-P3.AZ-S7 (ruling 7440b579 R5):
// the warrants a task created in this Phase could ride, so the creation
// surface can SUGGEST one. Suggestion only: nothing is auto-selected, and
// omitting the choice takes the R2(b) auto-grant fallback.
//
// Mounted BEFORE '/:id' so 'suggestions' is never read as a warrant id.
router.get('/suggestions', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  const phaseId = typeof req.query.phaseId === 'string' ? req.query.phaseId : '';
  if (!phaseId) {
    res.status(400).json({ error: 'Bad Request', code: 'PHASE_REQUIRED', message: 'phaseId is required' });
    return;
  }
  try {
    const all = await accessVehicleService.suggestionsForPhase(phaseId);
    // The §6.1/§9.1 self-scope arm applies here exactly as it does to the
    // listing: a non-root session is only ever offered warrants whose
    // holder lies in its own subtree.
    const visible = [];
    for (const suggestion of all) {
      if (await concealForeign(viewer, String(suggestion.holderPrincipalId))) continue;
      visible.push(suggestion);
    }
    res.json({ success: true, suggestions: visible });
  } catch (e) {
    const errorId = logCaughtFailure('[Warrants API] suggestions failed:', e);
    res.status(503).json({ error: 'Service Unavailable', code: 'WARRANT_SUGGESTIONS_UNAVAILABLE', message: 'Suggestions could not be read', errorId });
  }
});

// GET /warrants/:id/dependent-tasks — RH-P3.AZ-S7 (ruling 7440b579 R4):
// the enumerated list of dependent NOT-YET-TERMINAL tasks a revoke would
// auto-unassign. This IS the warning the revoke dialog renders.
router.get('/:id/dependent-tasks', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const existing = await warrantService.get(req.params.id);
    if (await concealForeign(viewer, existing.holderPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
      return;
    }
    // Holding a warrant is not authority over the Tasks riding it: `create`
    // validates that an anchor row EXISTS and nothing more, so a holder-tree
    // viewer could read the TITLE of a Task `GET /tasks/:id` refuses them
    // (review 302a338f B2). The COUNT stays whole - it is the warning the
    // revoke dialog renders, and a warning that undercounts what a revoke
    // will unassign is worse than one that withholds a name.
    const dependents = await accessVehicleService.dependentOpenTasks(req.params.id);
    const tasks = await filterAuthorizedResources(
      req, 'read', dependents, (task) => ({ type: 'task', id: task.id }),
    );
    res.json({
      success: true,
      tasks,
      total: dependents.length,
      concealed: dependents.length - tasks.length,
    });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] dependent-tasks failed:', e);
    res.status(503).json({ error: 'Service Unavailable', code: 'WARRANT_DEPENDENTS_UNAVAILABLE', message: 'Dependent tasks could not be read', errorId });
  }
});

// GET /warrants/:id/linkage — RH-P3.AZ-S7 (R5): the "warrant -> anchored
// objects" half of the two-way linkage, with the tasks currently riding it.
router.get('/:id/linkage', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const existing = await warrantService.get(req.params.id);
    if (await concealForeign(viewer, existing.holderPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
      return;
    }
    const anchors = await pool.query(
      `SELECT wa.anchor_type, wa.anchor_id,
              COALESCE(t.title, ph.name, pr.name) AS anchor_label,
              COALESCE(t.status, ph.status, pr.status) AS anchor_status
         FROM warrant_anchors wa
         LEFT JOIN tasks t ON wa.anchor_type = 'task' AND t.id = wa.anchor_id
         LEFT JOIN phases ph ON wa.anchor_type = 'phase' AND ph.id = wa.anchor_id
         LEFT JOIN projects pr ON wa.anchor_type = 'project' AND pr.id = wa.anchor_id
        WHERE wa.warrant_id = $1
        ORDER BY wa.anchor_type, wa.anchor_id`,
      [req.params.id],
    );
    const carried = await pool.query(
      `SELECT DISTINCT t.id, t.title, t.status
         FROM tasks t
        WHERE t.execution_warrant_id = $1
           OR EXISTS (SELECT 1 FROM access_vehicle_links l WHERE l.task_id = t.id AND l.warrant_id = $1)
        ORDER BY t.id`,
      [req.params.id],
    );
    // Same narrowing, same reason (review 302a338f B2). A Task ANCHOR whose
    // Task this caller may not read keeps its type and id - the warrant's own
    // structure, which the holder is entitled to - and loses the label and
    // status, which belong to the Task.
    const anchoredTaskIds = anchors.rows
      .filter((row) => row.anchor_type === 'task')
      .map((row) => String(row.anchor_id));
    const readableAnchorTasks = new Set(await filterAuthorizedResources(
      req, 'read', anchoredTaskIds, (taskId) => ({ type: 'task', id: taskId }),
    ));
    const carriedTasks = await filterAuthorizedResources(
      req,
      'read',
      carried.rows.map((row) => ({ id: String(row.id), title: String(row.title), status: String(row.status) })),
      (task) => ({ type: 'task', id: task.id }),
    );
    res.json({
      success: true,
      anchors: anchors.rows.map((row) => {
        const concealed = row.anchor_type === 'task' && !readableAnchorTasks.has(String(row.anchor_id));
        return {
          anchorType: row.anchor_type,
          anchorId: String(row.anchor_id),
          label: concealed ? null : (row.anchor_label ?? null),
          status: concealed ? null : (row.anchor_status ?? null),
          concealed,
        };
      }),
      carriedTasks,
      carriedTotal: carried.rows.length,
      carriedConcealed: carried.rows.length - carriedTasks.length,
    });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] linkage failed:', e);
    res.status(503).json({ error: 'Service Unavailable', code: 'WARRANT_LINKAGE_UNAVAILABLE', message: 'Linkage could not be read', errorId });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const warrant = await warrantService.get(req.params.id);
    if (await concealForeign(viewer, warrant.holderPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
      return;
    }
    res.json({
      success: true,
      warrant,
      mintedIdentities: await warrantService.mintedIdentities(warrant.id),
      events: await warrantService.events(warrant.id),
    });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] get failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'WARRANT_READ_FAILED', message: 'Failed to read the warrant', errorId });
  }
});

// POST /warrants — create (§6.2): session + step-up bound to
// ('warrant.create', holderPrincipalId).
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const holderId = typeof req.body?.holderPrincipalId === 'string' ? req.body.holderPrincipalId : '';
    if (!viewer.isRoot && holderId && await concealForeign(viewer, holderId)) {
      // A non-root Account warrants only holders in its own subtree.
      res.status(404).json({ error: 'Refused', code: 'HOLDER_NOT_FOUND', message: 'holderPrincipalId resolves to no principal' });
      return;
    }
    const stepUpToken = typeof req.body?.stepUpToken === 'string' ? req.body.stepUpToken : '';
    const stepUp = await stepUpService.consume(pool, {
      token: stepUpToken,
      principalId: viewer.principalId,
      action: 'warrant.create',
      targetId: holderId,
    });
    const warrant = await warrantService.create(req.body ?? {}, {
      principalId: viewer.principalId, isRoot: viewer.isRoot,
      // Review 1897c959 B1: the middleware-computed session scope set is
      // the creator's current effective scope authority — the ceiling's
      // scope half must lie within it.
      sessionScopes: req.scopes ?? [],
      stepUp,
    }, auditActorFromRequest(req));
    res.status(201).json({ success: true, warrant });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] create failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'WARRANT_CREATE_FAILED', message: 'Failed to create the warrant', errorId });
  }
});

// PATCH /warrants/:id — name/description only. Authority fields are
// immutable: widening is a NEW warrant under a fresh approval act.
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const existing = await warrantService.get(req.params.id);
    if (await concealForeign(viewer, existing.holderPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
      return;
    }
    const forbidden = ['holderPrincipalId', 'anchors', 'ceilingProfileId', 'ceilingRules', 'ceilingScopes',
      'expiresAt', 'transportPin', 'agentMaxAgeHours', 'maxConcurrent', 'maxTotal', 'status']
      .filter((field) => req.body && field in req.body);
    if (forbidden.length > 0) {
      res.status(422).json({ error: 'Unprocessable Entity', code: 'WARRANT_AUTHORITY_IMMUTABLE', message: `warrant authority is immutable (${forbidden.join('/')}): widening is a NEW warrant, narrowing is revocation` });
      return;
    }
    const warrant = await warrantService.update(req.params.id, req.body ?? {}, auditActorFromRequest(req));
    res.json({ success: true, warrant });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] update failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'WARRANT_UPDATE_FAILED', message: 'Failed to update the warrant', errorId });
  }
});

// POST /warrants/:id/revoke — protective direction: session, no step-up.
router.post('/:id/revoke', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const existing = await warrantService.get(req.params.id);
    if (await concealForeign(viewer, existing.holderPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    // R4: the caller must have SEEN the dependent-task warning. Without the
    // acknowledgement the service refuses and enumerates them; with it, the
    // revoke proceeds and auto-unassigns.
    const acknowledgeDependents = req.body?.acknowledgeDependents === true;
    const warrant = await warrantService.revoke(
      req.params.id, reason, auditActorFromRequest(req),
      authorizedTaskNarrowing(req), { acknowledgeDependents });
    res.json({ success: true, warrant });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] revoke failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'WARRANT_REVOKE_FAILED', message: 'Failed to revoke the warrant', errorId });
  }
});

// POST /warrants/:id/resume — the §6.4 re-approval act: session + step-up
// bound to ('warrant.resume', warrantId); the creator live-cap re-proves.
router.post('/:id/resume', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const existing = await warrantService.get(req.params.id);
    if (await concealForeign(viewer, existing.holderPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
      return;
    }
    const stepUpToken = typeof req.body?.stepUpToken === 'string' ? req.body.stepUpToken : '';
    await stepUpService.consume(pool, {
      token: stepUpToken,
      principalId: viewer.principalId,
      action: 'warrant.resume',
      targetId: req.params.id,
    });
    const warrant = await warrantService.resume(req.params.id, auditActorFromRequest(req));
    res.json({ success: true, warrant });
  } catch (e) {
    if (sendWarrantError(res, e)) return;
    const errorId = logCaughtFailure('[Warrants API] resume failed:', e);
    res.status(500).json({ error: 'Internal Server Error', code: 'WARRANT_RESUME_FAILED', message: 'Failed to resume the warrant', errorId });
  }
});

export default router;
