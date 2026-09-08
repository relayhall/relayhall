/**
 * Interactive SSO login drill — the whole journey, ending at the RENDERED board.
 *
 * ef35d960 taught this drill its job the hard way: its predecessor asserted the
 * landing URL and a direct authenticated fetch, and stayed green while every
 * human who completed a federated login was shown the login page again — the
 * server minted sessions, the SPA never armed its marker, and no assertion
 * looked at what a person actually SEES. The owner found it by clicking.
 *
 * So this drill's admitted arm passes only when, without any manual storage
 * edits, the login form is GONE and the board chrome is rendered. The refused
 * arm must stay on the login page with no session cookie.
 *
 * Environment (no secrets in this file, nothing logged):
 *   DRILL_BASE_URL    board origin, e.g. https://board.example.test
 *   SMOKE_USER        identity to sign in at the Identity provider
 *   SMOKE_PASS        its password
 *   DRILL_EXPECT      "admitted" | "refused"
 *
 * Needs a globally-installed playwright with the system Chrome channel.
 */
import { chromium } from 'playwright';
import { admittedSessionCookie, refusedLanding } from './sso-login-drill-oracles.mjs';

const BASE = process.env.DRILL_BASE_URL;
const USER = process.env.SMOKE_USER;
const PASS = process.env.SMOKE_PASS;
const EXPECT = process.env.DRILL_EXPECT;
/** The named refusal the refused arm expects to see rendered (default: the whitelist's). */
const REFUSAL_CODE = process.env.DRILL_REFUSAL_CODE || 'SSO_LOGIN_GROUP_REFUSED';
if (!BASE || !USER || !PASS) throw new Error('DRILL_BASE_URL, SMOKE_USER and SMOKE_PASS must be set');
if (EXPECT !== 'admitted' && EXPECT !== 'refused') throw new Error('DRILL_EXPECT must be "admitted" or "refused"');

const out = { user: USER, expect: EXPECT, steps: [] };
const step = (name, detail) => {
  out.steps.push({ name, ...detail });
  console.log(`  ${name}: ${JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

try {
  await page.goto(`${BASE}/dashboard/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-page', { timeout: 30000 });
  step('login-page-rendered', { url: page.url() });

  // The human path: the BUTTON, not a hand-rolled fetch of /sso/start.
  await page.click('.login-button--sso', { timeout: 15000 });
  await page.waitForURL(/\/if\/flow\//, { timeout: 60000 });
  step('at-identity-provider', { url: page.url().split('?')[0] });

  // The identification and password stages, in the exact sequence the estate
  // flow accepts (fill + Enter; a click on the stage button does not reliably
  // advance authentik's shadow-DOM form — this drill's first run proved it).
  await page.waitForSelector('input[name="uidField"]', { timeout: 20000 });
  await page.fill('input[name="uidField"]', USER);
  await page.keyboard.press('Enter');
  await page.waitForSelector('input[name="password"]', { timeout: 20000 });
  await page.fill('input[name="password"]', PASS);
  await page.keyboard.press('Enter');
  step('credentials-submitted', {});

  // Either a consent screen or a straight redirect back to the board origin.
  await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 30000 }).catch(async () => {
    const consent = await page.$('button[type="submit"], ak-flow-card button');
    if (consent) { await consent.click(); }
    await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 30000 });
  });
  step('returned-to-board', { url: page.url().split('?')[0] });

  if (EXPECT === 'admitted') {
    // THE assertion this drill exists for: a real person sees the BOARD —
    // the sidebar renders and the login form is gone — with no console
    // tricks, no storage edits, on the first landing after the callback.
    await page.waitForSelector('.sidebar-nav-section', { timeout: 60000 });
    const loginStillVisible = await page.locator('.login-page').count();
    step('board-rendered', { url: page.url(), loginFormStillPresent: loginStillVisible });
    if (loginStillVisible > 0) throw new Error('board and login form rendered together');

    // cba66ebb: the cookie is JUDGED, not recorded — a same-name cookie a
    // script could read is not a login session (the oracle's control proves
    // the oracle can say so).
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === 'relayhall_session');
    const cookieVerdict = admittedSessionCookie(cookies);
    step('session-cookie', { present: !!session, httpOnly: session?.httpOnly ?? null, verdict: cookieVerdict.reason });
    if (!cookieVerdict.ok) throw new Error(cookieVerdict.reason);

    // Survives a full reload: the marker is armed, not just in-memory state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar-nav-section', { timeout: 30000 });
    step('board-survives-reload', {});
    out.ok = true;
  } else {
    // Refused — the callback ANSWER, judged before any navigation (533db731,
    // a07f3277): the person lands on the LOGIN PAGE with the named refusal
    // rendered on it, holds no login-session cookie, and sees no board chrome
    // on that same answer. `refusedLanding` is the oracle; its controls prove
    // it refuses board chrome, raw JSON and a stray cookie.
    await page.waitForSelector('.login-page', { timeout: 30000 });
    const content = await page.content();
    let cookies = await ctx.cookies();
    let session = cookies.find((c) => c.name === 'relayhall_session');
    const verdict = refusedLanding({
      content,
      cookies,
      boardChromeCount: await page.locator('.sidebar-nav-section').count(),
      loginPageCount: await page.locator('.login-page').count(),
      expectedCode: REFUSAL_CODE,
    });
    const renderedMessage = await page.locator('[data-sso-refusal]').textContent().catch(() => null);
    step('refusal-answer', { verdict: verdict.reason, renderedMessage, sessionCookie: !!session, url: page.url().split('?')[0] });
    if (!verdict.ok) throw new Error(verdict.reason);

    await page.goto(`${BASE}/dashboard/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.login-page', { timeout: 30000 });
    const boardVisible = await page.locator('.sidebar-nav-section').count();
    cookies = await ctx.cookies();
    session = cookies.find((c) => c.name === 'relayhall_session');
    step('still-signed-out', { boardRendered: boardVisible, sessionCookie: !!session });
    out.ok = boardVisible === 0 && !session;
    if (!out.ok) throw new Error('a refused login reached the board or holds a login-session cookie');
  }
} catch (e) {
  out.ok = false;
  out.error = String(e).slice(0, 300);
  try { out.pageUrl = page.url(); } catch { /* browser already closed */ }
} finally {
  await browser.close();
}

console.log('RESULT ' + JSON.stringify({ ok: out.ok, expect: EXPECT, error: out.error ?? null, pageUrl: out.pageUrl ?? null }));
process.exit(out.ok ? 0 : 1);
