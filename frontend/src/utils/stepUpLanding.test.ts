// @vitest-environment jsdom
/**
 * The step-up landing — card a3e76724. The board's callback lands the
 * step-up window on a dashboard URL; this module reports to the dialog and
 * keeps the app from booting inside that window. Pinned here: only a
 * well-formed landing counts, the message carries the request id and a NAMED
 * code (never free text), it goes to the SAME origin only, and an ordinary
 * dashboard load is left alone.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  KEPT_LANDING_LIMIT_MS,
  RELAUNCH_ACK_MS,
  STEP_UP_CHANNEL,
  STEP_UP_MESSAGE_TYPE,
  STEP_UP_RELAUNCH_TYPE,
  asStepUpMessage,
  completeStepUpLanding,
  providerOriginFor,
  readStepUpLanding,
  relaunchKeptLanding,
  relaunchMessage,
  relaunchTarget,
  rememberStepUpRequest,
  stopKeptLanding,
} from './stepUpLanding';

const REQUEST_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

function fakeWindow(search: string, opener: { postMessage: ReturnType<typeof vi.fn> } | null) {
  document.body.innerHTML = '<div id="root"></div>';
  return {
    location: { search, origin: 'https://board.example.test' },
    opener,
    document,
    localStorage: window.localStorage,
    close: vi.fn(),
  } as unknown as Window & { close: ReturnType<typeof vi.fn> };
}

const channels: BroadcastChannel[] = [];

afterEach(() => {
  stopKeptLanding();
  channels.splice(0).forEach((channel) => channel.close());
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('readStepUpLanding', () => {
  test('card 7a99d63e: the named step-up causes travel as named codes', () => {
    for (const code of ['SSO_STEP_UP_NOT_FRESH', 'SSO_STEP_UP_TOO_WEAK', 'SSO_STEP_UP_PROVIDER_DECLINED']) {
      expect(readStepUpLanding(`?step_up=refused&request=${REQUEST_ID}&code=${code}`))
        .toEqual({ outcome: 'refused', requestId: REQUEST_ID, code });
      expect(asStepUpMessage({ type: STEP_UP_MESSAGE_TYPE, outcome: 'refused', requestId: REQUEST_ID, code }))
        .toEqual({ outcome: 'refused', requestId: REQUEST_ID, code });
    }
  });

  test('reads a completed and a refused landing', () => {
    expect(readStepUpLanding(`?step_up=complete&request=${REQUEST_ID}`))
      .toEqual({ outcome: 'complete', requestId: REQUEST_ID, code: null });
    expect(readStepUpLanding(`?step_up=refused&request=${REQUEST_ID}&code=SSO_ID_TOKEN_REFUSED`))
      .toEqual({ outcome: 'refused', requestId: REQUEST_ID, code: 'SSO_ID_TOKEN_REFUSED' });
  });

  test('anything else is not a landing, and a code that is not a NAMED code is dropped', () => {
    expect(readStepUpLanding('')).toBeNull();
    expect(readStepUpLanding('?sso_refused=SSO_STATE_UNKNOWN')).toBeNull();
    expect(readStepUpLanding('?step_up=complete&request=not-a-uuid')).toBeNull();
    expect(readStepUpLanding('?step_up=maybe&request=' + REQUEST_ID)).toBeNull();
    expect(readStepUpLanding(`?step_up=refused&request=${REQUEST_ID}&code=<b>free text</b>`)?.code).toBeNull();
  });

  test('asStepUpMessage validates a message field by field', () => {
    expect(asStepUpMessage({ type: STEP_UP_MESSAGE_TYPE, outcome: 'complete', requestId: REQUEST_ID, code: null }))
      .toEqual({ outcome: 'complete', requestId: REQUEST_ID, code: null });
    expect(asStepUpMessage({ type: 'other', outcome: 'complete', requestId: REQUEST_ID })).toBeNull();
    expect(asStepUpMessage({ type: STEP_UP_MESSAGE_TYPE, outcome: 'complete', requestId: 'x' })).toBeNull();
    expect(asStepUpMessage('relayhall:step-up')).toBeNull();
  });
});

describe('completeStepUpLanding', () => {
  test('an ordinary dashboard load is left alone', () => {
    const opener = { postMessage: vi.fn() };
    const win = fakeWindow('?approval=abc', opener);
    expect(completeStepUpLanding(win)).toBe(false);
    expect(opener.postMessage).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });

  test('a landing tells the opener, at its OWN origin only, renders no app, and closes', () => {
    const opener = { postMessage: vi.fn() };
    const win = fakeWindow(`?step_up=complete&request=${REQUEST_ID}`, opener);
    expect(completeStepUpLanding(win)).toBe(true);
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: STEP_UP_MESSAGE_TYPE, outcome: 'complete', requestId: REQUEST_ID, code: null },
      'https://board.example.test',
    );
    expect(document.getElementById('root')?.textContent).toContain('You can close this window');
    expect(win.close).toHaveBeenCalled();
  });

  test('a severed opener is not an error: the landing still completes', () => {
    const win = fakeWindow(`?step_up=refused&request=${REQUEST_ID}&code=SSO_STEP_UP_SUBJECT_MISMATCH`, null);
    expect(completeStepUpLanding(win)).toBe(true);
    expect(document.getElementById('root')?.textContent).toContain('refused');
  });
});

describe('E444: a reused sign-in keeps the window for the dialog to ask again', () => {
  test('a SSO_STEP_UP_NOT_FRESH landing tells the opener, says what happens next, and does NOT close', () => {
    const opener = { postMessage: vi.fn() };
    const win = fakeWindow(`?step_up=refused&request=${REQUEST_ID}&code=SSO_STEP_UP_NOT_FRESH`, opener);
    expect(completeStepUpLanding(win)).toBe(true);
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: STEP_UP_MESSAGE_TYPE, outcome: 'refused', requestId: REQUEST_ID, code: 'SSO_STEP_UP_NOT_FRESH' },
      'https://board.example.test',
    );
    expect(document.getElementById('root')?.textContent).toContain('asks it again in this window by itself');
    expect(win.close).not.toHaveBeenCalled();
  });

  test('every other refusal still closes the window', () => {
    for (const code of ['SSO_STEP_UP_TOO_WEAK', 'SSO_STEP_UP_PROVIDER_DECLINED', 'SSO_ID_TOKEN_REFUSED']) {
      const win = fakeWindow(`?step_up=refused&request=${REQUEST_ID}&code=${code}`, { postMessage: vi.fn() });
      expect(completeStepUpLanding(win)).toBe(true);
      expect(win.close).toHaveBeenCalled();
    }
  });

  test("the reused sign-in's auth_time and the provider's window travel on when present and in range", () => {
    const at = 1_792_756_000;
    expect(readStepUpLanding(`?step_up=refused&request=${REQUEST_ID}&code=SSO_STEP_UP_NOT_FRESH&auth_time=${at}&reuse_window=30`))
      .toEqual({ outcome: 'refused', requestId: REQUEST_ID, code: 'SSO_STEP_UP_NOT_FRESH', authTime: at, reuseWindowSeconds: 30 });
    expect(asStepUpMessage({ type: STEP_UP_MESSAGE_TYPE, outcome: 'refused', requestId: REQUEST_ID, code: 'SSO_STEP_UP_NOT_FRESH', authTime: at, reuseWindowSeconds: 30 }))
      .toEqual({ outcome: 'refused', requestId: REQUEST_ID, code: 'SSO_STEP_UP_NOT_FRESH', authTime: at, reuseWindowSeconds: 30 });
  });

  test('timing that is malformed, out of range, or on a completed landing is dropped, never guessed', () => {
    for (const query of ['auth_time=12abc&reuse_window=-1', 'auth_time=99&reuse_window=301', 'auth_time=1.5e9&reuse_window=30.5', 'reuse_window=0']) {
      const landing = readStepUpLanding(`?step_up=refused&request=${REQUEST_ID}&code=SSO_STEP_UP_NOT_FRESH&${query}`);
      expect(landing).toEqual({ outcome: 'refused', requestId: REQUEST_ID, code: 'SSO_STEP_UP_NOT_FRESH' });
    }
    expect(readStepUpLanding(`?step_up=complete&request=${REQUEST_ID}&auth_time=1792756000&reuse_window=30`))
      .toEqual({ outcome: 'complete', requestId: REQUEST_ID, code: null });
    expect(asStepUpMessage({ type: STEP_UP_MESSAGE_TYPE, outcome: 'refused', requestId: REQUEST_ID, code: null, authTime: '1792756000x', reuseWindowSeconds: 1e9 }))
      .toEqual({ outcome: 'refused', requestId: REQUEST_ID, code: null });
  });
});

/**
 * Round-2 review blocker (E444): the board's cross-origin opener policy cuts
 * the kept landing off from the dialog, so the landing listens on the channel
 * and moves itself. It must never go where the channel alone says: only ITS
 * OWN request id, only https, only the provider origin the board gave for
 * that request.
 */
describe('E444: the kept landing obeys only a relaunch for itself, onto the recorded provider origin', () => {
  const OTHER_REQUEST = '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e';
  const PROVIDER = 'https://idp.example.test';
  const NEW_URL = 'https://idp.example.test/authorize?state=new';
  const relaunch = (url: string, forRequest = REQUEST_ID) => relaunchMessage('relaunch', forRequest, url);

  test('relaunchTarget accepts exactly one shape and refuses every other', () => {
    expect(relaunchTarget(relaunch(NEW_URL), REQUEST_ID, PROVIDER)?.toString()).toBe(NEW_URL);
    const refused: Array<[string, unknown, string | null]> = [
      ['non-https', relaunch('http://idp.example.test/authorize'), PROVIDER],
      ['foreign origin', relaunch('https://evil.example.test/authorize'), PROVIDER],
      ['look-alike host', relaunch('https://idp.example.test.evil.example/authorize'), PROVIDER],
      ['other port', relaunch('https://idp.example.test:8443/authorize'), PROVIDER],
      ['credentials in the URL', relaunch('https://user:pw@idp.example.test/authorize'), PROVIDER],
      ['javascript URL', relaunch('javascript:alert(1)'), PROVIDER],
      ['not a URL', relaunch('not a url'), PROVIDER],
      ['foreign request id', relaunch(NEW_URL, OTHER_REQUEST), PROVIDER],
      ['no recorded origin', relaunch(NEW_URL), null],
      ['a recorded origin that is not https', relaunch('http://idp.example.test/authorize'), 'http://idp.example.test'],
      ['release is not a relaunch', relaunchMessage('release', REQUEST_ID), PROVIDER],
      ['wrong type', { type: STEP_UP_MESSAGE_TYPE, action: 'relaunch', forRequest: REQUEST_ID, url: NEW_URL }, PROVIDER],
      ['overlong URL', relaunch(`${NEW_URL}&pad=${'a'.repeat(5000)}`), PROVIDER],
    ];
    for (const [why, message, origin] of refused) {
      expect({ why, target: relaunchTarget(message, REQUEST_ID, origin) }).toEqual({ why, target: null });
    }
  });

  test('the provider origin is recorded from https origins only, kept 8 deep and for 15 minutes', () => {
    rememberStepUpRequest(REQUEST_ID, 'http://idp.example.test');
    expect(providerOriginFor(REQUEST_ID)).toBeNull();
    rememberStepUpRequest(REQUEST_ID, 'https://idp.example.test/authorize');
    expect(providerOriginFor(REQUEST_ID)).toBeNull();
    rememberStepUpRequest(REQUEST_ID, PROVIDER);
    expect(providerOriginFor(REQUEST_ID)).toBe(PROVIDER);
    for (let index = 0; index < 8; index += 1) {
      rememberStepUpRequest(`${String(index).repeat(8)}-0000-4000-8000-000000000000`, PROVIDER);
    }
    expect(providerOriginFor(REQUEST_ID)).toBeNull();
    vi.useFakeTimers();
    try {
      rememberStepUpRequest(REQUEST_ID, PROVIDER);
      vi.advanceTimersByTime(15 * 60_000 + 1);
      expect(providerOriginFor(REQUEST_ID)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /** A kept landing, its recorded navigations, and a channel to talk to it. */
  function keptLanding(code = 'SSO_STEP_UP_NOT_FRESH') {
    const hrefs: string[] = [];
    const win = fakeWindow(`?step_up=refused&request=${REQUEST_ID}&code=${code}`, null) as unknown as {
      location: { search: string; origin: string; href: string };
      close: ReturnType<typeof vi.fn>;
    };
    Object.defineProperty(win.location, 'href', { get: () => hrefs[hrefs.length - 1] ?? '', set: (value: string) => { hrefs.push(value); } });
    expect(completeStepUpLanding(win as unknown as Window)).toBe(true);
    const heard: unknown[] = [];
    const dialog = new BroadcastChannel(STEP_UP_CHANNEL);
    dialog.onmessage = (event: MessageEvent) => { heard.push(event.data); };
    channels.push(dialog);
    return { win, hrefs, heard, dialog };
  }

  test('a refused relaunch moves nothing; the one valid relaunch moves the window once and is answered', async () => {
    rememberStepUpRequest(REQUEST_ID, PROVIDER);
    const { win, hrefs, heard, dialog } = keptLanding();
    dialog.postMessage(relaunch('http://idp.example.test/authorize'));
    dialog.postMessage(relaunch('https://evil.example.test/authorize'));
    dialog.postMessage(relaunch(NEW_URL, OTHER_REQUEST));
    dialog.postMessage(relaunchMessage('release', OTHER_REQUEST));
    dialog.postMessage(relaunch(NEW_URL));
    // Messages arrive in order: once the valid one has moved the window, every earlier one was refused.
    await vi.waitFor(() => expect(hrefs).toEqual([NEW_URL]));
    await vi.waitFor(() => expect(heard).toEqual([{ type: STEP_UP_RELAUNCH_TYPE, action: 'relaunched', forRequest: REQUEST_ID }]));
    expect(win.close).not.toHaveBeenCalled();
    // It stops listening once it has moved.
    dialog.postMessage(relaunch(`${NEW_URL}&again=1`));
    dialog.postMessage(relaunchMessage('release', REQUEST_ID));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hrefs).toEqual([NEW_URL]);
    expect(win.close).not.toHaveBeenCalled();
  });

  test('with no recorded provider origin, even a well-formed relaunch is refused', async () => {
    const { hrefs, heard, dialog, win } = keptLanding();
    dialog.postMessage(relaunch(NEW_URL));
    dialog.postMessage(relaunchMessage('release', REQUEST_ID));
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(hrefs).toEqual([]);
    expect(heard).toEqual([]);
  });

  test('a release for its own request closes the landing; it then ignores a relaunch', async () => {
    rememberStepUpRequest(REQUEST_ID, PROVIDER);
    const { hrefs, dialog, win } = keptLanding();
    dialog.postMessage(relaunchMessage('release', REQUEST_ID));
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    dialog.postMessage(relaunch(NEW_URL));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hrefs).toEqual([]);
  });

  test('a landing that hears nothing closes itself after its bound', () => {
    vi.useFakeTimers();
    try {
      const { win } = keptLanding();
      vi.advanceTimersByTime(KEPT_LANDING_LIMIT_MS - 1);
      expect(win.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(win.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the dialog side: relaunchKeptLanding is true only when the landing answers, false after RELAUNCH_ACK_MS', async () => {
    rememberStepUpRequest(REQUEST_ID, PROVIDER);
    const { hrefs } = keptLanding();
    await expect(relaunchKeptLanding(REQUEST_ID, NEW_URL)).resolves.toBe(true);
    expect(hrefs).toEqual([NEW_URL]);
    const started = Date.now();
    await expect(relaunchKeptLanding(OTHER_REQUEST, NEW_URL)).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(RELAUNCH_ACK_MS - 50);
  });

  test('every other landing keeps no listener: a relaunch for it moves nothing', async () => {
    rememberStepUpRequest(REQUEST_ID, PROVIDER);
    const { hrefs, dialog } = keptLanding('SSO_STEP_UP_TOO_WEAK');
    dialog.postMessage(relaunch(NEW_URL));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hrefs).toEqual([]);
  });
});
