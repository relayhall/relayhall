// Phone-width overflow census (owner ruling: the Action Center must never scroll sideways).
//
// Serves the BUILT dashboard (frontend/dist) and a fake API entirely through Playwright request
// interception (no server, no network, no database), then visits every route of the census in
// headless Chromium at 375x812 and 320x640 and asserts the page body never scrolls sideways:
//   document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth.
// The Action Center is visited on every one of its five tabs, with fixture data that made the
// Agent sessions tab overflow (Reporting sources cards, a wide session table with long ids).
//
// The shell clips sideways overflow, so the check reads every shell element (see measure()).
// A diagnostic names the widest elements that reach past the viewport and are not clipped by an
// ancestor with its own horizontal scroll or clip, so a failure says WHICH element pushed the page.
//
// NOT wired into CI: it needs a Chromium and the `playwright` package, neither of which the
// frontend job installs. Run it by hand or from a lane:
//   (cd frontend && npx vite build) && node scripts/mobile-overflow-census.mjs frontend/dist <out dir>
// Playwright is resolved like the live drills do (a global install or a scripts/node_modules link).
//
// usage: node scripts/mobile-overflow-census.mjs <frontend/dist> <output dir>
//          [--expect-fail=<route-id>[,<route-id>...]]  routes EXPECTED to overflow (a red-first proof on a
//                                                       base build); every other route must pass
//          [--only=<route-id>[,...]]                   limit the census
//          [--shots]                                   write a screenshot per route and viewport
// A route also FAILS when its tab row (the first [role=tablist]) has the selected tab out of view.
// E464: a route may name `toolbars` (CSS selectors of control rows). Each must render as ONE row on a phone:
// every control's top edge AND vertical centre within 2 px of the others (the report prints both spreads), the bar no taller
// than its tallest child plus its own padding and border, a bar that overflows sideways scrolling INSIDE itself
// (overflow-x auto|scroll), every control reachable (focus() leaves it inside the bar's box, uncovered) and the
// control that ends the row on screen reachable at the end of the scroll. The Map view's toolbar is read with the recorded graph fixture.
// E466: a route may also name `phone` checks, run at rest (every row at scrollLeft 0):
//   pinned   - the primary action (New task) is fully inside the viewport AND clear of the row's end fade, nothing
//              covers it, and it meets the 44 px touch floor;
//   count    - the "N tasks in view" count is fully inside its row and the viewport without scrolling;
//   iconOnly - the named buttons are 44 px squares whose text is visually hidden but still their accessible name
//              (a real accessibility-tree lookup: getByRole(name, exact)), each with a tooltip (title) equal to it;
//   touch    - every control of the named rows meets the 44 px floor (also read at 768 px, the top of the phone range);
//   axe      - axe-core (from frontend/node_modules, when installed) finds no WCAG A/AA violation in the named rows.
// E469: `phone` may also name
//   fade     - rows whose controls must ALL sit clear of the row's end fade at rest (a row that fits has no fade);
//   iconOnly - an entry may be {name, bar, text} for a control outside the Map toolbar (Search: its word hidden visually);
//   labels   - the visible label of every icon-only button (see runLabelChecks): a held CDP touch press shows a role=tooltip
//              bubble fully inside the viewport (not at 350 ms, yes at 800 ms), with no layout shift and no click, gone on
//              release; a resting mouse shows it and leaving hides it; keyboard focus shows it, Escape and blur hide it;
//   themes   - a label shown in relay-dark, relay-light and high-contrast: the bubble's contrast >= 4.5:1 and axe clean.
//              Read at 375 and 320 px only (the label is a phone feature).
// exit 0 = every route passed (or failed only where --expect-fail said so), 1 = a failure, 64 = usage.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flag = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const [dist, outDir] = positional;
if (!dist || !outDir) {
  console.error('usage: node scripts/mobile-overflow-census.mjs <frontend/dist> <output dir> [--expect-fail=ids] [--only=ids] [--shots]');
  process.exit(64);
}
const expectFail = new Set(flag('expect-fail').split(',').filter(Boolean));
const only = new Set(flag('only').split(',').filter(Boolean));
const shots = args.includes('--shots');
fs.mkdirSync(outDir, { recursive: true });

const ORIGIN = 'http://127.0.0.1:4798';
const BASE = (/(?:src|href)="(\/[^"]*?\/)assets\//.exec(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')) || [, '/dashboard/'])[1];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

// ---------------------------------------------------------------------------------------------
// The fake API. Long, unbroken strings are deliberate: a long id or handle is what pushes a page.
const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
const LONG_ID = 'connector-example-reporter-one-0000-4000-8000-000000000001';
const LONG_REF = 'sess_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PRINCIPAL = {
  id: '00000000-0000-4000-8000-0000000000a0', handle: 'example-owner', displayName: 'Example Owner', kind: 'account',
  role: 'admin', status: 'active',
};
const presence = [
  { connectorId: LONG_ID, connectorHandle: 'connector-example-one', connectorDisplayName: 'Example reporter one',
    accountId: PRINCIPAL.id, sourceProduct: 'claude-code', adapter: 'reporter', adapterVersion: '1.0.0', mechanism: 'push',
    supportLevel: 'full', lastVerified: null, policyTier: 0, schemaVersion: '1', lastSeenAt: iso(12 * 60e3),
    firstSeenAt: iso(20 * 864e5), lastPhase: 'work', eventCount: 2118, sessionCount: 507, errorCount: 0, state: 'stale',
    basis: 'envelope', connectorFrame: null },
  { connectorId: 'connector-example-two-0000-4000-8000-000000000002', connectorHandle: 'example-two', connectorDisplayName: 'Example reporter two',
    accountId: PRINCIPAL.id, sourceProduct: 'example-runner', adapter: 'reporter', adapterVersion: '1.0.0', mechanism: 'push',
    supportLevel: 'full', lastVerified: null, policyTier: 0, schemaVersion: '1', lastSeenAt: iso(45 * 60e3),
    firstSeenAt: iso(20 * 864e5), lastPhase: 'work', eventCount: 1922, sessionCount: 38, errorCount: 0, state: 'stale',
    basis: 'envelope', connectorFrame: { state: 'active', receivedAt: iso(0), kind: 'heartbeat' } },
  { connectorId: 'connector-example-three-0000-4000-8000-000000000003', connectorHandle: 'example-three',
    connectorDisplayName: 'Example reporter three', accountId: PRINCIPAL.id, sourceProduct: 'codex', adapter: 'reporter',
    adapterVersion: '1.0.0', mechanism: 'push', supportLevel: 'full', lastVerified: null, policyTier: 0, schemaVersion: '1',
    lastSeenAt: iso(6 * 864e5), firstSeenAt: iso(20 * 864e5), lastPhase: 'work', eventCount: 23, sessionCount: 4,
    errorCount: 0, state: 'stale', basis: 'envelope', connectorFrame: null },
];
const sessions = Array.from({ length: 12 }, (_, i) => ({
  sessionRef: `${LONG_REF}${i}`, connectorId: presence[i % 3].connectorId, connectorHandle: presence[i % 3].connectorHandle,
  connectorDisplayName: presence[i % 3].connectorDisplayName, sourceProduct: presence[i % 3].sourceProduct,
  state: i % 4 === 0 ? 'active' : 'finished', startedAt: iso((i + 2) * 3600e3), lastSeenAt: iso((i + 1) * 3600e3),
  lastPhase: 'work', eventCount: 40 + i, errorCount: 0, models: ['claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929'],
  inputTokens: 123456 + i, outputTokens: 7890 + i, totalTokens: 131346 + 2 * i, requests: 20 + i,
}));
const TASK_ID = '00000000-0000-4000-8000-0000000000a1';
const task = id => ({
  id, title: 'A task whose title is long enough to wrap onto several lines on a phone screen', description: 'Body',
  status: 'in_progress', priority: 'medium', created_at: iso(864e5), updated_at: iso(3600e3), subtasks: [], references: [],
  tags: ['frontend'], assignee: null, project: 'RelayHall',
});
// The Map view's graph read: the recorded fixture the Map's own tests use (14 tasks, 6 edges, 3 phases).
const GRAPH = JSON.parse(fs.readFileSync(new URL('../frontend/src/components/map/__fixtures__/graph.task.json', import.meta.url), 'utf8'));
const emptyLists = { items: [], tasks: [], reports: [], projects: [], phases: [], skills: [], personalities: [], principals: [],
  grants: [], groups: [], services: [], connectors: [], blueprints: [], entries: [], events: [], notifications: [],
  requests: [], approvals: [], sources: [], plugins: [], results: [], tools: [], roles: [] };

function api(method, p) {
  const ok = body => ({ status: 200, body: { success: true, ...body }, stubbed: false });
  if (p === '/api/config') {
    return { status: 200, stubbed: false, body: { displayName: 'RelayHall', loginTitle: 'Welcome', loginSubtitle: 'Hub', defaultTheme: 'relay-dark',
      accentColor: null, assets: { logo: null, favicon: null, mark: null },
      features: { taskBoard: true, projects: true, skills: true, auditLog: true },
      auth: { sessions: true, sso: { enabled: false, displayName: null }, firstRun: false } } };
  }
  if (p === '/api/principals/me') return ok({ principal: PRINCIPAL, scopes: ['root'], delegableScopes: ['root'], settingsSurfaces: null });
  if (p === '/api/principals') return ok({ principals: [PRINCIPAL] });
  if (p === '/api/plugins') return { status: 200, body: { plugins: [] }, stubbed: false };
  if (p === '/api/telemetry/presence') return ok({ sources: presence });
  if (p === '/api/telemetry/sessions') {
    return ok({ sessions, hiddenCount: 120, shortCount: 120, total: 429, offset: 0, nextOffset: 50,
      shortSession: { maxEvents: 3, minDurationMs: 120000 } });
  }
  if (p.startsWith('/api/telemetry/sessions/')) return ok({ session: sessions[0], events: [], truncated: false, actions: [] });
  if (p === '/api/tasks') return ok({ tasks: [task(TASK_ID)], total: 1 });
  if (p === '/api/tasks/graph') return { status: 200, body: { ...GRAPH, generatedAt: new Date(now).toISOString() }, stubbed: false };
  if (p.startsWith('/api/tasks/')) return ok({ task: task(TASK_ID), ...task(TASK_ID) });
  if (p === '/api/notifications/actions') {
    const kinds = ['decision', 'verify', 'stuck', 'skill'];
    const items = kinds.map((kind, i) => ({ key: kind + i, kind, reasons: ['verifier'], since: iso((i + 1) * 3600e3),
      object: { type: kind === 'skill' ? 'skill' : 'task', id: LONG_REF + i,
        title: 'Verify the universal change request design against section twelve and every starred answer in it, then hand back ' + LONG_REF },
      project: { id: 'p1', name: 'RelayHall' }, href: '/tasks/' + TASK_ID, detail: {}, seen: false }));
    return ok({ items, counts: { decision: 1, verify: 1, stuck: 1, skill: 1, total: 4, unseen: 4 }, capped: {} });
  }
  if (p === '/api/notifications/timeline') {
    const items = ['task', 'status', 'report', 'approval', 'review'].map((kind, i) => ({ key: 'k' + i,
      at: new Date(now - i * 3600e3).toISOString().replace('Z', '000Z'), kind,
      label: 'Moved a task with a long name to Review: ' + LONG_REF, object: { type: 'task', id: TASK_ID, title: LONG_REF },
      project: { id: 'p1', name: 'RelayHall' }, actor: { handle: LONG_ID }, detail: {} }));
    return ok({ items, nextCursor: null, hasMore: false, headCursor: { feed: null, approvals: null, skills: null }, lastSeen: null });
  }
  if (method !== 'GET') return { status: 200, body: { success: true }, stubbed: true };
  return { status: 200, body: { success: true, ...emptyLists }, stubbed: true };
}

// ---------------------------------------------------------------------------------------------
// E466: New task, the primary action of the Tasks header, is pinned at the end of its row.
const PIN_NEW = { bar: '.tasks-page-header-actions', control: 'button[aria-label="Create new task"]' };
// E469: Search is icon-only on a phone: its word is visually hidden (not removed), so nothing in the line sits under the fade.
const SEARCH_ICON = { name: 'Search and filter', bar: '.tasks-page-header-actions', text: '.search-toggle-label' };

// The census. `id` names the route in the report and in --only / --expect-fail.
const CENSUS = [
  { id: 'action-center', path: '/action-center', ready: 'h1' },
  { id: 'action-center-timeline', path: '/action-center?tab=timeline', ready: '[role=tabpanel]' },
  { id: 'action-center-approvals', path: '/action-center?tab=approvals', ready: '[role=tabpanel]' },
  { id: 'action-center-requests', path: '/action-center?tab=requests', ready: '[role=tabpanel]' },
  { id: 'action-center-sessions', path: '/action-center?tab=sessions', ready: '.telemetry-source-card' },
  { id: 'dashboard', path: '/' },
  { id: 'tasks', path: '/tasks', ready: '.tasks-page-header-actions', toolbars: ['.tasks-mobile-tabs', '.tasks-page-header-actions', '.tasks-page-header-scroll'], menu: true,
    phone: { pinned: [PIN_NEW], fade: ['.tasks-page-header-scroll'], iconOnly: [SEARCH_ICON], touch: ['.tasks-page-header-actions'], axe: ['.tasks-page-header-actions'],
      labels: 'HEADER', themes: ['.tasks-page-header-actions'] } },
  { id: 'tasks-map', path: '/tasks?view=map', ready: '.map-toolbar', toolbars: ['.tasks-page-header-actions', '.tasks-page-header-scroll', '.map-toolbar'], menu: true,
    phone: { pinned: [PIN_NEW], fade: ['.tasks-page-header-scroll'], count: { bar: '.map-toolbar', el: '.map-scope-count' },
      iconOnly: [SEARCH_ICON, 'Re-pack layout', 'Show as list', 'Map and list'],
      touch: ['.tasks-page-header-actions', '.map-toolbar'], axe: ['.tasks-page-header-actions', '.map-toolbar'],
      labels: 'MAP', themes: ['.tasks-page-header-actions', '.map-toolbar'] } },
  { id: 'tasks-new', path: '/tasks/new' },
  { id: 'task-detail', path: `/tasks/${TASK_ID}` },
  { id: 'approvals', path: '/approvals' },
  { id: 'notifications-alias', path: '/notifications' },
  { id: 'oauth-consent', path: '/oauth/consent' },
  { id: 'projects', path: '/projects' },
  { id: 'project-charter', path: '/projects/p1/charter' },
  { id: 'project-phases', path: '/projects/p1/phases' },
  { id: 'audit', path: '/audit' },
  { id: 'knowledge', path: '/knowledge' },
  { id: 'reports', path: '/reports' },
  { id: 'report-detail', path: '/reports/r1' },
  { id: 'skills', path: '/skills' },
  { id: 'blueprints', path: '/blueprints' },
  { id: 'tools', path: '/tools' },
  { id: 'personalities', path: '/personalities' },
  { id: 'personality-detail', path: '/personalities/p1' },
  { id: 'stats', path: '/stats' },
  { id: 'about', path: '/about' },
  { id: 'directory', path: '/directory' },
  { id: 'groups', path: '/groups' },
  { id: 'team', path: '/team' },
  { id: 'settings-preferences', path: '/settings/preferences' },
  { id: 'settings-plugins', path: '/settings/plugins' },
  { id: 'settings-connections', path: '/settings/connections' },
  { id: 'settings-access-manager', path: '/settings/access-manager' },
  { id: 'settings-access', path: '/settings/access' },
  { id: 'settings-principals', path: '/settings/principals' },
  { id: 'settings-appearance', path: '/settings/appearance' },
  { id: 'settings-services', path: '/settings/services' },
].filter(r => only.size === 0 || only.has(r.id));
const VIEWPORTS = [{ label: '375', width: 375, height: 812 }, { label: '320', width: 320, height: 640 }];
// E466: routes with `phone` checks are also read at 768 px, the top of the phone range, for the touch floor only.
const VIEWPORT_768 = { label: '768', width: 768, height: 1024 };

async function serve(page, stubbed) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      const { status, body, stubbed: isStub } = api(route.request().method(), p);
      if (isStub) stubbed.add(p);
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (p.startsWith('/socket.io')) return route.abort();
    const file = p.startsWith(BASE) ? p.slice(BASE.length) : '';
    let full = path.join(dist, file);
    if (!file || !fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.join(dist, 'index.html');
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(full)] || 'application/octet-stream', body: fs.readFileSync(full) });
  });
}

// Runs in the page. The shell (html, body, the app containers and <main>) clips sideways overflow
// with overflow-x hidden/auto instead of letting the document grow, so `document.scrollWidth` alone
// reads 375 while the page is still dragged sideways inside .app-container/.main-content (the owner's
// phone screenshot). The test therefore reads every shell element's own scrollWidth > clientWidth, and
// the offenders are the elements that reach past the viewport and are not inside a designated inner
// scroller (an ancestor that is not part of the shell).
function measure() {
  const root = document.scrollingElement || document.documentElement;
  const vw = root.clientWidth;
  const shell = new Set([document.documentElement, document.body]);
  for (const el of document.querySelectorAll('#root, .app-container, .app, main, .main-content, .route-transition')) shell.add(el);
  const describe = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/[ ]+/).slice(0, 3).join('.') : '');
  const clips = el => {
    for (let a = el.parentElement; a && !shell.has(a); a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return a;
    }
    return null;
  };
  // .route-transition is only a wrapper inside <main>'s padding: it is measured through <main>.
  const shellWide = [...shell].filter(el => !el.classList.contains('route-transition')).map(el => ({ el: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: Math.round(el.scrollLeft) }))
    .filter(x => x.scrollWidth > x.clientWidth + 1 || x.scrollLeft > 0);
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 0.5 && !clips(el)) offenders.push({ el: describe(el), right: Math.round(r.right), width: Math.round(r.width) });
  }
  // Boxes whose own content spills past them (an unbreakable word in a flex item, a fixed-width input).
  // Only the deepest such box is named: its ancestors spill because it does.
  const spilling = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (shell.has(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && getComputedStyle(el).overflowX === 'visible' && !clips(el)) spilling.add(el);
  }
  for (const el of spilling) {
    if ([...el.children].some(child => spilling.has(child))) continue;
    offenders.push({ el: describe(el) + '[spill]', right: Math.round(el.getBoundingClientRect().left + el.scrollWidth), width: el.scrollWidth });
  }
  offenders.sort((a, b) => b.right - a.right);
  const tablist = document.querySelector('[role=tablist]');
  const active = tablist && tablist.querySelector('[aria-selected=true]');
  const tl = tablist && tablist.getBoundingClientRect();
  const ar = active && active.getBoundingClientRect();
  return {
    scrollWidth: root.scrollWidth, clientWidth: vw, scrollX: window.scrollX, scrollY: window.scrollY,
    shellWide, offenders: offenders.slice(0, 5),
    tablist: tablist && { overflowX: getComputedStyle(tablist).overflowX, scrollWidth: tablist.scrollWidth, clientWidth: tablist.clientWidth,
      scrollLeft: Math.round(tablist.scrollLeft), activeInView: !!(tl && ar && ar.left >= tl.left - 1 && ar.right <= tl.right + 1) },
  };
}

// E464: the header's More menu opens inside the scrolling row; it must not be clipped by it. Runs in the page.
async function measureMenu() {
  const trigger = document.querySelector('button[aria-label="More actions"]');
  if (!trigger) return { missing: true };
  trigger.click();
  await new Promise(r => setTimeout(r, 250));
  const menu = document.querySelector('[role=menu][aria-label="More actions"]');
  if (!menu) return { opened: false };
  const r = menu.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const items = [...menu.querySelectorAll('[role^=menuitem]')];
  // the menu is the topmost box at each of its items' centres (nothing clips or covers it)
  const covered = items.filter(i => { const b = i.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !(hit && menu.contains(hit)); }).length;
  const t = trigger.getBoundingClientRect();
  const out = { opened: true, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), vw, items: items.length, covered,
    belowTrigger: r.top >= t.bottom - 1 && r.top <= t.bottom + 16, inViewport: r.left >= 0 && r.right <= vw + 0.5 };
  trigger.click();
  return out;
}

// E464: is the control row ONE line, and does every control stay reachable? Runs in the page.
function measureToolbar(sel) {
  const bar = document.querySelector(sel);
  if (!bar) return { sel, missing: true };
  const cs = getComputedStyle(bar);
  const visible = el => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.classList.contains('sr-only');
  };
  const controls = [...bar.querySelectorAll('button, a[href], input, select, textarea, [role=radio], [role=tab]')].filter(visible);
  const kids = [...bar.children].filter(visible);
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 28);
  const tops = controls.map(c => c.getBoundingClientRect().top);
  const mids = controls.map(c => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; });
  const spread = list => list.length ? Math.round((Math.max(...list) - Math.min(...list)) * 10) / 10 : 0;
  const pad = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + parseFloat(cs[k] || '0'), 0);
  const tallest = Math.max(0, ...kids.map(k => k.getBoundingClientRect().height));
  const barH = bar.getBoundingClientRect().height;
  const scrollable = bar.scrollWidth > bar.clientWidth + 1;
  // reachable: focus each control from the start of the row and look where it lands
  const inBar = el => { const b = bar.getBoundingClientRect(); const r = el.getBoundingClientRect(); return r.left >= b.left - 1 && r.right <= b.right + 1; };
  const unreachable = [];
  // E466: a control that a pinned neighbour sits on top of is out of reach too (the box test alone passes it).
  const covered = c => {
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit && c.contains(hit));
  };
  for (const c of controls) {
    bar.scrollLeft = 0; c.focus();
    if (c.getBoundingClientRect().width <= bar.clientWidth && (!inBar(c) || covered(c))) unreachable.push(name(c));
  }
  bar.scrollLeft = 0;
  // E466: the control that ENDS the row on screen (the Map's count is first on screen and last in the markup).
  const last = kids.reduce((a, k) => (k.getBoundingClientRect().right > (a ? a.getBoundingClientRect().right : -Infinity) ? k : a), null);
  bar.scrollLeft = bar.scrollWidth;
  const endReachable = !last || last.getBoundingClientRect().width > bar.clientWidth || inBar(last);
  bar.scrollLeft = 0;
  const ox = cs.overflowX;
  const oneRow = spread(mids) <= 2 && spread(tops) <= 2 && barH <= tallest + pad + 1;
  const scrolls = !scrollable || ox === 'auto' || ox === 'scroll';
  return { sel, controls: controls.length, topSpread: spread(tops), centreSpread: spread(mids), barH: Math.round(barH), tallest: Math.round(tallest),
    pad, overflowX: ox, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, scrollable, oneRow, scrolls, unreachable, endReachable,
    ok: controls.length > 0 && oneRow && scrolls && unreachable.length === 0 && endReachable };
}

// E466: the phone rows at rest. Runs in the page.
function measurePhoneControls(spec) {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const FADE = 12; // the width of the row's end shadow (the end padding of the row)
  const box = el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 }; };
  const out = { pinned: [], count: null, iconOnly: [], touch: [], fade: [] };
  for (const { bar: barSel, control } of spec.pinned || []) {
    const bar = document.querySelector(barSel), el = bar && bar.querySelector(control);
    if (!bar || !el) { out.pinned.push({ control, missing: true, ok: false }); continue; }
    bar.scrollLeft = 0;
    const b = bar.getBoundingClientRect(), r = el.getBoundingClientRect();
    const overflows = bar.scrollWidth > bar.clientWidth + 1;
    const inView = r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5;
    const clearOfFade = r.left >= b.left - 0.5 && r.right <= b.right - (overflows ? FADE : 0) + 0.5;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const uncovered = !!hit && el.contains(hit);
    out.pinned.push({ control, ...box(el), barRight: Math.round(b.right * 10) / 10, overflows, inView, clearOfFade, uncovered,
      ok: inView && clearOfFade && uncovered && r.width >= 43.5 && r.height >= 43.5 });
  }
  if (spec.count) {
    const bar = document.querySelector(spec.count.bar), el = bar && bar.querySelector(spec.count.el);
    if (!bar || !el) out.count = { missing: true, ok: false };
    else {
      bar.scrollLeft = 0;
      const b = bar.getBoundingClientRect(), r = el.getBoundingClientRect();
      const inRow = r.left >= b.left - 0.5 && r.right <= b.right + 0.5, inView = r.left >= -0.5 && r.right <= vw + 0.5;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const uncovered = !!hit && el.contains(hit);
      out.count = { text: el.textContent.trim(), ...box(el), inRow, inView, uncovered, ok: /tasks? in view/.test(el.textContent) && inRow && inView && uncovered };
    }
  }
  // E469: every control of the named rows sits clear of the row's end fade at rest (scrollLeft 0), inside the viewport.
  for (const sel of spec.fade || []) {
    const bar = document.querySelector(sel);
    if (!bar) { out.fade.push({ sel, missing: true, ok: false }); continue; }
    bar.scrollLeft = 0;
    const b = bar.getBoundingClientRect();
    const overflows = bar.scrollWidth > bar.clientWidth + 1;
    const limit = b.right - (overflows ? FADE : 0);
    const under = [...bar.querySelectorAll('button, a[href], [role=radio], [role=tab]')]
      .filter(c => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !c.classList.contains('sr-only'); })
      .filter(c => { const r = c.getBoundingClientRect(); return r.right > limit + 0.5 || r.left < b.left - 0.5 || r.right > vw + 0.5; })
      .map(c => (c.getAttribute('aria-label') || c.textContent || c.tagName).trim().slice(0, 24));
    out.fade.push({ sel, overflows, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, right: Math.round(b.right * 10) / 10, under, ok: under.length === 0 });
  }
  for (const entry of spec.iconOnly || []) {
    const { name, bar: barSel = '.map-toolbar', text: textSel = '.btn-text' } = typeof entry === 'string' ? { name: entry } : entry;
    const bar = document.querySelector(barSel);
    const el = bar && [...bar.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || x.textContent || '').trim() === name);
    if (!el) { out.iconOnly.push({ name, missing: true, ok: false }); continue; }
    const text = el.querySelector(textSel), icon = el.querySelector('svg');
    const tb = text ? text.getBoundingClientRect() : { width: 0, height: 0 }, ib = icon ? icon.getBoundingClientRect() : { width: 0 };
    const b = el.getBoundingClientRect();
    const item = { name, ...box(el), textBox: [Math.round(tb.width * 10) / 10, Math.round(tb.height * 10) / 10], iconWidth: Math.round(ib.width), title: el.getAttribute('title'),
      textHidden: tb.width <= 1.5 && tb.height <= 1.5, square: b.width >= 43.5 && b.width <= 48 && b.height >= 43.5 && b.height <= 48 };
    item.ok = item.textHidden && item.square && item.iconWidth > 0 && item.title === name;
    out.iconOnly.push(item);
  }
  for (const sel of spec.touch || []) {
    const bar = document.querySelector(sel);
    const small = bar ? [...bar.querySelectorAll('button, a[href], [role=radio], [role=tab]')]
      .filter(c => { const r = c.getBoundingClientRect(); const s = getComputedStyle(c); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !c.classList.contains('sr-only'); })
      .map(c => { const r = c.getBoundingClientRect(); return { name: (c.getAttribute('aria-label') || c.textContent || c.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter(c => c.w < 44 || c.h < 44) : [{ name: 'MISSING ' + sel }];
    out.touch.push({ sel, small, ok: small.length === 0 });
  }
  out.ok = out.pinned.every(x => x.ok) && (!out.count || out.count.ok) && out.iconOnly.every(x => x.ok) && out.touch.every(x => x.ok) && out.fade.every(x => x.ok);
  return out;
}

// axe-core from the frontend's own dependencies, when installed (the census runs without it otherwise and says so).
const AXE_PATH = fileURLToPath(new URL('../frontend/node_modules/axe-core/axe.min.js', import.meta.url));
const AXE = fs.existsSync(AXE_PATH) ? fs.readFileSync(AXE_PATH, 'utf8') : null;
async function runAxe(page, selectors) {
  await page.evaluate(src => { if (!window.axe) (0, eval)(src); }, AXE);
  return page.evaluate(async sels => {
    const violations = [];
    for (const sel of sels) {
      const node = document.querySelector(sel);
      if (!node) { violations.push({ id: 'missing-row', target: sel }); continue; }
      const r = await window.axe.run(node, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
      for (const v of r.violations) violations.push({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map(n => n.target.join(' ')), target: sel });
    }
    return violations;
  }, selectors);
}

// ---------------------------------------------------------------------------------------------
// E469: the visible label of an icon-only button on a phone. Runs in Node (a real long press needs CDP touch input).
// For every named control: at rest it is revealed in its row; a CDP touch press held ~800 ms shows a role=tooltip
// label (not yet at 350 ms), fully inside the viewport, with words, causing no layout shift (every control box of both
// rows unchanged), firing no click (the URL, every aria-pressed / -expanded / -checked / -selected and the open menus are
// what they were), keeping aria-describedby honest, and the label is GONE on release. A mouse resting on the control
// shows it and leaving hides it; keyboard focus (after a key press) shows it, Escape and blur hide it.
const HEADER_LABELS = [
  { name: 'Board', role: 'radio' }, { name: 'Map', role: 'radio' }, { name: 'Search and filter', label: 'Search and filter' },
  { name: 'More actions' }, { name: 'Create new task' },
];
const MAP_LABELS = [
  ...HEADER_LABELS,
  { name: 'Zoom out' }, { name: 'Zoom in' }, { name: 'Fit view' },
  { name: 'Re-pack layout' }, { name: 'Show as list' }, { name: 'Map and list' },
];
const THEMES = ['relay-dark', 'relay-light', 'high-contrast'];

// Runs in the page: what a click or a layout shift would have changed.
function labelState() {
  return {
    url: location.pathname + location.search,
    aria: [...document.querySelectorAll('[aria-pressed],[aria-expanded],[aria-checked],[aria-selected]')]
      .map(e => [e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20), e.getAttribute('aria-pressed'), e.getAttribute('aria-expanded'),
        e.getAttribute('aria-checked'), e.getAttribute('aria-selected')].join('|')).join(';'),
    menus: document.querySelectorAll('[role=menu]').length,
    boxes: [...document.querySelectorAll('.tasks-page-header-actions button, .tasks-page-header-actions [role=radio], .map-toolbar button, .map-toolbar [role=radio]')]
      .map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(n => Math.round(n * 10)).join(','); }).join(';'),
  };
}

// Runs in the page: the bubble, if any, as the reader sees it.
function readTip(controlName) {
  const tips = [...document.querySelectorAll('[role=tooltip]')];
  const tip = tips[0];
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  if (!tip) return { count: 0 };
  const r = tip.getBoundingClientRect(), cs = getComputedStyle(tip);
  const control = [...document.querySelectorAll('button, [role=radio]')].find(x => (x.getAttribute('aria-label') || x.textContent || '').trim() === controlName);
  const described = control ? (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean) : [];
  const name = control ? (control.getAttribute('aria-label') || control.textContent || '').trim() : '';
  const text = tip.textContent.trim();
  return {
    count: tips.length, text, id: tip.id, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top * 10) / 10,
    bottom: Math.round(r.bottom * 10) / 10, width: Math.round(r.width), height: Math.round(r.height), vw, vh,
    inViewport: r.left >= 0 && r.right <= vw + 0.5 && r.top >= 0 && r.bottom <= vh + 0.5, visible: cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
    described: described.includes(tip.id), addsWords: !name.toLowerCase().includes(text.toLowerCase()), name,
    noSelect: control ? getComputedStyle(control).userSelect === 'none' : null,
    colour: cs.color, background: cs.backgroundColor,
  };
}

const parseRgb = s => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
const luminance = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

async function revealControl(loc, page) {
  await loc.evaluate(el => {
    let row = el.parentElement;
    while (row && !(getComputedStyle(row).overflowX === 'auto' && row.scrollWidth > row.clientWidth)) row = row.parentElement;
    if (row) { const b = row.getBoundingClientRect(), r = el.getBoundingClientRect(); row.scrollLeft += (r.left + r.width / 2) - (b.left + b.width / 2); }
  });
  await page.waitForTimeout(250);
}

async function runLabelChecks(context, page, specs, vp, opts) {
  const cdp = await context.newCDPSession(page);
  const results = [];
  for (const spec of specs) {
    const item = { name: spec.name, ok: false };
    results.push(item);
    try {
      const loc = page.getByRole(spec.role || 'button', { name: spec.name, exact: true });
      if ((await loc.count()) !== 1) { item.error = `role lookup found ${await loc.count()}`; continue; }
      await revealControl(loc, page);
      const box = await loc.boundingBox();
      if (!box) { item.error = 'no box'; continue; }
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      item.covered = await page.evaluate(([cx, cy, n]) => { const hit = document.elementFromPoint(cx, cy); const el = hit && hit.closest('button, [role=radio]'); return !(el && (el.getAttribute('aria-label') || el.textContent || '').trim() === n); }, [x, y, spec.name]);
      if (item.covered) { item.error = 'covered'; continue; }
      // 1. touch: a held press
      const before = await page.evaluate(labelState);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await page.waitForTimeout(350);
      item.early = (await page.evaluate(readTip, spec.name)).count;
      await page.waitForTimeout(450);
      const tip = await page.evaluate(readTip, spec.name);
      const during = await page.evaluate(labelState);
      if (opts.shots && ['Search and filter', 'Show as list', 'More actions'].includes(spec.name)) {
        await page.screenshot({ path: path.join(opts.outDir, `${opts.id}-${vp.label}-longpress-${spec.name.replace(/\W+/g, '-').toLowerCase()}.png`) });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(200);
      const afterTip = await page.evaluate(readTip, spec.name);
      await page.waitForTimeout(900);
      const after = await page.evaluate(labelState);
      Object.assign(item, { tip, gone: afterTip.count === 0, shift: during.boxes !== before.boxes,
        clicked: after.url !== before.url || after.aria !== before.aria || after.menus !== before.menus });
      item.touchOk = item.early === 0 && tip.count === 1 && tip.visible && tip.inViewport && tip.text.length > 0 && !item.shift && !item.clicked && item.gone &&
        (!spec.label || tip.text === spec.label) && tip.described === tip.addsWords && tip.noSelect === true;
      // 2. mouse: resting shows it, leaving hides it
      await page.mouse.move(x, y);
      await page.waitForTimeout(600);
      const hover = await page.evaluate(readTip, spec.name);
      await page.mouse.move(1, vp.height - 2);
      await page.waitForTimeout(500);
      const hoverGone = (await page.evaluate(readTip, spec.name)).count === 0;
      item.hoverOk = hover.count === 1 && hover.visible && hover.inViewport && hoverGone;
      // 3. keyboard: focus-visible shows it, Escape hides it, blur hides it (from a control that does not hold focus yet)
      await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
      await page.keyboard.press('Shift');
      await loc.focus();
      await page.waitForTimeout(150);
      const focus = await page.evaluate(readTip, spec.name);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      const escGone = (await page.evaluate(readTip, spec.name)).count === 0;
      await page.keyboard.press('Shift');
      await loc.focus();
      await page.waitForTimeout(100);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForTimeout(100);
      const blurGone = (await page.evaluate(readTip, spec.name)).count === 0;
      item.focusOk = focus.count === 1 && focus.visible && focus.inViewport && focus.described === focus.addsWords && escGone && blurGone;
      item.ok = item.touchOk && item.hoverOk && item.focusOk;
    } catch (error) { item.error = String(error.message || error).split('\n')[0]; }
  }
  await cdp.detach().catch(() => {});
  return results;
}

// A label shown in each theme: the bubble's own colours give >= 4.5:1 and axe-core is clean on the bubble and the rows.
async function runLabelThemes(context, page, rowSelectors) {
  const cdp = await context.newCDPSession(page);
  const out = [];
  for (const theme of THEMES) {
    const item = { theme, ok: false };
    out.push(item);
    try {
      await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(400);
      const loc = page.getByRole('button', { name: 'Search and filter', exact: true });
      await revealControl(loc, page);
      const box = await loc.boundingBox();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await page.waitForTimeout(800);
      const tip = await page.evaluate(readTip, 'Search and filter');
      const fg = parseRgb(tip.colour), bg = parseRgb(tip.background);
      item.contrast = fg && bg && bg.a === 1 ? Math.round(contrast(fg, bg) * 100) / 100 : null;
      item.themeApplied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      item.axe = AXE ? await runAxe(page, ['[role=tooltip]', ...rowSelectors]) : null;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(300);
      item.ok = tip.count === 1 && tip.visible && item.themeApplied === theme && item.contrast !== null && item.contrast >= 4.5 && (item.axe === null || item.axe.length === 0);
    } catch (error) { item.error = String(error.message || error).split('\n')[0]; }
  }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await cdp.detach().catch(() => {});
  return out;
}

const results = [];
let failures = 0;
const stubbed = new Set();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const route of CENSUS) {
    for (const vp of route.phone ? [...VIEWPORTS, VIEWPORT_768] : VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: true, hasTouch: true });
      await context.addInitScript(origin => { localStorage.setItem('relayhall_session_active:' + origin, '1'); }, ORIGIN);
      const page = await context.newPage();
      await serve(page, stubbed);
      let m;
      try {
        await page.goto(ORIGIN + BASE.replace(/\/$/, '') + route.path);
        await page.waitForSelector(route.ready || 'main, .main-content, h1', { timeout: 15000 });
        await page.waitForTimeout(900);
        m = await page.evaluate(measure);
        m.toolbars = [];
        // At 768 px only the touch floor (and axe) is read: the Tasks header is not in its phone layout there.
        const touchOnly = vp === VIEWPORT_768;
        for (const sel of touchOnly ? [] : route.toolbars || []) m.toolbars.push(await page.evaluate(measureToolbar, sel));
        // The toolbar read focuses every control (and a focused control shows its label): leave the page at rest.
        await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
        if (route.menu && !touchOnly) m.menu = await page.evaluate(measureMenu);
        if (route.phone) {
          m.phone = await page.evaluate(measurePhoneControls, touchOnly ? { touch: route.phone.touch } : route.phone);
          // The accessible name, read from the browser's accessibility tree (not from the markup).
          for (const item of m.phone.iconOnly) {
            item.roleLookup = await page.getByRole('button', { name: item.name, exact: true }).count();
            if (item.roleLookup !== 1) item.ok = false;
          }
          m.phone.axe = AXE ? await runAxe(page, route.phone.axe || []) : null;
          // E469: the visible label of every icon-only button (a phone feature: not read at 768 px).
          if (!touchOnly && route.phone.labels) {
            m.phone.labels = await runLabelChecks(context, page, route.phone.labels === 'MAP' ? MAP_LABELS : HEADER_LABELS, vp, { shots, outDir, id: route.id });
            if (route.phone.themes && vp.label === '375') m.phone.themes = await runLabelThemes(context, page, route.phone.themes);
          }
          m.phone.ok = m.phone.ok && m.phone.iconOnly.every(x => x.ok) && (m.phone.axe === null || m.phone.axe.length === 0) &&
            (!m.phone.labels || m.phone.labels.every(x => x.ok)) && (!m.phone.themes || m.phone.themes.every(x => x.ok));
        }
        if (shots) await page.screenshot({ path: path.join(outDir, `${route.id}-${vp.label}.png`) });
      } catch (error) {
        m = { error: String(error.message || error).split('\n')[0], scrollWidth: -1, clientWidth: 0, shellWide: [], offenders: [] };
      }
      await context.close();
      // A tab row whose selected tab is out of view is a failure too (E461: "the active tab kept in view").
      const activeOut = !!(m.tablist && m.tablist.activeInView === false);
      const badBars = (m.toolbars || []).filter(t => t.missing || !t.ok);
      if (m.phone && !m.phone.ok) badBars.push({ sel: 'phone-checks' });
      if (m.menu && !(m.menu.opened && m.menu.inViewport && m.menu.belowTrigger && m.menu.items === 2 && m.menu.covered === 0)) badBars.push({ sel: 'more-menu' });
      const overflowed = m.error ? true : (m.scrollWidth > m.clientWidth || m.shellWide.length > 0 || activeOut || badBars.length > 0);
      const expected = expectFail.has(route.id);
      const pass = expected ? overflowed : !overflowed;
      if (!pass) failures++;
      results.push({ route: route.id, viewport: vp.label, pass, expectedToFail: expected, ...m });
      if (activeOut) m.activeOutOfView = true;
      console.log(`${pass ? 'ok  ' : 'FAIL'} ${route.id.padEnd(26)} ${vp.label}px  scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}` +
        (m.error ? `  error=${m.error}` : '') + (activeOut ? '  ACTIVE-TAB-OUT-OF-VIEW' : '') +
        (overflowed && !m.error ? `  shell-wide=${m.shellWide.map(x => `${x.el}:${x.scrollWidth}/${x.clientWidth}`).join(',') || 'none'}  widest=${m.offenders.slice(0, 3).map(o => o.el + '@' + o.right).join(' | ') || '?'}` : '') +
        (m.toolbars || []).map(t => t.missing ? `  toolbar[${t.sel} MISSING]` :
          `  toolbar[${t.sel} ${t.ok ? 'one-row' : 'NOT-ONE-ROW'} controls=${t.controls} centreSpread=${t.centreSpread} topSpread=${t.topSpread} height=${t.barH}/${t.tallest}+${t.pad} ox=${t.overflowX} ${t.scrollWidth}/${t.clientWidth}${t.unreachable.length ? ' unreachable=' + t.unreachable.join('|') : ''}${t.endReachable ? '' : ' END-CLIPPED'}]`).join('') +
        (m.phone ? `  phone[${m.phone.ok ? 'ok' : 'FAIL'}` +
          m.phone.pinned.map(p => p.missing ? ' pin-MISSING' : ` new-task=${p.left}..${p.right}/${p.barRight}${p.inView ? '' : ' OUT-OF-VIEW'}${p.clearOfFade ? '' : ' UNDER-FADE'}${p.uncovered ? '' : ' COVERED'}${p.width >= 43.5 && p.height >= 43.5 ? '' : ` SMALL(${p.width}x${p.height})`}`).join('') +
          (m.phone.count ? (m.phone.count.missing ? ' count-MISSING' : ` count=${m.phone.count.left}..${m.phone.count.right}${m.phone.count.ok ? '' : ' COUNT-NOT-SEEN'}`) : '') +
          m.phone.iconOnly.map(i => i.missing ? ` ${i.name}:MISSING` : ` ${i.name}:${i.ok ? 'icon-only' : `NOT-ICON-ONLY(${i.width}x${i.height} text=${i.textBox.join('x')} title=${i.title} role=${i.roleLookup})`}`).join('') +
          m.phone.fade.map(f => f.missing ? ` fade-MISSING(${f.sel})` : ` fade[${f.sel} ${f.ok ? 'clear' : 'UNDER-FADE:' + f.under.join('|')} ${f.scrollWidth}/${f.clientWidth}]`).join('') +
          (m.phone.labels ? ` labels[${m.phone.labels.filter(l => l.ok).length}/${m.phone.labels.length}${m.phone.labels.filter(l => !l.ok).map(l => ` ${l.name}:${l.error || [l.touchOk ? '' : 'TOUCH', l.hoverOk ? '' : 'HOVER', l.focusOk ? '' : 'FOCUS'].filter(Boolean).join('+')}${l.tip && l.tip.count !== undefined ? `(tip=${l.tip.count} early=${l.early} vis=${l.tip.visible} in=${l.tip.inViewport} gone=${l.gone} shift=${l.shift} clicked=${l.clicked} desc=${l.tip.described}/${l.tip.addsWords} sel=${l.tip.noSelect})` : ''}`).join('')}]` : '') +
          (m.phone.themes ? ` themes[${m.phone.themes.map(x => `${x.theme}:${x.ok ? 'ok ' + x.contrast + ':1' : 'FAIL ' + (x.error || `contrast=${x.contrast} applied=${x.themeApplied} axe=${x.axe ? x.axe.map(v => v.id).join(',') : 'n/a'}`)}`).join(' ')}]` : '') +
          m.phone.touch.filter(t => !t.ok).map(t => ` TOUCH-FLOOR ${t.sel}:${t.small.map(s => `${s.name}=${s.w}x${s.h}`).join('|')}`).join('') +
          (m.phone.axe === null ? ' axe=not-installed' : m.phone.axe.length ? ` AXE:${m.phone.axe.map(v => v.id + '@' + v.nodes.join(',')).join(';')}` : ' axe=clean') + ']' : '') +
        (m.menu ? `  more-menu[${m.menu.opened ? `left=${m.menu.left} right=${m.menu.right}/${m.menu.vw} top=${m.menu.top} items=${m.menu.items} covered=${m.menu.covered} below-trigger=${m.menu.belowTrigger}` : 'NOT-OPENED'}]` : '') +
        (m.tablist ? `  tablist[ox=${m.tablist.overflowX} ${m.tablist.scrollWidth}/${m.tablist.clientWidth} scrollLeft=${m.tablist.scrollLeft} active-in-view=${m.tablist.activeInView}]` : ''));
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(outDir, 'mobile-overflow-census.json'), JSON.stringify({ base: BASE, results, stubbedApi: [...stubbed] }, null, 2));
if (stubbed.size) console.log('API paths answered by the generic stub (empty lists): ' + [...stubbed].sort().join(', '));
console.log(failures === 0 ? 'CENSUS PASS' : `CENSUS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
