import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { authenticatedFetch } from '../../utils/auth';
import {
  STEP_UP_CHANNEL,
  STEP_UP_WINDOW_NAME,
  asStepUpMessage,
  relaunchKeptLanding,
  releaseKeptLanding,
  rememberStepUpRequest,
  type StepUpLanding,
} from '../../utils/stepUpLanding';
import { reuseWait, type ReuseWaitSource } from '../../utils/stepUpReuseWait';
import './StepUpDialog.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * Step-up elevation dialog (AZ-S4; design 4d961e37 §7.6, AZ-23).
 *
 * Mints a SINGLE-USE elevation token bound to ONE named action + target,
 * then hands the token to the caller, which sends it with the elevated act —
 * the consuming endpoint burns it. The dialog never stores the password or
 * the token; a cancelled dialog leaves any minted-but-unused token to its
 * ~5-minute expiry.
 *
 * Card a3e76724: it asks for the proof THIS Account can give. The board says
 * which (`GET /auth/step-up/methods`): an Account that signed in through its
 * Identity provider and holds no password confirms there instead — the
 * provider opens in a window of its own and asks the person to sign in again,
 * the board proves it was the same Account, and the dialog collects the token
 * (`POST /auth/step-up/collect`).
 *
 * Card f5a70765: the owner's SECOND step-up on one mounted page offered only
 * a Password field, which her Identity-provider-only Account cannot give.
 * The dialog used to show its password form as a placeholder until the
 * board answered, and to keep it whenever the board could not answer. Now
 * every binding the dialog is handed is a fresh question to the board (read
 * past the browser cache), nothing is offered until it answers, and a read
 * that fails offers the methods the step-up challenge advertised or, with no
 * challenge in hand, BOTH proofs, says so, and can ask again. Offering a
 * proof never accepts it: the board decides which proof it takes.
 *
 * Card 7a99d63e (design SU-32): a refused confirmation names its cause — the
 * provider reused an earlier sign-in, the confirmation was too weak, or the
 * provider declined — and offers one "Try again", which is always a NEW
 * request. No state suggests signing out.
 *
 * Owner ruling E444: a provider that REUSED a recent sign-in
 * (`SSO_STEP_UP_NOT_FRESH`) is not a red refusal with a manual "Try again"
 * any more. The dialog counts down to the earliest moment a fresh
 * confirmation can pass (`reuseWait`: from the reused sign-in's `auth_time`
 * when the refusal carries it, else the window the board states, else a
 * cautious wait it says it is using) and then asks again by itself, as a NEW
 * request, in the window the landing kept open for it. Cancel is always there
 * and stops it. It does so at most `MAX_AUTOMATIC_RETRIES` times in one
 * dialog; the next reuse shows the normal message, which says who can change
 * it. Every other refusal is unchanged. The countdown is announced politely at
 * its start and at its end, never every second; focus stays in the dialog;
 * nothing moves, so there is no motion to reduce.
 *
 * The board's cross-origin opener policy usually cuts the kept window off
 * from this dialog on its way back from the provider, so the retry has three
 * routes, in order: (1) the kept landing, told on `STEP_UP_CHANNEL` to move
 * itself to the NEW request's authorize URL, which it checks against its own
 * request id and the provider origin the board gave (`stepUpLanding.ts`);
 * (2) the window reference this dialog still holds, when it was not cut off;
 * (3) a new window, which a browser blocks without a click, so the last
 * fallback is a notice asking for one click. Cancel, a closed dialog and a
 * new binding tell the kept landing to close itself (`release`). Each
 * landing counts once, however many paths deliver it, and a start that is
 * overtaken by Cancel, a switch or a new binding while the board answers
 * leaves nothing behind.
 */
interface StepUpDialogProps {
  /** The ratified action string the token binds to (e.g. 'approval.decide'). */
  action: string;
  /** The exact target object id the token binds to. */
  targetId: string;
  /** Human sentence naming the act being elevated. */
  description: string;
  onToken: (stepUpToken: string) => void;
  onCancel: () => void;
  /**
   * Card f5a70765: the methods a `403 STEP_UP_REQUIRED` challenge named for
   * this binding (SU-14 `methods`), when the dialog answers one. Used only
   * when the methods read fails; the board's fresh answer always wins.
   */
  advertisedMethods?: readonly StepUpMethod[];
}

type StepUpMethod = 'password' | 'sso';

/** The one sentence a failed methods read shows, whatever made it fail. */
const METHODS_UNREAD_SENTENCE = 'This page could not check how your account confirms it is you, so every way it might is offered. Check again, or use the one you have.';

/** How long the dialog waits for the methods answer before it stops waiting. */
const METHODS_READ_TIMEOUT_MS = 10_000;

function knownMethods(values: readonly unknown[]): StepUpMethod[] {
  return values.filter((value): value is StepUpMethod => value === 'password' || value === 'sso');
}

/** What a failed read offers: the challenge's own list, else both proofs. */
function fallbackMethods(advertised: readonly StepUpMethod[] | undefined): StepUpMethod[] {
  const known = advertised ? knownMethods(advertised) : [];
  return known.length > 0 ? known : ['password', 'sso'];
}

/**
 * Card 7a99d63e (design SU-32): the step-up causes the board now names, each
 * with its own state. The person is told WHY the confirmation did not
 * count, and never to sign out: a sign-out detour is exactly what the owner
 * asked to remove (E255), and the board's own answer is a relaunch or, where
 * the provider keeps reusing its sign-in, an administrator's setting.
 */
const STEP_UP_NOT_FRESH_SENTENCE = 'Your identity provider reused your current sign-in instead of asking you again, so this was not confirmed. If you signed in or confirmed something less than half a minute ago, wait a moment and try again.';
/** E444: past the automatic retries the reuse is said without "wait and try again". */
const STEP_UP_NOT_FRESH_PAST_BOUND_SENTENCE = 'Your identity provider reused your current sign-in again instead of asking you, so this was not confirmed.';
const STEP_UP_NOT_FRESH_AGAIN_SENTENCE ='Your identity provider is not asking again for this site. An administrator can change how this board asks it; until then this act cannot be confirmed through single sign-on.';
const STEP_UP_TOO_WEAK_SENTENCE = 'This act needs a stronger confirmation (for example your passkey) than the one used.';
const STEP_UP_PROVIDER_DECLINED_SENTENCE = 'Your identity provider could not confirm it was you in the way this act needs.';

/**
 * The named causes whose state offers "Try again" (a NEW request, SU-16). A
 * reused sign-in is not among them since E444: the dialog retries it itself.
 */
const RELAUNCHABLE_CAUSES = new Set(['SSO_STEP_UP_TOO_WEAK', 'SSO_STEP_UP_PROVIDER_DECLINED']);

/** E444: how many times one dialog waits out a reused sign-in and asks again by itself. */
export const MAX_AUTOMATIC_RETRIES = 2;
const NOT_FRESH = 'SSO_STEP_UP_NOT_FRESH';
const POPUP_FEATURES = 'popup,width=520,height=720';

const REUSE_COUNTDOWN_SENTENCE = 'Your identity provider reused your recent sign-in instead of asking you again. This dialog asks it again by itself as soon as it can.';
const reuseCautiousSentence = (seconds: number) =>
  `Your identity provider does not say how long it reuses a sign-in, so this waits a cautious ${seconds} seconds.`;
const REUSE_RETRYING_SENTENCE = 'Asking your identity provider again now.';
const REUSE_BLOCKED_SENTENCE = 'Your browser did not let this page open the sign-in window by itself. Continue with single sign-on to ask your identity provider again.';

const secondsWords = (seconds: number) => `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;

interface ReuseCountdown {
  /** When the countdown ends, in epoch milliseconds. */
  endsAt: number;
  seconds: number;
  source: ReuseWaitSource;
}

type ReuseTiming = Pick<StepUpLanding, 'authTime' | 'reuseWindowSeconds'>;

/** Person-visible sentences for the board's NAMED refusals; never its text. */
const SSO_STEP_UP_REFUSALS: Record<string, string> = {
  SSO_STEP_UP_NOT_FRESH: STEP_UP_NOT_FRESH_SENTENCE,
  SSO_STEP_UP_TOO_WEAK: STEP_UP_TOO_WEAK_SENTENCE,
  SSO_STEP_UP_PROVIDER_DECLINED: STEP_UP_PROVIDER_DECLINED_SENTENCE,
  SSO_STEP_UP_SUBJECT_MISMATCH: 'Your Identity provider signed in a different account. Sign in there as yourself and try again.',
  SSO_ID_TOKEN_REFUSED: 'Your Identity provider did not confirm a fresh sign-in. Try again.',
  SSO_STATE_UNKNOWN: 'That confirmation attempt expired or was already used. Try again.',
  SSO_COOKIE_MISMATCH: 'The confirmation could not be tied to this browser. Try again.',
  SSO_PROVIDER_ERROR: 'Your Identity provider refused the confirmation.',
  SSO_PROVIDER_UNREACHABLE: 'Your Identity provider could not be reached.',
  SSO_STEP_UP_UNAVAILABLE: 'This account has no linked Identity provider to confirm with.',
  STEP_UP_REFUSED: 'Your Identity provider did not confirm it was you. Try again.',
  STEP_UP_EXPIRED: 'The confirmation expired before it was used. Try again.',
  STEP_UP_ALREADY_COLLECTED: 'That confirmation was already used. Try again.',
  STEP_UP_REQUEST_UNKNOWN: 'That confirmation belongs to a different session. Try again.',
};

function refusalSentence(code: unknown): string {
  return (typeof code === 'string' && SSO_STEP_UP_REFUSALS[code]) || 'The confirmation through your Identity provider did not complete. Try again.';
}

interface StartedSso { started: true; url: URL; requestId: string }
/** The board's answer to a start: a NEW request, or its named refusal. */
type SsoStart = StartedSso | { started: false; code: unknown };

function closeQuietly(target: Window): void {
  try { target.close(); } catch { /* already gone */ }
}

/** Only an https URL is ever handed to the sign-in window. */
function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export const StepUpDialog: React.FC<StepUpDialogProps> = ({ action, targetId, description, onToken, onCancel, advertisedMethods }) => {
  /** `checking` until the board answers for THIS binding (card f5a70765). */
  const [method, setMethod] = useState<StepUpMethod | 'none' | 'checking'>('checking');
  const [available, setAvailable] = useState<StepUpMethod[]>([]);
  /** Whether the last methods read failed, and how many reads were asked for. */
  const [unread, setUnread] = useState(false);
  const [readCount, setReadCount] = useState(0);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The pending re-authentication this dialog started, while it is open. */
  const [awaiting, setAwaiting] = useState<string | null>(null);
  /**
   * Card 7a99d63e (SU-32): the NAMED cause of the last refused single
   * sign-on attempt, and how many times in this dialog the provider reused
   * its sign-in. E444: each reuse up to `MAX_AUTOMATIC_RETRIES` is waited out
   * and asked again by the dialog; the one after that (S6b) stops: a
   * provider that keeps answering with an old sign-in would only be looped.
   */
  const [cause, setCause] = useState<string | null>(null);
  const [notFreshCount, setNotFreshCount] = useState(0);
  const notFreshSeen = useRef(0);
  /** E444: the running countdown, the whole seconds left on it, and what is announced. */
  const [countdown, setCountdown] = useState<ReuseCountdown | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  /** E444: the browser refused to open the sign-in window without a click. */
  const [autoBlocked, setAutoBlocked] = useState(false);
  /**
   * E444: the sign-in window this dialog opened. After a reused sign-in the
   * landing keeps it open; when the kept landing does not answer on the
   * channel and this reference was not cut off, the automatic retry points it
   * at the provider again (a NEW window that no click opened would be blocked).
   */
  const signInWindow = useRef<Window | null>(null);
  /** E444: the refused request whose landing window is kept open for the retry. */
  const keptLanding = useRef<string | null>(null);
  /** E444: the landings already handled, by request id; one landing counts once, however it arrives. */
  const handledLandings = useRef(new Set<string>());
  /**
   * E444: moved on by every start, and by Cancel, a switch, a new binding and
   * a closed dialog. A start whose generation has moved on while the board
   * was answering stores nothing.
   */
  const generation = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const collecting = useRef(false);

  /**
   * The kept landing and the window kept for a retry, let go when no retry
   * will use them: the landing is told to close itself (it may be cut off
   * from this dialog), and a window this dialog can still reach is closed.
   */
  const releaseSignInWindow = useCallback(() => {
    const kept = keptLanding.current;
    keptLanding.current = null;
    if (kept) releaseKeptLanding(kept);
    const held = signInWindow.current;
    signInWindow.current = null;
    try { if (held && !held.closed) held.close(); } catch { /* already gone */ }
  }, []);

  /** Cancel, a switch, a new binding or a closed dialog: nothing in flight may store anything after it. */
  const abandon = useCallback(() => {
    generation.current += 1;
    setPending(false);
    releaseSignInWindow();
  }, [releaseSignInWindow]);

  const stopCountdown = useCallback(() => {
    setCountdown(null);
    setAutoBlocked(false);
  }, []);

  /**
   * A refused single sign-on attempt: its fixed sentence, by its code.
   * `landedFor` names the request whose landing reported it; for a reused
   * sign-in that landing is kept open for the retry.
   */
  const refuseSso = useCallback((code: unknown, timing?: ReuseTiming, landedFor?: string) => {
    const named = typeof code === 'string' ? code : null;
    setAwaiting(null);
    setCause(named);
    setAutoBlocked(false);
    if (named === NOT_FRESH) {
      if (landedFor) keptLanding.current = landedFor;
      notFreshSeen.current += 1;
      setNotFreshCount(notFreshSeen.current);
      if (notFreshSeen.current <= MAX_AUTOMATIC_RETRIES) {
        // E444: no refusal is shown; the provider's reuse is waited out.
        const now = Date.now();
        const wait = reuseWait({ authTime: timing?.authTime, reuseWindowSeconds: timing?.reuseWindowSeconds, now });
        setError(null);
        setRemaining(wait.seconds);
        setCountdown({ endsAt: now + wait.seconds * 1000, seconds: wait.seconds, source: wait.source });
        setAnnouncement(`${REUSE_COUNTDOWN_SENTENCE} Asking again in ${secondsWords(wait.seconds)}.`);
        return;
      }
      // Past the bound: the normal message, and the kept window is let go.
      releaseSignInWindow();
    }
    setCountdown(null);
    setError(refusalSentence(named));
  }, [releaseSignInWindow]);

  useEffect(() => { if (method === 'password') inputRef.current?.focus(); }, [method]);

  // Card f5a70765: a NEW binding handed to a mounted dialog is a new act.
  // Nothing from the previous one (its refusal, its reuse count, a pending
  // re-authentication, a typed password) is carried into it.
  const binding = `${action}\u0000${targetId}`;
  const lastBinding = useRef(binding);
  useEffect(() => {
    if (lastBinding.current === binding) return;
    lastBinding.current = binding;
    setPassword('');
    setError(null);
    setNotice(null);
    setAwaiting(null);
    setCause(null);
    setNotFreshCount(0);
    notFreshSeen.current = 0;
    setCountdown(null);
    setAutoBlocked(false);
    setAnnouncement('');
    abandon();
  }, [binding, abandon]);

  // A dialog that closes lets go of a window it was keeping for a retry, and
  // of any start still waiting for the board.
  useEffect(() => abandon, [abandon]);

  // Which proof this Account can give, asked afresh for every binding and on
  // every "Check again", never answered from the browser cache (card
  // f5a70765). Nothing is offered until it answers; a failed read offers the
  // challenge's methods, else both, and says so.
  const advertisedKey = (advertisedMethods ?? []).join(',');
  useEffect(() => {
    let cancelled = false;
    const advertised = advertisedKey ? (advertisedKey.split(',') as StepUpMethod[]) : undefined;
    setMethod('checking');
    setUnread(false);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), METHODS_READ_TIMEOUT_MS);
    const offer = (methods: StepUpMethod[], preferred: unknown) => {
      setAvailable(methods);
      if ((preferred === 'sso' || preferred === 'password') && methods.includes(preferred)) setMethod(preferred);
      else if (methods.length === 0) setMethod('none');
      else setMethod(methods[0]);
    };
    const fallBack = () => {
      if (cancelled) return;
      const methods = fallbackMethods(advertised);
      setUnread(true);
      offer(methods, methods.includes('password') ? 'password' : 'sso');
    };
    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE}/auth/step-up/methods`, {
          cache: 'no-store',
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (cancelled) return;
        if (!response.ok) { fallBack(); return; }
        const data = await response.json();
        if (cancelled) return;
        if (!data || !Array.isArray(data.methods)) { fallBack(); return; }
        offer(knownMethods(data.methods as unknown[]), data.preferred);
      } catch {
        fallBack();
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [binding, advertisedKey, readCount]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || !password) return;
    setPending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/auth/step-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, targetId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success || typeof data.stepUpToken !== 'string') {
        throw new Error(data.message || data.error || 'Step-up failed');
      }
      setPassword('');
      onToken(data.stepUpToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Step-up failed');
    } finally {
      setPending(false);
    }
  };

  /** Exchange the proven re-authentication for the token, once. */
  const collect = useCallback(async (requestId: string) => {
    if (collecting.current) return;
    collecting.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authenticatedFetch(`${API_BASE}/auth/step-up/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      const data = await response.json();
      if (data?.code === 'STEP_UP_PENDING') {
        setNotice('Still waiting for your Identity provider. Finish signing in there, then check again.');
        return;
      }
      if (!response.ok || !data?.success || typeof data.stepUpToken !== 'string') {
        refuseSso(data?.code);
        return;
      }
      // The board binds the token; this only refuses to hand a token for some
      // OTHER act to the caller that asked for this one.
      if (data.action !== action || data.targetId !== targetId) {
        refuseSso(null);
        return;
      }
      setAwaiting(null);
      onToken(data.stepUpToken);
    } catch {
      setCause(null);
      setError(refusalSentence(null));
    } finally {
      collecting.current = false;
      setPending(false);
    }
  }, [action, targetId, onToken, refuseSso]);

  // The landing window reports back by request id; only THIS dialog's counts.
  // It reports on two paths at once (the channel and the opener), and both
  // can arrive before the dialog re-renders: E444 counts each landing ONCE,
  // by its request id, so one reuse is never counted as two.
  useEffect(() => {
    if (!awaiting) return undefined;
    const handle = (data: unknown) => {
      const landing = asStepUpMessage(data);
      if (!landing || landing.requestId !== awaiting) return;
      if (handledLandings.current.has(landing.requestId)) return;
      handledLandings.current.add(landing.requestId);
      if (landing.outcome === 'complete') {
        void collect(awaiting);
      } else {
        refuseSso(landing.code, { authTime: landing.authTime, reuseWindowSeconds: landing.reuseWindowSeconds }, landing.requestId);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      handle(event.data);
    };
    window.addEventListener('message', onMessage);
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(STEP_UP_CHANNEL);
        channel.onmessage = (event: MessageEvent) => handle(event.data);
      }
    } catch {
      channel = null;
    }
    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, [awaiting, collect, refuseSso]);

  /**
   * Ask the board for a NEW request. Every start comes here (the person's
   * click, "Try again", and the E444 automatic retry), so each is a new
   * request id, state and nonce (SU-16), never a retry of the refused one.
   */
  const requestSsoStart = async (): Promise<SsoStart> => {
    const response = await authenticatedFetch(`${API_BASE}/auth/step-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'sso', action, targetId }),
    });
    const data = await response.json();
    const authorizeUrl = httpsUrl(data?.authorizeUrl);
    if (!response.ok || !data?.success || !authorizeUrl || typeof data.requestId !== 'string') {
      return { started: false, code: data?.code };
    }
    return { started: true, url: authorizeUrl, requestId: data.requestId };
  };

  /** Wait for THIS request's landing, and record where the board sent it (E444). */
  const awaitLanding = (start: StartedSso) => {
    rememberStepUpRequest(start.requestId, start.url.origin);
    setAwaiting(start.requestId);
  };

  /** Begin a re-authentication from the person's own click. */
  const startSso = async () => {
    if (pending) return;
    setError(null);
    setNotice(null);
    setCause(null);
    stopCountdown();
    // Opened inside the click, so a pop-up blocker sees the person's own act;
    // it is pointed at the Identity provider once the board has bound it.
    const popup = window.open('', STEP_UP_WINDOW_NAME, POPUP_FEATURES);
    if (!popup) {
      setError('Your browser did not open the sign-in window. Allow pop-ups for this site, then try again.');
      return;
    }
    const mine = ++generation.current;
    setPending(true);
    try {
      const start = await requestSsoStart();
      if (generation.current !== mine) {
        // Cancelled, switched or rebound while the board answered: the blank
        // window opened for this start is closed and nothing is stored.
        closeQuietly(popup);
        return;
      }
      if (!start.started) {
        closeQuietly(popup);
        signInWindow.current = null;
        refuseSso(start.code);
        return;
      }
      popup.location.href = start.url.toString();
      signInWindow.current = popup;
      try { popup.focus(); } catch { /* the window keeps its own focus */ }
      awaitLanding(start);
    } catch {
      closeQuietly(popup);
      if (generation.current !== mine) return;
      signInWindow.current = null;
      setCountdown(null);
      setError(refusalSentence(null));
    } finally {
      if (generation.current === mine) setPending(false);
    }
  };

  /**
   * E444: the countdown ended. A NEW request is asked for, then sent to the
   * provider by the first route that works: (1) the kept landing moves itself
   * (it answers `relaunched`); (2) the window this dialog still holds, when
   * it was not cut off; (3) a new window, which a browser may block without
   * a click. When none works the person is asked for one click, not refused.
   */
  const retryAutomatically = async () => {
    const mine = ++generation.current;
    const refused = keptLanding.current;
    setAnnouncement(REUSE_RETRYING_SENTENCE);
    setPending(true);
    let start: SsoStart;
    try {
      start = await requestSsoStart();
    } catch {
      if (generation.current !== mine) return;
      releaseSignInWindow();
      setPending(false);
      setError(refusalSentence(null));
      return;
    }
    if (generation.current !== mine) return;
    if (!start.started) {
      releaseSignInWindow();
      setPending(false);
      refuseSso(start.code);
      return;
    }
    const target = start.url.toString();
    awaitLanding(start);
    let sent = refused ? await relaunchKeptLanding(refused, target) : false;
    if (generation.current !== mine) return;
    keptLanding.current = null;
    let popup = signInWindow.current;
    if (popup && popup.closed) popup = null;
    if (!sent && popup) {
      popup.location.href = target;
      sent = true;
    }
    if (!sent) {
      popup = window.open('', STEP_UP_WINDOW_NAME, POPUP_FEATURES);
      if (popup) {
        popup.location.href = target;
        sent = true;
      }
    }
    signInWindow.current = popup;
    setPending(false);
    if (!sent) {
      // Nothing could carry it: a landing that never answered is told to close.
      if (refused) releaseKeptLanding(refused);
      setAwaiting(null);
      setAutoBlocked(true);
      setAnnouncement(REUSE_BLOCKED_SENTENCE);
      return;
    }
    try { popup?.focus(); } catch { /* the window keeps its own focus */ }
  };
  const retryRef = useRef(retryAutomatically);
  retryRef.current = retryAutomatically;

  // E444: one tick a second for the visible number; the announcement above
  // changes only at the countdown's start and its end.
  useEffect(() => {
    if (!countdown) return undefined;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((countdown.endsAt - Date.now()) / 1000));
      setRemaining(left);
      if (left > 0) return;
      clearInterval(timer);
      setCountdown(null);
      void retryRef.current();
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  /** Cancel always works, and stops a running countdown before anything else. */
  const cancel = () => {
    stopCountdown();
    setAwaiting(null);
    abandon();
    onCancel();
  };

  /** Ask the board again which proof applies (after a failed read). */
  const checkAgain = () => {
    setError(null);
    setNotice(null);
    setReadCount((count) => count + 1);
  };

  const switchTo = (next: StepUpMethod) => {
    setError(null);
    setNotice(null);
    setAwaiting(null);
    setCause(null);
    stopCountdown();
    abandon();
    setMethod(next);
  };

  // S6b: the provider kept reusing its sign-in past the automatic retries.
  // The board cannot make it ask again from here, so the state says who can.
  const notFreshAgain = cause === NOT_FRESH && notFreshCount > MAX_AUTOMATIC_RETRIES;
  const relaunchable = cause !== null && RELAUNCHABLE_CAUSES.has(cause);
  const shownError = notFreshAgain ? `${STEP_UP_NOT_FRESH_PAST_BOUND_SENTENCE} ${STEP_UP_NOT_FRESH_AGAIN_SENTENCE}` : error;

  // E444: focus stays in the dialog. A state change that removes the focused
  // control (the countdown starting or ending) hands focus to the last
  // action of the new state instead of dropping it on the page.
  const stateKey = `${method}|${awaiting ?? ''}|${countdown ? 'countdown' : ''}|${autoBlocked}|${notFreshAgain}`;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('.stepup-actions button:not([disabled])');
    buttons[buttons.length - 1]?.focus();
  }, [stateKey]);

  return (
    <div className="stepup-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div ref={dialogRef} className="stepup-dialog" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
        <div className="stepup-head">
          <ShieldCheck aria-hidden="true" />
          <h2 id="stepup-title">Confirm it&rsquo;s you</h2>
          <IconButton icon={<X size={16} aria-hidden="true" />} ariaLabel="Cancel step-up" onClick={cancel} variant="ghost" />
        </div>
        <p className="stepup-description">{description}</p>
        <p className="stepup-note">This mints a single-use elevation token bound to exactly this act. It expires in about five minutes and is burned on use.</p>
        {shownError && <div className="stepup-error" role="alert">{shownError}</div>}
        {notice && <p className="stepup-note" role="status">{notice}</p>}
        {/* E444: said politely, at the countdown's start and end only. */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
        {method === 'checking' && (
          <>
            <p className="stepup-note" role="status">Checking how your account confirms it is you&hellip;</p>
            <div className="stepup-actions">
              <Button type="button" variant="secondary" size="compact" onClick={cancel}>Cancel</Button>
            </div>
          </>
        )}
        {unread && method !== 'checking' && !awaiting && (
          <>
            <p className="stepup-note">{METHODS_UNREAD_SENTENCE}</p>
            <div className="stepup-actions">
              <Button type="button" variant="secondary" size="compact" disabled={pending} onClick={checkAgain}>Check again</Button>
            </div>
          </>
        )}
        {method === 'password' && (
          <form onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="stepup-password">Password</label>
              <input
                id="stepup-password"
                ref={inputRef}
                className="form-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <div className="stepup-actions">
              {available.includes('sso') && (
                <Button type="button" variant="secondary" size="compact" onClick={() => switchTo('sso')}>Use single sign-on instead</Button>
              )}
              <Button type="button" variant="secondary" size="compact" onClick={cancel}>Cancel</Button>
              <Button type="submit" variant="primary" size="compact" disabled={pending || !password}>
                {pending ? 'Verifying…' : 'Continue'}
              </Button>
            </div>
          </form>
        )}
        {method === 'sso' && countdown && (
          <>
            <p className="stepup-description">{REUSE_COUNTDOWN_SENTENCE}</p>
            <p className="stepup-countdown-timer" role="timer" aria-live="off">
              Asking again in {secondsWords(remaining)}.
            </p>
            {countdown.source === 'conservative' && <p className="stepup-note">{reuseCautiousSentence(countdown.seconds)}</p>}
            <div className="stepup-actions">
              {available.includes('password') && (
                <Button type="button" variant="secondary" size="compact" onClick={() => switchTo('password')}>Use password instead</Button>
              )}
              <Button type="button" variant="secondary" size="compact" onClick={cancel}>Cancel</Button>
            </div>
          </>
        )}
        {method === 'sso' && !countdown && (
          <>
            {autoBlocked && !awaiting && <p className="stepup-description">{REUSE_BLOCKED_SENTENCE}</p>}
            <p className="stepup-description">
              {awaiting
                ? 'Finish signing in in the window that opened. This dialog continues on its own when you are done.'
                : 'Your account signs in through your Identity provider, so confirm there: it opens in a new window and asks you to sign in again.'}
            </p>
            <div className="stepup-actions">
              {available.includes('password') && !awaiting && (
                <Button type="button" variant="secondary" size="compact" onClick={() => switchTo('password')}>Use password instead</Button>
              )}
              <Button type="button" variant="secondary" size="compact" onClick={cancel}>Cancel</Button>
              {awaiting ? (
                <Button type="button" variant="primary" size="compact" disabled={pending} onClick={() => { void collect(awaiting); }}>
                  {pending ? 'Checking…' : 'Check again'}
                </Button>
              ) : notFreshAgain ? null : (
                <Button type="button" variant="primary" size="compact" disabled={pending} onClick={() => { void startSso(); }}>
                  {pending ? 'Opening…' : relaunchable ? 'Try again' : 'Continue with single sign-on'}
                </Button>
              )}
            </div>
          </>
        )}
        {method === 'none' && (
          <>
            <div className="stepup-error" role="alert">
              This account has no way to confirm it is you here: it holds no password and no linked Identity provider. An administrator can set a password for it.
            </div>
            <div className="stepup-actions">
              <Button type="button" variant="secondary" size="compact" onClick={cancel}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
