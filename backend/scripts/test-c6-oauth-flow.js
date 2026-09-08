#!/usr/bin/env node
/**
 * RH-P3.C6 — the Tier-B end-to-end drill, against a DEPLOYED board.
 *
 * Owner decision D3 (run packet ac60a038): "Tier B end-to-end proof = scripted
 * client + browser QA. A scripted OAuth 2.1 client (authorization code + PKCE,
 * client_id as a CIMD URL hosting a metadata document) drives the full flow
 * against DEV over https, the human authorize/consent step exercised via
 * signed-in browser QA, then the issued token performs real MCP read/write;
 * plus the revocation drill: revoke → the VERY NEXT MCP call refused."
 *
 * This script is the scripted-client half. It exists because the unit suites
 * carry no Postgres, so the authorization-code leg — the rows, the one-time
 * consumption, the credential mint, the per-call lookup — is only observable
 * against a real deployment. That is the C3 lesson written into a file: a
 * compose file that never forwarded a feature flag left a whole TESTED surface
 * unreachable, and only a live drill found it.
 *
 * WHAT IT PROVES, in order, each step failing loudly:
 *   1  discovery: the MCP 401 challenge names protected-resource metadata,
 *      that document is served, and it names an authorization server whose
 *      metadata is served too;
 *   2  the CIMD document this run hosts is fetched and validated by the board;
 *   3  /authorize parks the request and redirects to the consent page;
 *   4  the consent decision is a SIGNED-IN act (the browser-QA half supplies
 *      the session; this script uses the same session token so the leg is
 *      exercised end to end here as well);
 *   5  the code exchanges ONCE for an access token, and a replay is refused;
 *   6  the token bootstraps, performs a real MCP WRITE and reads back what it
 *      wrote — checked on the TOOL RESULT, because MCP carries refusals inside
 *      a 200, with a deliberately-refused call as the control;
 *   7  the token is refused on a REST route (audience restriction);
 *   8  revocation → the VERY NEXT MCP call is refused (ruling TS-12).
 *
 * Usage:
 *   RH_BOARD=https://board.example.test/api \
 *   RH_CLIENT_ID=https://<public-https-url-of-the-cimd-document> \
 *   RH_REDIRECT_URI=https://<a redirect_uri the document declares> \
 *   RH_SESSION_TOKEN=<dashboard JWT> \
 *   node backend/scripts/test-c6-oauth-flow.js
 */
const crypto = require('crypto');

const BOARD = (process.env.RH_BOARD || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.RH_CLIENT_ID || '';
const REDIRECT_URI = process.env.RH_REDIRECT_URI || '';
const SESSION_TOKEN = process.env.RH_SESSION_TOKEN || '';
// `principals:read` is not decoration: the bootstrap call compiles the SESSION
// brief, which is a principals-plane read, and without a bootstrap record every
// work-plane tool is refused. A Tier-B client that omits it can read but can
// never write. docs/oauth.md says so; this default proves it.
const SCOPES = process.env.RH_SCOPES
  || 'principals:read tasks:read tasks:write reports:read';

if (!BOARD || !CLIENT_ID || !REDIRECT_URI || !SESSION_TOKEN) {
  console.error('RH_BOARD, RH_CLIENT_ID, RH_REDIRECT_URI and RH_SESSION_TOKEN are all required');
  process.exit(2);
}

let failures = 0;
let step = 0;

function check(label, condition, detail) {
  step += 1;
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`${mark}  ${String(step).padStart(2, '0')}  ${label}${detail ? `\n            ${detail}` : ''}`);
}

async function call(method, url, { headers = {}, body, form, json, redirect = 'manual' } = {}) {
  const init = { method, headers: { ...headers }, redirect };
  if (form) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: Date.now(), method, params });

async function mcp(token, payload) {
  return call('POST', `${BOARD}/mcp`, {
    headers: {
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    json: payload,
  });
}

/**
 * The text of a tools/call result.
 *
 * MCP CARRIES TOOL FAILURES INSIDE A 200. An earlier version of this drill
 * asserted `status === 200 && !body.error` and reported PASS while the board
 * was answering "relayhall_brief_compile failed (HTTP 403)" and "bootstrap
 * first" in the content block. That is a false green of exactly the kind this
 * programme keeps rejecting, so every MCP assertion below goes through
 * `toolText` and `toolSucceeded` instead of through the HTTP status.
 */
function toolText(response) {
  const content = response.body && response.body.result && response.body.result.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  return String(content[0].text ?? '');
}

/** A tools/call result, unwrapped and parsed when it is JSON. */
function toolPayload(response) {
  const text = toolText(response);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** The refusal shapes the board answers with inside a 200. */
const TOOL_REFUSAL_MARKERS = [
  'failed (HTTP',          // a board route refused: 401/403/404/409...
  'bootstrap first',       // the fail-closed bootstrap gate
  'is not authorized',     // the shared authorization predicate
];

function toolSucceeded(response) {
  if (response.status !== 200) return false;
  if (response.body && response.body.error) return false;
  if (response.body && response.body.result && response.body.result.isError) return false;
  const text = toolText(response);
  return !TOOL_REFUSAL_MARKERS.some((marker) => text.includes(marker));
}

(async () => {
  console.log(`\nRH-P3.C6 Tier-B drill against ${BOARD}\n`);

  // ── 1 · discovery, walked the way a client walks it ────────────────────────
  const challenge = await mcp(null, rpc('tools/list'));
  check('anonymous MCP call answers 401', challenge.status === 401);
  const header = challenge.headers.get('www-authenticate') || '';
  const pointer = /resource_metadata="([^"]+)"/.exec(header);
  check('the 401 challenge names protected-resource metadata', pointer !== null, header);
  if (!pointer) process.exit(1);

  const prm = await call('GET', pointer[1]);
  check('that protected-resource document is served', prm.status === 200, pointer[1]);
  check('it names this board MCP endpoint as the resource',
    prm.body && prm.body.resource === `${BOARD}/mcp`,
    prm.body && prm.body.resource);
  const issuer = prm.body && prm.body.authorization_servers && prm.body.authorization_servers[0];
  check('it names an authorization server', Boolean(issuer), String(issuer));

  const asMeta = await call('GET', `${issuer}/.well-known/oauth-authorization-server`);
  check('the authorization server metadata is served', asMeta.status === 200);
  check('it advertises authorization_code + S256 and no registration endpoint',
    asMeta.body
      && JSON.stringify(asMeta.body.grant_types_supported) === JSON.stringify(['authorization_code'])
      && JSON.stringify(asMeta.body.code_challenge_methods_supported) === JSON.stringify(['S256'])
      && asMeta.body.registration_endpoint === undefined
      && asMeta.body.client_id_metadata_document_supported === true,
    JSON.stringify(asMeta.body && asMeta.body.grant_types_supported));

  // ── 2-3 · authorize with a real CIMD client and real PKCE ─────────────────
  const verifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const authorizeUrl = `${asMeta.body.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: `${BOARD}/mcp`,
  })}`;
  const authorize = await call('GET', authorizeUrl);
  check('/authorize fetched the CIMD document and parked the request (302 to consent)',
    authorize.status === 302, `${authorize.status} ${authorize.headers.get('location') || authorize.text.slice(0, 200)}`);
  if (authorize.status !== 302) process.exit(1);
  const consentLocation = authorize.headers.get('location') || '';
  const requestId = new URL(consentLocation, BOARD).searchParams.get('request_id');
  check('the consent redirect carries a request id', Boolean(requestId), consentLocation);

  // The open-redirect control, on the live surface: an unfetchable client_id
  // must never produce a redirect to the caller-supplied redirect_uri.
  const hostile = await call('GET', `${asMeta.body.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: 'https://127.0.0.1/c.json',
    redirect_uri: 'https://attacker.example/steal',
    scope: 'tasks:read',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })}`);
  check('an unresolvable client_id is refused WITHOUT redirecting to the caller URI',
    hostile.status === 400 && !hostile.headers.get('location'),
    `${hostile.status} ${hostile.headers.get('location') || ''}`);

  // ── 4 · the consent decision is a signed-in act ───────────────────────────
  const anonymousView = await call('GET', `${BOARD}/oauth/authorization-requests/${requestId}`);
  check('an unauthenticated caller cannot read the pending consent', anonymousView.status === 401);

  const view = await call('GET', `${BOARD}/oauth/authorization-requests/${requestId}`, {
    headers: { authorization: `Bearer ${SESSION_TOKEN}` },
  });
  check('the signed-in person can read it', view.status === 200, view.text.slice(0, 200));
  check('it shows the client and the scopes asked for',
    view.body && view.body.clientId === CLIENT_ID
      && Array.isArray(view.body.grantableScopes) && view.body.grantableScopes.length > 0,
    JSON.stringify(view.body && view.body.grantableScopes));

  const decision = await call('POST', `${BOARD}/oauth/authorization-requests/${requestId}/decision`, {
    headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    json: { approve: true, grantedScopes: view.body.grantableScopes },
  });
  check('the decision is recorded and returns the client redirect', decision.status === 200,
    decision.text.slice(0, 200));
  const back = new URL(decision.body.redirectTo);
  check('the redirect carries the code and the client own state',
    Boolean(back.searchParams.get('code')) && back.searchParams.get('state') === state);
  check('the redirect goes to the URI the client document declared',
    `${back.origin}${back.pathname}` === REDIRECT_URI.replace(/\?.*$/, ''),
    back.toString());
  const code = back.searchParams.get('code');

  // ── 5 · the code exchanges exactly once ──────────────────────────────────
  //
  // The FIRST authorization is spent proving the two refusals, because this
  // server consumes a code on ANY exchange attempt, not only a successful one
  // — so a wrong verifier and a replay cannot be demonstrated on a code that
  // still has to work afterwards.
  const wrongVerifier = await call('POST', asMeta.body.token_endpoint, {
    form: {
      grant_type: 'authorization_code', code, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: crypto.randomBytes(32).toString('base64url'),
    },
  });
  check('a wrong PKCE verifier is refused', wrongVerifier.status === 400
    && wrongVerifier.body && wrongVerifier.body.error === 'invalid_grant',
    wrongVerifier.text.slice(0, 160));

  const afterWrongVerifier = await call('POST', asMeta.body.token_endpoint, {
    form: {
      grant_type: 'authorization_code', code, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: verifier,
    },
  });
  check('that attempt BURNED the code — even the RIGHT verifier now fails',
    afterWrongVerifier.status === 400 && afterWrongVerifier.body
      && afterWrongVerifier.body.error === 'invalid_grant',
    afterWrongVerifier.text.slice(0, 160));

  // A SECOND authorization, for the code that will actually be exchanged.
  const verifier2 = crypto.randomBytes(32).toString('base64url');
  const challenge2 = crypto.createHash('sha256').update(verifier2, 'ascii').digest('base64url');
  const state2 = crypto.randomBytes(16).toString('hex');
  const authorize2 = await call('GET', `${asMeta.body.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: SCOPES, state: state2, code_challenge: challenge2, code_challenge_method: 'S256',
  })}`);
  const requestId2 = new URL(authorize2.headers.get('location'), BOARD).searchParams.get('request_id');
  const view2 = await call('GET', `${BOARD}/oauth/authorization-requests/${requestId2}`, {
    headers: { authorization: `Bearer ${SESSION_TOKEN}` },
  });
  const decision2 = await call('POST', `${BOARD}/oauth/authorization-requests/${requestId2}/decision`, {
    headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    json: { approve: true, grantedScopes: view2.body.grantableScopes },
  });
  const code2 = new URL(decision2.body.redirectTo).searchParams.get('code');

  const token = await call('POST', asMeta.body.token_endpoint, {
    form: {
      grant_type: 'authorization_code', code: code2, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: verifier2,
    },
  });
  check('the code exchanges for an access token', token.status === 200 && token.body
    && typeof token.body.access_token === 'string', token.text.slice(0, 200));
  check('the token is an opaque rh_ reference credential, not a JWT',
    token.body.access_token.startsWith('rh_') && token.body.access_token.split('.').length === 2,
    `${token.body.access_token.slice(0, 12)}…`);
  check('the response carries token_type, expires_in and the granted scope',
    token.body.token_type === 'Bearer' && Number(token.body.expires_in) > 0
      && typeof token.body.scope === 'string', JSON.stringify({
        token_type: token.body.token_type, expires_in: token.body.expires_in, scope: token.body.scope,
      }));

  const replay = await call('POST', asMeta.body.token_endpoint, {
    form: {
      grant_type: 'authorization_code', code: code2, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: verifier2,
    },
  });
  check('replaying the same code is refused (one-time use)',
    replay.status === 400 && replay.body && replay.body.error === 'invalid_grant',
    replay.text.slice(0, 160));

  const accessToken = token.body.access_token;

  // ── 6 · a real MCP read and a real MCP write ─────────────────────────────
  const bootstrap = await mcp(accessToken, rpc('tools/call', {
    name: 'relayhall_brief_compile', arguments: { session: true },
  }));
  check('the token bootstraps the MCP session',
    toolSucceeded(bootstrap) && toolText(bootstrap).startsWith('Bootstrapped.'),
    toolText(bootstrap).slice(0, 220) || bootstrap.text.slice(0, 220));

  // A WRITE FIRST, so the read that follows has something this token is
  // genuinely authorized to see. A brand-new Connector holds no object grants
  // — correctly — so "the list came back empty" would prove nothing about
  // whether reads work; an object the token created is one it owns.
  const title = `C6 Tier-B drill ${new Date().toISOString()}`;
  const write = await mcp(accessToken, rpc('tools/call', {
    name: 'relayhall_task_create',
    arguments: { title, description: 'Created by the RH-P3.C6 Tier-B drill.', status: 'ideas' },
  }));
  // `relayhall_task_create` answers in prose and prints the full id on its
  // own line; that line is the contract this reads.
  const createdId = (/full id: ([0-9a-f-]{36})/.exec(toolText(write)) || [])[1];
  check('the token performs a real MCP WRITE',
    toolSucceeded(write) && Boolean(createdId),
    toolText(write).slice(0, 300) || write.text.slice(0, 300));
  if (createdId) console.log(`            created task ${createdId}`);

  const read = await mcp(accessToken, rpc('tools/call', {
    name: 'relayhall_task_get',
    arguments: { task: createdId, response_format: 'detailed' },
  }));
  const fetched = toolPayload(read);
  const fetchedTask = fetched && (fetched.task || fetched);
  check('the token performs a real MCP READ of what it just wrote',
    toolSucceeded(read) && fetchedTask && fetchedTask.id === createdId
      && fetchedTask.title === title,
    toolText(read).slice(0, 300) || read.text.slice(0, 300));

  // The control the two above need: the SAME assertion must go red on a call
  // the board refuses. Without it, `toolSucceeded` could be returning true for
  // everything — which is precisely the bug this control replaces.
  const refused = await mcp(accessToken, rpc('tools/call', {
    name: 'relayhall_task_get',
    arguments: { task: '00000000-0000-0000-0000-000000000000' },
  }));
  check('a refusal the board answers INSIDE a 200 is seen as a failure',
    refused.status === 200 && !toolSucceeded(refused),
    `${refused.status} ${toolText(refused).slice(0, 160)}`);

  // ── 7 · the audience restriction, observed ──────────────────────────────
  const rest = await call('GET', `${BOARD}/tasks?limit=1`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  check('the same token is REFUSED on a REST route (TRANSPORT_MISMATCH)',
    rest.status === 403 && rest.body && rest.body.code === 'TRANSPORT_MISMATCH',
    `${rest.status} ${rest.text.slice(0, 160)}`);

  // ── 8 · revoke, then the VERY NEXT call ─────────────────────────────────
  const revoke = await call('POST', asMeta.body.revocation_endpoint, { form: { token: accessToken } });
  check('revocation answers 200 (RFC 7009)', revoke.status === 200);

  const afterRevoke = await mcp(accessToken, rpc('tools/call', {
    name: 'relayhall_task_get', arguments: { task: createdId },
  }));
  check('THE VERY NEXT MCP CALL IS REFUSED (ruling TS-12: per-call lookup)',
    afterRevoke.status === 401, `${afterRevoke.status} ${afterRevoke.text.slice(0, 160)}`);

  const revokeAgain = await call('POST', asMeta.body.revocation_endpoint, { form: { token: accessToken } });
  check('revocation is idempotent', revokeAgain.status === 200);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}  (${step} checks)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\nDRILL ABORTED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
