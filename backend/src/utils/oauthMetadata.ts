/**
 * oauthMetadata — the ONE renderer for everything this deployment publishes
 * about its OAuth 2.1 authorization server (RH-P3.C6).
 *
 * Contract: strategy 4e40f06f Phase 3 (ratified C3 amendment) — the OAuth 2.1
 * authorization server as "the budgeted price of Tier B clients, following
 * where MCP auth is going (Client ID Metadata Documents, not DCR)".
 *
 * ── WHY A RENDERER AND NOT THREE HAND-WRITTEN DOCUMENTS ──
 *
 * Four surfaces have to agree about this server or a client breaks:
 *
 *   1. RFC 8414 authorization-server metadata, which tells a client where the
 *      endpoints are and what this server will actually accept;
 *   2. RFC 9728 protected-resource metadata, which tells a client that the
 *      MCP endpoint is protected and by WHICH authorization server;
 *   3. the `WWW-Authenticate` challenge the MCP endpoint answers 401 with,
 *      which is how a client discovers (2) in the first place;
 *   4. the published support matrix, which tells a HUMAN the same thing.
 *
 * They are all rendered here, from the same constants, so "the server accepts
 * only S256" is one fact with one home rather than four sentences that can
 * drift. The drift suite (`backend/src/__tests__/c9BootstrapPacks.test.ts`)
 * rebuilds its expectation from these constants rather than from the document
 * it is checking, and anchors the whole thing on the endpoints' real refusals.
 *
 * ── WHAT THESE CONSTANTS ARE CLAIMING ──
 *
 * Each one is a REFUSAL somewhere in routes/oauth.ts, not an aspiration:
 *   - `authorization_code` is the only grant this server implements. There is
 *     no refresh-token grant in this release, no implicit flow, no password
 *     grant, and no RFC 8693 token exchange (that upgrade rung is DEFERRED —
 *     ruling KS-1, record d92e756c; vehicle 86508d90 stays Phase-4-parked).
 *     A client reading this metadata is told exactly that.
 *   - `S256` is the only PKCE method, and PKCE is required, not optional.
 *   - `none` is the only token-endpoint authentication method because every
 *     CIMD client is a public client: its identity is a URL it controls, its
 *     proof is the PKCE verifier, and there is no secret to present.
 */

/** The mount path of the authorization server's own endpoints. */
export const OAUTH_ROUTE_PATH = '/oauth';

/**
 * The discovery documents are mounted at the API ROOT, not under `/oauth`.
 *
 * RFC 8414 has a client construct `<issuer>/.well-known/oauth-authorization-
 * server`, and the issuer here is the board's public API endpoint — so the
 * document has to be reachable at exactly that path or a conforming client
 * never finds it. Two mounts is the price of being discoverable the ordinary
 * way, and the second one is three lines of router with no authority at all.
 *
 * These paths are relative to the board's API prefix rather than the origin
 * root because the deployment's ingress owns the origin root and strips the
 * prefix before the application sees a request. Both RFCs still hold: RFC 9728
 * §5.1 has the client follow the ABSOLUTE URL in the `resource_metadata`
 * challenge parameter, and RFC 8414's construction is relative to the ISSUER,
 * which is the prefixed endpoint. Nothing in the chain is guessed from a
 * convention, so nothing in it breaks under a prefix.
 */
export const OAUTH_WELL_KNOWN_ROUTE_PATH = '/.well-known';
export const OAUTH_AS_METADATA_SUFFIX = '/oauth-authorization-server';
export const OAUTH_PROTECTED_RESOURCE_METADATA_SUFFIX = '/oauth-protected-resource';
export const OAUTH_AS_METADATA_PATH = `${OAUTH_WELL_KNOWN_ROUTE_PATH}${OAUTH_AS_METADATA_SUFFIX}`;
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  `${OAUTH_WELL_KNOWN_ROUTE_PATH}${OAUTH_PROTECTED_RESOURCE_METADATA_SUFFIX}`;

/** OAuth 2.1: the authorization-code grant, and nothing else (see above). */
export const OAUTH_GRANT_TYPES_SUPPORTED = ['authorization_code'] as const;
export const OAUTH_RESPONSE_TYPES_SUPPORTED = ['code'] as const;
/** PKCE is REQUIRED and S256 is the only method accepted. */
export const OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED = ['S256'] as const;
/** Every CIMD client is a public client: no secret exists to present. */
export const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = ['none'] as const;
/** The token rides the Authorization header, and only there. */
export const OAUTH_BEARER_METHODS_SUPPORTED = ['header'] as const;

/** Endpoint paths under {@link OAUTH_ROUTE_PATH}. */
export const OAUTH_AUTHORIZATION_ENDPOINT_PATH = `${OAUTH_ROUTE_PATH}/authorize`;
export const OAUTH_TOKEN_ENDPOINT_PATH = `${OAUTH_ROUTE_PATH}/token`;
export const OAUTH_REVOCATION_ENDPOINT_PATH = `${OAUTH_ROUTE_PATH}/revoke`;

/**
 * Where the browser is sent for the human consent step.
 *
 * The dashboard is served under a deployment-chosen base path (`/dashboard/`
 * in a production build, which is what every deployed RelayHall is). A
 * deployment that serves it elsewhere declares it here rather than discovering
 * the mismatch as a 404 in the middle of someone's authorization.
 */
export const DASHBOARD_BASE_PATH_ENV = 'RELAYHALL_DASHBOARD_BASE_PATH';
export const DEFAULT_DASHBOARD_BASE_PATH = '/dashboard';

export function consentPagePath(env: NodeJS.ProcessEnv = process.env): string {
  const declared = (env[DASHBOARD_BASE_PATH_ENV] || '').trim();
  const base = (declared || DEFAULT_DASHBOARD_BASE_PATH).replace(/\/+$/, '');
  return `${base}/oauth/consent`;
}

/**
 * The issuer identifier: the board's own public API endpoint.
 *
 * `boardEndpointFor` is the deployment's declared `RELAYHALL_PUBLIC_API_URL`
 * when it has one, and the request's own origin otherwise — the same
 * derivation the onboarding pack uses to name the endpoint a credential
 * authenticates against, and for the same reason: a document that named a
 * different origin than the one the caller reached would be a document about
 * some other deployment.
 */
export function oauthIssuer(boardEndpoint: string): string {
  return boardEndpoint.replace(/\/+$/, '');
}

/** The resource identifier this authorization server issues tokens for. */
export function oauthResourceIdentifier(boardEndpoint: string): string {
  return `${oauthIssuer(boardEndpoint)}/mcp`;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  /** CIMD, not DCR: there is no registration endpoint, and saying so is the
   * point — a client that would otherwise try DCR is told what to do instead. */
  client_id_metadata_document_supported: boolean;
}

/** RFC 8414 authorization-server metadata for this deployment. */
export function buildAuthorizationServerMetadata(
  boardEndpoint: string,
  scopesSupported: string[],
): AuthorizationServerMetadata {
  const issuer = oauthIssuer(boardEndpoint);
  return {
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_AUTHORIZATION_ENDPOINT_PATH}`,
    token_endpoint: `${issuer}${OAUTH_TOKEN_ENDPOINT_PATH}`,
    revocation_endpoint: `${issuer}${OAUTH_REVOCATION_ENDPOINT_PATH}`,
    scopes_supported: [...scopesSupported],
    response_types_supported: [...OAUTH_RESPONSE_TYPES_SUPPORTED],
    grant_types_supported: [...OAUTH_GRANT_TYPES_SUPPORTED],
    code_challenge_methods_supported: [...OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED],
    token_endpoint_auth_methods_supported: [...OAUTH_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED],
    revocation_endpoint_auth_methods_supported: [...OAUTH_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED],
    client_id_metadata_document_supported: true,
  };
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

/** RFC 9728 protected-resource metadata for the board's MCP endpoint. */
export function buildProtectedResourceMetadata(
  boardEndpoint: string,
  scopesSupported: string[],
): ProtectedResourceMetadata {
  const issuer = oauthIssuer(boardEndpoint);
  return {
    resource: oauthResourceIdentifier(boardEndpoint),
    authorization_servers: [issuer],
    scopes_supported: [...scopesSupported],
    bearer_methods_supported: [...OAUTH_BEARER_METHODS_SUPPORTED],
  };
}

/** The absolute URL a client fetches {@link buildProtectedResourceMetadata} from. */
export function protectedResourceMetadataUrl(boardEndpoint: string): string {
  return `${oauthIssuer(boardEndpoint)}${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}`;
}

/** The absolute URL a client fetches {@link buildAuthorizationServerMetadata} from. */
export function authorizationServerMetadataUrl(boardEndpoint: string): string {
  return `${oauthIssuer(boardEndpoint)}${OAUTH_AS_METADATA_PATH}`;
}

/**
 * The Tier-B availability cell of the published support matrix.
 *
 * ── WHY THIS SENTENCE IS RENDERED AND NOT WRITTEN ──
 *
 * `docs/harness-support.md` shipped with C9 carrying an honest not-yet row and
 * this promise: the MCP endpoint "deliberately advertises no OAuth
 * protected-resource metadata today ... when the authorization server ships,
 * this row flips and **that release is what flips it** — not this page."
 *
 * Keeping the promise means the cell cannot be a word a later editor changes.
 * It is rendered here from the constants that ARE the server's behaviour —
 * the grant it implements and the PKCE method it requires — so the published
 * claim and the endpoints move together or the drift suite goes red.
 *
 * The claim is also, for the first time, PROVABLE. C9 could only pin the
 * not-yet row ("nothing in this repository can demonstrate the absence of an
 * authorization server"). Availability is the opposite kind of statement: the
 * suite drives the real token endpoint and the real MCP challenge and watches
 * them do what this sentence says.
 */
export function tierBAvailabilitySentence(): string {
  return '**yes — the OAuth 2.1 authorization server is released: '
    + `${OAUTH_GRANT_TYPES_SUPPORTED.join(' + ')} grant, `
    + `${OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED.join('/')} PKCE required, `
    + 'client identity by Client ID Metadata Document**';
}

/**
 * The `WWW-Authenticate` challenge the MCP endpoint answers 401 with.
 *
 * RH-P3.C4 shipped this as a fixed string that advertised NO metadata,
 * deliberately: with no authorization server released, a `resource_metadata`
 * pointer would have lured a static-header client into a flow the board could
 * not serve (the Claude Code #59467 edge). C6 releases the server, so the
 * pointer becomes true and is added — RFC 9728 §5.1. THIS IS THE MECHANISM
 * THAT FLIPS THE TIER-B ROW.
 *
 * `boardEndpoint` is null only where the challenge is emitted with no request
 * in hand; the challenge then degrades to the pre-C6 form rather than guessing
 * an origin, because a WRONG discovery URL is worse than none.
 */
export function mcpWwwAuthenticate(boardEndpoint: string | null): string {
  const base = 'Bearer realm="relayhall-mcp", error="invalid_token"';
  if (!boardEndpoint) return base;
  return `${base}, resource_metadata="${protectedResourceMetadataUrl(boardEndpoint)}"`;
}
