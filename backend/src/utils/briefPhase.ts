// briefPhase.ts - the Phase a compiled Brief may show for one Task (owner
// ruling E338, W62 option A).
//
// A Task carries no goal of its own; it inherits its Phase's, so the Brief has
// always embedded the bound Phase's name, goal and description (task-element
// design e20a12d6 §4, E-12). The Phase lists, the Map and a Warrant's linkage
// conceal a Phase the caller cannot read (card 1e0f3bd4), and the Brief did
// not: a caller holding only the Task read a restricted Phase's name, goal and
// description through it. E338 closes that: the Brief applies the same Phase
// read decision as every other surface, and for a caller who cannot read the
// Phase it omits the name, goal and description and states only that the Task
// sits in a restricted Phase. Granting the Phase is how that context is given.
//
// ONE DECISION, NOT A NEW RULE. Readability is asked of
// `authorizationRepository.authorizedIds(actor, 'phase', [id], 'read')`: the
// shared SQL adapter that `filterReadablePhases` (routes/phases.ts) reaches
// through `filterAuthorizedResources` for every Phase it cannot settle without
// a query, and that the session brief already asks for its bound Task. A Phase
// resource carries no owner, visibility or role column in memory, so the only
// rows the in-memory fast path in front of that adapter settles are root and a
// non-delegated administrator, and the adapter answers both the same way.
// `listPointParity` anchors the result on `GET /phases/{id}` for each caller.
//
// Every Brief altitude that renders a Task's Phase resolves it here: the task
// altitude (`generateTaskPromptWithSkills`, behind `POST /tasks/{id}/brief`,
// the MCP `relayhall_brief_compile` taskId altitude and the Agent-mint pack)
// and the project altitude with a taskId (`POST /projects/{id}/brief`).
import { phaseService, PhaseError, PhaseLookupError, type Phase } from '../services/PhaseService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import type { AuthorizationActor } from '../services/AuthorizationService';

/**
 * The one sentence a Brief carries for a Phase its caller cannot read. Fixed
 * text: nothing in it varies with the Phase, so it says the same thing of
 * every unreadable Phase and cannot be used to tell one from another.
 */
export const RESTRICTED_PHASE_NOTICE = 'This Task sits in a restricted Phase. Its name, goal and description '
  + 'are not shown because your grants do not reach that Phase; a grant on the Phase gives that context.';

/** What a Brief may show of a Task's Phase. */
export type BriefPhase =
  /** The Task has no Phase, or its Phase no longer exists (confirmed absence). */
  | { kind: 'none' }
  /** The caller may read the Phase: render it as before. */
  | { kind: 'readable'; phase: Phase }
  /** The caller may not: render its id and `RESTRICTED_PHASE_NOTICE` only. */
  | { kind: 'restricted'; id: string };

/**
 * Resolve the Phase a Brief may show for `taskId`, bound to `phaseId`, to
 * `actor`.
 *
 * FAIL-CLOSED both ways. A failed Phase read is not absence (review 1a786ae4
 * F2) and a failed authorization decision is not a refusal or a permission:
 * both raise `PhaseLookupError`, which every compile surface maps to a fixed
 * 503 carrying nothing exception-derived. No actor reads nothing, as the
 * referenced-Reports path already compiles: the Phase is concealed.
 */
export async function resolveBriefPhase(
  phaseId: string | null | undefined,
  actor: AuthorizationActor | null | undefined,
  taskId: string,
): Promise<BriefPhase> {
  if (!phaseId) return { kind: 'none' };
  let phase: Phase;
  try {
    phase = await phaseService.get(phaseId);
  } catch (e) {
    // Confirmed absence: the binding is gone, not unreadable. The composite FK
    // makes this unreachable in practice; absence keeps a deleted Phase from
    // wedging every Brief for its former members.
    if (e instanceof PhaseError && e.status === 404) return { kind: 'none' };
    throw new PhaseLookupError(`Phase lookup failed for task ${taskId}`);
  }
  const id = String(phase.id);
  if (!actor) return { kind: 'restricted', id };
  let readable: Set<string>;
  try {
    readable = await authorizationRepository.authorizedIds(actor, 'phase', [id], 'read');
  } catch {
    throw new PhaseLookupError(`Phase read decision failed for task ${taskId}`);
  }
  return readable.has(id) ? { kind: 'readable', phase } : { kind: 'restricted', id };
}
