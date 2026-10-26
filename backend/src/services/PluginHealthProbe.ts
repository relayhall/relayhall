import { ownDataProperty } from '../utils/failureClassification';

/**
 * The plugin loader's health probe, split from the loader so the outcome of one
 * probe is a closed, secret-free value (card fa519c4c, subtask 2085337).
 *
 * WHY THIS EXISTS. The loader used to log every failed probe through the
 * secret-safe sink with the thrown value as the only evidence. A refused
 * connection surfaces from the platform fetch as `TypeError: fetch failed`
 * whose reason lives on `cause`, so the line read
 * `(Error) [class=TypeError code=ERROR_UNCLASSIFIED]` with no plugin named and
 * no way to tell a stopped container from a plugin that answered something
 * unexpected. The recorded case on the development estate was a plugin whose
 * health port refused connections from the backend container: every tick
 * logged the same anonymous line.
 *
 * THE NON-DISCLOSURE CONTRACT IS KEPT. Nothing read from the caught value, the
 * response or the body is ever returned. Reasons are looked up by typed marker
 * (an own `code` data property on the cause, our own timeout flag, the HTTP
 * status number) in tables written here, and the table's stored constant is
 * what leaves this module. Message text is never matched. A plugin body is
 * parsed, bounded, and discarded; only the closed `detail` constants it maps
 * to are reported.
 *
 * WHAT COUNTS AS WHAT.
 *  - transport: no HTTP answer (refused, unresolved, reset, closed, unreachable).
 *  - timeout: no answer within the bound.
 *  - redirect: a 3xx answer; the probe never follows one.
 *  - plugin_reported: an HTTP answer outside 2xx, or a 2xx answer whose
 *    `status` the plugin itself states as unhealthy.
 *  - shape: a 2xx answer whose body is not the documented
 *    `{"status": "<word>", ...}` object. This is named and logged but does NOT
 *    mark the plugin unhealthy: the HTTP answer is the liveness contract that
 *    has always held, and a plugin that answers 200 with another body shape
 *    must not vanish from the sidebar because of a body this host never read
 *    before.
 *  - config: the host refused to build the probe URL from the manifest.
 *  - internal: the probe itself failed in a way none of the above names.
 */

export type PluginHealthKind =
  | 'ok' | 'transport' | 'timeout' | 'redirect' | 'plugin_reported' | 'shape' | 'config' | 'internal';

export const PLUGIN_HEALTH_DETAILS = [
  'NONE',
  // transport
  'CONNECTION_REFUSED', 'HOST_NOT_FOUND', 'CONNECTION_RESET', 'HOST_UNREACHABLE',
  'CONNECT_TIMEOUT', 'SOCKET_CLOSED', 'TRANSPORT_OTHER',
  // timeout
  'REQUEST_TIMEOUT',
  // redirect
  'REDIRECT_NOT_FOLLOWED',
  // plugin_reported
  'HTTP_STATUS_NOT_OK', 'STATUS_REPORTED_UNHEALTHY',
  // shape
  'BODY_EMPTY', 'BODY_NOT_JSON', 'BODY_NOT_OBJECT', 'STATUS_MISSING', 'STATUS_NOT_STRING',
  'STATUS_UNRECOGNISED', 'BODY_TOO_LARGE_TO_READ',
  // config
  'HEALTH_PATH_INVALID', 'HEALTH_ORIGIN_INVALID',
  // internal
  'PROBE_UNEXPECTED',
] as const;
export type PluginHealthDetail = (typeof PLUGIN_HEALTH_DETAILS)[number];

export interface PluginHealthOutcome {
  /** Whether the plugin counts as healthy; the loader assigns this to the registry. */
  healthy: boolean;
  kind: PluginHealthKind;
  detail: PluginHealthDetail;
  /** The HTTP status when an answer arrived, else undefined. */
  httpStatus?: number;
}

/**
 * `status` words the documented `{"status":"ok"}` answer and the answers
 * recorded from the estate use. `healthy` is what the GPU gateway answers.
 */
export const HEALTH_STATUS_OK_WORDS: readonly string[] = ['ok', 'healthy', 'up', 'pass', 'passing', 'ready'];
export const HEALTH_STATUS_UNHEALTHY_WORDS: readonly string[] = [
  'error', 'unhealthy', 'down', 'fail', 'failed', 'failing', 'unavailable', 'degraded',
];

/** Platform and driver error codes seen on the cause of a failed fetch. */
const TRANSPORT_CODES: ReadonlyMap<string, PluginHealthDetail> = new Map<string, PluginHealthDetail>([
  ['ECONNREFUSED', 'CONNECTION_REFUSED'],
  ['ENOTFOUND', 'HOST_NOT_FOUND'],
  ['EAI_AGAIN', 'HOST_NOT_FOUND'],
  ['ECONNRESET', 'CONNECTION_RESET'],
  ['EPIPE', 'CONNECTION_RESET'],
  ['EHOSTUNREACH', 'HOST_UNREACHABLE'],
  ['ENETUNREACH', 'HOST_UNREACHABLE'],
  ['ETIMEDOUT', 'CONNECT_TIMEOUT'],
  ['UND_ERR_CONNECT_TIMEOUT', 'CONNECT_TIMEOUT'],
  ['UND_ERR_SOCKET', 'SOCKET_CLOSED'],
  ['UND_ERR_HEADERS_TIMEOUT', 'CONNECT_TIMEOUT'],
  ['UND_ERR_BODY_TIMEOUT', 'CONNECT_TIMEOUT'],
]);

/**
 * Classify a fetch or body-read rejection (an answer that never arrived or never finished). `timedOut` is the probe's own flag,
 * set by its timer before it aborts, so a timeout is never inferred from the
 * error's name or text.
 */
export function classifyHealthTransportFailure(caught: unknown, timedOut: boolean): PluginHealthOutcome {
  if (timedOut) return { healthy: false, kind: 'timeout', detail: 'REQUEST_TIMEOUT' };
  // Not `instanceof Error`: the platform raises these in another realm under some runners (jest's vm context),
  // where the check is false for a genuine fetch failure. Only an object can carry the typed markers read below.
  if (caught === null || typeof caught !== 'object') return { healthy: false, kind: 'internal', detail: 'PROBE_UNEXPECTED' };
  try {
    // fetch reports the reason on `cause`; a bare error may carry the code itself.
    let carrier: unknown = ownDataProperty(caught, 'cause');
    for (let depth = 0; depth < 3 && carrier !== null && typeof carrier === 'object'; depth++) {
      const code = ownDataProperty(carrier as object, 'code');
      if (typeof code === 'string') {
        const detail = TRANSPORT_CODES.get(code);
        if (detail) return { healthy: false, kind: 'transport', detail };
      }
      carrier = ownDataProperty(carrier as object, 'cause');
    }
    const own = ownDataProperty(caught, 'code');
    const direct = typeof own === 'string' ? TRANSPORT_CODES.get(own) : undefined;
    if (direct) return { healthy: false, kind: 'transport', detail: direct };
  } catch { /* a hostile value is reported as the generic failure below */ }
  // fetch rejects only for a request that produced no answer: the platform's anonymous `fetch failed` TypeError,
  // whose reason is not one of the codes above.
  return { healthy: false, kind: 'transport', detail: 'TRANSPORT_OTHER' };
}

/**
 * Interpret one HTTP answer. `body` is the bounded text (null when the body
 * was not read because it exceeded the bound or the answer was not 2xx).
 */
export function interpretHealthAnswer(status: number, body: string | null, bodyTooLarge = false): PluginHealthOutcome {
  if (status >= 300 && status < 400) return { healthy: false, kind: 'redirect', detail: 'REDIRECT_NOT_FOLLOWED', httpStatus: status };
  if (status < 200 || status >= 300) return { healthy: false, kind: 'plugin_reported', detail: 'HTTP_STATUS_NOT_OK', httpStatus: status };
  // From here the plugin answered 2xx: it stays healthy unless it says otherwise.
  const shape = (detail: PluginHealthDetail): PluginHealthOutcome => ({ healthy: true, kind: 'shape', detail, httpStatus: status });
  if (bodyTooLarge) return shape('BODY_TOO_LARGE_TO_READ');
  if (body === null || body.trim() === '') return shape('BODY_EMPTY');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return shape('BODY_NOT_JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return shape('BODY_NOT_OBJECT');
  const word = ownDataProperty(parsed as object, 'status');
  if (word === undefined) return shape('STATUS_MISSING');
  if (typeof word !== 'string') return shape('STATUS_NOT_STRING');
  const lowered = word.trim().toLowerCase();
  if (HEALTH_STATUS_OK_WORDS.includes(lowered)) return { healthy: true, kind: 'ok', detail: 'NONE', httpStatus: status };
  if (HEALTH_STATUS_UNHEALTHY_WORDS.includes(lowered)) return { healthy: false, kind: 'plugin_reported', detail: 'STATUS_REPORTED_UNHEALTHY', httpStatus: status };
  return shape('STATUS_UNRECOGNISED');
}

/** The largest body the probe reads. A larger 2xx answer stays healthy, unread. */
export const HEALTH_BODY_LIMIT_BYTES = 1024 * 1024;

interface ReadableLike { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } }

/** Read at most `limit` bytes of the answer; never returns a partial string. */
async function readBoundedBody(response: Response, limit: number): Promise<{ text: string | null; tooLarge: boolean }> {
  const stream = (response as unknown as { body?: ReadableLike | null }).body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) { await reader.cancel().catch(() => undefined); return { text: null, tooLarge: true }; }
        chunks.push(Buffer.from(value));
      }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
  }
  // A response without a stream (a test double or an exotic runtime): fall back to text().
  const text = typeof (response as { text?: unknown }).text === 'function' ? await response.text() : null;
  if (text !== null && Buffer.byteLength(text) > limit) return { text: null, tooLarge: true };
  return { text, tooLarge: false };
}

export interface PluginHealthProbeInput {
  url: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Probe one plugin health URL. Never throws: every failure is an outcome.
 * The URL has already passed the loader's path and origin checks.
 */
export async function probePluginHealth(input: PluginHealthProbeInput): Promise<PluginHealthOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs ?? 15000);
  try {
    const doFetch = input.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(input.url, {
        signal: controller.signal,
        // 'manual' hands back the 3xx itself, so a redirect is named as one rather
        // than surfacing as an anonymous fetch failure; it is still never followed.
        redirect: 'manual',
        headers: { 'User-Agent': 'relayhall-plugin-loader/2.0.0' },
      });
    } catch (err) {
      return classifyHealthTransportFailure(err, timedOut);
    }
    const status = typeof response.status === 'number' ? response.status : 0;
    // A double that gives `ok` and no status keeps the old reading (ok means 200).
    const effective = status === 0 && (response as { ok?: unknown }).ok === true ? 200 : status;
    if (effective < 200 || effective >= 300) {
      try { await (response as unknown as { body?: { cancel?: () => Promise<void> } }).body?.cancel?.(); } catch { /* already classified */ }
      return interpretHealthAnswer(effective, null);
    }
    try {
      const { text, tooLarge } = await readBoundedBody(response, HEALTH_BODY_LIMIT_BYTES);
      return interpretHealthAnswer(effective, text, tooLarge);
    } catch (err) {
      return classifyHealthTransportFailure(err, timedOut);
    }
  } catch {
    return { healthy: false, kind: 'internal', detail: 'PROBE_UNEXPECTED' };
  } finally {
    clearTimeout(timer);
  }
}
