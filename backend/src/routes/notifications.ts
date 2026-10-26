/**
 * /notifications — "Needs your action" and the Timeline (Notifications and
 * Timeline design, Slice A; card 5854f0d6; owner ruling E394, choice C3: a new
 * prefix of its own, mounted in routeRegistry with the route ceiling
 * `tasks:read`; it does not collide with `/notification-endpoints`).
 *
 *   GET  /notifications/actions         the open action items that wait on the caller
 *   GET  /notifications/actions/owner   the same, read only, plus the items waiting on the
 *                                       owning person's Account for a delegated caller (E467)
 *   POST /notifications/actions/seen    mark the caller's OWN action items seen (E455)
 *   GET  /notifications/timeline        every change the caller may see, newest first
 *                                       (with `q`, a text search: E453)
 *   POST /notifications/timeline/seen   the caller's OWN last-seen feed cursor
 *
 * The dashboard shows this family as the Action Center (owner ruling E453).
 * Nothing here reads or writes the old history's per-item read state; the old
 * `GET /tasks/notifications*` routes and `GET /dashboard/activity` stay until
 * one release after Slice B (choices C3, C11). The one MCP tool that composes
 * this family is the read-only `relayhall_action_items_list` over
 * `GET /notifications/actions/owner` (owner ruling E467, which supersedes
 * design section 6's "no MCP tool" for that one route); the Timeline and the
 * seen marks stay off MCP.
 */
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { actorFromRequest, authorizedListScope } from '../middleware/sharedAuthorization';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { scopesSatisfy } from '../utils/scopeMap';
import { administratorSessionOf, APPROVAL_DECIDE_ACT, isLoginSessionKind } from '../utils/administratorSession';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { scopesForRole } from '../utils/identityScopes';
import { principalService } from '../services/PrincipalService';
import {
  notificationActionsService, ACTION_KEY, ACTION_SEEN_MAX_KEYS, type ActionsSeenRequest, type ActionsViewer,
} from '../services/NotificationActionsService';
import {
  timelineService, decodeTimelineCursor, isTimelineTimeout, TIMELINE_TYPES, TIMELINE_PAGE_DEFAULT, TIMELINE_PAGE_MAX,
  TIMELINE_SEARCH_MAX, type TimelineQuery, type TimelineType, type TimelineViewer,
} from '../services/TimelineService';
import { promotedReportActor } from '../services/ReportVisibility';
import { viewerOf as skillViewerOf } from './skills';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The administrator login-session standing the approvals self-scope widens by (AZ-A9 clause 6). */
function administratorSession(req: AuthRequest): boolean {
  return isLoginSessionKind(req.authMethod) && administratorSessionOf({
    authMethod: req.authMethod,
    handle: req.userId,
    principalRole: req.principal?.role ?? null,
    sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, APPROVAL_DECIDE_ACT).ok;
}

function sendPrincipalRequired(res: Response): void {
  sendApiError(res, 403, 'PRINCIPAL_REQUIRED', 'Notifications are read per principal, and this identity has no resolved principal');
}

/** The Timeline's viewer: each object type's ceiling and list scope, from the request the shared middleware authenticated. */
export function timelineViewer(req: AuthRequest): TimelineViewer | null {
  const principalId = req.principal?.id;
  if (!principalId) return null;
  const scopes = req.scopes ?? null;
  const promoted = promotedReportActor(req);
  return {
    principalId,
    isRoot: scopesSatisfy(scopes, 'root'),
    isSession: isLoginSessionKind(req.authMethod),
    isAdministrator: administratorSession(req),
    ceilings: {
      reports: scopesSatisfy(scopes, 'reports:read'),
      phases: scopesSatisfy(scopes, 'phases:read'),
      projects: scopesSatisfy(scopes, 'projects:read'),
      skills: scopesSatisfy(scopes, 'skills:read'),
    },
    taskScope: authorizedListScope(req, 'task', 'read'),
    reportScope: authorizedListScope(req, 'report', 'read'),
    phaseScope: authorizedListScope(req, 'phase', 'read'),
    projectScope: authorizedListScope(req, 'project', 'read'),
    skillScope: authorizedListScope(req, 'skill', 'read'),
    reportActor: { principalId: promoted.principalId, root: promoted.root },
    skillViewer: skillViewerOf(req),
  };
}

/** The action list's viewer: the task scope, and the approvals hub's own viewer for this request. */
export function actionsViewer(req: AuthRequest): ActionsViewer | null {
  const principalId = req.principal?.id;
  if (!principalId) return null;
  const scopes = req.scopes ?? null;
  const isSession = isLoginSessionKind(req.authMethod);
  return {
    principalId,
    isSession,
    taskScope: authorizedListScope(req, 'task', 'read'),
    projectScope: scopesSatisfy(scopes, 'projects:read') ? authorizedListScope(req, 'project', 'read') : null,
    hub: {
      principalId,
      isRoot: scopesSatisfy(scopes, 'root'),
      administratorOk: administratorSession(req),
      principalKind: req.principal?.kind ?? null,
      scopes,
      actor: req.authorizationActor ?? actorFromRequest(req),
      authMethod: req.authMethod ?? null,
    },
  };
}

/**
 * The owner-queue caller (E467): the caller's own viewer, plus the Skill read
 * scope the form checks a Skill review against (null without `skills:read`).
 */
export function ownerQueueCaller(req: AuthRequest): ActionsViewer | null {
  const viewer = actionsViewer(req);
  if (!viewer) return null;
  const readsSkills = scopesSatisfy(req.scopes ?? null, 'skills:read');
  return { ...viewer, skillScope: readsSkills ? authorizedListScope(req, 'skill', 'read') : null, skillViewer: skillViewerOf(req) };
}

/**
 * The owning person's Account, as the login session it reads its own Action
 * Center under (E467), or null. Only a DELEGATED caller has one: the server-
 * resolved, live delegation chain (never a header or an argument) must end at
 * an active human Account that is the root of the chain, with no legacy
 * identity anywhere on it. Every other caller (an Account itself, a session,
 * a legacy key, a service Account's own chain) has none and is answered with
 * its own list. The viewer is built by `actionsViewer` from the request shape a
 * login session gives the route (the Account's role, its login scopes), so the
 * hub and the task predicates are the ones the Account's own page runs.
 */
export async function owningAccountViewer(req: AuthRequest): Promise<ActionsViewer | null> {
  const links = req.delegationLinks;
  if (!links || links.length < 2 || links.some((link) => link.legacyIdentity)) return null;
  const top = links[links.length - 1];
  if (top.kind !== 'human' || top.parentPrincipalId) return null;
  const account = await principalService.getPrincipalByIdStrict(top.principalId);
  if (!account || account.status !== 'active' || account.kind !== 'human' || account.parentPrincipalId) return null;
  const asSession = {
    principal: account,
    userId: account.handle,
    sessionRole: null,
    authMethod: 'session',
    scopes: scopesForRole(resolveActorRole({ handle: account.handle, principalRole: account.role })),
  } as unknown as AuthRequest;
  return actionsViewer(asSession);
}

/**
 * GET /notifications/actions/owner (owner ruling E467) — the owner-queue form
 * of the list, READ ONLY: for a person's own Connector, or an Agent under it,
 * the items waiting on the owning Account as well as the caller's own, each
 * with that person's seen state; for any other caller exactly its own list.
 * `{ scope, items[], counts, capped, asOf }`; each item adds `readable`,
 * `waitingOn` and `waitedSeconds` to the list's, and an object the CALLER
 * cannot read is kind, id, wait and link only. Route ceiling `tasks:read`, as
 * the list. It marks nothing seen and decides nothing.
 */
router.get('/actions/owner', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const caller = ownerQueueCaller(req);
    if (!caller) { sendPrincipalRequired(res); return; }
    const answer = await notificationActionsService.listForOwner(caller, await owningAccountViewer(req));
    res.json({ success: true, ...answer });
  } catch (err) {
    const errorId = logCaughtFailure('[Notifications API] Error reading the owner action queue:', err);
    sendApiError(res, 500, 'NOTIFICATION_ACTIONS_READ_FAILED', 'The action items could not be read', undefined, { errorId });
  }
});

/**
 * GET /notifications/actions — `{ items[], counts{decision,verify,stuck,skill,total,unseen}, capped }`.
 * Not paged; each kind is capped at 200 rows. Each item carries `seen` (E455);
 * the bell counts `counts.unseen`.
 */
router.get('/actions', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const viewer = actionsViewer(req);
    if (!viewer) { sendPrincipalRequired(res); return; }
    const answer = await notificationActionsService.list(viewer);
    res.json({ success: true, ...answer });
  } catch (err) {
    const errorId = logCaughtFailure('[Notifications API] Error reading action items:', err);
    sendApiError(res, 500, 'NOTIFICATION_ACTIONS_READ_FAILED', 'The action items could not be read', undefined, { errorId });
  }
});

/** Parse the seen request: `{ keys: [...] }` or `{ all: true }`, nothing else. A key is checked by its grammar only. */
export function parseActionsSeen(body: unknown): ActionsSeenRequest | { error: string } {
  const shape = 'The body is { keys: [action item keys] } or { all: true }';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: shape };
  const record = body as Record<string, unknown>;
  const fields = Object.keys(record);
  if (fields.length !== 1) return { error: shape };
  if (fields[0] === 'all') return record.all === true ? { all: true } : { error: shape };
  if (fields[0] !== 'keys' || !Array.isArray(record.keys)) return { error: shape };
  const keys = record.keys as unknown[];
  if (keys.length < 1 || keys.length > ACTION_SEEN_MAX_KEYS) return { error: `keys holds 1 to ${ACTION_SEEN_MAX_KEYS} action item keys` };
  if (!keys.every((key) => typeof key === 'string' && ACTION_KEY.test(key))) {
    return { error: 'Each key is an action item key as GET /notifications/actions returns it' };
  }
  return { keys: [...new Set(keys as string[])] };
}

/**
 * POST /notifications/actions/seen { keys } | { all: true } — mark the
 * caller's OWN action items seen (owner ruling E455). Only keys on the caller's
 * own current list are marked; any other key is ignored without a trace, so a
 * mark never widens what the caller sees and never says whether a key exists.
 * Route ceiling `tasks:read`, as the list itself; session and bearer alike.
 * Answers the list as it now reads, with `marked`.
 */
router.post('/actions/seen', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const viewer = actionsViewer(req);
    if (!viewer) { sendPrincipalRequired(res); return; }
    const request = parseActionsSeen(req.body);
    if ('error' in request) { sendApiError(res, 400, 'INVALID_ACTIONS_SEEN', request.error); return; }
    const answer = await notificationActionsService.markSeen(viewer, request);
    res.json({ success: true, ...answer });
  } catch (err) {
    const errorId = logCaughtFailure('[Notifications API] Error marking action items seen:', err);
    sendApiError(res, 500, 'NOTIFICATION_ACTIONS_SEEN_FAILED', 'The action items could not be marked seen', undefined, { errorId });
  }
});

type TimelineFilters = Omit<TimelineQuery, 'before' | 'limit'>;

/** Parse the Timeline's filters. A value outside a grammar is a 400, never a silently wider list. */
export function parseTimelineFilters(source: Record<string, unknown>): TimelineFilters | { error: string } {
  const one = (name: string): string | null | { error: string } => {
    const value = source[name];
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string') return { error: `${name} must be one value` };
    return value;
  };
  let types: TimelineType[] = [];
  const rawType = one('type');
  if (rawType !== null && typeof rawType === 'object') return rawType;
  if (rawType !== null && rawType !== 'all') {
    const parts = rawType.split(',').map((part) => part.trim()).filter(Boolean);
    const unknown = parts.filter((part) => !(TIMELINE_TYPES as readonly string[]).includes(part));
    if (unknown.length > 0) return { error: `Unknown timeline type: ${unknown.join(', ')} (one of ${TIMELINE_TYPES.join(', ')})` };
    types = [...new Set(parts)] as TimelineType[];
  }
  const ids: Record<'project' | 'phase' | 'person', string | null> = { project: null, phase: null, person: null };
  for (const name of ['project', 'phase', 'person'] as const) {
    const value = one(name);
    if (value !== null && typeof value === 'object') return value;
    if (value !== null && !UUID.test(value)) return { error: `${name} must be a UUID` };
    ids[name] = value === null ? null : value.toLowerCase();
  }
  const dates: Record<'since' | 'until', string | null> = { since: null, until: null };
  for (const name of ['since', 'until'] as const) {
    const value = one(name);
    if (value !== null && typeof value === 'object') return value;
    if (value !== null && (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) || Number.isNaN(Date.parse(value)))) {
      return { error: `${name} must be an ISO 8601 date or time` };
    }
    dates[name] = value === null ? null : new Date(value).toISOString();
  }
  const scope = one('scope');
  if (scope !== null && typeof scope === 'object') return scope;
  if (scope !== null && scope !== 'all' && scope !== 'mine') return { error: 'scope must be all or mine' };
  const acl = one('acl');
  if (acl !== null && typeof acl === 'object') return acl;
  if (acl !== null && !['true', 'false', '1', '0'].includes(acl)) return { error: 'acl must be true or false' };
  // E453: the text search, over the titles and labels of what the caller may see.
  const rawQ = one('q');
  if (rawQ !== null && typeof rawQ === 'object') return rawQ;
  const q = rawQ === null ? '' : rawQ.trim();
  if (q.length > TIMELINE_SEARCH_MAX) return { error: `q must be at most ${TIMELINE_SEARCH_MAX} characters` };
  return {
    q: q === '' ? null : q,
    types,
    acl: acl === 'true' || acl === '1',
    project: ids.project, phase: ids.phase, person: ids.person,
    since: dates.since, until: dates.until,
    // Choice C7: the default scope is "Everything I can see".
    scope: scope === 'mine' ? 'mine' : 'all',
  };
}

/**
 * GET /notifications/timeline?before&limit&type&project&phase&person&since&until&scope&acl&q
 * — `{ items[], nextCursor, hasMore, headCursor, lastSeen }`, newest first.
 */
router.get('/timeline', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const filters = parseTimelineFilters(req.query as Record<string, unknown>);
    if ('error' in filters) { sendApiError(res, 400, 'INVALID_TIMELINE_FILTER', filters.error); return; }
    const before = decodeTimelineCursor(req.query.before);
    if (before === 'invalid') { sendApiError(res, 400, 'INVALID_TIMELINE_CURSOR', 'before must be a cursor this route returned'); return; }
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? TIMELINE_PAGE_DEFAULT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > TIMELINE_PAGE_MAX) {
      sendApiError(res, 400, 'INVALID_TIMELINE_LIMIT', `limit must be an integer from 1 to ${TIMELINE_PAGE_MAX}`);
      return;
    }
    const viewer = timelineViewer(req);
    if (!viewer) { sendPrincipalRequired(res); return; }
    const page = await timelineService.page(viewer, { ...filters, before, limit });
    res.json({
      success: true,
      ...page,
      // "New since your last visit": the caller's own last-seen feed cursor.
      lastSeen: await timelineService.lastSeen(viewer.principalId),
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Notifications API] Error reading the timeline:', err);
    if (isTimelineTimeout(err)) {
      // A statement reached the Timeline's own ceiling: this one request
      // fails, and no connection or backend is held for it.
      sendApiError(res, 503, 'TIMELINE_READ_TIMEOUT', 'The timeline read took too long; narrow the filters or try again', undefined, { errorId });
      return;
    }
    sendApiError(res, 500, 'TIMELINE_READ_FAILED', 'The timeline could not be read', undefined, { errorId });
  }
});

/**
 * POST /notifications/timeline/seen { cursor } — moves the caller's OWN
 * last-seen feed cursor, clamped to the newest feed row the caller may see
 * (never the board-wide head) and never backwards. Written only here, never
 * by a GET. Route ceiling `tasks:read`.
 */
router.post('/timeline/seen', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const viewer = timelineViewer(req);
    if (!viewer) { sendPrincipalRequired(res); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(body);
    const raw = body.cursor;
    const cursor = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw)
      : typeof raw === 'string' && /^[0-9]{1,19}$/.test(raw) ? raw : null;
    if (keys.some((key) => key !== 'cursor') || cursor === null) {
      sendApiError(res, 400, 'INVALID_TIMELINE_SEEN', 'The body is { cursor }, a feed cursor this route family returned');
      return;
    }
    res.json({ success: true, lastSeen: await timelineService.markSeen(viewer, cursor) });
  } catch (err) {
    const errorId = logCaughtFailure('[Notifications API] Error recording the last-seen cursor:', err);
    if (isTimelineTimeout(err)) {
      sendApiError(res, 503, 'TIMELINE_READ_TIMEOUT', 'The timeline read took too long; try again', undefined, { errorId });
      return;
    }
    sendApiError(res, 500, 'TIMELINE_SEEN_FAILED', 'The last-seen cursor could not be recorded', undefined, { errorId });
  }
});

export default router;
