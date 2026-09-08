/**
 * ssoOutbound — the relying party's outbound fetch policy (SS-5, SS-6;
 * design `d95136d7` §4.3; threat rows T-SS11, T-SS12).
 *
 * ── WHY THIS IS NOT C6's FETCH, AND WHY IT IS ALMOST ALL OF IT ──
 *
 * C6's client-metadata fetch (`services/OAuthClientMetadataService`) is a good
 * policy and this module keeps every mechanic of it that defends the
 * DESTINATION: https only, no userinfo, no fragment, resolve -> validate EVERY
 * address -> pin the connection to the validated one, TLS verified against the
 * real name, redirects refused rather than followed, one deadline for the whole
 * exchange, and a bounded response size.
 *
 * It replaces EXACTLY ONE rule. C6 requires every resolved address to be
 * public, because a `client_id` is supplied by any anonymous caller on every
 * request — that is the whole threat. An `issuer` has the opposite provenance:
 * a `root` principal supplies it ONCE, at configuration, as an audited
 * owner-plane act, and no request parameter ever reaches the destination
 * (SS-6). Keeping C6's rule verbatim would make the product unusable for two
 * of its named shape classes — an in-cluster issuer (class 7) is routine.
 *
 * So the public-address requirement becomes DEFAULT-DENY WITH A PER-PROVIDER,
 * OWNER-SET, AUDITED `allow_private_issuer_address` flag. With the flag off,
 * `outboundAddressVerdict` governs unchanged. With it on, private addresses
 * are permitted FOR THAT IDENTITY PROVIDER'S VALIDATED ORIGINS ONLY — never as
 * a global switch, and the Access manager renders the Identity provider as
 * private-address-enabled so it is visible at a glance.
 *
 * Two further deltas, both stated in §4.3 rather than inferred: the port pin is
 * dropped (an on-premises issuer on `:8443` is ordinary), and the loopback
 * carve-out is NOT added — a loopback issuer is a development affordance and is
 * covered by the same flag.
 *
 * ── SS-6, AND WHAT MAKES IT CHECKABLE ──
 *
 * No request parameter — not `returnRef`, not a header, not a form field —
 * influences any outbound destination. The only URLs this module is ever asked
 * for are (a) an Identity provider's stored `discovery_url` and (b) endpoint
 * URLs taken from a document that `assertEndpointOrigin` has already accepted.
 * `fetchJsonDocument` takes a URL and a policy; it has no access to a request,
 * which is what makes SS-6 a property of the module boundary rather than a
 * promise about call sites.
 */
import dns from 'dns';
import https from 'https';
import { outboundAddressVerdict } from '../../utils/outboundAddressPolicy';

/** One deadline for the whole exchange — connect, TLS, headers and body. */
export const SSO_FETCH_TIMEOUT_MS = 5_000;
/** Discovery documents and JWKS are small; a hostile one is not. */
export const SSO_MAX_DOCUMENT_BYTES = 256 * 1024;

export type SsoOutboundRejection =
  | 'URL_NOT_ABSOLUTE'
  | 'URL_NOT_HTTPS'
  | 'URL_HAS_USERINFO'
  | 'URL_HAS_FRAGMENT'
  | 'HOST_UNRESOLVABLE'
  | 'ADDRESS_NOT_PERMITTED'
  | 'ENDPOINT_ORIGIN_NOT_ALLOWED'
  | 'DOCUMENT_REDIRECTED'
  | 'DOCUMENT_STATUS'
  | 'DOCUMENT_CONTENT_TYPE'
  | 'DOCUMENT_TOO_LARGE'
  | 'DOCUMENT_UNREACHABLE'
  | 'DOCUMENT_NOT_JSON';

export class SsoOutboundError extends Error {
  constructor(public readonly code: SsoOutboundRejection, message: string) {
    super(message);
    this.name = 'SsoOutboundError';
  }
}

const refuse = (code: SsoOutboundRejection, message: string): never => {
  throw new SsoOutboundError(code, message);
};

/**
 * The per-Identity-provider outbound policy. It carries no request state by
 * construction: everything here comes from the stored configuration row.
 */
export interface SsoOutboundPolicy {
  /** The configured `issuer`, whose origin every endpoint must share... */
  issuerOrigin: string;
  /** ...unless the operator listed the exact origin here (value-scoped). */
  additionalEndpointOrigins: readonly string[];
  /** SS-5: default false. Applies to THIS Identity provider only. */
  allowPrivateIssuerAddress: boolean;
}

/** Shape checks that never become a socket, so they are testable without one. */
export function validateOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('URL_NOT_ABSOLUTE', 'an Identity provider URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:') return refuse('URL_NOT_HTTPS', 'an Identity provider URL must use https');
  if (url.username !== '' || url.password !== '') {
    return refuse('URL_HAS_USERINFO', 'an Identity provider URL must not carry userinfo');
  }
  if (url.hash !== '') return refuse('URL_HAS_FRAGMENT', 'an Identity provider URL must not carry a fragment');
  return url;
}

/**
 * §4.2: every endpoint URL taken from a discovery document must be https and
 * SAME-ORIGIN WITH THE ISSUER, unless the operator has listed that exact origin
 * in the per-Identity-provider allowlist.
 *
 * A discovery document is REMOTE DATA. Without this rule a compromised or
 * hostile document turns the board into an outbound request generator pointed
 * wherever it likes, with operator authority (T-SS11). The exemption is
 * VALUE-SCOPED — an exact origin string — because whole-surface exemptions hide
 * what nobody reviewed, which is the RFC1918 lesson this programme paid for.
 */
export function assertEndpointOrigin(raw: string, policy: SsoOutboundPolicy): URL {
  const url = validateOutboundUrl(raw);
  if (url.origin === policy.issuerOrigin) return url;
  if (policy.additionalEndpointOrigins.includes(url.origin)) return url;
  return refuse(
    'ENDPOINT_ORIGIN_NOT_ALLOWED',
    `the discovery document names an endpoint at ${url.origin}, which is neither the issuer origin nor a listed additional endpoint origin`,
  );
}

/**
 * Resolve, validate EVERY returned address, and return the one to pin to.
 *
 * EVERY address, not just the first: a name that answers with one public and
 * one private address must not be usable by retrying until the private one is
 * picked. The flag widens WHICH verdicts are acceptable; it never reduces the
 * set of addresses examined.
 */
export async function resolvePinnedAddress(
  hostname: string,
  policy: SsoOutboundPolicy,
): Promise<{ address: string; family: number }> {
  let resolved: dns.LookupAddress[];
  try {
    resolved = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return refuse('HOST_UNRESOLVABLE', `the Identity provider host ${hostname} does not resolve`);
  }
  if (resolved.length === 0) {
    return refuse('HOST_UNRESOLVABLE', `the Identity provider host ${hostname} does not resolve`);
  }
  for (const candidate of resolved) {
    const verdict = outboundAddressVerdict(candidate.address);
    if (verdict.allowed) continue;
    // SS-5: the flag admits a PRIVATE destination for this Identity provider.
    // It is not a licence to reach anything: multicast, reserved, unspecified
    // and IPv4-mapped addresses are never a legitimate issuer, so they stay
    // refused with the flag on. Only the address classes an on-premises
    // deployment actually uses are widened.
    const privateClass =
      verdict.reason === 'PRIVATE' || verdict.reason === 'LOOPBACK' || verdict.reason === 'SHARED_ADDRESS_SPACE';
    if (policy.allowPrivateIssuerAddress && privateClass) continue;
    return refuse(
      'ADDRESS_NOT_PERMITTED',
      `the Identity provider host ${hostname} resolves to an address the board may not reach (${verdict.reason})`,
    );
  }
  return { address: resolved[0].address, family: resolved[0].family };
}

/**
 * Fetch and parse a JSON document, pinned to an already-validated address.
 *
 * The https agent is given a `lookup` that ignores the hostname and answers
 * with the validated address, so there is no second resolution for a rebinding
 * attack to win. TLS still verifies the certificate against the real hostname,
 * because `servername` and the `Host` header stay the name.
 */
function sendRequest(
  url: URL,
  pinned: { address: string; family: number },
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: 'https:',
        host: url.hostname,
        servername: url.hostname,
        // §4.3: the port pin is dropped. An on-premises issuer on :8443 is
        // ordinary, and the destination is defended by the address check.
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'RelayHall-RP/1.0',
          ...(init.body === undefined
            ? {}
            : {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(Buffer.byteLength(init.body)),
              }),
          ...(init.headers ?? {}),
        },
        timeout: SSO_FETCH_TIMEOUT_MS,
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
        // document re-aim the fetch at anything, past every check above.
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new SsoOutboundError('DOCUMENT_REDIRECTED', 'an Identity provider document must be served without a redirect'));
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(new SsoOutboundError('DOCUMENT_STATUS', `the Identity provider document answered HTTP ${status}`));
          return;
        }
        const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
          response.destroy();
          reject(new SsoOutboundError('DOCUMENT_CONTENT_TYPE', 'an Identity provider document must be served as application/json'));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > SSO_MAX_DOCUMENT_BYTES) {
          response.destroy();
          reject(new SsoOutboundError('DOCUMENT_TOO_LARGE', 'the Identity provider document is too large'));
          return;
        }
        let received = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > SSO_MAX_DOCUMENT_BYTES) {
            response.destroy();
            reject(new SsoOutboundError('DOCUMENT_TOO_LARGE', 'the Identity provider document is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', () =>
          reject(new SsoOutboundError('DOCUMENT_UNREACHABLE', 'the Identity provider document could not be read')));
      },
    );
    const deadline = setTimeout(() => {
      request.destroy();
      reject(new SsoOutboundError('DOCUMENT_UNREACHABLE', 'the Identity provider document did not answer in time'));
    }, SSO_FETCH_TIMEOUT_MS);
    deadline.unref();
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => {
      request.destroy();
      reject(new SsoOutboundError('DOCUMENT_UNREACHABLE', 'the Identity provider document did not answer in time'));
    });
    request.on('error', () =>
      reject(new SsoOutboundError('DOCUMENT_UNREACHABLE', 'the Identity provider document could not be reached')));
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

/**
 * What one outbound act looks like. The conformance harness and the test
 * suites drive fixtures through the SAME shape, which is what lets a fixture
 * assert what was sent ON THE WIRE (shape class 8) and which endpoint was
 * dialled (T-SS4) rather than merely that a call succeeded.
 */
export interface SsoOutboundRequest {
  url: URL;
  method: 'GET' | 'POST';
  policy: SsoOutboundPolicy;
  /** `application/x-www-form-urlencoded` fields, for the token endpoint. */
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * A transport is the seam a provider double substitutes for. Production has
 * exactly one implementation, below; nothing else in the relying party opens a
 * socket.
 */
export interface SsoTransport {
  send(request: SsoOutboundRequest): Promise<unknown>;
}

/**
 * THE single outbound entry point of the relying party.
 *
 * SS-6 is a property of this signature: there is no parameter through which a
 * caller's request could influence the destination. `url` is either a stored
 * `discovery_url` or an endpoint `assertEndpointOrigin` has already bound to
 * the Identity provider's own origins.
 */
export const httpsSsoTransport: SsoTransport = {
  async send(request: SsoOutboundRequest): Promise<unknown> {
    const pinned = await resolvePinnedAddress(request.url.hostname, request.policy);
    const body =
      request.form === undefined ? undefined : new URLSearchParams(request.form).toString();
    const text = await sendRequest(request.url, pinned, {
      method: request.method,
      headers: request.headers,
      body,
    });
    try {
      return JSON.parse(text);
    } catch {
      return refuse('DOCUMENT_NOT_JSON', 'the Identity provider document is not valid JSON');
    }
  },
};

/** Convenience for the GET case, which is every document fetch. */
export function fetchJsonDocument(
  url: URL,
  policy: SsoOutboundPolicy,
  transport: SsoTransport = httpsSsoTransport,
): Promise<unknown> {
  return transport.send({ url, method: 'GET', policy });
}
