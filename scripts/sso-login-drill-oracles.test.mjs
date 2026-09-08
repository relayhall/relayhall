// The controls for the two drill oracles — run with `node --test`.
//
// Each finding the oracles exist for is reproduced VERBATIM as the bad input
// and required to be refused, beside the good input that must pass; an oracle
// that accepted both would be the recorded-not-judged value the findings were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admittedSessionCookie, refusedLanding, SESSION_COOKIE_NAME } from './sso-login-drill-oracles.mjs';

const httpOnly = { name: SESSION_COOKIE_NAME, value: 'x', httpOnly: true };
const readable = { name: SESSION_COOKIE_NAME, value: 'x', httpOnly: false };
const other = { name: 'rh_sso_state', value: 'y', httpOnly: true };

test('admitted: an httpOnly login-session cookie passes', () => {
  assert.equal(admittedSessionCookie([other, httpOnly]).ok, true);
});

test('admitted CONTROL (cba66ebb): a same-name cookie that is NOT httpOnly cannot pass', () => {
  const verdict = admittedSessionCookie([other, readable]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not httpOnly/);
});

test('admitted CONTROL: a readable twin beside the real cookie still fails', () => {
  assert.equal(admittedSessionCookie([httpOnly, readable]).ok, false);
});

test('admitted: no cookie at all fails, by a different reason', () => {
  const verdict = admittedSessionCookie([other]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no login-session cookie/);
});

const refusedGood = {
  content: '<div class="login-page"><div class="login-error">Sign-in refused: not a member (SSO_LOGIN_GROUP_REFUSED)</div></div>',
  cookies: [other],
  boardChromeCount: 0,
  loginPageCount: 1,
  expectedCode: 'SSO_LOGIN_GROUP_REFUSED',
};

test('refused: the named message on the login page, no cookie, no board chrome passes', () => {
  assert.equal(refusedLanding(refusedGood).ok, true);
});

test('refused CONTROL (533db731): board chrome on the callback answer fails, even with the code and no cookie', () => {
  const verdict = refusedLanding({ ...refusedGood, boardChromeCount: 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /board chrome/);
});

test('refused CONTROL (a07f3277): raw JSON without the login page fails', () => {
  const verdict = refusedLanding({ ...refusedGood, content: '{"error":"SSO refused","code":"SSO_LOGIN_GROUP_REFUSED"}', loginPageCount: 0 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /login page/);
});

test('refused CONTROL: a login-session cookie on a refused answer fails', () => {
  assert.equal(refusedLanding({ ...refusedGood, cookies: [httpOnly] }).ok, false);
});

test('refused CONTROL: the wrong named code fails', () => {
  assert.equal(refusedLanding({ ...refusedGood, expectedCode: 'SSO_ACCOUNT_UNAVAILABLE' }).ok, false);
});
