/**
 * Review-visible authorization mount contract. Public entries are deliberately
 * short: growing this list is a security-significant code-review event.
 */
export const PUBLIC_ROUTE_MOUNTS = [
  '/',
  '/health',
  // RH-P3.C8 ops floor: a monitor must never be told 401 about the thing it
  // watches. Both shipped with C8 and were absent from this list until the C4
  // mount census made the omission visible — nothing had ever censused
  // `app.get` (REJECT 492c7d11 B2).
  '/readiness',
  '/health/functional',
  // Card 590c638a - the effective orchestration configuration of the
  // running process (the reachability check). Same audience as /health:
  // coarse policy integers, no database, no identity, no board data.
  '/health/orchestration',
  '/auth',
  '/config',
  // RH-P3.C6 — the OAuth 2.1 authorization server. PUBLIC by contract: a
  // client that holds no credential yet is exactly who this surface is for.
  // What is public is PROTOCOL, not board data — discovery metadata, the
  // authorize entry point, the token exchange and RFC 7009 revocation. The
  // two endpoints that touch a person's authority (reading a pending consent
  // and deciding it) authenticate the LOGIN SESSION in-handler, the way
  // `POST /auth/step-up` does on this same kind of mount, and refuse bearer
  // credentials outright (AZ-18). The authority a consent confers is still
  // decided by the shared predicate on every later call, never here.
  '/oauth',
  // RH-P3.C6 — the two OAuth discovery documents (RFC 8414 / RFC 9728). They
  // render constants: no database, no identity, no side effect. They sit at
  // the API root because that is where a conforming client looks for them.
  '/.well-known',
  '/appearance', // active pre-login identity asset only; admin router is protected below
  '/plugin-proxy',
  '/plugins/theme.css',
] as const;

/**
 * RH-P3.C4 — the board's in-process MCP ingress. AUTHENTICATED, but
 * deliberately NOT a `protectedRouter` mount: that funnel installs
 * `authMiddleware`, which stamps the transport class `api`, and this ingress
 * must stamp `mcp` after transport termination (design 4d961e37 §7.5). It
 * runs the SAME credential acceptance (`acceptPrincipalKey`) and dispatches
 * every tool through the SAME routers behind the SAME shared-authorization
 * ceiling — see mcp/inProcess. This list has exactly one entry, and growing
 * it is a security-significant code-review event of the first order.
 */
export const SELF_AUTHENTICATING_ROUTE_MOUNTS = ['/mcp'] as const;

export const PROTECTED_ROUTE_MOUNTS = [
  '/appearance',
  '/plugins',
  '/audit',
  // RH-P3.C1: the cursor event feed — read-only, tasks:read ceiling,
  // per-event grant scoping in the handler.
  '/events',
  '/telemetry',
  '/notification-endpoints',
  // RH-P5.SSO.W2: the Identity provider owner-plane surface — root in the
  // scope map, audited by its service, and never returning a client secret.
  '/identity-providers',
  // RH-P5.SSO.W4: the inbound SCIM 2.0 provisioning surface — the ONE
  // family requiring `directory-provisioning:write` (A24). PROTECTED and
  // not public: RFC 7644 §2 would permit an unauthenticated
  // ServiceProviderConfig, and growing PUBLIC_ROUTE_MOUNTS for it is not
  // worth a discovery document a provisioning client can fetch
  // authenticated anyway.
  '/scim',
  // RH-KW1 (KNOWLEDGE-DESIGN `94747de9` §5.5): the caller's queryable set
  // of knowledge sources. PROTECTED, `knowledge-contents:read` in the
  // scope map, and row-authorized in the handler — it composes the SAME
  // shared predicate over `service` rows that `GET /services` composes,
  // never a copy of it. It is NOT in ROW_AUTHORIZED_ROUTE_MOUNTS because
  // that list classifies families whose OWN rows carry object authority;
  // this family serves a projection of `/services` rows, whose mount is
  // already listed there.
  '/knowledge-sources',
  // RH-KW1 candidate B: the §8.2 drill-down. Same ceiling and the same
  // shared predicate as its sibling; the handle carries the source, so
  // this family addresses `service` rows exactly as `/knowledge-sources`
  // does and is likewise not a ROW_AUTHORIZED family of its own.
  '/knowledge-contents',
  // RH-KW1 candidate C: §7's search. Same ceiling, same shared predicate, and
  // the same reason it is not a ROW_AUTHORIZED family — the rows it returns
  // are `service` projections plus, for the board pseudo-source, rows the
  // board adapter draws through the shipped predicate IN-QUERY.
  '/knowledge-queries',
  '/tasks',
  '/webhooks',
  '/openapi.json',
  '/projects',
  '/principals',
  '/preferences',
  '/credentials',
  '/skills',
  '/blueprints',
  // Ledger rows derive authority from the Blueprint and root Project; they
  // are protected projections, not a new independently grantable resource.
  '/instantiations',
  '/personalities',
  '/services',
  '/grants',
  // RH-P3.AZ-S2: Access profiles — mutation owner-plane (root), listings
  // principals:read, what-if/events root, per the scope map.
  '/access-profiles',
  // RH-P3.AZ-S4: Warrants + Approvals — session-only human surfaces with
  // the §6.1 self-scope step-up arm in the handlers; /delegation carries
  // the one mint route dispatched by authentication kind (§9.2).
  '/warrants',
  '/approvals',
  '/delegation',
  // RH-P3.AZ-S1: Group administration — mutation owner-plane (root),
  // listings principals:read, per the scope map.
  '/groups',
  '/phases',
  '/dashboard',
  // RH-LENSES-a (card 74e02a05): the remote-group catalog. It is protected
  // like every other mount -- authentication, then the shared predicate,
  // then the in-handler s5.3 projection, which narrows further and is not
  // the ceiling.
  '/directory-group-references',
  '/models',
  '/litellm',
  '/sessions',
  '/reports',
] as const;

/** Families whose rows carry object authority or are grantable resources.
 * Their handlers must call the point/list adapter in addition to the route
 * ceiling. The structural test pins this classification. */
export const ROW_AUTHORIZED_ROUTE_MOUNTS = [
  '/tasks',
  '/projects',
  '/phases',
  '/reports',
  '/skills',
  '/blueprints',
  '/personalities',
  '/services',
] as const;

/** Blueprint published declarations select read/use projection in their
 * handler before applying the same canonical SQL row predicate. A generic
 * GET-to-read point gate would discard the ratified use-only audience. */
export const HANDLER_ROW_AUTHORIZED_ROUTE_MOUNTS = ['/blueprints'] as const;

/** Route-ceiling only until its target-shape object arrives. Plugin registry
 * ids are manifest names today while grants.resource_id is UUID, so claiming
 * object authorization here would be fictional. Phase 4 owns that conversion. */
export const ROUTE_ONLY_RESOURCE_MOUNTS = ['/plugins'] as const;
