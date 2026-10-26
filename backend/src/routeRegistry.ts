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
import { nativeTaskReviewsRouter, nativeServiceReviewsRouter } from './routes/nativeReviews';
import { nativeExecutionsRouter } from './routes/nativeExecutions';
import tasksBatchRoutes from './routes/tasksBatch';
import projectsRoutes from './routes/projects';
import principalsRoutes from './routes/principals';
import preferencesRoutes from './routes/preferences';
import credentialsRoutes from './routes/credentials';
import identityProvidersRoutes from './routes/identityProviders';
import scimRoutes from './routes/scim';
import notificationEndpointsRoutes from './routes/notificationEndpoints';
import notificationsRoutes from './routes/notifications';
import eventsRoutes from './routes/events';
import appearanceAdminRoutes from './routes/appearanceAdmin';
import reporterHealthRoutes from './routes/reporterHealth';
import telemetryRoutes from './routes/telemetry';
import metricsRoutes from './routes/metrics';
import skillsRoutes from './routes/skills';
import blueprintsRoutes, { instantiationsRouter } from './routes/blueprints';
import personalitiesRoutes from './routes/personalities';
import servicesRoutes from './routes/services';
import grantsRoutes from './routes/grants';
import groupsRoutes from './routes/groups';
import directoryGroupReferencesRoutes from './routes/directoryGroupReferences';
import accessProfilesRoutes from './routes/accessProfiles';
import accessExplorerRoutes from './routes/accessExplorer';
import warrantsRoutes from './routes/warrants';
import approvalsRoutes from './routes/approvals';
import delegationRoutes from './routes/delegation';
import auditRoutes from './routes/audit';
import phasesRoutes from './routes/phases';
import dashboardRoutes from './routes/dashboard';
import modelsRoutes from './routes/models';
import pluginsRoutes from './routes/plugins';
import pluginHostRoutes from './routes/pluginHost';
import pluginAdminRoutes from './routes/pluginAdmin';
import knowledgeRoutes, {
  knowledgeContentsRouter, knowledgeQueriesRouter, knowledgeWritesRouter,
} from './routes/knowledge';
import { knowledgeSharedWritersRouter } from './routes/knowledgeSharedWriters';
import { knowledgeSourceRegistrationsRouter } from './routes/knowledgeSourceRegistrations';

import reportsRoutes from './routes/reports';
import litellmAdminRoutes from './routes/litellmAdmin';
import webhooksRoutes from './routes/webhooks';
import toolCatalogueRoutes from './routes/toolCatalogue';
import connectorsRoutes from './routes/connectors';

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
  { path: '/tool-catalogue', router: toolCatalogueRoutes, note: 'built-in MCP metadata only, no invocation or service records' },
  { path: '/plugin-host', router: pluginHostRoutes },
  {
    path: '/plugin-admin',
    router: pluginAdminRoutes,
    note: 'card bedf50cc (E380): plugin availability and deployment settings; an admin or operator login session in the handler',
  },
  { path: '/plugins', router: pluginsRoutes, note: 'the registry itself still needs auth' },
  {
    path: '/appearance',
    router: appearanceAdminRoutes,
    note: 'public asset reads have their own two-route router mounted earlier',
  },
  { path: '/tasks', router: tasksBatchRoutes, note: '/tasks/batch must match before /tasks/:id' },
  { path: '/tasks', router: nativeTaskReviewsRouter },
  { path: '/tasks', router: nativeExecutionsRouter },
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
  { path: '/services', router: nativeServiceReviewsRouter },
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
    path: '/access-explorer',
    router: accessExplorerRoutes,
    note: 'AZ-A12 build 6 (card 1e56dbef): the Access Explorer read model; read-only, principals:read, narrowed in the handlers',
  },
  {
    path: '/warrants',
    router: warrantsRoutes,
    note: 'RH-P3.AZ-S4: login-session-only human surfaces with the §9.1 self-scope arm in the handlers',
  },
  { path: '/approvals', router: approvalsRoutes },
  { path: '/delegation', router: delegationRoutes, note: 'the one mint route, dispatched by authentication kind (§9.2)' },
  { path: '/audit', router: auditRoutes },
  { path: '/events', router: eventsRoutes, note: 'RH-P3.C1 cursor event feed: read-only, grant-scoped in the handler' },
  {
    path: '/notifications',
    router: notificationsRoutes,
    note: 'Card 5854f0d6 (E394, choice C3): Needs your action and the Timeline, tasks:read; every arm narrowed IN the query by its own ceiling and list scope. One MCP tool, read only (E467: relayhall_action_items_list over GET /notifications/actions/owner). Shares no prefix with /notification-endpoints or /tasks/notifications',
  },
  { path: '/phases', router: phasesRoutes },
  { path: '/dashboard', router: dashboardRoutes },
  { path: '/models', router: modelsRoutes },
  { path: '/litellm', router: litellmAdminRoutes },
  { path: '/sessions', router: reporterHealthRoutes, note: 'reporter-ingest health seed (A18) — the only surviving /sessions route' },
  { path: '/telemetry', router: telemetryRoutes },
  {
    path: '/connectors',
    router: connectorsRoutes,
    note: 'E462 slice S3: what the local connector reads. GET /connectors/trust-policy is the board\'s NARROW-ONLY override of the connector release\'s trust policy (design 4.3, B3), services:read; no board object, nothing about the caller.',
  },
  { path: '/metrics', router: metricsRoutes, note: 'Account-bound dedicated read-only collector; handler applies live object narrowing' },
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
  {
    path: '/knowledge-writes',
    router: knowledgeWritesRouter,
    note: 'RB-11 Governor v0 (b796067e): propose / preview / commit, door relays to the source write surface (design C.12, answer E1) on the same knowledge module. The core stores no note content.',
  },
  {
    path: '/knowledge-shared-writers',
    router: knowledgeSharedWritersRouter,
    note: 'Card 549cc51f (E298, E299, E310): the shared-area writer list of a knowledge source, in its own route module. GET is services:read; the add and remove POSTs are root or administrator login-session acts with step-up, decided in the handler.',
  },
  {
    path: '/knowledge-source-registrations',
    router: knowledgeSourceRegistrationsRouter,
    note: 'Card 08792425 (member N6, the default-store design C7): two-way registration of a knowledge source from an installer bundle, its state and its return bundle. Root or an administrator login session in the handler, a step-up on the act; bearers are refused.',
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
