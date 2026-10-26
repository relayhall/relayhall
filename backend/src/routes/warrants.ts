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
import { filterReadablePhases } from './phases';
import { warrantService, WarrantError } from '../services/WarrantService';
import { accessVehicleService, AssignmentAccessError } from '../services/AccessVehicleService';
import { stepUpService, StepUpError } from '../services/StepUpService';
import { credentialLifecycleService } from '../services/CredentialLifecycleService';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { pool } from '../db/connection';
import { isLoginSessionKind } from '../utils/administratorSession';
import { authorityEditExecutor } from '../services/AuthorityEditExecutor';
import {
  auditRouteRefusal, canonicalObjectId, editorContext, editorStanding, editResponse, refuseStanding, sendAuthorityEditError,
  splitEditBody,
} from './authorityEditRoute';

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
  if (e instanceof WarrantError || e instanceof StepUpError || (e instanceof AssignmentAccessError && e.code === 'ASSIGNMENT_REFERENCE_BUSY')) {
    // Card 7a99d63e (SU-14): what to step up for, on STEP_UP_REQUIRED. Read
    // inline (the same expression as `stepUpChallengeBody`): this mapper is
    // compiled on its own by assignmentReferenceBusy.test.ts, so it names no
    // helper beyond the classes it already guards on.
    res.status(e.status).json({
      error: 'Refused', code: e.code, message: e.message,
      ...(e instanceof StepUpError && e.challenge ? { stepUp: e.challenge } : {}),
    });
    return true;
  }
  return false;
}

/** Self-scope containment for a single warrant (§9.1): holder in the
 * viewer's subtree — 404-conceal otherwise. The rule lives in
 * `credentialLifecycleService.holderConcealedFrom`, which the Access Explorer
 * asks too (card 1e56dbef), so the two cannot drift apart. */
async function concealForeign(viewer: SessionViewer, holderPrincipalId: string): Promise<boolean> {
  return credentialLifecycleService.holderConcealedFrom(viewer, holderPrincipalId);
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
    // A Phase ANCHOR follows the same rule through the one Phase read
    // decision (card 1e0f3bd4): a restricted Phase suppresses what its Project
    // lends (ruling 44ee41f2), and holding a Warrant anchored to it reads
    // nothing of it, so its name and status are concealed like a Task's.
    const readableAnchorPhases = new Set((await filterReadablePhases(req, anchors.rows
      .filter((row) => row.anchor_type === 'phase')
      .map((row) => ({ id: String(row.anchor_id) })))).map((phase) => phase.id));
    // A Project ANCHOR follows the same rule through the Project read decision
    // the Project lists ask (card bdf7b876): holding a Warrant anchored to a
    // Project reads nothing of that Project, so its name and status are
    // concealed like a Task's or a Phase's.
    const readableAnchorProjects = new Set(await filterAuthorizedResources(
      req, 'read', anchors.rows
        .filter((row) => row.anchor_type === 'project')
        .map((row) => String(row.anchor_id)),
      (projectId) => ({ type: 'project', id: projectId }),
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
        const concealed = (row.anchor_type === 'task' && !readableAnchorTasks.has(String(row.anchor_id)))
          || (row.anchor_type === 'project' && !readableAnchorProjects.has(String(row.anchor_id)))
          || (row.anchor_type === 'phase' && !readableAnchorPhases.has(String(row.anchor_id)));
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

// PATCH /warrants/:id — name and description, and (AZ-A13 clause 10,
// ratified 2026-10-11, E95) the warrant's authority IN PLACE: the ceiling
// (re-pinned: `ceilingProfileId`, or `ceilingRules` the server publishes),
// `ceilingScopes`, `maxConcurrent`, `maxTotal`, `expiresAt`, `transportPin`.
// Holder, anchors, `agentMaxAgeHours` and status are still refused
// WARRANT_AUTHORITY_IMMUTABLE. The editor is root, an administrator login
// session, or the owning Account (clause 4a); a narrowing saves, a widening
// takes `lifetime` and a step-up bound to ('warrant.edit', id) (clause 4b). A
// ceiling edit while tasks ride the warrant needs `acknowledgeDependents`
// (clause 10c). `applyRevert: <approvalId>` applies a due until-task revert
// that waits on riding tasks (clause 6j with 10c). Every refusal of an edit
// act writes a durable denied audit with the chain (clause 13), the 404
// concealments included.
const WARRANT_IMMUTABLE_FIELDS = ['holderPrincipalId', 'anchors', 'agentMaxAgeHours', 'status'];
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const viewer = await requireSessionViewer(req, res, 'warrant');
  if (!viewer) return;
  try {
    const id = canonicalObjectId(String(req.params.id ?? ''));
    const { name, description, applyRevert, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    const { fields, controls } = splitEditBody(rest);
    const forbidden = WARRANT_IMMUTABLE_FIELDS.filter((field) => req.body && field in req.body);
    const authorityEdit = Object.keys(fields).length > 0;
    // clause 13 / §5.2 rule 8: every refusal of an edit act writes a durable
    // denied audit with the chain, the 404 concealments included (review
    // 1a38270d r1 B2).
    const editAct = authorityEdit || applyRevert !== undefined;
    let existing: Awaited<ReturnType<typeof warrantService.get>>;
    try {
      existing = await warrantService.get(id);
    } catch (e) {
      if (editAct && e instanceof WarrantError && e.code === 'WARRANT_NOT_FOUND') {
        await auditRouteRefusal(req, 'warrant', id, 'WARRANT_NOT_FOUND',
          { clause: 'AZ-A13 clause 15', subject: 'target', rule: 'the edited object exists' });
      }
      throw e;
    }
    if (forbidden.length > 0) {
      const refusal = {
        rule: "a warrant's holder, anchors, agentMaxAgeHours and status never change", subject: 'editor',
        clause: 'AZ-A13 clause 10a', fields: forbidden,
      };
      if (await concealForeign(viewer, existing.holderPrincipalId)) {
        await auditRouteRefusal(req, 'warrant', id, 'WARRANT_AUTHORITY_IMMUTABLE', { ...refusal, answeredAs: 'WARRANT_NOT_FOUND' });
        res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
        return;
      }
      await auditRouteRefusal(req, 'warrant', id, 'WARRANT_AUTHORITY_IMMUTABLE', refusal);
      res.status(422).json({ error: 'Refused', code: 'WARRANT_AUTHORITY_IMMUTABLE', message: `a warrant's ${forbidden.join('/')} never change${forbidden.length > 1 ? '' : 's'} (AZ-A13 clause 10a): a different holder or anchor set is a new warrant`, ...refusal });
      return;
    }
    if (editAct) {
      // clause 4a: the administrator arm is admitted AHEAD of the self-scope
      // concealment, for the edit acts only (D-10, D-11).
      const standing = await editorStanding(req, existing.holderPrincipalId);
      if (!standing) {
        await refuseStanding(req, res, 'warrant', id, { concealAs: 'WARRANT_NOT_FOUND' });
        return;
      }
      if (applyRevert !== undefined) {
        const reverted = await authorityEditExecutor.applyDueRevert(
          id, String(applyRevert), controls.acknowledgeDependents === true, auditActorFromRequest(req));
        res.json({ success: true, revert: reverted, warrant: await warrantService.get(id) });
        return;
      }
      const result = await authorityEditExecutor.editObject({
        type: 'warrant', id, fields, editor: editorContext(req, standing),
        stepUpToken: controls.stepUpToken, lifetime: controls.lifetime, reason: controls.reason,
        narrowAgents: controls.narrowAgents, acknowledgeDependents: controls.acknowledgeDependents,
      }, auditActorFromRequest(req));
      const renamed = name !== undefined || description !== undefined
        ? await warrantService.update(id, { name, description }, auditActorFromRequest(req))
        : await warrantService.get(id);
      res.json({ ...editResponse(result), warrant: renamed });
      return;
    }
    if (await concealForeign(viewer, existing.holderPrincipalId)) {
      res.status(404).json({ error: 'Refused', code: 'WARRANT_NOT_FOUND', message: 'No such warrant' });
      return;
    }
    const warrant = await warrantService.update(id, { name, description }, auditActorFromRequest(req));
    res.json({ success: true, warrant });
  } catch (e) {
    if (sendAuthorityEditError(res, e)) return;
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
