/**
 * routeRegistry — the ONE ordered list of protected route registrations.
 *
 * RH-P3.C4 (run packet 3e6ec75a, owner decision D1; AUTHZ design 4d961e37
 * §7.5; MCP spec de73f9f8 §1.3).
 *
 * ── Why this module exists ──
 *
 * C4 mounts a SECOND ingress in front of the same routers: the board's
 * in-process MCP endpoint handler. §7.5 makes the two ingresses differ in
 * exactly one respect — the transport class each stamps after transport
 * termination (`api` for REST, `mcp` for MCP) — and in NOTHING else.
 *
 * Two hand-maintained mount lists would have made that promise a convention.
 * The list lives here instead, and both ingresses iterate it, so a router
 * reachable over REST is reachable over MCP by construction and a router
 * added to one is added to both. This is the same "one source, every path"
 * doctrine `utils/credentialAcceptance` was extracted for.
 *
 * ORDER IS SIGNIFICANT: `/tasks` batch routes must match before `/tasks/:id`.
 * Keep entries in the order the server has always mounted them.
 */
import type { RequestHandler, Router } from 'express';

import tasksRoutes from './routes/tasks';
import tasksBatchRoutes from './routes/tasksBatch';
import projectsRoutes from './routes/projects';
import principalsRoutes from './routes/principals';
import preferencesRoutes from './routes/preferences';
import credentialsRoutes from './routes/credentials';
import identityProvidersRoutes from './routes/identityProviders';
import scimRoutes from './routes/scim';
import notificationEndpointsRoutes from './routes/notificationEndpoints';
import eventsRoutes from './routes/events';
import appearanceAdminRoutes from './routes/appearanceAdmin';
import reporterHealthRoutes from './routes/reporterHealth';
import telemetryRoutes from './routes/telemetry';
import skillsRoutes from './routes/skills';
import blueprintsRoutes, { instantiationsRouter } from './routes/blueprints';
import personalitiesRoutes from './routes/personalities';
import servicesRoutes from './routes/services';
import grantsRoutes from './routes/grants';
import groupsRoutes from './routes/groups';
import directoryGroupReferencesRoutes from './routes/directoryGroupReferences';
import accessProfilesRoutes from './routes/accessProfiles';
import warrantsRoutes from './routes/warrants';
import approvalsRoutes from './routes/approvals';
import delegationRoutes from './routes/delegation';
import auditRoutes from './routes/audit';
import phasesRoutes from './routes/phases';
import dashboardRoutes from './routes/dashboard';
import modelsRoutes from './routes/models';
import pluginsRoutes from './routes/plugins';
import knowledgeRoutes, { knowledgeContentsRouter, knowledgeQueriesRouter } from './routes/knowledge';

import reportsRoutes from './routes/reports';
import litellmAdminRoutes from './routes/litellmAdmin';
import webhooksRoutes from './routes/webhooks';

export interface ProtectedRouteRegistration {
  /** Mount path, exactly as the server has always mounted it. */
  path: string;
  /** The router mounted there. */
  router: Router;
  /** Review-visible note, carried from the original server.ts comment. */
  note?: string;
}

/**
 * Every `app.use`-mounted protected router, in mount order.
 *
 * `/openapi.json` is deliberately absent: it is an `app.get` single handler,
 * not a router, and no MCP tool composes it. It keeps its own registration in
 * server.ts and its own `any` transport class.
 */
export const PROTECTED_ROUTE_REGISTRATIONS: ProtectedRouteRegistration[] = [
  { path: '/plugins', router: pluginsRoutes, note: 'the registry itself still needs auth' },
  {
    path: '/appearance',
    router: appearanceAdminRoutes,
    note: 'public asset reads have their own two-route router mounted earlier',
  },
  { path: '/tasks', router: tasksBatchRoutes, note: '/tasks/batch must match before /tasks/:id' },
  { path: '/tasks', router: tasksRoutes },
  { path: '/webhooks', router: webhooksRoutes },
  { path: '/projects', router: projectsRoutes },
  { path: '/principals', router: principalsRoutes },
  { path: '/preferences', router: preferencesRoutes, note: "the caller's OWN preferences; no identifier in the path" },
  { path: '/credentials', router: credentialsRoutes },
  { path: '/skills', router: skillsRoutes },
  { path: '/blueprints', router: blueprintsRoutes },
  { path: '/instantiations', router: instantiationsRouter },
  { path: '/personalities', router: personalitiesRoutes },
  { path: '/services', router: servicesRoutes },
  { path: '/grants', router: grantsRoutes },
  { path: '/groups', router: groupsRoutes },
  {
    path: '/directory-group-references',
    router: directoryGroupReferencesRoutes,
    note: 'RH-LENSES-a: the remote-group catalog. Mounted AFTER /groups, as design 07764243 §5.1 '
      + 'specifies: the two families share no path prefix, and keeping the order the design names '
      + 'keeps the review-visible list and the record in step.',
  },
  { path: '/access-profiles', router: accessProfilesRoutes },
  {
    path: '/warrants',
    router: warrantsRoutes,
    note: 'RH-P3.AZ-S4: login-session-only human surfaces with the §9.1 self-scope arm in the handlers',
  },
  { path: '/approvals', router: approvalsRoutes },
  { path: '/delegation', router: delegationRoutes, note: 'the one mint route, dispatched by authentication kind (§9.2)' },
  { path: '/audit', router: auditRoutes },
  { path: '/events', router: eventsRoutes, note: 'RH-P3.C1 cursor event feed: read-only, grant-scoped in the handler' },
  { path: '/phases', router: phasesRoutes },
  { path: '/dashboard', router: dashboardRoutes },
  { path: '/models', router: modelsRoutes },
  { path: '/litellm', router: litellmAdminRoutes },
  { path: '/sessions', router: reporterHealthRoutes, note: 'reporter-ingest health seed (A18) — the only surviving /sessions route' },
  { path: '/telemetry', router: telemetryRoutes },
  {
    path: '/knowledge-sources',
    router: knowledgeRoutes,
    note: 'RH-KW1: the caller\'s queryable set of knowledge sources (design 94747de9 §5.5). Owner decision D8 puts the three knowledge paths on the SAME module as they land.',
  },
  {
    path: '/knowledge-contents',
    router: knowledgeContentsRouter,
    note: 'RH-KW1 candidate B: §8.2 drill-down. The handle is the only source selector.',
  },
  {
    path: '/knowledge-queries',
    router: knowledgeQueriesRouter,
    note: 'RH-KW1 candidate C: §7 search. The third and last of decision D8\'s pinned paths; the fan-out set is §5.5 (a)-(e) and the response leads with the coverage record.',
  },
  { path: '/identity-providers', router: identityProvidersRoutes },
  {
    path: '/scim',
    router: scimRoutes,
    note: 'RH-P5.SSO.W4: inbound SCIM 2.0 — directory-provisioning:write (A24), Identity provider resolved from the credential',
  },
  { path: '/notification-endpoints', router: notificationEndpointsRoutes },
  { path: '/reports', router: reportsRoutes },
];

/**
 * Mount every registration through `mount`, which supplies the ingress's own
 * authentication (and therefore its own server-derived transport stamp).
 */
export function registerProtectedRoutes(
  mount: (path: string, ...handlers: Array<RequestHandler | Router>) => void,
): void {
  for (const registration of PROTECTED_ROUTE_REGISTRATIONS) {
    mount(registration.path, registration.router);
  }
}
