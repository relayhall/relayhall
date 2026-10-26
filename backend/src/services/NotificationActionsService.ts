/**
 * NotificationActionsService — "Needs your action" (Notifications and Timeline
 * design section 3, Slice A; card 5854f0d6; owner ruling E394, choices C1-C3).
 *
 * Each item is DERIVED at read time from state the board already keeps,
 * through the code's own predicates. There is no queue table: an item is open
 * while its condition holds and leaves when it ends (choice C2: no dismiss, no
 * snooze). The one stored state is the caller's SEEN mark (owner ruling E455,
 * which amends section 3.2 and C2; migration 169): a seen item STAYS listed
 * until it is resolved, shown as seen, and the bell counts only the unseen
 * ones. The mark records the item's `since`, so a new occurrence of the same
 * key (a new `since`) reads as unseen again. The four kinds (choice C1):
 *
 *   decision  a hub approval item (not skill-publish, not native-review) that is
 *             pending and `decidable` for this session: `ApprovalHubService.list`,
 *             exactly the hub's `waitingOnYou` minus those two kinds;
 *   verify    a Task in Review whose Verifier is in the caller's principal
 *             subtree (a Project or Phase default is already copied there at
 *             creation, migration 155), OR an ACTIVE native review naming the
 *             caller's subtree as Verifier, by the hub's own read
 *             (`verificationRequests`, unchanged); and a Task in Review with NO
 *             usable Verifier (`verifierUnusableSql` over
 *             `usableVerifierPrincipalIds`, the list filter's one predicate),
 *             addressed to the Task's account owner. One item per Task;
 *   stuck     `tasks.status = 'stuck'`, OR in progress with a `task.stuck` row at
 *             or after the sweep's own activity clock (`stuckActivityAtSql`,
 *             exported from TelemetryService), addressed to the shepherd, else
 *             the creator, else the Assignee;
 *   skill     the hub's skill-review rule, unchanged (human, skills:admin,
 *             write on the Skill, not the version's creator).
 *
 * WHO SEES WHAT. Every task item rides the shared task predicate IN the query.
 * A login session gets every kind; any other credential (an Account's own
 * bearer, its Connectors and Agents) gets verify and stuck only, as the hub is
 * a login-session surface. Each kind is capped at ACTIONS_KIND_CAP rows, with a
 * `capped` flag; the list is not paged.
 *
 * THE PER-TASK FORM (universal harness connector design, owner ruling E462,
 * section 6.1). `openTaskItems` answers the same verify and stuck questions for
 * named Tasks only, through the SAME two queries the list runs (one SQL source,
 * narrowed by an id filter, never a copy). The Connector wake rings `verify`
 * and `stuck` from it, so a Connector is rung for exactly the items its own
 * `GET /notifications/actions` would list.
 *
 * THE OWNER-QUEUE FORM (owner ruling E467, option A). `listForOwner` answers a
 * caller that is a person's own Connector, or an Agent under it, with the items
 * waiting on the owning Account (the login-session list: Decisions, Verify,
 * Stuck, Skill reviews, that Account's seen marks) as well as the caller's own.
 * It compiles BOTH lists through `compile`, the one body `list` itself runs, so
 * there is no second copy of any predicate or cap. It never widens what the
 * caller can read: an item's title, Project name and detail are kept only where
 * the CALLER's own read scope reaches the object it points at (the Task, the
 * Skill, the Project), the same decision a point read makes; every other item
 * is kind, id, how long it has waited and the board link. A caller that is not
 * a delegated principal of a person's Account gets exactly its own list. The
 * form is read only: it marks nothing seen and decides nothing.
 */
import { pool as defaultPool } from '../db/connection';
import type { Pool } from 'pg';
import type { AuthorizationListScope } from './AuthorizationRepository';
import { approvalHubService, type HubItem, type HubViewer } from './ApprovalHubService';
import { stuckActivityAtSql, stuckEpisodeAnnouncedSql } from './TelemetryService';
import { usableVerifierPrincipalIds, verifierUnusableSql } from './VerifierUsability';
import { draftVisibilitySql, type SkillViewer } from './SkillManager';

export const ACTION_KINDS = ['decision', 'verify', 'stuck', 'skill'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** Each kind lists at most this many items (design section 3.3). */
export const ACTIONS_KIND_CAP = 200;

/** The hub kinds that are NOT Decisions: a skill review is its own kind, and a
 * native review waits on a Verifier (it is never `decidable`). */
const NOT_DECISIONS = new Set(['skill-publish', 'native-review']);

export interface ActionsViewer {
  principalId: string;
  /** A login session: only these read Decisions and Skill reviews. */
  isSession: boolean;
  taskScope: AuthorizationListScope<'task'>;
  /** Project names are shown only to a `projects:read` holder who reads the Project. */
  projectScope: AuthorizationListScope<'project'> | null;
  /** The approvals hub's own viewer for this request. */
  hub: HubViewer;
  /** The Skill read scope, null when the caller lacks `skills:read`: used by the owner-queue form only. */
  skillScope?: AuthorizationListScope<'skill'> | null;
  /** The registry's draft rule for this caller (an unpublished Skill is neither listed nor found without it). */
  skillViewer?: SkillViewer | null;
}

export interface ActionItem {
  key: string;
  kind: ActionKind;
  /** The caller has marked THIS occurrence seen (E455): its stored mark carries the item's current `since`. */
  seen: boolean;
  /** Why the item is open: `verifier`, `native-review`, `no-verifier`, `status`, `episode`, or the hub kind. */
  reasons: string[];
  /** Since when it has waited. */
  since: string;
  object: { type: 'task' | 'approval' | 'skill'; id: string; title: string | null };
  project: { id: string; name: string | null } | null;
  /** Where the act is done (a dashboard path). */
  href: string;
  detail: Record<string, unknown>;
}

export interface ActionsAnswer {
  items: ActionItem[];
  /** `total` counts every listed item; `unseen` only the ones not marked seen (the bell's number, E455). */
  counts: Record<ActionKind | 'total' | 'unseen', number>;
  capped: Record<ActionKind, boolean>;
}

/** An action item key as GET /notifications/actions writes it (and migration 169's CHECK admits). */
export const ACTION_KEY = /^(decision|verify|stuck|skill):[0-9A-Za-z._-]{1,128}$/;
/** The most keys one POST /notifications/actions/seen names (every kind at its cap). */
export const ACTION_SEEN_MAX_KEYS = ACTIONS_KIND_CAP * ACTION_KINDS.length;

/** What to mark seen: the named keys, or every item the caller's list holds now ("Mark all seen"). */
export type ActionsSeenRequest = { all: true } | { all?: false; keys: string[] };

const iso = (value: unknown): string => new Date(value as string).toISOString();

/** An open Verify item in the per-Task form: why it is open, since when, and
 * the active native reviews behind its `native-review` reason (their ids). */
export interface OpenVerifyItem { reasons: string[]; since: string; nativeReviewIds?: string[] }
/** An open Stuck item in the per-Task form: the Task status (`stuck` or an announced episode) and since when. */
export interface OpenStuckItem { status: string; since: string }
/** The per-Task form's answer, keyed by Task id: only the Tasks whose item is open for this viewer. */
export interface OpenTaskItems {
  verify: Map<string, OpenVerifyItem>;
  stuck: Map<string, OpenStuckItem>;
}

/** The objects an item points at, for the owner-queue form's read check. */
interface ReadTargets { task: string | null; project: string | null; skill: string | null }

/** One owner-queue item (E467): an action item plus whether the caller reads its object, who it waits on and for how long. */
export interface OwnerActionItem extends ActionItem {
  /** False when the caller cannot read the object: then only kind, id, wait and link are given (title null, no reasons, project or detail). */
  readable: boolean;
  /** `account` the owning person's list only, `caller` the caller's own list only, `both` on each. */
  waitingOn: 'account' | 'caller' | 'both';
  /** Seconds since `since`, at `asOf`. */
  waitedSeconds: number;
}

export interface OwnerActionsAnswer {
  /** `owning-account`: the person's queue is included; `own`: the caller has no such Account, this is its own list. */
  scope: 'owning-account' | 'own';
  items: OwnerActionItem[];
  counts: Record<ActionKind | 'total' | 'unseen', number>;
  capped: Record<ActionKind, boolean>;
  asOf: string;
}

/** The hub's active native reviews that name the viewer's subtree as Verifier (the Verify item's native-review arm). */
function nativeReviewsFor(hubItems: HubItem[], subtree: Set<string>): HubItem[] {
  return hubItems.filter((item) => item.kind === 'native-review'
    && subtree.has(String((item as { verification?: { verifierPrincipalId?: string } }).verification?.verifierPrincipalId ?? '')));
}

export class NotificationActionsService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async list(viewer: ActionsViewer): Promise<ActionsAnswer> {
    return (await this.compile(viewer)).answer;
  }

  /**
   * The list and, beside it, the objects each item points at (for the
   * owner-queue form's read check). `list` is `compile(...).answer`: one body.
   */
  private async compile(viewer: ActionsViewer): Promise<{ answer: ActionsAnswer; targets: Map<string, ReadTargets> }> {
    // The hub, read once: a login session's whole pending list, a bearer only
    // its active native reviews (the Verify arm the hub serves to any reader).
    const hubItems: HubItem[] = await approvalHubService.list(
      viewer.hub, viewer.isSession ? { status: 'pending' } : { status: 'pending', kind: 'native-review' },
    );
    const subtree = await this.subtree(viewer.principalId);

    const decisions = viewer.isSession
      ? hubItems.filter((item) => !NOT_DECISIONS.has(String(item.kind)) && item.status === 'pending' && item.decidable !== false)
      : [];
    const skills = viewer.isSession ? hubItems.filter((item) => item.kind === 'skill-publish') : [];
    const nativeReviews = nativeReviewsFor(hubItems, subtree);

    const verify = await this.verify(viewer, nativeReviews, null);
    const stuck = await this.stuck(viewer, null);
    const projectNames = await this.projectNames(viewer, [...verify.rows, ...stuck.rows].map((row) => row.project_id));
    const projectOf = (id: unknown) => (id ? { id: String(id), name: projectNames.get(String(id)) ?? null } : null);

    const decisionItems = decisions
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
      .slice(0, ACTIONS_KIND_CAP)
      .map((item): ActionItem => ({
        key: `decision:${item.id}`,
        kind: 'decision',
        seen: false,
        reasons: [String(item.kind)],
        since: iso(item.requestedAt),
        object: { type: 'approval', id: String(item.id), title: item.refs?.task?.title ?? null },
        project: item.refs?.project ? { id: item.refs.project.id, name: item.refs.project.title } : null,
        href: `/notifications?tab=approvals&approval=${item.id}`,
        detail: { approvalKind: item.kind, requesterHandle: item.requesterHandle ?? null },
      }));
    const verifyItems = verify.rows.slice(0, ACTIONS_KIND_CAP).map((row): ActionItem => ({
      key: `verify:${row.id}`,
      kind: 'verify',
      seen: false,
      reasons: row.reasons,
      since: iso(row.since),
      object: { type: 'task', id: String(row.id), title: row.title ?? null },
      project: projectOf(row.project_id),
      href: `/tasks/${row.id}`,
      detail: {},
    }));
    const stuckItems = stuck.rows.slice(0, ACTIONS_KIND_CAP).map((row): ActionItem => ({
      key: `stuck:${row.id}`,
      kind: 'stuck',
      seen: false,
      reasons: [row.status === 'stuck' ? 'status' : 'episode'],
      since: iso(row.since),
      object: { type: 'task', id: String(row.id), title: row.title ?? null },
      project: projectOf(row.project_id),
      href: `/tasks/${row.id}`,
      detail: row.reason ? { reason: row.reason } : {},
    }));
    const skillItems = skills
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
      .slice(0, ACTIONS_KIND_CAP)
      .map((item): ActionItem => {
        const skill = (item as { skill?: { id: string; name: string; version: number } }).skill;
        return {
          key: `skill:${item.id}`,
          kind: 'skill',
          seen: false,
          reasons: ['skill-publish'],
          since: iso(item.requestedAt),
          object: { type: 'skill', id: String(skill?.id ?? ''), title: skill?.name ?? null },
          project: null,
          href: `/skills?skill=${skill?.id ?? ''}`,
          detail: { versionId: String(item.id), version: skill?.version ?? null, requesterHandle: item.requesterHandle ?? null },
        };
      });

    const items = [...decisionItems, ...verifyItems, ...stuckItems, ...skillItems];
    // E455: an item is seen while the caller's own mark names THIS occurrence.
    const marks = await this.seenMarks(viewer.principalId, items.map((item) => item.key));
    for (const item of items) item.seen = marks.get(item.key) === Date.parse(item.since);
    const counts = {
      decision: decisionItems.length, verify: verifyItems.length, stuck: stuckItems.length, skill: skillItems.length,
      total: items.length,
      unseen: items.filter((item) => !item.seen).length,
    };
    // The objects each listed item points at, by key: a Decision's Task and
    // Project (its hub refs), a Task item's Task and Project, a Skill review's Skill.
    const targets = new Map<string, ReadTargets>();
    for (const item of decisions) {
      targets.set(`decision:${item.id}`, { task: item.refs?.task?.id ?? null, project: item.refs?.project?.id ?? null, skill: null });
    }
    for (const item of [...verifyItems, ...stuckItems]) {
      targets.set(item.key, { task: item.object.id, project: item.project?.id ?? null, skill: null });
    }
    for (const item of skillItems) targets.set(item.key, { task: null, project: null, skill: item.object.id || null });
    return {
      answer: {
        items,
        counts,
        capped: {
          decision: decisions.length > ACTIONS_KIND_CAP,
          verify: verify.rows.length > ACTIONS_KIND_CAP,
          stuck: stuck.rows.length > ACTIONS_KIND_CAP,
          skill: skills.length > ACTIONS_KIND_CAP,
        },
      },
      targets,
    };
  }

  /**
   * The owner-queue form (E467). `caller` is the credential's own viewer;
   * `account` is the owning person's Account viewer as a login session, or null
   * when the caller has no such Account (then the answer is the caller's own
   * list, every item readable by construction: it rode the caller's scope).
   *
   * With an Account: the Account's list (`compile`: its predicates, caps and
   * seen marks) is read, each item is checked against the CALLER's read scope
   * and stripped to kind, id, wait and link where the caller cannot read the
   * object it points at, and the caller's own list is merged in by key (an
   * item on both is readable, since the caller's own list rode the caller's
   * scope). A Decision is readable where its Task is, and then gives that
   * Task's title only: its reasons (the approval kind) and detail (the
   * requester) are kept only where the caller passes the approval point read.
   * An item's `seen` is the Account's mark for an item on the Account's list
   * and the caller's own mark for one only the caller holds. The merged list is
   * capped per kind as a list is, oldest first.
   */
  async listForOwner(caller: ActionsViewer, account: ActionsViewer | null, now: Date = new Date()): Promise<OwnerActionsAnswer> {
    const own = await this.compile(caller);
    const wait = (since: string): number => Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 1000));
    const merged = new Map<string, OwnerActionItem>();
    let accountCapped: Record<ActionKind, boolean> | null = null;

    if (account) {
      const theirs = await this.compile(account);
      accountCapped = theirs.answer.capped;
      const wanted = { task: [] as string[], project: [] as string[], skill: [] as string[] };
      for (const target of theirs.targets.values()) {
        if (target.task) wanted.task.push(target.task);
        if (target.project) wanted.project.push(target.project);
        if (target.skill) wanted.skill.push(target.skill);
      }
      const readableTasks = await this.readableIds(caller.taskScope, wanted.task);
      const readableSkills = await this.readableSkillIds(caller, wanted.skill);
      const projectNames = await this.projectNames(caller, wanted.project);
      const openApprovals = this.openableApprovalKeys(caller, own.answer.items);
      for (const item of theirs.answer.items) {
        const target = theirs.targets.get(item.key);
        const readable = item.kind === 'skill'
          ? Boolean(target?.skill && readableSkills.has(target.skill))
          : Boolean(target?.task && readableTasks.has(target.task));
        // A Decision's reasons (the approval's kind) and detail (its requester) are approval content: kept only
        // where the caller passes the approval's own point read (GET /approvals/{id}); its Task's title, shown
        // under the Task read above, is all a Decision otherwise gives.
        const approvalOpen = item.kind !== 'decision' || openApprovals.has(item.key);
        merged.set(item.key, readable
          ? {
            ...item,
            reasons: approvalOpen ? item.reasons : [],
            // A Skill review's detail names the requester and the version: content the caller does not read, so
            // only a Task item, or a Decision whose approval the caller opens, keeps its detail.
            detail: item.kind === 'verify' || item.kind === 'stuck' || (item.kind === 'decision' && approvalOpen) ? item.detail : {},
            // A Project the caller cannot read has no name to give, and its id is not given either.
            project: item.project && projectNames.has(item.project.id) ? { id: item.project.id, name: projectNames.get(item.project.id)! } : null,
            readable: true, waitingOn: 'account', waitedSeconds: wait(item.since),
          }
          : {
            key: item.key, kind: item.kind, seen: item.seen, reasons: [], since: item.since,
            object: { type: item.object.type, id: item.object.id, title: null },
            project: null, href: item.href, detail: {},
            readable: false, waitingOn: 'account', waitedSeconds: wait(item.since),
          });
      }
    }

    for (const item of own.answer.items) {
      const held = merged.get(item.key);
      if (held) {
        // On both lists: the person's seen mark stands; the caller's own reasons join; its own list rode its scope.
        held.waitingOn = 'both';
        held.reasons = [...new Set([...held.reasons, ...item.reasons])];
        if (!held.readable) {
          Object.assign(held, { object: item.object, project: item.project, detail: item.detail, readable: true });
        }
        continue;
      }
      merged.set(item.key, { ...item, readable: true, waitingOn: 'caller', waitedSeconds: wait(item.since) });
    }

    const items: OwnerActionItem[] = [];
    const capped = { decision: false, verify: false, stuck: false, skill: false } as Record<ActionKind, boolean>;
    for (const kind of ACTION_KINDS) {
      const ofKind = [...merged.values()].filter((item) => item.kind === kind)
        .sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.key.localeCompare(b.key));
      capped[kind] = own.answer.capped[kind] || Boolean(accountCapped?.[kind]) || ofKind.length > ACTIONS_KIND_CAP;
      items.push(...ofKind.slice(0, ACTIONS_KIND_CAP));
    }
    const counts = {
      decision: items.filter((item) => item.kind === 'decision').length,
      verify: items.filter((item) => item.kind === 'verify').length,
      stuck: items.filter((item) => item.kind === 'stuck').length,
      skill: items.filter((item) => item.kind === 'skill').length,
      total: items.length,
      unseen: items.reduce((count, item) => count + (item.seen ? 0 : 1), 0),
    };
    return { scope: account ? 'owning-account' : 'own', items, counts, capped, asOf: now.toISOString() };
  }

  /**
   * The Decisions the caller passes the approval point read for (`GET
   * /approvals/{id}`), as item keys. That route is a login-session act: a
   * bearer credential is refused there outright (`SESSION_ONLY`), so a bearer
   * opens none. A session opens exactly the approvals its own queue lists (the
   * route's self-scope text is the one the hub list reads), which are the
   * Decisions on its own compiled list; a cap or a not-decidable item fails
   * closed.
   */
  private openableApprovalKeys(caller: ActionsViewer, ownItems: ActionItem[]): Set<string> {
    if (!caller.isSession) return new Set();
    return new Set(ownItems.filter((item) => item.kind === 'decision').map((item) => item.key));
  }

  /**
   * Which Skills the caller reads at the registry's own point route: its read
   * scope AND the catalogue rule (`draftVisibilitySql`, the one `GET /skills/:id`
   * applies): a Skill with no published Version is found only by a caller who
   * may see its drafts. Without `skills:read` (no scope) none.
   */
  private async readableSkillIds(caller: ActionsViewer, ids: string[]): Promise<Set<string>> {
    const wanted = [...new Set(ids.filter(Boolean).map(String))];
    const scope = caller.skillScope ?? null;
    if (!scope || wanted.length === 0) return new Set();
    const params: unknown[] = [wanted];
    const rendered = scope.render(params.length + 1);
    params.push(...rendered.params);
    const viewer = caller.skillViewer ?? null;
    let draft = 'FALSE';
    if (viewer) {
      const account = viewer.manage && viewer.accountId ? (params.push(viewer.accountId), `$${params.length}`) : null;
      draft = draftVisibilitySql(viewer, account, true);
    }
    const result = await this.pool.query(
      `SELECT ${scope.id}::text AS id FROM ${scope.from}
        WHERE ${scope.id} = ANY($1::uuid[]) AND ${rendered.sql}
          AND (s.current_published_version_id IS NOT NULL OR ${draft})`, params);
    return new Set(result.rows.map((row) => String(row.id)));
  }

  /** Which of these ids the viewer's read scope reaches: the point-read decision, as a set. */
  private async readableIds(scope: AuthorizationListScope | null, ids: string[]): Promise<Set<string>> {
    const wanted = [...new Set(ids.filter(Boolean).map(String))];
    if (!scope || wanted.length === 0) return new Set();
    const params: unknown[] = [wanted];
    const rendered = scope.render(params.length + 1);
    params.push(...rendered.params);
    const result = await this.pool.query(
      `SELECT ${scope.id}::text AS id FROM ${scope.from} WHERE ${scope.id} = ANY($1::uuid[]) AND ${rendered.sql}`, params);
    return new Set(result.rows.map((row) => String(row.id)));
  }

  /**
   * `POST /notifications/actions/seen` (E455): mark items of the CALLER'S OWN
   * current list seen, per item or all of them. The list is read first through
   * the same predicates as the GET, and only its keys are marked: a key that is
   * not on it (another principal's item, an object the caller cannot read, a
   * resolved item, a key that never existed) is ignored alike, so the answer
   * says nothing about it and nothing is stored for it. Each mark records the
   * item's current `since`; a new occurrence reads as unseen again. While no
   * kind is capped, the caller's marks of items no longer listed are dropped,
   * so the table holds at most one row per open item. The answer is the list as
   * it now reads, with `marked`: how many of the caller's own items this call
   * marked.
   */
  async markSeen(viewer: ActionsViewer, request: ActionsSeenRequest): Promise<ActionsAnswer & { marked: number }> {
    const answer = await this.list(viewer);
    const chosen: Array<{ key: string; since: string }> = request.all === true
      ? answer.items
      : answer.items.filter((item) => request.keys.includes(item.key));
    if (chosen.length > 0) {
      await this.pool.query(
        `INSERT INTO notification_action_seen (principal_id, item_key, since, seen_at)
         SELECT $1::uuid, marked.item_key, marked.since, now()
           FROM unnest($2::text[], $3::timestamptz[]) AS marked(item_key, since)
         ON CONFLICT (principal_id, item_key) DO UPDATE
           SET since = EXCLUDED.since, seen_at = now()`,
        [viewer.principalId, chosen.map((item) => item.key), chosen.map((item) => item.since)],
      );
    }
    if (!ACTION_KINDS.some((kind) => answer.capped[kind])) {
      await this.pool.query(
        `DELETE FROM notification_action_seen WHERE principal_id = $1::uuid AND NOT (item_key = ANY($2::text[]))`,
        [viewer.principalId, answer.items.map((item) => item.key)],
      );
    }
    const keys = new Set(chosen.map((item) => item.key));
    for (const item of answer.items) if (keys.has(item.key)) item.seen = true;
    answer.counts.unseen = answer.items.filter((item) => !item.seen).length;
    return { ...answer, marked: chosen.length };
  }

  /**
   * The per-Task form of the Verify and Stuck kinds (design section 6.1): for
   * each named Task, whether its Verify or Stuck item is open for this viewer,
   * answered by the list's own two queries narrowed to these ids, with the
   * native-review arm read from the hub exactly as a bearer's list reads it.
   * A Task the viewer cannot read is never in the answer (the shared task
   * predicate rides in the query). Verify keeps every reason the list would
   * give; a caller that wants only some (the wake) filters them itself.
   */
  async openTaskItems(viewer: ActionsViewer, taskIds: string[]): Promise<OpenTaskItems> {
    const ids = [...new Set(taskIds.map(String))].slice(0, ACTIONS_KIND_CAP);
    const answer: OpenTaskItems = { verify: new Map(), stuck: new Map() };
    if (ids.length === 0) return answer;
    const hubItems: HubItem[] = await approvalHubService.list(viewer.hub, { status: 'pending', kind: 'native-review' });
    const subtree = await this.subtree(viewer.principalId);
    const verify = await this.verify(viewer, nativeReviewsFor(hubItems, subtree), ids);
    const stuck = await this.stuck(viewer, ids);
    // E462 S4b (S4 review fold): the native-review arm's occurrence is its review id.
    const reviews = nativeReviewsFor(hubItems, subtree);
    for (const row of verify.rows) {
      answer.verify.set(String(row.id), { reasons: row.reasons, since: iso(row.since),
        nativeReviewIds: reviews.filter((item) => String(item.targetTaskId) === String(row.id)).map((item) => String(item.id)).sort() });
    }
    for (const row of stuck.rows) answer.stuck.set(String(row.id), { status: String(row.status), since: iso(row.since) });
    return answer;
  }

  /** The caller's own seen marks for these keys: key -> the `since` it was marked at (ms). */
  private async seenMarks(principalId: string, keys: string[]): Promise<Map<string, number>> {
    const marks = new Map<string, number>();
    if (keys.length === 0) return marks;
    const result = await this.pool.query(
      `SELECT item_key, since FROM notification_action_seen
        WHERE principal_id = $1::uuid AND item_key = ANY($2::text[])`,
      [principalId, keys],
    );
    for (const row of result.rows) marks.set(String(row.item_key), new Date(row.since).getTime());
    return marks;
  }

  private async subtree(principalId: string): Promise<Set<string>> {
    const result = await this.pool.query(
      `WITH RECURSIVE my_subtree(id) AS (
         SELECT id FROM principals WHERE id = $1::uuid
         UNION
         SELECT c.id FROM principals c JOIN my_subtree s ON c.parent_principal_id = s.id
       ) SELECT id::text AS id FROM my_subtree`, [principalId]);
    return new Set(result.rows.map((row) => String(row.id)));
  }

  /**
   * Verify and Verify (no Verifier): one item per Task, oldest first. With
   * `onlyTaskIds` it is the per-Task form: the same query, narrowed to them.
   */
  private async verify(viewer: ActionsViewer, nativeReviews: HubItem[], onlyTaskIds: string[] | null): Promise<{ rows: any[] }> {
    const params: unknown[] = [viewer.principalId];
    const usable = await usableVerifierPrincipalIds(this.pool);
    params.push(usable);
    const usableParam = `$${params.length}`;
    const nativeTaskIds = [...new Set(nativeReviews.map((item) => String(item.targetTaskId)))];
    params.push(nativeTaskIds);
    const nativeParam = `$${params.length}`;
    params.push(onlyTaskIds);
    const onlyParam = `$${params.length}`;
    const scope = viewer.taskScope.render(params.length + 1);
    params.push(...scope.params);
    params.push(ACTIONS_KIND_CAP + 1);
    const result = await this.pool.query(
      `WITH RECURSIVE my_subtree(id) AS (
         SELECT id FROM principals WHERE id = $1::uuid
         UNION
         SELECT c.id FROM principals c JOIN my_subtree s ON c.parent_principal_id = s.id
       ),
       open AS (
         SELECT vt.id, vt.title, vt.project_id,
                (vt.status = 'review' AND vt.verifier_principal_id IN (SELECT id FROM my_subtree)) AS as_verifier,
                (vt.id = ANY(${nativeParam}::uuid[])) AS as_native,
                (vt.status = 'review' AND ${verifierUnusableSql('vt', usableParam)}
                  AND COALESCE(vt.account_owner_principal_id, vp.owner_principal_id) IN (SELECT id FROM my_subtree)) AS as_owner,
                COALESCE((SELECT max(fe.occurred_at) FROM feed_events fe
                           WHERE fe.object_type = 'task' AND fe.object_id = vt.id
                             AND fe.payload->>'status' = 'review'), vt.updated_at) AS since
           FROM tasks vt
           LEFT JOIN projects vp ON vp.id = vt.project_id
          WHERE EXISTS (SELECT 1 FROM ${viewer.taskScope.from} WHERE ${viewer.taskScope.id} = vt.id AND ${scope.sql})
            AND (${onlyParam}::uuid[] IS NULL OR vt.id = ANY(${onlyParam}::uuid[]))
       )
       SELECT id::text AS id, title, project_id::text AS project_id, since,
              array_remove(ARRAY[
                CASE WHEN as_verifier THEN 'verifier' END,
                CASE WHEN as_native THEN 'native-review' END,
                CASE WHEN as_owner THEN 'no-verifier' END], NULL) AS reasons
         FROM open
        WHERE as_verifier OR as_native OR as_owner
        ORDER BY since ASC, id ASC
        LIMIT $${params.length}`,
      params,
    );
    return { rows: result.rows };
  }

  /**
   * Stuck, addressed to the shepherd, else the creator, else the Assignee.
   * With `onlyTaskIds` it is the per-Task form: the same query, narrowed to them.
   */
  private async stuck(viewer: ActionsViewer, onlyTaskIds: string[] | null): Promise<{ rows: any[] }> {
    const params: unknown[] = [viewer.principalId, onlyTaskIds];
    const scope = viewer.taskScope.render(params.length + 1);
    params.push(...scope.params);
    params.push(ACTIONS_KIND_CAP + 1);
    const result = await this.pool.query(
      `SELECT st.id::text AS id, st.title, st.project_id::text AS project_id, st.status,
              CASE WHEN st.status = 'stuck'
                THEN COALESCE((SELECT max(fe.occurred_at) FROM feed_events fe
                                WHERE fe.object_type = 'task' AND fe.object_id = st.id
                                  AND fe.payload->>'status' = 'stuck'), st.updated_at)
                ELSE (SELECT max(fe.occurred_at) FROM feed_events fe
                       WHERE fe.name = 'task.stuck' AND fe.object_type = 'task' AND fe.object_id = st.id)
              END AS since,
              (SELECT fe.payload->>'reason' FROM feed_events fe
                WHERE fe.name = 'task.stuck' AND fe.object_type = 'task' AND fe.object_id = st.id
                ORDER BY fe.cursor DESC LIMIT 1) AS reason
         FROM tasks st
        WHERE COALESCE(st.shepherd_principal_id, st.creator_principal_id, st.owner_principal_id) = $1::uuid
          AND (st.status = 'stuck'
            OR (st.status = 'in-progress' AND ${stuckEpisodeAnnouncedSql('st.id', stuckActivityAtSql('st'))}))
          AND EXISTS (SELECT 1 FROM ${viewer.taskScope.from} WHERE ${viewer.taskScope.id} = st.id AND ${scope.sql})
          AND ($2::uuid[] IS NULL OR st.id = ANY($2::uuid[]))
        ORDER BY since ASC NULLS LAST, st.id ASC
        LIMIT $${params.length}`,
      params,
    );
    return { rows: result.rows };
  }

  private async projectNames(viewer: ActionsViewer, ids: unknown[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter(Boolean).map(String))];
    const names = new Map<string, string>();
    if (!viewer.projectScope || wanted.length === 0) return names;
    const params: unknown[] = [wanted];
    const scope = viewer.projectScope.render(params.length + 1);
    params.push(...scope.params);
    const result = await this.pool.query(
      `SELECT ${viewer.projectScope.id}::text AS id, p.name FROM ${viewer.projectScope.from}
        WHERE ${viewer.projectScope.id} = ANY($1::uuid[]) AND ${scope.sql}`, params);
    for (const row of result.rows) names.set(String(row.id), String(row.name));
    return names;
  }
}

export const notificationActionsService = new NotificationActionsService();
