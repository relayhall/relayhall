/**
 * c2-live-probe.mjs — RH-P3.C2 live evidence on DEV (real Postgres, real
 * server, real delivery over the wire).
 *
 * The unit suites mock the pool, so everything schema-shaped — the 101 CHECKs,
 * the auto_start default, the ON CONFLICT claim, the advisory-lock cursor
 * ordering — is only ever really exercised here and in
 * qa/c2-readiness-matrix.sql (which owns the readiness truth table and the
 * work-plane due-set, over real rows).
 *
 * ── After owner ruling ccd53781 ──
 *
 * A subscription carries event-class filters and NO URL: the endpoint, the
 * mode and the SIGNING SECRET are the subscriber Connector's registry data,
 * set through the root-gated owner-plane subroute. Go signals are not
 * observable — `task.ready` is delivered per-assignee by the work plane. What
 * this probe proves live is the OBSERVATION plane end to end, plus the two
 * refusals that are cheapest to get wrong at the API surface.
 *
 * DEV ONLY. The base URL is checked against an enumerated allowlist rather
 * than a denylist: the A8 seeder's /28082|tst|prod/ denylist let canonical
 * PROD through because no token matched, and reviewers reject that on sight.
 */
import crypto from 'node:crypto';
import http from 'node:http';

const BASE = process.env.RH_BASE;
// A POSITIVE allowlist, supplied by the caller. Positive because the A8
// seeder's denylist let canonical PROD through — no token in /28082|tst|prod/
// matched it — and no estate topology is hard-coded here because this file is
// inside the publication tree.
const ALLOWED_DEV_ORIGINS = new Set(
  String(process.env.RH_DEV_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
);
if (!BASE || ALLOWED_DEV_ORIGINS.size === 0) {
  console.error('RH_BASE and RH_DEV_ORIGINS are both required (RH_DEV_ORIGINS is a comma-separated allowlist of permitted DEV origins)');
  process.exit(2);
}
if (!ALLOWED_DEV_ORIGINS.has(BASE)) {
  console.error(`REFUSED: ${BASE} is not an enumerated DEV origin`);
  process.exit(2);
}
// The callback host the deployment must use to reach this probe's listener.
// It is NOT 'localhost': the server under test runs in a container, where a
// loopback URL resolves to the container's own loopback and never arrives.
const CALLBACK_HOST = process.env.RH_CALLBACK_HOST;
if (!CALLBACK_HOST) {
  console.error('RH_CALLBACK_HOST is required — the address the deployment can reach this probe on');
  process.exit(2);
}
const PW = process.env.RH_DASH_PW;
if (!PW) { console.error('RH_DASH_PW required'); process.exit(2); }

const results = [];
let token = null;

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, init = {}) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();

/**
 * The current head of the feed. `?limit=1` answers with the cursor of the
 * FIRST row, not the last, so the head has to be paged to.
 */
async function feedHead() {
  let cursor = '0';
  for (let i = 0; i < 200; i++) {
    const page = await api(`/api/events?cursor=${cursor}&limit=500`);
    const next = String(page.body?.nextCursor ?? cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return cursor;
}

/** Every event after `cursor`, paged to the end. */
async function collectSince(cursor) {
  const all = [];
  let at = String(cursor);
  for (let i = 0; i < 200; i++) {
    const page = await api(`/api/events?cursor=${at}&limit=500`);
    const events = page.body?.events ?? [];
    all.push(...events);
    const next = String(page.body?.nextCursor ?? at);
    if (next === at) break;
    at = next;
  }
  return all;
}

// ── login ────────────────────────────────────────────────────────────────
{
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
  token = login.body?.token;
  check('login to DEV', Boolean(token));
  if (!token) process.exit(1);
}

// ── 1 · born parked at the SCHEMA level ──────────────────────────────────
// The application layer already resolved a missing autoStart to FALSE; what
// 101 adds is the COLUMN default, for insert paths that never traverse it.
let parkedTaskId = null;
{
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: `c2 probe parked ${stamp}`, description: 'c2 live probe' }),
  });
  const task = created.body?.task || created.body;
  parkedTaskId = task?.id;
  check('a task created without autoStart is born PARKED', task?.autoStart === false,
    `autoStart=${task?.autoStart}`);
}

// ── 2 · arming enforcement: an unarmed task refuses the claim ────────────
{
  const claim = await api(`/api/tasks/${parkedTaskId}/claim`, { method: 'POST', body: JSON.stringify({}) });
  const text = JSON.stringify(claim.body ?? {});
  check('claiming an UNARMED task is refused',
    claim.status >= 400 || /unarmed|AUTO_START_DISABLED/i.test(text),
    `status=${claim.status} body=${text.slice(0, 160)}`);
}

// ── 3 · task.ready requires ASSIGNMENT (ruling ccd53781 R2 / review r2 B7) ──
//
// This block used to assert the OPPOSITE: it created an armed child with no
// assignment and expected `task.ready` when its parent completed. The
// reviewer cited these very lines as the reason the Jest matrix and the live
// QA both missed B7. It is now the live control for the ruled contract — an
// unassigned task never rings anyone's doorbell, however ready it looks.
let parentId = null; let childId = null;
{
  const cursorBefore = await feedHead();

  const parent = await api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: `c2 probe parent ${stamp}`, description: 'parent' }),
  });
  parentId = (parent.body?.task || parent.body)?.id;

  const child = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `c2 probe child ${stamp}`, description: 'child', autoStart: true,
      dependsOn: [parentId],
    }),
  });
  childId = (child.body?.task || child.body)?.id;
  check('probe fixture created', Boolean(parentId && childId), `parent=${parentId} child=${childId}`);

  async function readyEventsFor(taskId, after) {
    const events = await collectSince(after);
    return events.filter((e) => e.name === 'task.ready' && e.objectId === taskId);
  }

  // Armed, but its dependency is unmet: readiness must NOT be announced.
  await sleep(500);
  const premature = await readyEventsFor(childId, cursorBefore);
  check('an ARMED task with an unmet dependency is NOT announced ready',
    premature.length === 0, `found ${premature.length}`);

  // Completing the parent removes the LAST obstacle other than assignment.
  // Under the pre-ruling three-clause predicate this announced immediately.
  const completion = await api(`/api/tasks/${parentId}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'completed' }),
  });
  check('the parent actually completed', completion.status === 200,
    `status=${completion.status}`);
  await sleep(2000);

  const announced = await readyEventsFor(childId, cursorBefore);
  check('an UNASSIGNED task is NOT announced ready, however satisfied it is (R2/B7)',
    announced.length === 0,
    `armed + todo + dependency-satisfied + unassigned -> ${announced.length} task.ready event(s)`);

  // Nothing to re-announce, and nothing that could be re-announced later: the
  // announcement bookkeeping must not have claimed a row for this task.
  const cursorAfterReady = await feedHead();
  await api(`/api/tasks/${childId}`, { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) });
  await sleep(1000);
  const repeat = await readyEventsFor(childId, cursorAfterReady);
  check('an unassigned task stays silent across later updates', repeat.length === 0,
    `found ${repeat.length}`);
}

// ── 4 · delivery: causation suppression, then a real signed delivery ─────
{
  const principals = await api('/api/principals?limit=200');
  const rows = principals.body?.principals || principals.body?.rows || [];
  // The probe authenticates as the dashboard user, so that principal IS the
  // writer for every event it generates.
  const self = rows.find((p) => p.handle === 'dashboard_user');
  const selfPrincipalId = self?.id ?? null;
  check('the writing principal is identified', Boolean(selfPrincipalId), String(selfPrincipalId));

  // A subscription names a registered CONNECTOR and the live credential it
  // delivers as: authority comes from that credential's own scopes, exactly
  // as a real request's does (review r1, B2).
  //
  // The probe BUILDS that Connector rather than discovering one. An earlier
  // cut offered every existing principal to the real route and took the first
  // it accepted, which made the run depend on estate CONTENT: against a DEV
  // database carrying no Connector at all it reported three failures that
  // were about the fixture and not about the candidate. Building its own also
  // means the probe never reconfigures — and never has to restore — a
  // registration somebody else owns.
  const connectorSlug = `c2-probe-${stamp}`.slice(0, 63);
  const registration = await api('/api/services', {
    method: 'POST',
    body: JSON.stringify({
      slug: connectorSlug, name: 'C2 live probe connector', kind: 'connector',
      issueCredential: { scopes: ['tasks:read'], label: 'c2 live probe' },
    }),
  });
  const credentialId = registration.body?.onboarding?.credential?.credentialId ?? null;
  let registryService = registration.body?.service ?? null;
  let other = null;
  if (registryService) {
    // Migration 097 pairs a Connector registration with a principal handled
    // `connector-<slug>`; /api/services does not project the link, so the
    // handle is how the probe finds it. The PARENT is carried too: a
    // delegated Connector with `{"objects": "parent"}` takes its object
    // authority from its Account (4d961e37 §5).
    const principalsAfter = await api('/api/principals?limit=300');
    const afterRows = principalsAfter.body?.principals || principalsAfter.body?.rows || [];
    const connectorPrincipal = afterRows.find((p) => p.handle === `connector-${connectorSlug}`);
    if (connectorPrincipal) {
      other = {
        id: connectorPrincipal.id,
        handle: connectorPrincipal.handle,
        parentPrincipalId: connectorPrincipal.parentPrincipalId
          ?? connectorPrincipal.parent_principal_id ?? null,
      };
    }
  }
  check('a Connector is registered with a live tasks:read credential',
    Boolean(other && credentialId && registryService),
    other ? `${other.handle} cred=${String(credentialId).slice(0, 8)}`
          : `status=${registration.status} code=${registration.body?.code}`);

  // Only a PUBLISHED Connector is delivered to, and publication needs a
  // capability descriptor first — the real registration sequence.
  if (registryService) {
    const descriptor = await api(`/api/services/${registryService.id}/descriptor`, {
      method: 'PUT',
      headers: { 'If-Match': String(registryService.revision) },
      body: JSON.stringify({ descriptor: { options: [] } }),
    });
    const afterDescriptor = await api('/api/services');
    const descriptorRow = (afterDescriptor.body?.services || [])
      .find((sv) => sv.id === registryService.id);
    const published = await api(`/api/services/${registryService.id}`, {
      method: 'PATCH',
      headers: { 'If-Match': String(descriptorRow?.revision) },
      body: JSON.stringify({ status: 'published' }),
    });
    if (published.body?.service) registryService = published.body.service;
    check('the Connector is published and therefore deliverable',
      registryService?.status === 'published',
      `descriptor=${descriptor.status} publish=${published.status} status=${registryService?.status}`);
  } else {
    check('the Connector is published and therefore deliverable', false, 'no registration');
  }

  /**
   * The owner-plane subroute is revision-guarded (If-Match), and the revision
   * moves with every write, so it is re-read immediately before each PATCH
   * rather than cached.
   */
  async function setDeliveryMode(mode, endpoint, secret) {
    const current = await api('/api/services');
    const row = (current.body?.services || []).find((sv) => sv.id === registryService.id);
    if (!row) return { status: 404, body: { error: 'registry row vanished' } };
    return api(`/api/services/${registryService.id}/owner-plane`, {
      method: 'PATCH',
      headers: { 'If-Match': String(row.revision) },
      body: JSON.stringify({
        deliveryMode: mode,
        deliveryEndpoint: endpoint ?? null,
        // Ruling ccd53781 R1: one endpoint, one secret, both registry data.
        // Unsigned webhook delivery is not representable (101 CHECK).
        ...(mode === 'webhook' ? { deliverySecret: secret } : {}),
        // `poll` is only valid with an interval (migration 076 CHECK: >= 30s).
        ...(mode === 'poll' ? { deliveryPollIntervalSeconds: 60 } : {}),
      }),
    });
  }

  async function withListener(run) {
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200); res.end('{}');
      });
    });
    // Bind on all interfaces and address the listener by the VM's LAN IP:
    // the backend runs INSIDE a container, so a 127.0.0.1 URL would resolve to
    // the container's own loopback and never reach this process. (The first
    // run of this probe reported 'no delivery arrived' for exactly that
    // reason, while the worker was in fact attempting delivery correctly.)
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    try {
      await run(server.address().port, received);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // ── refusals, live against the real CHECK and route ──
  await withListener(async (port) => {
    // R1, at the surface where it is easiest to violate: a subscription may
    // not name an endpoint of its own. The live route must refuse the field
    // outright, not merely ignore it — an ignored url would look accepted.
    const withUrl = await api('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: `http://${CALLBACK_HOST}:${port}/x`,
        subscriberPrincipalId: selfPrincipalId, subscriberCredentialId: credentialId,
        events: ['task.created'],
      }),
    });
    check('a subscription may not carry its own url (ruling ccd53781 R1)',
      withUrl.status === 400, `status=${withUrl.status} code=${withUrl.body?.code}`);

    const withSecret = await api('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        secret: 'abc',
        subscriberPrincipalId: selfPrincipalId, subscriberCredentialId: credentialId,
        events: ['task.created'],
      }),
    });
    check('a subscription may not carry its own signing secret',
      withSecret.status === 400, `status=${withSecret.status} code=${withSecret.body?.code}`);

    // R1: go signals belong to the work plane and are delivered per assignee.
    const goSignal = await api('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        subscriberPrincipalId: selfPrincipalId, subscriberCredentialId: credentialId,
        events: ['task.created', 'task.ready'],
      }),
    });
    check('a go signal cannot be registered as an observation',
      goSignal.status === 400 && goSignal.body?.code === 'GO_SIGNAL_NOT_OBSERVABLE',
      `status=${goSignal.status} code=${goSignal.body?.code}`);

    const unattributed = await api('/api/webhooks', {
      method: 'POST', body: JSON.stringify({ events: ['task.created'] }),
    });
    check('an ACTIVE subscription without a subscriber is refused live',
      unattributed.status === 400 && unattributed.body?.code === 'SUBSCRIPTION_UNATTRIBUTED',
      `status=${unattributed.status} code=${unattributed.body?.code}`);

    const retired = await api('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        subscriberPrincipalId: selfPrincipalId,
        subscriberCredentialId: credentialId, events: ['skill.version.published'],
      }),
    });
    check('a retired pre-C2 event name is no longer registrable',
      retired.status === 400 && retired.body?.code === 'UNKNOWN_EVENT',
      `status=${retired.status} code=${retired.body?.code}`);
  });

  // ── A · causation: a subscriber is not told about its OWN writes ─────────
  await withListener(async (port, received) => {
    const created = await api('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        subscriberPrincipalId: selfPrincipalId,
        subscriberCredentialId: credentialId,
        events: ['task.created', 'task.updated'],
        description: `c2 probe causation ${stamp}`,
      }),
    });
    // The dashboard user is an ACCOUNT. Accounts hold no bearer credentials
    // (4d961e37 A17.1), so there is no pull authority for a delivery to
    // mirror and the subscription must be refused outright — the repair for
    // review r1 B2, asserted live.
    check('an Account cannot be a subscription subscriber',
      created.status === 400 && created.body?.code === 'INVALID_SUBSCRIBER',
      `status=${created.status} code=${created.body?.code}`);
    const subId = created.body?.webhook?.id;
    if (subId) await api(`/api/webhooks/${subId}`, { method: 'DELETE' });
  });

  // ── B · a real signed delivery to a DIFFERENT principal ─────────────────
  if (other) {
    await withListener(async (port, received) => {
      // The signing secret is REGISTRY data now (ruling ccd53781 R1): the
      // probe sets it on the Connector's owner-plane row and verifies the
      // received signature against it.
      const secret = crypto.randomBytes(24).toString('hex');
      const issuedGrantIds = [];
      const subject = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: `c2 probe delivery ${stamp}`, description: 'delivery subject' }),
      });
      const subjectId = (subject.body?.task || subject.body)?.id;

      // The subscriber must be able to PULL this task, or delivering it would
      // be the very leak this candidate exists to prevent.
      //
      // A delegated Connector with `{"objects": "parent"}` takes its object
      // authority from its parent Account (4d961e37 §5), so the grant has to
      // reach the parent as well — granting only to the child leaves the
      // Connector unable to read it, and the worker correctly delivers
      // nothing.
      const grantees = [other.id];
      const parentId = other.parentPrincipalId;
      if (parentId) grantees.push(parentId);
      let granted = 0;
      for (const grantee of grantees) {
        const grant = await api('/api/grants', {
          method: 'POST',
          body: JSON.stringify({
            granteeType: 'principal', granteeId: grantee,
            resourceType: 'task', resourceId: subjectId, verb: 'read',
          }),
        });
        if (grant.status < 400) {
          granted += 1;
          // Tracked so the probe can revoke it. The Connector is retired at
          // the end, but its owning ACCOUNT is the caller's own principal and
          // outlives the run — a grant left there accumulates on a shared
          // identity every time this probe is executed.
          if (grant.body?.grant?.id) issuedGrantIds.push(grant.body.grant.id);
        }
      }
      check('a read grant is issued along the subscriber chain', granted === grantees.length,
        `${granted}/${grantees.length} grants (parent=${parentId ? 'yes' : 'none exposed'})`);

      const created = await api('/api/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          subscriberPrincipalId: other.id,
          subscriberCredentialId: credentialId,
          // No go signal: this is the OBSERVATION plane (ruling R1).
          events: ['task.created', 'task.updated'],
          description: `c2 probe delivery ${stamp}`,
        }),
      });
      const subId = created.body?.webhook?.id;
      check('a subscription for a DISTINCT principal is created', Boolean(subId), `status=${created.status}`);
      if (!subId) return;

      // ── B1 · the registry gates the push, live across all three modes ──
      // A Connector registered `none` or `poll` must NOT be pushed to; only
      // `webhook` delivers, and the registry endpoint is the address of record.
      if (registryService) {
        for (const withheld of ['none', 'poll']) {
          const set = await setDeliveryMode(withheld, `http://${CALLBACK_HOST}:${port}/hook`, secret);
          check(`the Connector registry accepts deliveryMode=${withheld}`, set.status < 400,
            `status=${set.status}`);
          await api(`/api/tasks/${subjectId}`, {
            method: 'PATCH', body: JSON.stringify({ priority: 'low' }),
          });
          await sleep(14000);
          check(`a Connector registered ${withheld} is NOT pushed to`,
            received.length === 0, `received ${received.length}`);
        }
        const armed = await setDeliveryMode('webhook', `http://${CALLBACK_HOST}:${port}/hook`, secret);
        check('the Connector registry accepts deliveryMode=webhook', armed.status < 400,
          `status=${armed.status}`);
      }

      // Touch the granted task so an event exists that this subscriber may see.
      await api(`/api/tasks/${subjectId}`, {
        method: 'PATCH', body: JSON.stringify({ priority: 'high' }),
      });

      // Withholding parks next_attempt_at a full rate window ahead, so the
      // wait after arming has to outlast that hold. This is the worker's own
      // backoff behaving as designed, not latency.
      for (let i = 0; i < 50 && received.length === 0; i++) await sleep(2500);
      check('a delivery arrived over the wire once the registry says webhook',
        received.length > 0, `received ${received.length}`);

      if (received.length) {
        const { headers, raw } = received[0];
        const parsed = JSON.parse(raw);

        const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
        check('the HMAC signature verifies over the exact received bytes',
          headers['x-relayhall-signature'] === expected,
          `header=${String(headers['x-relayhall-signature']).slice(0, 24)}...`);

        check('the delivery declares its PLANE in the signed body and the headers',
          parsed.plane === 'observation' && headers['x-relayhall-plane'] === 'observation',
          `body=${parsed.plane} header=${headers['x-relayhall-plane']}`);

        check('the cursor header is present and decimal',
          /^\d+$/.test(String(headers['x-relayhall-cursor'] ?? '')),
          String(headers['x-relayhall-cursor']));

        const keys = Object.keys(parsed.events?.[0] ?? {}).sort();
        check('the delivered event is ID-only',
          JSON.stringify(keys) === JSON.stringify(['cursor', 'name', 'objectId', 'objectType', 'occurredAt']),
          JSON.stringify(keys));

        const leaked = ['title', 'status', 'priority', 'project', 'tags', 'description']
          .filter((field) => raw.includes(`"${field}"`));
        check('no content-bearing field appears anywhere in the body',
          leaked.length === 0, leaked.join(',') || 'none');

        // Grant scoping, live: the subscriber holds read on exactly ONE task,
        // so nothing about any other object may appear in the batch.
        const foreign = (parsed.events || []).filter((e) => e.objectId !== subjectId);
        check('grant scoping holds — only the granted object is delivered',
          foreign.length === 0, `foreign=${foreign.length}`);

        const listing = await api('/api/webhooks');
        const mine = (listing.body?.webhooks || []).find((w) => w.id === subId);
        check('the delivery cursor advanced and is readable for reconciliation',
          mine && /^\d+$/.test(String(mine.deliveryCursor)) && Number(mine.deliveryCursor) > 0,
          `deliveryCursor=${mine?.deliveryCursor}`);
        check('the listing never exposes the signing secret',
          !JSON.stringify(listing.body).includes(secret));
        const services = await api('/api/services');
        check('the registry never returns the delivery secret either',
          !JSON.stringify(services.body).includes(secret));
      }
      await api(`/api/webhooks/${subId}`, { method: 'DELETE' });
      let revoked = 0;
      for (const grantId of issuedGrantIds) {
        const gone = await api(`/api/grants/${grantId}`, { method: 'DELETE' });
        if (gone.status < 400) revoked += 1;
      }
      check('every grant the probe issued is revoked',
        revoked === issuedGrantIds.length, `${revoked}/${issuedGrantIds.length}`);
      if (registryService) {
        // The probe built this Connector, so it retires it rather than
        // restoring a registration it never owned — and no secret has to be
        // rotated to put the estate back. Delivery is stood down first: a
        // webhook-mode row may not lose its signing secret (101 CHECK).
        await setDeliveryMode('none', null, undefined);
        const current = await api('/api/services');
        const row = (current.body?.services || []).find((sv) => sv.id === registryService.id);
        const retired = await api(`/api/services/${registryService.id}/retire`, {
          method: 'POST',
          headers: { 'If-Match': String(row?.revision) },
          body: JSON.stringify({}),
        });
        check('the probe Connector is retired, leaving the estate as it was found',
          retired.status < 400, `status=${retired.status}`);
      }
    });
  }
}

// ── summary ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
}
console.log('\nJSON ' + JSON.stringify({ results }, null, 0));
process.exit(failed.length ? 1 : 0);
