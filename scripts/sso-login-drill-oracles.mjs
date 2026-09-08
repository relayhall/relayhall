/**
 * sso-login-drill-oracles — the verdicts of `sso-login-live-drill.mjs`, as
 * pure functions with their own controls.
 *
 * Two QA findings shaped this file. `cba66ebb`: the drill RECORDED
 * `session?.httpOnly` and never failed on it, so a cookie a script could read
 * would have passed as a login-session cookie. `533db731`: the refused arm
 * checked the named code and the cookie on the callback answer, but asserted
 * board absence only AFTER navigating away, so a callback answer that rendered
 * the board for one paint would have passed. Both are the same shape — a
 * recorded value nobody judged — and the repair is the same: judge it here,
 * where a control can be handed the bad state and watched go red.
 *
 * The oracles take VALUES the drill observed (cookies, counts, text), never
 * the page, so `sso-login-drill-oracles.test.mjs` can run them without a
 * browser against the exact states the findings describe.
 */

export const SESSION_COOKIE_NAME = 'relayhall_session';

/**
 * The admitted arm's cookie verdict: the login-session cookie is present AND
 * httpOnly. A same-name cookie that a script could read is NOT a
 * login session — it is the finding.
 */
export function admittedSessionCookie(cookies) {
  const matching = (cookies ?? []).filter((c) => c && c.name === SESSION_COOKIE_NAME);
  if (matching.length === 0) return { ok: false, reason: 'no login-session cookie' };
  const readable = matching.filter((c) => c.httpOnly !== true);
  if (readable.length > 0) return { ok: false, reason: 'a login-session cookie is not httpOnly' };
  return { ok: true, reason: 'login-session cookie present and httpOnly' };
}

/**
 * The refused arm's verdict on the CALLBACK ANSWER — the page as it rendered
 * on the first landing, before any navigation:
 *   - the named refusal reaches the human (the code is in the rendered text,
 *     and so is the login page, because the message is rendered ON it);
 *   - no login-session cookie exists;
 *   - the board chrome is ABSENT on that same answer, not merely later.
 */
export function refusedLanding({ content, cookies, boardChromeCount, loginPageCount, expectedCode }) {
  const text = String(content ?? '');
  if (!expectedCode || !text.includes(expectedCode)) return { ok: false, reason: 'the refusal did not carry its named code' };
  if (Number(loginPageCount) < 1) return { ok: false, reason: 'the named refusal is not rendered on the login page' };
  if ((cookies ?? []).some((c) => c && c.name === SESSION_COOKIE_NAME)) return { ok: false, reason: 'a refused login holds a login-session cookie' };
  if (Number(boardChromeCount) > 0) return { ok: false, reason: 'the callback answer rendered board chrome' };
  return { ok: true, reason: 'named refusal rendered on the login page, no login-session cookie, no board chrome' };
}
