// ProjectInboxPhase.ts — the per-Project inbox phase (card b13e5ac9, owner
// ruling D34(b), Charter v5 §6.1 and §6.2).
//
// Charter §6.1: "Each project keeps one inbox phase ... Every new card lands
// there with status Ideas, whether a human or an agent creates it." §6.2: an
// explicit placement in the request still wins (the authorised-work
// exception: a follow-up or a release blocker goes straight to To-Do in its
// active Phase).
//
// The setting is `projects.inbox_phase_id` (migration 141). Every creation
// surface — the dashboard form, REST `POST /tasks`, MCP
// `relayhall_task_create` and the CLI `relayhall create` — reaches
// `TaskManagerDB.createTask`, and that is the one place the default is
// decided, so no surface can drift from another.
//
// THE RULE, field by field (each explicit value wins for its own field):
//   * phaseId ABSENT from the request, and the Project has an inbox phase in
//     force -> the Task lands in the inbox phase. An explicit `phaseId: null`
//     is a choice (the unphased project backlog) and is honoured as one.
//   * status ABSENT, and the Task lands in the inbox phase (by default or by
//     naming it) -> status `ideas`. Otherwise an absent status keeps today's
//     default, `todo`.
//   * No inbox phase, an orphan Task (no Project), or an inbox phase that is
//     not in force -> exactly the behaviour before migration 141.
//
// IN FORCE means the Phase is neither archived nor restricted. PATCH
// /projects/:id refuses to NAME such a Phase, but a Phase can be archived or
// restricted after it was named; a default that silently filed new cards into
// an archived Phase, or into a restricted one where the Project's members can
// no longer see them, would be a data change nobody asked for. So the default
// is suspended, never redirected, while the Phase is in either state.

/** The status a Task gets when it lands in the inbox phase without one. */
export const INBOX_DEFAULT_STATUS = 'ideas' as const;
/** The status an absent status has always defaulted to everywhere else. */
export const ORDINARY_DEFAULT_STATUS = 'todo' as const;

export interface InboxPhase {
  id: string;
  name: string;
  status: string;
  restrictedAccess: boolean;
  /** False while the Phase is archived or restricted: the default is suspended. */
  inForce: boolean;
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * The Project's inbox phase as stored, or null when the Project names none.
 *
 * `lock` takes FOR SHARE on the Phase row, so a create that decided on this
 * Phase cannot have it archived or deleted underneath it before its INSERT
 * commits. Readers that only render (the Brief) do not lock.
 */
export async function readInboxPhase(
  queryable: Queryable,
  projectId: string,
  options: { lock?: boolean } = {},
): Promise<InboxPhase | null> {
  const result = await queryable.query(
    `SELECT ph.id, ph.name, ph.status, ph.restricted_access
       FROM projects p
       JOIN phases ph ON ph.id = p.inbox_phase_id AND ph.project_id = p.id
      WHERE p.id = $1${options.lock ? '\n      FOR SHARE OF ph' : ''}`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const restrictedAccess = Boolean(row.restricted_access);
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
    restrictedAccess,
    inForce: row.status !== 'archived' && !restrictedAccess,
  };
}

/** Absent, for a status: undefined, null or the empty string (the INSERT's `||` has always read them so). */
export function statusAbsent(status: unknown): boolean {
  return status === undefined || status === null || status === '';
}

/**
 * Where a new Task lands and with which status. Pure: the caller reads the
 * inbox phase (or passes null) and writes what this returns.
 *
 * `requestedPhaseId === undefined` is ABSENCE; `null` is the explicit backlog.
 */
export function resolveCreatePlacement(
  requested: { phaseId: string | null | undefined; status: unknown },
  inbox: Pick<InboxPhase, 'id' | 'inForce'> | null,
): { phaseId: string | null; status: string; landedInInbox: boolean } {
  const inForce = Boolean(inbox && inbox.inForce);
  const phaseId = requested.phaseId === undefined
    ? (inForce ? inbox!.id : null)
    : requested.phaseId;
  const landedInInbox = inForce && phaseId !== null && phaseId === inbox!.id;
  const status = statusAbsent(requested.status)
    ? (landedInInbox ? INBOX_DEFAULT_STATUS : ORDINARY_DEFAULT_STATUS)
    : String(requested.status);
  return { phaseId, status, landedInInbox };
}
