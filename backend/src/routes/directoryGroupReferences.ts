/**
 * routes/directoryGroupReferences — THE REMOTE-GROUP CATALOG and one-click
 * *Use this group* (RH-LENSES-a, card `74e02a05`; design v5 `07764243` §5).
 *
 * ── WHAT THIS FAMILY IS FOR ──────────────────────────────────────────────
 *
 * Today an administrator binding a board Group to a directory group is told to
 * *"paste it unchanged"* (`frontend/src/pages/AccessManagerPage.tsx:1676`) — to
 * type an opaque provider string by hand, with no list of what the directory
 * has actually shown, and then to wait: members arrive only at their next
 * login. This family is the list, and `POST /:id/use` is the one click that
 * makes the Group and populates it in the same transaction.
 *
 * ── THE VISIBILITY, AS NARROWED BY DBD-14 ────────────────────────────────
 *
 * Design §5.3's table has three live rows: root session, STEWARD, everyone
 * else. `group_stewards` defers to LENSES-c with migration 126's successor, so
 * **in v1 the steward row has no subject** and the projection is:
 *
 *     a ROOT LOGIN SESSION            -> every row, counts over the whole store
 *     every other caller, bearer      -> `200` with an EMPTY LIST
 *     or session
 *
 * That is NARROWER than the design and than owner decision 5, never wider, and
 * it is register row **DBD-14** rather than a silent omission.
 *
 * **An empty list, not a `403`.** A 403 on a list route discloses that the
 * surface exists and is populated; an empty list discloses that the caller has
 * nothing here, which is true of a caller who has nothing here.
 *
 * **A bearer never sees it, however scoped.** AZ-18's owner plane is
 * session-only and a catalog is deployment-shaped disclosure — every external
 * group name in the estate, and how many people carry each. The classification
 * is `isLoginSessionKind` from `utils/administratorSession`, CALLED and never
 * re-implemented: it is the tree's only copy of "this request is a person's
 * login session, not a machine credential".
 *
 * ── NO MEMBER IDENTITIES, AT ANY DEPTH ───────────────────────────────────
 *
 * `[B6]`. There is deliberately **no `/directory-group-references/:id/members`
 * route** — design round 1 constructed the disclosure it would have been — and
 * `memberCount` is a COUNT, never an identity list. The owner asked for
 * *"every external group seen across people, member count"*: a count, not
 * identities. A person's OWN references are on their own profile, served by
 * `GET /principals/me/directory-group-references`, which is the caller's own
 * carriage and nobody else's.
 */
import { Router, Request, Response } from 'express';

import { AuthRequest } from '../middleware/auth';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { auditActorFromRequest } from '../utils/auditActor';
import { isLoginSessionKind } from '../utils/administratorSession';
import { directoryCarriageService, DirectoryCarriageError } from '../services/DirectoryCarriageService';

const router = Router();

/**
 * The v1 projection scope, in one place.
 *
 * BOTH halves are required and neither is sufficient: `root` alone is held by
 * bearer credentials this surface must not disclose to, and a login session
 * alone is held by every signed-in person. `A-L16` asserts the second half and
 * the catalog drill asserts the first.
 */
function projectionScope(req: AuthRequest): { rootSession: boolean } {
  return {
    rootSession: isLoginSessionKind(req.authMethod) && Boolean(req.scopes?.includes('root')),
  };
}

function sendCarriageError(res: Response, e: unknown): boolean {
  if (e instanceof DirectoryCarriageError) {
    sendApiError(res, e.status, e.code, e.message, undefined, e.field ? { field: e.field } : undefined);
    return true;
  }
  return false;
}

function logDirectoryGroupReferenceFailure(context: string, e: unknown): string {
  return logCaughtFailure(`[Directory group references API] ${context} failed:`, e);
}

/**
 * THE ONE 404, PRODUCED FROM ONE BRANCH.
 *
 * A reference that exists but is outside this caller's projection and one that
 * does not exist answer with the SAME status, the SAME code and the SAME body.
 * The estate standard landed with FIX-C at `21daf85`: *"refused in the same
 * words, from ONE branch, so closing the bypass does not open an oracle in its
 * place"*. Two branches producing "the same" body is how they stop being the
 * same, so there is one.
 */
function notFound(res: Response): void {
  sendApiError(res, 404, 'DIRECTORY_GROUP_REFERENCE_NOT_FOUND', 'No such directory group reference');
}

/** GET /api/directory-group-references — the catalog (principals:read + §5.3). */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const references = await directoryCarriageService.listReferences(projectionScope(req as AuthRequest));
    res.json({ success: true, references });
  } catch (e) {
    if (sendCarriageError(res, e)) return;
    const errorId = logDirectoryGroupReferenceFailure('list directory group references', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list directory group references', undefined, { errorId });
  }
});

/** GET /api/directory-group-references/:id — one row, 404-concealed. */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const reference = await directoryCarriageService.getReference(
      String(req.params.id), projectionScope(req as AuthRequest),
    );
    if (!reference) { notFound(res); return; }
    res.json({ success: true, reference });
  } catch (e) {
    if (sendCarriageError(res, e)) return;
    const errorId = logDirectoryGroupReferenceFailure('read directory group reference', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read directory group reference', undefined, { errorId });
  }
});

/**
 * POST /api/directory-group-references/:id/use — *Use this group*.
 *
 * ONE CLICK, ONE TRANSACTION: the Group is created, bound to the reference,
 * and populated from the reference's carriage, or none of it happens. A
 * project — or here, a Group — that exists without the membership its creator
 * believes it has is a support ticket, not an exception.
 *
 * The ceiling is `root` in `utils/scopeMap.ts`, because creating and binding a
 * Group are rule-4 acts A-4 and A-5 which `65b9ffa1` §1.3 refuses for every
 * bound caller and this card does not ask to change. It carries NO additional
 * in-handler session arm: design §5.1's surface table names the in-handler arm
 * for every route in this family and names none for this one, and adding a
 * session gate the surface table does not name would make obligation `B-L11a`'s
 * `relayhall directory-group-reference use` unreachable — the CLI presents a
 * bearer credential. The READ projection above is session-classified because
 * §5.3 says so in as many words; this write is not, because §5.1 does not.
 */
router.post('/:id/use', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!['name', 'description'].includes(key)) {
        sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' — accepted fields are: name, description`);
        return;
      }
    }
    const outcome = await directoryCarriageService.bindReferenceToGroup(
      String(req.params.id), body, auditActorFromRequest(req as AuthRequest),
    );
    res.status(201).json({
      success: true,
      groupId: outcome.groupId,
      groupName: outcome.groupName,
      memberCountApplied: outcome.memberCountApplied,
      externalGroupRef: outcome.reference.externalGroupRef,
    });
  } catch (e) {
    if (sendCarriageError(res, e)) return;
    const errorId = logDirectoryGroupReferenceFailure('bind directory group reference', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to bind directory group reference', undefined, { errorId });
  }
});

/**
 * DELETE /api/directory-group-references/:id — housekeeping (root).
 *
 * A reference whose carriage falls to zero is RETAINED, not deleted: the
 * catalog exists to tell an administrator what the directory has shown, and
 * one that forgets a group the moment its last member leaves cannot answer
 * *"is this the group I bound last month?"*. So forgetting is an explicit,
 * audited act — and it is REFUSED while the ref is bound to a Group, on the
 * `identity_provider_login_groups` `ON DELETE RESTRICT` precedent: unbind
 * first, which is itself audited.
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const outcome = await directoryCarriageService.deleteReference(
      String(req.params.id), auditActorFromRequest(req as AuthRequest),
    );
    res.json({ success: true, carriageRowsRemoved: outcome.carriageRowsRemoved });
  } catch (e) {
    if (sendCarriageError(res, e)) return;
    const errorId = logDirectoryGroupReferenceFailure('delete directory group reference', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to delete directory group reference', undefined, { errorId });
  }
});

export default router;
