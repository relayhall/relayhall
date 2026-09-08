// KnowledgeDialClient.ts — RH-KW1 candidate A (card `0b4b779b`).
//
// The DIAL-time half of §4.2's outbound policy. Set time and dial time share
// one classifier (`KnowledgeSourcePolicy`), so the two enforcement points can
// never disagree about what an address means.
//
// ── WHY THIS IS NOT `fetch` AND NOT THE WEBHOOK PATH ──
//
// §4.2 requires connecting "ONLY to a validated address (socket-pinned
// lookup)" and refusing "if the connected peer is not in the validated set".
// Global `fetch` does not expose the socket's name resolution, so a validated
// answer and the answer the socket actually used are two different lookups
// and a DNS rebinder wins the gap. `undici` would supply that control and is
// NOT a dependency (census `abc71ffb` F6); owner decision D4(a) is ZERO new
// packages. The shipped outbound precedent, `WebhookService` `fetch(...)`,
// cannot pin a socket either. So this dials with `node:https` and a custom
// `lookup`, which is new code rather than a wrapper — F6 records exactly that.
//
// ── THE THREE THINGS THAT MAKE REBINDING LOSE ──
//
//  1. ONE resolution. The addresses are resolved once, here, and the custom
//     `lookup` hands the SAME list to the socket. There is no second
//     resolution for an attacker's short TTL to win.
//  2. EVERY record is validated, not the first. `dns.lookup(all:true)` can
//     return a public and a private address for one name; validating only the
//     one the socket happened to pick would admit the other on a retry.
//  3. The CONNECTED PEER is re-checked after connect against the validated
//     set. That is the backstop for anything below this module — a resolver
//     cache, a hosts file, a proxy — deciding differently than we did.
//
// Redirects are never followed (§4.2): a 3xx is a policy refusal, because
// following one would dial an address no set-time or dial-time check ever saw.

import https from 'https';
import dns from 'dns';
import net from 'net';
import type { LookupAddress } from 'dns';
import { classifyAddress, normalizeAddress, validateKnowledgeEndpoint } from './KnowledgeSourcePolicy';

/**
 * Unwrap the IPv4-MAPPED form for PEER COMPARISON ONLY.
 *
 * This is not a re-entry of the decoding the policy just deleted, and the
 * distinction is the direction of trust. `classifyAddress` decides about an
 * address a CALLER supplied, where a carrier is refused outright. This reads
 * an address the KERNEL reported for a socket already opened: Node reports a
 * v4 peer as `::ffff:a.b.c.d` on a dual-stack socket, while the validated set
 * holds the dotted quad the resolver returned. Without this unwrap every
 * legitimate IPv4 dial would fail its own peer check.
 *
 * It handles exactly one form and returns the input unchanged otherwise.
 */
function peerAddressForComparison(raw: string): string | null {
  const normalized = normalizeAddress(raw);
  if (normalized === null) return null;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  return mapped ? mapped[1] : normalized;
}

/** Core-authored outcome tokens. Source-authored text is NEVER forwarded. */
export type KnowledgeDialFailure =
  | 'refusedByPolicy'
  | 'timedOut'
  | 'transport'
  | 'rate-limited';

export interface KnowledgeDialSuccess {
  ok: true;
  status: number;
  /** Response headers, used by candidate C for Retry-After and etag handling. */
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** The peer actually connected to, normalized. Evidence, not decoration. */
  peerAddress: string;
}

export interface KnowledgeDialRefusal {
  ok: false;
  failure: KnowledgeDialFailure;
  /** A core-authored enum-ish token. Never source text. */
  reason: string;
  /** Present only for `rate-limited`: the source's Retry-After, parsed. */
  retryAfterSeconds?: number;
}

export type KnowledgeDialResult = KnowledgeDialSuccess | KnowledgeDialRefusal;

export interface KnowledgeDialOptions {
  url: string;
  method?: 'GET' | 'POST';
  /** Core-authored request body (a knowledge query). Never caller bytes verbatim. */
  body?: string;
  headers?: Record<string, string>;
  /** §4.2 `knowledge_allowed_networks`. Empty ⇒ public addresses only. */
  allowedNetworks: readonly string[];
  /** Per-source deadline; candidate C supplies the ruled 500..8000 range. */
  timeoutMs?: number;
  /** Response body cap, so a hostile source cannot exhaust memory. */
  maxResponseBytes?: number;
  /**
   * **TEST-ONLY (owner decision D7(a)).** Extra trust anchors for the hostile
   * FIXTURE source's self-signed certificate. The seam is unreachable from
   * production configuration BY CONSTRUCTION: no environment variable, no
   * descriptor field and no database column feeds it — the only way to supply
   * one is for a caller to pass this option, and the guard below refuses that
   * outside `NODE_ENV=test`. The production dial path therefore leaves `ca`
   * undefined, which is Node's DEFAULT TRUST STORE. Both halves of D7's drill
   * live in `__tests__/kw1KnowledgeOutboundPolicy.test.ts`: remove the anchor
   * and the fixture dial fails; census the tree and no production file passes
   * this option.
   */
  trustAnchors?: string | string[];
  /**
   * §4.2's core→source channel authentication, mutual-TLS form: the client
   * identity core presents to the source. Supplied by
   * `KnowledgeChannelAuth.channelAuthDialOptions`; the bearer form travels as
   * a header instead. Both are CORE's identity, never the caller's — the
   * caller's credential never leaves core (§5.4).
   */
  clientCertificate?: { certificate: string; privateKey: string };
}

export const KNOWLEDGE_DIAL_DEFAULT_TIMEOUT_MS = 3000;
export const KNOWLEDGE_DIAL_MAX_RESPONSE_BYTES = 1048576;

const refusal = (failure: KnowledgeDialFailure, reason: string, retryAfterSeconds?: number): KnowledgeDialRefusal => ({
  ok: false,
  failure,
  reason,
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

/**
 * Resolve a host and validate EVERY record. Returns the validated set, or a
 * refusal naming the core-authored reason. A literal host skips the resolver
 * and is classified directly — `https://2130706433/` must not become a DNS
 * question, and `KnowledgeSourcePolicy.normalizeAddress` is what recognises
 * that spelling as an address at all.
 */
export async function resolveAndValidate(
  hostname: string,
  allowedNetworks: readonly string[],
): Promise<{ ok: true; addresses: LookupAddress[] } | KnowledgeDialRefusal> {
  const literal = normalizeAddress(hostname);
  if (literal !== null) {
    const disposition = classifyAddress(literal, allowedNetworks);
    if (!disposition.admissible) {
      return refusal('refusedByPolicy', `address-refused:${disposition.reason}`);
    }
    return { ok: true, addresses: [{ address: literal, family: net.isIPv4(literal) ? 4 : 6 }] };
  }

  let records: LookupAddress[];
  try {
    records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return refusal('transport', 'dns-resolution-failed');
  }
  if (records.length === 0) return refusal('transport', 'dns-empty');

  const validated: LookupAddress[] = [];
  for (const record of records) {
    const normalized = normalizeAddress(record.address);
    // EVERY record, not the first: a name answering with one public and one
    // private address must be refused, not partially admitted.
    const disposition = normalized === null
      ? { admissible: false as const, reason: 'not-an-address' as const }
      : classifyAddress(normalized, allowedNetworks);
    if (!disposition.admissible) {
      return refusal('refusedByPolicy', `address-refused:${disposition.reason}`);
    }
    validated.push({ address: normalized as string, family: net.isIPv4(normalized as string) ? 4 : 6 });
  }
  return { ok: true, addresses: validated };
}

/**
 * Dial a knowledge source under the full §4.2 policy. Every refusal is a
 * core-authored token; nothing the source wrote is ever part of one.
 */
export async function dialKnowledgeSource(options: KnowledgeDialOptions): Promise<KnowledgeDialResult> {
  if (options.trustAnchors !== undefined && process.env.NODE_ENV !== 'test') {
    // D7(a): the seam exists for the hostile fixture and nothing else.
    throw new Error('KnowledgeDialClient: trustAnchors is a test-only seam and is refused outside NODE_ENV=test');
  }

  let url: URL;
  try {
    // The SAME set-time statement, re-asserted at dial time (§4.2 requires
    // both). A row written before a policy tightened is refused here.
    url = new URL(validateKnowledgeEndpoint(options.url, 'endpoint', options.allowedNetworks));
  } catch {
    return refusal('refusedByPolicy', 'endpoint-policy-refused');
  }

  const resolved = await resolveAndValidate(url.hostname, options.allowedNetworks);
  if (!('addresses' in resolved)) return resolved;
  const validatedSet = new Set(resolved.addresses.map((a) => a.address));

  const timeoutMs = options.timeoutMs ?? KNOWLEDGE_DIAL_DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? KNOWLEDGE_DIAL_MAX_RESPONSE_BYTES;

  return new Promise<KnowledgeDialResult>((resolve) => {
    let settled = false;
    const settle = (result: KnowledgeDialResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        // SNI names a HOST, not an address: sending an IP literal as a server
        // name is invalid and makes identity verification fail for a reason
        // that has nothing to do with the policy under test. For a literal
        // host, OpenSSL verifies against the certificate's IP SANs instead.
        ...(normalizeAddress(url.hostname) === null ? { servername: url.hostname } : {}),
        // The pin. The socket never asks a resolver again.
        lookup: ((_host: string, lookupOptions: dns.LookupAllOptions, callback: (
          err: NodeJS.ErrnoException | null,
          address: string | LookupAddress[],
          family?: number,
        ) => void) => {
          if (lookupOptions && lookupOptions.all) {
            callback(null, resolved.addresses);
            return;
          }
          const first = resolved.addresses[0];
          callback(null, first.address, first.family);
        }) as unknown as typeof dns.lookup,
        ...(options.trustAnchors !== undefined ? { ca: options.trustAnchors } : {}),
        ...(options.clientCertificate !== undefined
          ? { cert: options.clientCertificate.certificate, key: options.clientCertificate.privateKey }
          : {}),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // §4.2: redirects are NOT followed. Following one would dial an
        // address neither the set-time nor the dial-time check ever saw.
        if (status >= 300 && status < 400) {
          response.destroy();
          request.destroy();
          settle(refusal('refusedByPolicy', 'redirect-not-followed'));
          return;
        }
        if (status === 429) {
          const header = response.headers['retry-after'];
          const raw = Array.isArray(header) ? header[0] : header;
          const parsed = raw !== undefined && /^[0-9]{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
          response.destroy();
          request.destroy();
          settle(refusal('rate-limited', 'source-rate-limited', parsed));
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            response.destroy();
            request.destroy();
            settle(refusal('transport', 'response-too-large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          settle({
            ok: true,
            status,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            peerAddress: peerAddressForComparison(response.socket?.remoteAddress ?? '') ?? '',
          });
        });
        response.on('error', () => settle(refusal('transport', 'response-stream-failed')));
      },
    );

    request.on('socket', (socket) => {
      const check = () => {
        const peer = peerAddressForComparison(socket.remoteAddress ?? '');
        // The backstop. If anything below this module resolved differently
        // than we did, the connection dies before a byte is written.
        if (peer === null || !validatedSet.has(peer)) {
          socket.destroy();
          request.destroy();
          settle(refusal('refusedByPolicy', 'peer-not-in-validated-set'));
        }
      };
      if (socket.remoteAddress) check();
      else socket.once('connect', check);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle(refusal('timedOut', 'per-source-deadline'));
    });
    request.on('error', () => settle(refusal('transport', 'connect-failed')));

    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}
