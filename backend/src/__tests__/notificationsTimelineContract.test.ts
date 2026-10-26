/**
 * Notifications and Timeline, Slice A (card 5854f0d6; owner ruling E394): the
 * REGISTERS that need no database.
 *
 *   (1) the route family: four routes (the three of the design and the E455
 *       seen mark), their exact scope rows (tasks:read; any other path or
 *       method under the mount falls to root), the registry order, the
 *       transport class, and no MCP tool (design section 6); the grammars of
 *       the E453 text search and the E455 seen request;
 *   (2) R2-N4: the named exports the Timeline and the action list compose -
 *       `draftVisibilitySql`, the sweep's activity clock, the report list-scope
 *       builder, the My-work rule and the unusable-Verifier predicate - exist,
 *       are imported from their one home, and are not re-typed beside it;
 *   (3) section 4.3: every emit site of a Timeline-visible feed name passes the
 *       acting principal, or is on the NAMED system list with its reason; no
 *       such emit takes its actor from an optional creation transaction; and
 *       every route call of a writer whose actor parameter is optional passes
 *       the request actor. These are TEXT registers over the sites and the
 *       calls; the live suite's runtime census (5) measures the stored actor
 *       of every route-level writer;
 *   (4) choice C10: the legacy file notifier is gone, with every reference
 *       (its env file path included).
 */
import fs from 'fs';
import path from 'path';
import { requiredScopeFor } from '../utils/scopeMap';
import { PROTECTED_ROUTE_REGISTRATIONS } from '../routeRegistry';
import { routeTransportClassFor } from '../utils/transportMap';
import notificationsRouter, { parseActionsSeen, parseTimelineFilters } from '../routes/notifications';
import {
  TIMELINE_FEED_NAMES, TIMELINE_LABELS, TIMELINE_SEARCH_MAX, TIMELINE_TYPES, timelineLabelMatches, timelineSearchPattern,
} from '../services/TimelineService';
import { ACTION_SEEN_MAX_KEYS } from '../services/NotificationActionsService';

const backend = path.join(__dirname, '..');
const read = (relative: string): string => fs.readFileSync(path.join(backend, relative), 'utf8');

describe('(1) the /notifications route family', () => {
  it('mounts exactly the three routes the design names, the E455 seen mark and the E467 owner queue', () => {
    const routes = (notificationsRouter as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`)
      .sort();
    expect(routes).toEqual(['GET /actions', 'GET /actions/owner', 'GET /timeline', 'POST /actions/seen', 'POST /timeline/seen']);
  });

  it('rides tasks:read for those five, and root for anything else under the mount', () => {
    expect(requiredScopeFor('GET', '/notifications/actions')).toBe('tasks:read');
    expect(requiredScopeFor('GET', '/notifications/actions/owner')).toBe('tasks:read');
    // The owner queue is a read: no other method reaches it.
    expect(requiredScopeFor('POST', '/notifications/actions/owner')).toBe('root');
    expect(requiredScopeFor('PUT', '/notifications/actions/owner')).toBe('root');
    expect(requiredScopeFor('DELETE', '/notifications/actions/owner')).toBe('root');
    expect(requiredScopeFor('GET', '/notifications/actions/owner/seen')).toBe('root');
    expect(requiredScopeFor('GET', '/notifications/timeline')).toBe('tasks:read');
    expect(requiredScopeFor('POST', '/notifications/timeline/seen')).toBe('tasks:read');
    expect(requiredScopeFor('POST', '/notifications/actions/seen')).toBe('tasks:read');
    expect(requiredScopeFor('GET', '/notifications/actions/seen')).toBe('root');
    expect(requiredScopeFor('DELETE', '/notifications/actions/seen')).toBe('root');
    expect(requiredScopeFor('POST', '/notifications/actions/seen/extra')).toBe('root');
    expect(requiredScopeFor('POST', '/notifications/actions')).toBe('root');
    expect(requiredScopeFor('DELETE', '/notifications/timeline')).toBe('root');
    expect(requiredScopeFor('GET', '/notifications/timeline/seen')).toBe('root');
    expect(requiredScopeFor('GET', '/notifications')).toBe('root');
    // No collision with the root-only endpoint family or the old history.
    expect(requiredScopeFor('GET', '/notification-endpoints')).toBe('root');
    expect(requiredScopeFor('GET', '/tasks/notifications')).toBe('tasks:read');
  });

  it('is registered once, after /events and before /phases, on both ingresses', () => {
    const paths = PROTECTED_ROUTE_REGISTRATIONS.map((registration) => registration.path);
    expect(paths.filter((mount) => mount === '/notifications')).toHaveLength(1);
    expect(paths.indexOf('/notifications')).toBe(paths.indexOf('/events') + 1);
    expect(paths.indexOf('/phases')).toBe(paths.indexOf('/notifications') + 1);
    expect(PROTECTED_ROUTE_REGISTRATIONS.find((r) => r.path === '/notifications')?.router).toBe(notificationsRouter);
    expect(routeTransportClassFor('/notifications/timeline')).toBe('any');
  });

  it('adds one MCP tool only: the read-only owner queue (design section 6 as superseded by E467)', () => {
    const registry = read('mcp/registry.ts');
    // The Timeline, the seen marks and the plain list stay off MCP; the one
    // route a tool composes is the owner-queue form, GET only, by exact path.
    expect([...registry.matchAll(/\/notifications\/[A-Za-z/]*/g)].map((match) => match[0]))
      .toEqual(['/notifications/actions/owner']);
    expect(registry).not.toMatch(/relayhall_(notification|timeline)/);
    expect([...registry.matchAll(/relayhall_action[a-z_]*/g)].map((match) => match[0]))
      .toEqual(['relayhall_action_items_list']);
    expect(registry).not.toMatch(/relayhall_action_item[a-z_]*(seen|decide|mark|dismiss)/);
  });

  it('shows a whitelist: no task.ready, no tombstone, no personality row, access changes only as their own type', () => {
    const names = Object.values(TIMELINE_FEED_NAMES).flat();
    expect(names).not.toContain('task.ready');
    expect(names.filter((name) => name.endsWith('.deleted'))).toEqual([]);
    expect(names.filter((name) => name.startsWith('personality.'))).toEqual([]);
    const access = names.filter((name) => name.endsWith('.acl_changed'));
    expect(access.sort()).toEqual([...TIMELINE_FEED_NAMES.access].sort());
    expect([...TIMELINE_TYPES]).toEqual([
      'task', 'status', 'update', 'stuck', 'review', 'report', 'phase', 'project', 'skill', 'skill-version', 'approval', 'access',
    ]);
  });
});

describe('(1b) E453 and E455: the text search and the seen request grammars', () => {
  it('q is trimmed, empty means no search, and more than the maximum is a 400, never a cut', () => {
    expect(parseTimelineFilters({ q: '  needle  ' })).toMatchObject({ q: 'needle' });
    expect(parseTimelineFilters({ q: '   ' })).toMatchObject({ q: null });
    expect(parseTimelineFilters({})).toMatchObject({ q: null });
    expect(parseTimelineFilters({ q: 'x'.repeat(TIMELINE_SEARCH_MAX) })).toMatchObject({ q: 'x'.repeat(TIMELINE_SEARCH_MAX) });
    expect(parseTimelineFilters({ q: 'x'.repeat(TIMELINE_SEARCH_MAX + 1) })).toEqual({ error: `q must be at most ${TIMELINE_SEARCH_MAX} characters` });
    expect(parseTimelineFilters({ q: ['a', 'b'] })).toEqual({ error: 'q must be one value' });
  });

  it("the caller's wildcards are taken literally: %, _ and the backslash are escaped", () => {
    expect(timelineSearchPattern('plain')).toBe('%plain%');
    expect(timelineSearchPattern('100%_done\\x')).toBe('%100\\%\\_done\\\\x%');
  });

  it('a label matches case-insensitively, by the labels the Timeline shows', () => {
    expect([...timelineLabelMatches('STATUS')]).toEqual(['status']);
    expect([...timelineLabelMatches('skill')].sort()).toEqual(['skill', 'skill-version']);
    expect([...timelineLabelMatches('zzz-no-label')]).toEqual([]);
    for (const type of TIMELINE_TYPES) expect(timelineLabelMatches(TIMELINE_LABELS[type]).has(type)).toBe(true);
  });

  it('the seen request is { keys } or { all: true }, keys checked by grammar only', () => {
    const key = 'verify:0f6c1a52-7a54-4c38-9d2b-1f8d8b1e1c11';
    expect(parseActionsSeen({ all: true })).toEqual({ all: true });
    expect(parseActionsSeen({ keys: [key, key] })).toEqual({ keys: [key] });
    for (const bad of [null, [], {}, { all: false }, { all: 'yes' }, { keys: [] }, { keys: 'x' }, { keys: ['nope'] },
      { keys: ['verify:'] }, { keys: [`verify:${'a'.repeat(129)}`] }, { keys: [key], all: true }, { keys: [key], principalId: 'x' },
      { keys: Array.from({ length: ACTION_SEEN_MAX_KEYS + 1 }, (_, i) => `stuck:${i}`) }]) {
      expect({ bad, error: 'error' in (parseActionsSeen(bad) as object) }).toEqual({ bad, error: true });
    }
  });
});

describe('(2) R2-N4: the exported builders, each from its one home', () => {
  const EXPORTS: Array<{ name: string; home: string; consumers: string[] }> = [
    { name: 'draftVisibilitySql', home: 'services/SkillManager.ts', consumers: ['services/TimelineService.ts'] },
    { name: 'stuckActivityAtSql', home: 'services/TelemetryService.ts', consumers: ['services/NotificationActionsService.ts'] },
    { name: 'stuckEpisodeAnnouncedSql', home: 'services/TelemetryService.ts', consumers: ['services/NotificationActionsService.ts'] },
    { name: 'reportVisibilitySql', home: 'services/ReportVisibility.ts', consumers: ['services/TimelineService.ts'] },
    { name: 'myWorkTaskCondition', home: 'services/NotificationHistoryService.ts', consumers: ['services/TimelineService.ts'] },
    { name: 'verifierUnusableSql', home: 'services/VerifierUsability.ts', consumers: ['services/NotificationActionsService.ts', 'services/TaskManagerDB.ts'] },
    { name: 'viewerOf', home: 'routes/skills.ts', consumers: ['routes/notifications.ts'] },
  ];

  it.each(EXPORTS.map((entry) => [entry.name, entry]))('%s is exported from its home and imported by its consumers', (_name, entry) => {
    const { name, home, consumers } = entry as (typeof EXPORTS)[number];
    expect(read(home)).toMatch(new RegExp(`export function ${name}\\(`));
    for (const consumer of consumers) {
      const source = read(consumer);
      const imported = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '[./]+${path.basename(home, '.ts')}'`).test(source);
      expect(`${consumer} imports ${name}: ${imported}`).toBe(`${consumer} imports ${name}: true`);
      // Never re-typed: the consumer declares no function of that name.
      expect(source).not.toMatch(new RegExp(`function ${name}\\(`));
    }
  });

  it('the sweep reads its own exported clock, so the action list and the sweep cannot drift', () => {
    const telemetry = read('services/TelemetryService.ts');
    expect(telemetry).toContain("${stuckActivityAtSql('t')} AS activity_at");
    expect(telemetry).toContain("NOT ${stuckEpisodeAnnouncedSql('c.id', 'c.activity_at')}");
  });

  it('the list filter reads the exported unusable-Verifier predicate', () => {
    expect(read('services/TaskManagerDB.ts')).toContain("conditions.push(verifierUnusableSql('t', `$${paramIndex++}`));");
  });

  it('the Timeline composes every arm from the shared list scopes and the hub predicates, never a copy', () => {
    const route = read('routes/notifications.ts');
    for (const type of ['task', 'report', 'phase', 'project', 'skill']) {
      expect(route).toContain(`authorizedListScope(req, '${type}', 'read')`);
    }
    const timeline = read('services/TimelineService.ts');
    expect(timeline).toContain('approvalSelfScopeCondition(');
    expect(timeline).toContain('APPROVAL_ACTOR_HANDLE');
    expect(timeline).not.toMatch(/filterAuthorizedResources|filterVisibleReports/);
    const actions = read('services/NotificationActionsService.ts');
    expect(actions).toContain('approvalHubService.list(');
    expect(actions).toContain('usableVerifierPrincipalIds(');
  });
});

/**
 * (3) Section 4.3: the person filter matches `actor_principal_id`, so every emit
 * the Timeline shows passes the acting principal where the writer has one. The
 * writers that have none (the board acting by itself) are named here, with why.
 */
const TIMELINE_SYSTEM_EMITS: Record<string, string> = {
  'services/TelemetryService.ts sweepStuckTasks task.stuck': 'the stuck sweep: the board clock, no acting principal',
  'services/TaskManagerDB.ts resolveReviewedSubtasks task.updated': 'the reviewer verdict application, board-internal',
  'services/PersonalityService.ts retireDuplicate task.updated': 'a board maintenance act (duplicate retirement)',
  'services/TaskElementService.ts redact report.updated': 'a redaction: naming who redacted would re-attach an erased author to the Report',
};
const ACTOR_MARKERS = /actorPrincipalId|feedActorFields\(|creationFeedActor\(|this\.feedActor\(|\.\.\.feedActor\b/;

function emitSites(): Array<{ file: string; fn: string; name: string; block: string }> {
  const sites: Array<{ file: string; fn: string; name: string; block: string }> = [];
  // Access changes are Timeline rows too (acl=true), so their emits are censused.
  const visible = new Set(Object.values(TIMELINE_FEED_NAMES).flat());
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
  for (const full of walk(backend)) {
    const source = fs.readFileSync(full, 'utf8');
    const file = path.relative(backend, full).split(path.sep).join('/');
    let at = source.indexOf('feedEventService.emit(');
    while (at !== -1) {
      let depth = 0; let end = at + 'feedEventService.emit'.length;
      for (; end < source.length; end += 1) {
        if (source[end] === '(') depth += 1;
        if (source[end] === ')') { depth -= 1; if (depth === 0) break; }
      }
      const block = source.slice(at, end + 1);
      const named = /name\s*:\s*'([a-z_.]+)'/.exec(block);
      // A templated access-change name (`${...}.acl_changed`) is an access row.
      const templatedAcl = /name\s*:\s*(?:`[^`]*\.acl_changed`|[^,]*\+\s*'\.acl_changed')/.test(block);
      const before = source.slice(0, at);
      const fns = [...before.matchAll(/\n  (?:private |public )?(?:async )?([A-Za-z]+)(?:<[^>]*>)?\(/g)];
      const fn = fns.length > 0 ? fns[fns.length - 1][1] : '?';
      if (named && visible.has(named[1])) sites.push({ file, fn, name: named[1], block });
      else if (!named && templatedAcl) sites.push({ file, fn, name: '*.acl_changed', block });
      at = source.indexOf('feedEventService.emit(', end);
    }
  }
  return sites;
}

describe('(3) every Timeline-visible emit passes the acting principal or is a named system emit', () => {
  const sites = emitSites();

  it('finds the emit sites it is pinned to find (a census that finds nothing proves nothing)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(40);
    for (const name of ['task.created', 'task.updated', 'task.archived', 'task.stuck', 'task.review_requested',
      'report.created', 'report.updated', 'phase.created', 'phase.updated', 'project.updated', 'skill.created', 'skill.updated']) {
      expect(`${name}: ${sites.some((site) => site.name === name)}`).toBe(`${name}: true`);
    }
  });

  it('each site passes an actor, or is on TIMELINE_SYSTEM_EMITS', () => {
    const unattributed = sites
      .filter((site) => !ACTOR_MARKERS.test(site.block))
      .map((site) => `${site.file} ${site.fn} ${site.name}`);
    expect([...new Set(unattributed)].sort()).toEqual(Object.keys(TIMELINE_SYSTEM_EMITS).sort());
  });

  it('no Timeline-visible emit takes its actor from an optional creation transaction (round 1 blocker)', () => {
    // `transaction?.actor... ?? null` records NULL whenever a caller omits the
    // transaction: POST /phases did, so every route-created Phase was unattributed.
    const optional = sites.filter((site) => /\btransaction\?\.actor\b/.test(site.block))
      .map((site) => `${site.file} ${site.fn} ${site.name}`);
    expect(optional).toEqual([]);
  });

  it('a system emit never claims an actor (the list states exactly what is unattributed)', () => {
    for (const key of Object.keys(TIMELINE_SYSTEM_EMITS)) {
      const matching = sites.filter((site) => `${site.file} ${site.fn} ${site.name}` === key);
      expect(`${key}: ${matching.length > 0}`).toBe(`${key}: true`);
      expect(matching.every((site) => !ACTOR_MARKERS.test(site.block))).toBe(true);
    }
  });
});

/**
 * (3, continued) A writer whose actor parameter is OPTIONAL compiles when a
 * route omits it, and its feed row is then unattributed. Every route call of
 * such a writer passes the request actor. `taskReviewerService.runReview` is
 * not listed: its verdict is the board's own (the internal reviewer).
 */
const ROUTE_WRITERS = [
  'taskManager.createTask', 'taskManager.updateTask', 'taskManager.archiveTask', 'taskManager.unarchiveTask',
  'taskManager.bulkArchiveCompleted', 'taskManager.recoverTask', 'taskManager.releaseTask', 'taskManager.assignTaskRoles',
  'taskManager.addDependency', 'taskManager.removeDependency', 'taskManager.createSubtask', 'taskManager.reorderSubtasks',
  'taskManager.updateSubtaskText', 'taskManager.updateSubtaskStatusById', 'taskManager.updateSubtaskStatus',
  'taskManager.approveSubtask', 'taskManager.rejectSubtask', 'taskManager.skipSubtask',
  'taskAnalyzer.breakdownTask', 'taskReviewerService.rejectTask',
  'reportManager.create', 'reportManager.update', 'reportManager.archive', 'reportManager.unarchive',
  'phaseService.create', 'phaseService.update', 'phaseService.archive', 'phaseService.unarchive',
  'skillManager.create', 'skillManager.update', 'skillManager.transition', 'skillManager.setGlobal',
  'skillManager.changeOwner', 'skillManager.pinToProject', 'skillManager.unlinkFromProject',
];
const REQUEST_ACTOR = /requestActor\(req\)|phaseActor\(req\)|reportActor\(req\)|auditActorFromRequest\(|actorFromRequest\(|\bactor\(req\)|\btransaction\b|callerPrincipal\.id|\bactor\b/;

function routeWriterCalls(): Array<{ file: string; writer: string; call: string }> {
  const calls: Array<{ file: string; writer: string; call: string }> = [];
  const dir = path.join(backend, 'routes');
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const writer of ROUTE_WRITERS) {
      const pattern = new RegExp(`\\b${writer.replace('.', '\\.')}\\(`, 'g');
      for (const match of source.matchAll(pattern)) {
        let depth = 0; let end = match.index! + writer.length;
        for (; end < source.length; end += 1) {
          if (source[end] === '(') depth += 1;
          if (source[end] === ')') { depth -= 1; if (depth === 0) break; }
        }
        calls.push({ file: `routes/${name}`, writer, call: source.slice(match.index!, end + 1) });
      }
    }
  }
  return calls;
}

describe('(3, continued) every route call of an optional-actor writer passes the request actor', () => {
  const calls = routeWriterCalls();

  it('finds the calls it is pinned to find', () => {
    expect(calls.length).toBeGreaterThanOrEqual(40);
    for (const writer of ['phaseService.create', 'reportManager.create', 'taskManager.approveSubtask',
      'taskManager.updateSubtaskStatusById', 'taskAnalyzer.breakdownTask', 'taskReviewerService.rejectTask']) {
      expect(`${writer}: ${calls.some((call) => call.writer === writer)}`).toBe(`${writer}: true`);
    }
  });

  it('each call names the acting principal', () => {
    const omitted = calls.filter((call) => !REQUEST_ACTOR.test(call.call.slice(call.writer.length)))
      .map((call) => `${call.file} ${call.call.replace(/\s+/g, ' ').slice(0, 120)}`);
    expect(omitted).toEqual([]);
  });
});

describe('(4) choice C10: the legacy file notifier is gone', () => {
  it('the module and every import, mock and env file path left the tree', () => {
    expect(fs.existsSync(path.join(backend, 'services', 'NotificationManager.ts'))).toBe(false);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|js)$/.test(entry.name) || entry.name === 'notificationsTimelineContract.test.ts') continue;
        const source = fs.readFileSync(full, 'utf8');
        if (/services\/NotificationManager|notificationManager\.|TASK_NOTIFICATIONS_FILE/.test(source)) offenders.push(path.relative(backend, full));
      }
    };
    walk(backend);
    walk(path.join(backend, '..', 'scripts'));
    expect(offenders).toEqual([]);
  });
});
