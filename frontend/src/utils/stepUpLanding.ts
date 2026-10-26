/**
 * The step-up landing (card a3e76724).
 *
 * An Account whose only proof is its Identity provider confirms a step-up by
 * signing in there again, in a window of its own. The board's callback lands
 * that window on `/dashboard/?step_up=complete|refused&request=<id>[&code=…]`
 * — never a token, never a secret — and this module is what the dashboard
 * runs INSTEAD of the app when it is loaded there: it tells the dialog that
 * opened the window how the re-authentication ended, then closes the window.
 *
 * Two paths carry the message, because either can be missing: the opener
 * reference is severed when an Identity provider sends a cross-origin opener
 * policy, and an old browser has no BroadcastChannel. The dialog listens on
 * both, accepts only a same-origin message naming ITS request id, and then
 * asks the board for the token — the message itself proves nothing.
 *
 * Owner ruling E444: when the provider REUSED a recent sign-in
 * (`SSO_STEP_UP_NOT_FRESH`) the window stays open. The dialog waits out the
 * provider's reuse and then asks again by itself, and a browser blocks a NEW
 * window that no click opened, so the kept window is the one that goes back
 * to the provider. Every other outcome closes the window as before. When the
 * refusal carries the reused sign-in's `auth_time` or the provider's reuse
 * window, they travel on as bounded whole numbers, so the dialog can wait
 * exactly as long as needed; neither is ever required.
 *
 * The board's responses carry a cross-origin opener policy, so the hop back
 * from the provider usually cuts this window off from the dialog: the
 * dialog's reference reads as closed and `opener` is null here. The kept
 * landing therefore LISTENS on the channel and moves ITSELF (a window that
 * navigates itself needs no click). It obeys two messages only, each naming
 * its OWN request id: `relaunch`, carrying a NEW request's https authorize URL
 * on the provider origin the board sent THIS request to (the dialog records it
 * from the board's own start answer, `rememberStepUpRequest`), and `release`,
 * which closes it. Anything else, or a URL that fails any check, is ignored:
 * the channel never chooses where this window goes. It answers a relaunch it
 * obeyed with `relaunched`, so the dialog does not use its other routes, and
 * it closes itself if nothing comes within `KEPT_LANDING_LIMIT_MS`.
 */
export const STEP_UP_CHANNEL = 'relayhall-step-up';
export const STEP_UP_MESSAGE_TYPE = 'relayhall:step-up';
export const STEP_UP_WINDOW_NAME = 'relayhall-step-up';

export interface StepUpLanding {
  outcome: 'complete' | 'refused';
  requestId: string;
  /** The board's NAMED refusal code, from a fixed vocabulary; never text. */
  code: string | null;
  /** E444: the reused sign-in's `auth_time` (epoch seconds), only when the refusal names it. */
  authTime?: number;
  /** E444: the provider's reuse window in seconds, only when the refusal names it. */
  reuseWindowSeconds?: number;
}

/** E444: the one refusal whose window stays open for the dialog's own retry. */
export const STEP_UP_REUSED_SIGN_IN = 'SSO_STEP_UP_NOT_FRESH';

/** E444: the dialog-to-landing messages on `STEP_UP_CHANNEL`. */
export const STEP_UP_RELAUNCH_TYPE = 'relayhall:step-up-relaunch';
/** How long the dialog waits for a kept landing to answer `relaunched`. */
export const RELAUNCH_ACK_MS = 1_000;
/**
 * How long a kept landing waits for a relaunch before it closes itself. The
 * dialog's longest wait is 300 s (`reuseWait`'s bound); this is twice that.
 */
export const KEPT_LANDING_LIMIT_MS = 600_000;

export type RelaunchAction = 'relaunch' | 'release' | 'relaunched';

export interface RelaunchMessage {
  action: RelaunchAction;
  /** The REFUSED request whose kept landing the message is for. */
  forRequest: string;
  /** `relaunch` only: the NEW request's authorize URL. */
  url?: string;
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const WHOLE_NUMBER = /^[0-9]{1,12}$/;
/** An `auth_time` is a plausible epoch second (after 2001, before 2286); a window is 1 to 300 s. */
const AUTH_TIME_RANGE = [1_000_000_000, 9_999_999_999] as const;
const REUSE_WINDOW_RANGE = [1, 300] as const;

function bounded(value: unknown, [low, high]: readonly [number, number]): number | null {
  const number = typeof value === 'string' && WHOLE_NUMBER.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= low && number <= high ? number : null;
}

/** The E444 timing fields, only those present and in range (absent keys stay absent). */
function reuseTiming(authTime: unknown, reuseWindow: unknown): Pick<StepUpLanding, 'authTime' | 'reuseWindowSeconds'> {
  const at = bounded(authTime, AUTH_TIME_RANGE);
  const reuse = bounded(reuseWindow, REUSE_WINDOW_RANGE);
  return { ...(at !== null ? { authTime: at } : {}), ...(reuse !== null ? { reuseWindowSeconds: reuse } : {}) };
}

/** Parse a landing URL's query, or null when it is not a step-up landing. */
export function readStepUpLanding(search: string): StepUpLanding | null {
  const params = new URLSearchParams(search);
  const outcome = params.get('step_up');
  if (outcome !== 'complete' && outcome !== 'refused') return null;
  const requestId = params.get('request') ?? '';
  if (!REQUEST_ID.test(requestId)) return null;
  const code = params.get('code');
  return {
    outcome,
    requestId,
    code: code && REFUSAL_CODE.test(code) ? code : null,
    ...(outcome === 'refused' ? reuseTiming(params.get('auth_time'), params.get('reuse_window')) : {}),
  };
}

/** The message shape, validated field by field: it arrives from another window. */
export function asStepUpMessage(value: unknown): StepUpLanding | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== STEP_UP_MESSAGE_TYPE) return null;
  if (message.outcome !== 'complete' && message.outcome !== 'refused') return null;
  if (typeof message.requestId !== 'string' || !REQUEST_ID.test(message.requestId)) return null;
  const code = typeof message.code === 'string' && REFUSAL_CODE.test(message.code) ? message.code : null;
  return {
    outcome: message.outcome,
    requestId: message.requestId,
    code,
    ...(message.outcome === 'refused' ? reuseTiming(message.authTime, message.reuseWindowSeconds) : {}),
  };
}

const URL_MAX_LENGTH = 4096;
const REQUESTS_KEY = 'relayhall_step_up_requests';
const REQUESTS_KEPT = 8;
const REQUEST_MEMORY_MS = 15 * 60_000;

interface RememberedRequest { requestId: string; origin: string; at: number }

/** An https origin, exactly as `URL.origin` writes it, or null. */
function httpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

function rememberedRequests(storage: Storage, now: number): RememberedRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(REQUESTS_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is RememberedRequest => Boolean(entry)
    && typeof entry === 'object'
    && typeof entry.requestId === 'string' && REQUEST_ID.test(entry.requestId)
    && httpsOrigin(entry.origin) !== null
    && typeof entry.at === 'number' && now - entry.at >= 0 && now - entry.at <= REQUEST_MEMORY_MS);
}

function storageOf(win: Window): Storage | null {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * E444: the dialog records, for each request the board started, the provider
 * origin of the authorize URL the board ITSELF answered with. A kept landing
 * accepts a relaunch only onto that origin. Kept for 15 minutes, 8 at most.
 */
export function rememberStepUpRequest(requestId: string, providerOrigin: string, win: Window = window): void {
  if (!REQUEST_ID.test(requestId) || httpsOrigin(providerOrigin) === null) return;
  const storage = storageOf(win);
  if (!storage) return;
  try {
    const now = Date.now();
    const kept = rememberedRequests(storage, now).filter((entry) => entry.requestId !== requestId);
    kept.push({ requestId, origin: providerOrigin, at: now });
    storage.setItem(REQUESTS_KEY, JSON.stringify(kept.slice(-REQUESTS_KEPT)));
  } catch {
    // No storage: the kept landing then refuses every relaunch, and the dialog uses its other routes.
  }
}

/** The provider origin recorded for a request, or null. */
export function providerOriginFor(requestId: string, win: Window = window): string | null {
  const storage = storageOf(win);
  if (!storage) return null;
  try {
    return rememberedRequests(storage, Date.now()).find((entry) => entry.requestId === requestId)?.origin ?? null;
  } catch {
    return null;
  }
}

/** A dialog-to-landing message, validated field by field. */
export function asRelaunchMessage(value: unknown): RelaunchMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== STEP_UP_RELAUNCH_TYPE) return null;
  const { action, forRequest, url } = message;
  if (action !== 'relaunch' && action !== 'release' && action !== 'relaunched') return null;
  if (typeof forRequest !== 'string' || !REQUEST_ID.test(forRequest)) return null;
  if (action !== 'relaunch') return { action, forRequest };
  if (typeof url !== 'string' || url.length > URL_MAX_LENGTH) return null;
  return { action, forRequest, url };
}

/**
 * The one place a kept landing decides where it may go: a `relaunch` for ITS
 * OWN request id, whose URL is https, on exactly the provider origin recorded
 * for that request, with no credentials in it. Anything else is null.
 */
export function relaunchTarget(value: unknown, ownRequestId: string, providerOrigin: string | null): URL | null {
  const message = asRelaunchMessage(value);
  if (!message || message.action !== 'relaunch' || message.forRequest !== ownRequestId || !message.url) return null;
  if (httpsOrigin(providerOrigin) === null) return null;
  let url: URL;
  try {
    url = new URL(message.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== providerOrigin || url.username || url.password) return null;
  return url;
}

/** Build a dialog-to-landing message. */
export function relaunchMessage(action: RelaunchAction, forRequest: string, url?: string): Record<string, string> {
  return { type: STEP_UP_RELAUNCH_TYPE, action, forRequest, ...(url !== undefined ? { url } : {}) };
}

/** Tell the landing kept for `forRequest` to close; a browser without the channel posts nothing. */
export function releaseKeptLanding(forRequest: string): void {
  try {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(STEP_UP_CHANNEL);
    channel.postMessage(relaunchMessage('release', forRequest));
    channel.close();
  } catch {
    // Nothing to tell: the landing closes itself after its bound.
  }
}

/**
 * The dialog's first route for its automatic retry: ask the landing kept for
 * `forRequest` to move itself to `url`. Resolves true only when that landing
 * answered `relaunched` within `RELAUNCH_ACK_MS`.
 */
export function relaunchKeptLanding(forRequest: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof BroadcastChannel === 'undefined') { resolve(false); return; }
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(STEP_UP_CHANNEL);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (answered: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try { channel.close(); } catch { /* already closed */ }
      resolve(answered);
    };
    timer = setTimeout(() => finish(false), RELAUNCH_ACK_MS);
    channel.onmessage = (event: MessageEvent) => {
      const answer = asRelaunchMessage(event.data);
      if (answer && answer.action === 'relaunched' && answer.forRequest === forRequest) finish(true);
    };
    try {
      channel.postMessage(relaunchMessage('relaunch', forRequest, url));
    } catch {
      finish(false);
    }
  });
}

function closeWindow(win: Window): void {
  try {
    win.close();
  } catch {
    // Some browsers keep a window the script did not open; its text says what to do.
  }
}

/** The kept landing's listener in this window, while there is one. */
let keptLanding: (() => void) | null = null;

/** Stop the kept landing's listener in this window, if it has one. */
export function stopKeptLanding(): void {
  const stop = keptLanding;
  keptLanding = null;
  stop?.();
}

/** E444: keep this landing for its dialog's relaunch or release (see the module note). */
function keepForRelaunch(win: Window, requestId: string): void {
  stopKeptLanding();
  if (typeof BroadcastChannel === 'undefined') return;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(STEP_UP_CHANNEL);
  } catch {
    return;
  }
  let stopped = false;
  let limit: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (limit !== undefined) clearTimeout(limit);
    try { channel.close(); } catch { /* already closed */ }
    if (keptLanding === stop) keptLanding = null;
  };
  limit = setTimeout(() => { stop(); closeWindow(win); }, KEPT_LANDING_LIMIT_MS);
  channel.onmessage = (event: MessageEvent) => {
    if (stopped) return;
    const message = asRelaunchMessage(event.data);
    if (!message || message.forRequest !== requestId) return;
    if (message.action === 'release') {
      stop();
      closeWindow(win);
      return;
    }
    const target = relaunchTarget(event.data, requestId, providerOriginFor(requestId, win));
    if (!target) return;
    try { channel.postMessage(relaunchMessage('relaunched', requestId)); } catch { /* the dialog's other routes then run */ }
    stop();
    win.location.href = target.toString();
  };
  keptLanding = stop;
}

/**
 * Run on every dashboard load, before the app. Returns true when this load
 * WAS a step-up landing, in which case the caller must not render the app.
 */
export function completeStepUpLanding(win: Window = window): boolean {
  const landing = readStepUpLanding(win.location.search);
  if (!landing) return false;
  const message = { type: STEP_UP_MESSAGE_TYPE, ...landing };
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(STEP_UP_CHANNEL);
      channel.postMessage(message);
      channel.close();
    }
  } catch {
    // The other path below still carries it.
  }
  try {
    win.opener?.postMessage(message, win.location.origin);
  } catch {
    // A severed or foreign opener: the channel above is the path that remains.
  }
  const root = win.document.getElementById('root');
  const reused = landing.outcome === 'refused' && landing.code === STEP_UP_REUSED_SIGN_IN;
  if (root) {
    root.textContent = landing.outcome === 'complete'
      ? 'Confirmed. You can close this window and return to RelayHall.'
      : reused
        ? 'Your identity provider reused your recent sign-in. RelayHall asks it again in this window by itself when its wait ends. If nothing happens here, close this window and continue in RelayHall.'
        : 'The confirmation was refused. Close this window and try again in RelayHall.';
  }
  // E444: kept open for the dialog's own retry, listening for it (see above).
  if (reused) {
    keepForRelaunch(win, landing.requestId);
    return true;
  }
  try {
    win.close();
  } catch {
    // Some browsers keep a window the script did not open; the text above says what to do.
  }
  return true;
}
