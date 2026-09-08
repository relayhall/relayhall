// transportMap.ts — declared route transport classes (RH-P3.AZ-S3; AUTHZ
// design 4d961e37 §7.5, AZ-14, T15/T26).
//
// THE TRUST BOUNDARY: a request's transport class is a SERVER-DERIVED
// provenance attribute stamped at ingress termination — REST ingress
// stamps `api`; the board's in-process MCP endpoint handler (when one
// mounts) stamps `mcp` AFTER transport termination. The attribute is never
// read from headers or any caller-controllable input, so a direct HTTP
// caller cannot masquerade as MCP. The auth middleware compares a
// credential's transport pin against ONLY this stamp.
//
// EVERY route family carries a DECLARED class below (the registration
// lint pins full coverage of the protected mounts). An UNCLASSIFIED path
// mirrors the scopeMap unmapped-route rule: it rejects any credential
// whose transport pin is not `any` (T26 — fail closed, never fail open).
//
// RH-P3.C4 — THE MCP HANDLER NOW EXISTS, and `/mcp` is declared `mcp`.
// That declaration is load-bearing, and it is the narrowing this candidate
// lands: an UNCLASSIFIED path rejects every non-'any' pin (T26), so without
// this row an `mcp`-pinned credential could not use the MCP endpoint at all.
//
// EVERY OTHER FAMILY STAYS 'any', DELIBERATELY. The §9.3 agent-plane
// operations are served on BOTH surfaces — design §9.2 mandates "agent-plane
// REST mirrors of the §9.3 operations under /delegation/* so OpenAPI covers
// them" — so declaring /delegation `mcp` would be a false statement about a
// route that REST really does serve. It would also change nothing: §7.5 says
// the middleware "compares the credential's transport pin against ONLY this
// server-derived attribute", and `evaluateTransportPin` implements exactly
// that — a declared class gates COVERAGE (classified vs not), never identity.
//
// The enforcement the ruling asks for is delivered by the two ingresses
// instead, and is complete without narrowing anything else: an `mcp`-pinned
// credential is stamped `mcp` only by the in-process MCP handler, so it
// SUCCEEDS through a tool and is refused (403 TRANSPORT_MISMATCH) on every
// REST route (T15); a forged provenance header cannot reach the MCP ingress
// at all and still classifies `api`; rotation inherits the pin verbatim
// (T28). Narrowing a dual-served family here is a security-significant review
// event AND a truthfulness question — do both before changing a row.

export type TransportClass = 'any' | 'mcp' | 'api';

const ROUTE_TRANSPORT_CLASSES: Array<{ pattern: RegExp; transport: TransportClass }> = [
  { pattern: /^\/appearance(\/|$)/, transport: 'any' },
  { pattern: /^\/plugins(\/|$)/, transport: 'any' },
  { pattern: /^\/audit(\/|$)/, transport: 'any' },
  { pattern: /^\/events(\/|$)/, transport: 'any' },
  { pattern: /^\/telemetry(\/|$)/, transport: 'any' },
  { pattern: /^\/notification-endpoints(\/|$)/, transport: 'any' },
  // RH-P5.SSO.W2 — the Identity provider owner-plane surface (A23.1, SS-3).
  { pattern: /^\/identity-providers(\/|$)/, transport: 'any' },
  // RH-P5.SSO.W4 — the inbound SCIM 2.0 surface. 'any', like every family
  // but /mcp: the Identity provider's SCIM client reaches it over REST and
  // declaring it `mcp` would be a false statement about a route REST serves.
  { pattern: /^\/scim(\/|$)/, transport: 'any' },
  { pattern: /^\/tasks(\/|$)/, transport: 'any' },
  { pattern: /^\/webhooks(\/|$)/, transport: 'any' },
  { pattern: /^\/openapi\.json$/, transport: 'any' },
  { pattern: /^\/projects(\/|$)/, transport: 'any' },
  { pattern: /^\/principals(\/|$)/, transport: 'any' },
  { pattern: /^\/preferences(\/|$)/, transport: 'any' },
  { pattern: /^\/credentials(\/|$)/, transport: 'any' },
  { pattern: /^\/skills(\/|$)/, transport: 'any' },
  { pattern: /^\/blueprints(\/|$)/, transport: 'any' },
  { pattern: /^\/instantiations(\/|$)/, transport: 'any' },
  { pattern: /^\/personalities(\/|$)/, transport: 'any' },
  { pattern: /^\/services(\/|$)/, transport: 'any' },
  // RH-KW1 — the knowledge source plane. 'any', like every family but
  // /mcp: candidate D's two MCP tools reach it through the in-process
  // ingress and REST callers reach it directly, so declaring it `mcp`
  // would be a false statement about a route REST serves.
  { pattern: /^\/knowledge-sources(\/|$)/, transport: 'any' },
  { pattern: /^\/knowledge-contents(\/|$)/, transport: 'any' },
  { pattern: /^\/knowledge-queries(\/|$)/, transport: 'any' },
  { pattern: /^\/grants(\/|$)/, transport: 'any' },
  { pattern: /^\/groups(\/|$)/, transport: 'any' },
  // RH-LENSES-a (card 74e02a05) -- the remote-group catalog. 'any', like
  // every family but /mcp, and the reason is this module's own doctrine:
  // a declared class gates COVERAGE, never identity, and declaring a
  // REST-served family anything else is a false statement about what REST
  // serves. This family is served over REST to a browser and to the CLI.
  //
  // OBLIGATION B-L12 -- "no MCP surface for any act OR read in this
  // design" -- is NOT delivered here and must not be read into this row.
  // It is delivered by `src/mcp/registry.ts` carrying no tool for this
  // family, which is an explicit hand-written list and not derived from
  // the mounts; `directoryCarriageSeamCensus.test.ts` asserts the absence
  // over that list.
  { pattern: /^\/directory-group-references(\/|$)/, transport: 'any' },
  { pattern: /^\/access-profiles(\/|$)/, transport: 'any' },
  { pattern: /^\/warrants(\/|$)/, transport: 'any' },
  { pattern: /^\/approvals(\/|$)/, transport: 'any' },
  { pattern: /^\/delegation(\/|$)/, transport: 'any' },
  { pattern: /^\/phases(\/|$)/, transport: 'any' },
  { pattern: /^\/dashboard(\/|$)/, transport: 'any' },
  { pattern: /^\/models(\/|$)/, transport: 'any' },
  { pattern: /^\/litellm(\/|$)/, transport: 'any' },
  { pattern: /^\/sessions(\/|$)/, transport: 'any' },
  { pattern: /^\/reports(\/|$)/, transport: 'any' },
  // The board's in-process MCP endpoint. The ONLY family declared `mcp`.
  { pattern: /^\/mcp(\/|$)/, transport: 'mcp' },
];

/** Declared class for a mounted path; undefined = UNCLASSIFIED (which
 * rejects every non-'any' credential pin — T26). */
export function routeTransportClassFor(mountedPath: string): TransportClass | undefined {
  const path = (mountedPath || '/').split('?')[0].replace(/\/{2,}/g, '/').toLowerCase().replace(/\/+$/, '') || '/';
  for (const rule of ROUTE_TRANSPORT_CLASSES) {
    if (rule.pattern.test(path)) return rule.transport;
  }
  return undefined;
}

/** The lint surface: patterns exported so the structural test can prove
 * every protected mount carries a declared class. */
export const DECLARED_TRANSPORT_PATTERNS = ROUTE_TRANSPORT_CLASSES.map((rule) => rule.pattern.source);
