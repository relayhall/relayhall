/**
 * OAuthClientMetadataService — Client ID Metadata Documents (RH-P3.C6).
 *
 * Contract: strategy 4e40f06f Phase 3, ratified C3 amendment — the OAuth 2.1
 * authorization server follows "where MCP auth is going (**Client ID Metadata
 * Documents, not DCR**)". A client's identity IS an https URL it controls;
 * that URL serves a JSON document describing the client; there is no
 * registration endpoint, no client secret and nothing an anonymous caller can
 * create on this board by asking.
 *
 * ── THE OUTBOUND POLICY IS THE SECURITY SURFACE ──
 *
 * The AS fetches a document from a URL an UNAUTHENTICATED caller supplies.
 * Every bound below is a refusal, and each closes a specific attack:
 *
 *   scheme     https only              — no file:, no http:, no gopher:
 *   userinfo   refused                 — `https://board@evil/` credential smuggling
 *   fragment   refused                 — the fragment is not sent, so a document
 *                                        identified by one is not addressable
 *   port       443 only                — no probing arbitrary internal ports
 *   host       must be a NAME          — an IP literal is never a CIMD identity,
 *                                        and refusing it removes the whole
 *                                        "point at the metadata service" class
 *   address    public ranges only      — utils/outboundAddressPolicy; every
 *                                        resolved address is checked, not just
 *                                        the one that happens to be used
 *   rebinding  connection is PINNED    — resolve once, validate, then connect
 *                                        to the validated address. The agent
 *                                        never resolves, so a second answer
 *                                        cannot exist
 *   redirects  never followed          — a 3xx is a refusal, not a hop. Following
 *                                        one would re-open every bound above
 *   type       application/json        — an HTML page is not a metadata document
 *   size       64 KiB, enforced as it
 *              arrives                 — never "read it all, then check"
 *   time       5 s total               — a slowloris document cannot hold a
 *                                        request handler open
 *
 * The document itself is then validated: it must name ITSELF as `client_id`
 * (the self-reference is what makes a URL an identity), and every redirect_uri
 * must be one the OAuth 2.1 redirect rules permit.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──
 *
 * No cache is trusted for an authorization decision. `oauth_clients` records
 * what was fetched, with the sha256 of the exact bytes, so a client that
 * changes its document between authorizations is visible in the audit ledger —
 * but every /authorize re-fetches and re-validates. A cached redirect_uris
 * list is a stale allowlist, and a stale allowlist is an open redirector.
 */
import dns from 'dns';
import https from 'https';
import crypto from 'crypto';

import { pool } from '../db/connection';
import { outboundAddressVerdict } from '../utils/outboundAddressPolicy';

/** Total wall-clock budget for one document fetch. */
export const CIMD_FETCH_TIMEOUT_MS = 5_000;
/** Hard ceiling on the document, enforced while the body streams in. */
export const CIMD_MAX_DOCUMENT_BYTES = 64 * 1024;
/** The only port a Client ID Metadata Document may be served from. */
export const CIMD_REQUIRED_PORT = 443;
/** Content types accepted for the document. */
export const CIMD_ACCEPTED_CONTENT_TYPES = ['application/json'];

export type ClientMetadataRefusal =
  | 'CLIENT_ID_NOT_A_URL'
  | 'CLIENT_ID_NOT_HTTPS'
  | 'CLIENT_ID_HAS_USERINFO'
  | 'CLIENT_ID_HAS_FRAGMENT'
  | 'CLIENT_ID_PORT_NOT_ALLOWED'
  | 'CLIENT_ID_HOST_IS_ADDRESS'
  | 'CLIENT_HOST_UNRESOLVABLE'
  | 'CLIENT_ADDRESS_NOT_PUBLIC'
  | 'DOCUMENT_UNREACHABLE'
  | 'DOCUMENT_REDIRECTED'
  | 'DOCUMENT_STATUS'
  | 'DOCUMENT_CONTENT_TYPE'
  | 'DOCUMENT_TOO_LARGE'
  | 'DOCUMENT_NOT_JSON'
  | 'DOCUMENT_CLIENT_ID_MISMATCH'
  | 'DOCUMENT_NO_REDIRECT_URIS'
  | 'DOCUMENT_BAD_REDIRECT_URI';

export class ClientMetadataError extends Error {
  constructor(public readonly refusal: ClientMetadataRefusal, message: string) {
    super(message);
    this.name = 'ClientMetadataError';
  }
}

const refuse = (refusal: ClientMetadataRefusal, message: string): never => {
  throw new ClientMetadataError(refusal, message);
};

export interface ClientMetadataDocument {
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  scope: string | null;
  raw: Record<string, unknown>;
  documentSha256: string;
}

/**
 * A redirect URI OAuth 2.1 permits for a public client.
 *
 * https anywhere, plus loopback http for a native client that listens on an
 * ephemeral port. `localhost` as a NAME is deliberately excluded (OAuth 2.1
 * §8.4.2 says the same): it can be made to resolve elsewhere, while the
 * literals cannot. A fragment is refused because the redirect appends the
 * response parameters as a query and a fragment would be dropped.
 */
export function isAcceptableRedirectUri(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== '') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  return false;
}

/**
 * An optional DISPLAY url from a client's metadata document — `client_uri`,
 * `logo_uri` — that the board is willing to put in front of a human.
 *
 * ── WHY THIS EXISTS (review 6fe97bc5, B3) ──
 *
 * These fields are supplied by an UNAUTHENTICATED caller and end up on the
 * signed-in consent page, where the person's dashboard session lives. An
 * earlier draft accepted any non-empty string up to 2048 bytes, and the
 * consent page rendered `client_uri` straight into an `href` — so
 * `javascript:alert(document.domain)` became a link on an authenticated
 * surface. `rel="noreferrer noopener"` is not URL validation, and a framework
 * that happens to block one scheme today is not a control either.
 *
 * So the board decides here, once, on the server: an absolute `https:` URL
 * with no userinfo and no fragment, or NOTHING. A value that fails is dropped
 * to null rather than passed along, and the page has nothing unsafe to render
 * even if it stops being careful.
 */
export function sanitizeDisplayUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hash !== '') return null;
  return url.toString();
}

/**
 * Validate the shape of the `client_id` itself, BEFORE any network act.
 *
 * A caller-supplied URL that fails here never becomes a socket, which is why
 * this is a separate exported step: the authorize endpoint can refuse a
 * malformed client_id without the board having made any outbound request at
 * all, and the test suite can prove that boundary without a network.
 */
export function validateClientIdUrl(clientId: unknown): URL {
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 2048) {
    return refuse('CLIENT_ID_NOT_A_URL', 'client_id must be an https URL (Client ID Metadata Document)');
  }
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return refuse('CLIENT_ID_NOT_A_URL', 'client_id must be an https URL (Client ID Metadata Document)');
  }
  if (url.protocol !== 'https:') {
    return refuse('CLIENT_ID_NOT_HTTPS', 'client_id must use https');
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('CLIENT_ID_HAS_USERINFO', 'client_id must not carry userinfo');
  }
  if (url.hash !== '') {
    return refuse('CLIENT_ID_HAS_FRAGMENT', 'client_id must not carry a fragment');
  }
  if (url.port !== '' && Number(url.port) !== CIMD_REQUIRED_PORT) {
    return refuse('CLIENT_ID_PORT_NOT_ALLOWED', `client_id must be served from port ${CIMD_REQUIRED_PORT}`);
  }
  // An IP literal is never a client identity, and refusing it here removes the
  // entire "point the AS at 169.254.169.254" class before DNS is involved.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    return refuse('CLIENT_ID_HOST_IS_ADDRESS', 'client_id must name a host, not an IP address');
  }
  // The client_id is compared to the document's own client_id byte for byte,
  // so the canonical form is the one we fetched with.
  return url;
}

/** Resolve, validate EVERY address, and return the one we will pin to. */
async function resolvePinnedAddress(hostname: string): Promise<{ address: string; family: number }> {
  let resolved: dns.LookupAddress[];
  try {
    resolved = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return refuse('CLIENT_HOST_UNRESOLVABLE', 'client_id host does not resolve');
  }
  if (resolved.length === 0) {
    return refuse('CLIENT_HOST_UNRESOLVABLE', 'client_id host does not resolve');
  }
  // EVERY address, not just the first: a name that answers with one public and
  // one private address must not be usable by retrying until the private one
  // is picked.
  for (const candidate of resolved) {
    const verdict = outboundAddressVerdict(candidate.address);
    if (!verdict.allowed) {
      return refuse('CLIENT_ADDRESS_NOT_PUBLIC',
        'client_id host resolves to an address the board may not reach');
    }
  }
  return { address: resolved[0].address, family: resolved[0].family };
}

/**
 * Fetch and validate the document at `url`.
 *
 * The request PINS the connection to `pinned`: the https agent is given a
 * `lookup` that ignores the hostname and answers with the already-validated
 * address, so there is no second resolution for a rebinding attack to win.
 * TLS still verifies the certificate against the real hostname, because
 * `servername` and the `Host` header stay the name.
 */
function fetchDocumentBytes(url: URL, pinned: { address: string; family: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: 'https:',
        host: url.hostname,
        servername: url.hostname,
        port: CIMD_REQUIRED_PORT,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'RelayHall-AS/1.0' },
        timeout: CIMD_FETCH_TIMEOUT_MS,
        // The pin. `lookup` never consults DNS; it answers with the address
        // resolvePinnedAddress already validated.
        lookup: (
          _hostname: string,
          options: dns.LookupOneOptions | dns.LookupAllOptions | number,
          callback: (...args: never[]) => void,
        ): void => {
          const all = typeof options === 'object' && options !== null && (options as dns.LookupAllOptions).all === true;
          const cb = callback as unknown as (
            err: NodeJS.ErrnoException | null,
            address: string | dns.LookupAddress[],
            family?: number,
          ) => void;
          if (all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // A redirect is a refusal, not a hop: following it would let the
        // client re-aim the fetch at anything, past every check above.
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new ClientMetadataError('DOCUMENT_REDIRECTED',
            'the client metadata document must be served directly, without a redirect'));
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(new ClientMetadataError('DOCUMENT_STATUS',
            `the client metadata document answered HTTP ${status}`));
          return;
        }
        const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const acceptable = CIMD_ACCEPTED_CONTENT_TYPES.includes(contentType) || contentType.endsWith('+json');
        if (!acceptable) {
          response.destroy();
          reject(new ClientMetadataError('DOCUMENT_CONTENT_TYPE',
            'the client metadata document must be served as application/json'));
          return;
        }
        // A declared length past the ceiling is refused before a byte of body
        // is read; the running total below covers a missing or lying header.
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > CIMD_MAX_DOCUMENT_BYTES) {
          response.destroy();
          reject(new ClientMetadataError('DOCUMENT_TOO_LARGE', 'the client metadata document is too large'));
          return;
        }
        let received = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > CIMD_MAX_DOCUMENT_BYTES) {
            response.destroy();
            reject(new ClientMetadataError('DOCUMENT_TOO_LARGE', 'the client metadata document is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', () => reject(new ClientMetadataError('DOCUMENT_UNREACHABLE',
          'the client metadata document could not be read')));
      },
    );
    // One deadline for the whole exchange — connect, TLS, headers and body.
    const deadline = setTimeout(() => {
      request.destroy();
      reject(new ClientMetadataError('DOCUMENT_UNREACHABLE',
        'the client metadata document did not answer in time'));
    }, CIMD_FETCH_TIMEOUT_MS);
    deadline.unref();
    const settle = (): void => clearTimeout(deadline);
    request.on('close', settle);
    request.on('timeout', () => {
      request.destroy();
      reject(new ClientMetadataError('DOCUMENT_UNREACHABLE',
        'the client metadata document did not answer in time'));
    });
    request.on('error', () => reject(new ClientMetadataError('DOCUMENT_UNREACHABLE',
      'the client metadata document could not be fetched')));
    request.end();
  });
}

/** Validate the fetched bytes as a Client ID Metadata Document. */
export function parseClientMetadataDocument(clientId: string, body: string): ClientMetadataDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return refuse('DOCUMENT_NOT_JSON', 'the client metadata document is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('DOCUMENT_NOT_JSON', 'the client metadata document must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  // THE SELF-REFERENCE IS THE IDENTITY. Without it, anyone who can host JSON
  // anywhere could serve a document claiming to be someone else's client.
  if (raw.client_id !== clientId) {
    return refuse('DOCUMENT_CLIENT_ID_MISMATCH',
      'the client metadata document must name its own URL as client_id');
  }
  const redirectUris = raw.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return refuse('DOCUMENT_NO_REDIRECT_URIS', 'the client metadata document must list redirect_uris');
  }
  if (redirectUris.length > 32) {
    return refuse('DOCUMENT_BAD_REDIRECT_URI', 'the client metadata document lists too many redirect_uris');
  }
  for (const candidate of redirectUris) {
    if (!isAcceptableRedirectUri(candidate)) {
      return refuse('DOCUMENT_BAD_REDIRECT_URI',
        'every redirect_uri must be https (or http on a loopback address) with no fragment');
    }
  }
  const text = (value: unknown, max: number): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
  return {
    clientId,
    clientName: text(raw.client_name, 200),
    // Display URLs are sanitized, never merely length-checked (B3): an
    // unusable one becomes null here and can never reach an href.
    clientUri: sanitizeDisplayUri(raw.client_uri),
    logoUri: sanitizeDisplayUri(raw.logo_uri),
    redirectUris: redirectUris as string[],
    scope: text(raw.scope, 1024),
    raw,
    documentSha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
  };
}

export class OAuthClientMetadataService {
  /**
   * Resolve a `client_id` to its validated metadata document, fetching it
   * fresh. The cached row is written as provenance AFTER validation and is
   * never consulted for the decision (see the header note).
   */
  async resolve(clientId: unknown): Promise<ClientMetadataDocument> {
    const url = validateClientIdUrl(clientId);
    const pinned = await resolvePinnedAddress(url.hostname);
    const body = await fetchDocumentBytes(url, pinned);
    const document = parseClientMetadataDocument(url.toString(), body);
    await this.record(document);
    return document;
  }

  /**
   * Provenance write.
   *
   * NOT best-effort: `oauth_authorization_requests.client_id` references this
   * row, so a swallowed failure here would surface as an unexplained foreign
   * key violation one step later. A write failure is a substrate failure and
   * fails the authorization, which is the fail-closed direction.
   */
  private async record(document: ClientMetadataDocument): Promise<void> {
    await pool.query(
        `INSERT INTO oauth_clients
           (client_id, client_name, redirect_uris, document, document_sha256, last_fetched_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now())
         ON CONFLICT (client_id) DO UPDATE
           SET client_name = EXCLUDED.client_name,
               redirect_uris = EXCLUDED.redirect_uris,
               document = EXCLUDED.document,
               document_sha256 = EXCLUDED.document_sha256,
               last_fetched_at = now()`,
        [
          document.clientId,
          document.clientName,
          JSON.stringify(document.redirectUris),
          JSON.stringify(document.raw),
          document.documentSha256,
        ],
    );
  }
}

export const oauthClientMetadataService = new OAuthClientMetadataService();
