#!/usr/bin/env node
/**
 * setgov-live-drill — the SETGOV candidate A drills, against a REAL migrated
 * PostgreSQL and a REAL server process, over the HTTP seam.
 *
 * SETGOV candidate A (card `bbec04de`); acceptance annex `85a2218d` D1, D2
 * (i)(ii)(iii)(v)(vi)(vii), D3, D6, D10, D13, D15, D16, D17, D19, and D21 as
 * RESCOPED by owner ruling `70af4d82` on escalation `94c77997`.
 *
 * WHY THIS FILE EXISTS BESIDE THE JEST SUITE.
 *
 * `backend/src/__tests__/accessSurfaces.test.ts` drives the census, the
 * resolver and the arm's SQL shape with a MOCK pool. A mock fails only as it is
 * told to, so it cannot decide whether the evaluator really ignores a wildcard
 * surface row, whether a bearer credential really cannot widen a core surface,
 * or whether a boot really refuses an overlapping catalogue. Those are
 * properties of a running process against real rows, and this is where they are
 * measured. Every verdict is delegated to `setgov-drill-oracles.mjs`, whose own
 * controls (`node --test setgov-drill-oracles.test.mjs`) are handed the exact
 * bad states these drills produce.
 *
 * Environment. NOTHING is defaulted to a live deployment:
 *   DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD  a DISPOSABLE database
 *   DRILL_FIXTURES   the manifest from `environments/dev-setgov-fixtures`
 *   DRILL_PORT       a free port for the drill's own server (default 3996)
 *   RELAYHALL_REPO   product checkout (default: the repo this file sits in)
 *
 * THE DATABASE IS MUTATED DESTRUCTIVELY — surfaces are truncated, governance
 * classes flipped, hostile rows inserted. Point it at a disposable database
 * only. It refuses the names that are not disposable.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORITY_MUTATION_SURFACE_KEYS,
  D6_CALLER_STATES,
  armRecordExcludes,
  authorityMutationArmNeverAdmits,
  authorityMutationSurfacesUnbundled,
  authorityMutationWritesRefused,
  bearerNeverWidensCore,
  bootAccepted,
  bootRefused,
  canonicalPath,
  capturesIdentical,
  levelAnswers,
  decisionOf,
  d6Verdict,
  escalationCaptureRefused,
  governableCatalogueIsPartitioned,
  RATIFIED_ESCALATION_ACTS,
  exactlyOneDecisionMoved,
  pluginBearerNarrowsOnly,
  refusalsAudited,
  surfaceStageShape,
  tookEffectImmediately,
} from './setgov-drill-oracles.mjs';
import {
  CANONICAL_PATH_CORPUS,
  D21_WRITE_STORES,
  buildD6Census,
  buildD17Census,
  buildD21WriteCensus,
  buildLockedCensus,
  d17ControlUrls,
  declaredFamilies,
  familiesAbsentFromRegistry,
  familiesOfClass,
  levelResolverFromMembership,
  loadProductionContract,
  ratifiedAuthorityStores,
  ratifiedBearerLayers,
  authoritySeamCompositionDrift,
  buildPluginLevelCensus,
  levelAnswersClass,
  normaliserDrift,
  parseSeededCatalogue,
} from './setgov-drill-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.RELAYHALL_REPO || path.join(HERE, '..');
const BACKEND = path.join(REPO, 'backend');
const PORT = Number(process.env.DRILL_PORT || 3996);
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'setgov-drill-secret-not-for-production-0123456789abcdef';

const FORBIDDEN_DB_NAMES = new Set(['relayhall_tst', 'relayhall_prod', 'relayhall', 'clawboard']);
if (!process.env.DB_NAME || FORBIDDEN_DB_NAMES.has(process.env.DB_NAME)) {
  console.error(`DB_NAME must name a DISPOSABLE database (got '${process.env.DB_NAME ?? '(unset)'}')`);
  process.exit(2);
}
if (!process.env.DRILL_FIXTURES) {
  console.error('DRILL_FIXTURES must point at the manifest written by environments/dev-setgov-fixtures');
  process.exit(2);
}
const FIXTURES = JSON.parse(readFileSync(process.env.DRILL_FIXTURES, 'utf8'));

const require_ = createRequire(path.join(BACKEND, 'package.json'));
const { Pool } = require_('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  max: 4,
});
const sql = (text, params) => pool.query(text, params);

// ── verdict bookkeeping ─────────────────────────────────────────────────────
/**
 * Every request this drill made that the SURFACE STAGE must have refused, as
 * the audit ledger spells it: the METHOD and `normalizePathForScope` of the
 * URL. §3.6's oracle correlates its rows against this list rather than counting
 * them, because round 1 of this candidate's review showed three unrelated rows
 * satisfying an aggregate minimum while four of five expected refusals wrote
 * nothing (regression `e776b244`).
 */
const causedRefusals = [];
/**
 * ROUND-4 REVIEW `5cfe851b` B1. An expectation used to name only a method and
 * a path, so §3.6's correlation was an AGGREGATE over every row this run wrote
 * - and the drill makes many unregistered requests EARLIER IN THE SAME RUN
 * that write matching rows (68 caused refusals against 191 in-run rows). A
 * sibling request could therefore cover a request that wrote nothing. Every
 * expectation now carries the ids of the rows ITS OWN request created, which
 * `call()` records below, and the oracle refuses a row that no request claims.
 */
const expectRefusal = (answer, method, route, contractSays = {}) => {
  // `canonicalPath` is the drill-layer copy of production's
  // `normalizePathForScope`, anchored against the compiled module by the
  // `contract (normaliser anchor)` drill below - and it is the same function
  // production writes into `metadata.path`, so a declared expectation and the
  // row it must find are spelled the same way BY CONSTRUCTION rather than by
  // two independent re-spellings that agree today.
  const ledgerEntry = REQUEST_LEDGER.find((row) => row.seq === answer?.seq);
  const entry = {
    method: method.toUpperCase(),
    path: canonicalPath(route),
    rowIds: ledgerEntry ? ledgerEntry.rowIds : null,
    // ROUND-4 EXTRA VERDICT `36e8588e` B6. An expectation used to name only a
    // method and a path, and §3.6's oracle then checked the surface key and the
    // level for TRUTHINESS — so a row for the right URL naming the WRONG
    // surface satisfied it. Where the drill's CONTRACT knows which surface must
    // have refused, which family class and which computed level, it says so
    // here and the oracle requires the row to agree exactly.
    ...contractSays,
  };
  // Deduplicated, so the count in the verdict is the number of DISTINCT
  // refusals correlated rather than the number of requests made.
  // ROUND-2 REGRESSION `4e894e2d`: this used to DEDUPLICATE by method+path, so
  // a run causing thirteen auditable refusals declared seven targets and a
  // subset could silently write no row. Every caused refusal is now declared.
  causedRefusals.push(entry);
};

/**
 * Which stages of `evaluateSurfaceStage` WRITE a `surface.refused` row, and
 * which do not — because expecting a row from a stage that never writes one
 * would make §3.6 fail for the wrong reason, and expecting none from a stage
 * that does would leave the hole `e776b244` was filed for:
 *
 *   step 2  (required !== root)                 no row — the arm is not consulted
 *   step 3/4 (unresolved / non-governable)      no row — the ratified gate decides
 *   step 4b (authority-mutation surface)        ROW
 *   step 5  (authentication kind)               ROW
 *   step 6  (family not declared)               no row
 *   step 7  (concealed / level-insufficient)    ROW
 */

/**
 * THE RUN BOUNDARY (finding `93a7cbdb`, self-filed by the round-3 session).
 *
 * §3.6's correlation used to read EVERY `surface.refused` row in the table, so
 * on a REUSED database an earlier run's rows covered this run's refusals -
 * measured at 136 -> 272 -> 408 rows across three runs against one database.
 *
 * The boundary is CAPTURED rather than stamped. Production writes no
 * caller-supplied correlator into `metadata` (it writes the surface key, the
 * computed level, the method and `normalizePathForScope` of the path), and
 * minting one would be a production change made for a drill - the shape this
 * board has refused before. What is captured is exact rather than merely
 * temporal: the id of every pre-existing row of the two acts this drill
 * correlates, plus the database's own clock as a second, independent bound.
 * The oracle refuses any row that fails either.
 */
let RUN_BOUNDARY = null;
const CORRELATED_ACTS = ['surface.refused', 'access_bundle.refused'];

/**
 * THE REQUEST LEDGER: one entry per HTTP request this drill made, carrying the
 * ids of the `surface.refused` rows THAT REQUEST created.
 *
 * ROUND-4 REVIEW `5cfe851b` B1. The run boundary was necessary and not
 * sufficient: bounding by RUN still left an aggregate method/path count that a
 * sibling request could satisfy. Because the drill is strictly serial and the
 * server under drill is its only client, the rows that appear between one
 * request and the next are that request's, and the ledger is what lets the
 * oracle refuse a row nothing claims.
 */
const REQUEST_LEDGER = [];
const SEEN_REFUSAL_ROWS = new Set();
let REQUEST_SEQ = 0;

/** The `surface.refused` rows written since the last time this was asked. */
async function newRefusalRowIds() {
  const { rows } = await sql(
    `SELECT id::text AS id FROM audit_events
      WHERE action = 'surface.refused' AND occurred_at >= $1 ORDER BY occurred_at, id`,
    [RUN_BOUNDARY.startedAt]);
  const fresh = [];
  for (const row of rows) {
    if (SEEN_REFUSAL_ROWS.has(row.id) || RUN_BOUNDARY.preExistingIds.includes(row.id)) continue;
    SEEN_REFUSAL_ROWS.add(row.id);
    fresh.push(row.id);
  }
  return fresh;
}

async function captureRunBoundary() {
  const startedAt = (await sql('SELECT now() AS t')).rows[0].t;
  const { rows } = await sql(
    'SELECT id FROM audit_events WHERE action = ANY($1::text[])', [CORRELATED_ACTS]);
  return { runId: randomUUID(), startedAt, preExistingIds: rows.map((row) => String(row.id)) };
}

/**
 * How many `surface.refused` rows exist in this run so far.
 *
 * D6 asks WHICH STAGE answered, and the status code cannot say: §9.6's
 * concealment is `404 RESOURCE_NOT_FOUND` exactly so it is indistinguishable
 * from the resource being absent. §3.6 is what distinguishes them - only the
 * surface stage writes this act - so the drill measures the ledger around each
 * probe and hands the delta to the oracle.
 */
async function surfaceRefusalCount() {
  return Number((await sql(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE action = 'surface.refused' AND occurred_at >= $1`, [RUN_BOUNDARY.startedAt])).rows[0].n);
}

/** Audit rows for `action` written INSIDE this run, newest last. */
async function auditRowsInRun(action, { bounded = true } = {}) {
  const { rows } = await sql(
    `SELECT id::text AS id, action, metadata, occurred_at FROM audit_events
      WHERE action = $1 ${bounded ? 'AND occurred_at >= $2' : ''} ORDER BY occurred_at`,
    bounded ? [action, RUN_BOUNDARY.startedAt] : [action]);
  const inRun = rows.map((row) => ({ ...row, occurredAt: row.occurred_at }));
  return bounded ? inRun.filter((row) => !RUN_BOUNDARY.preExistingIds.includes(row.id)) : inRun;
}

const results = [];
function record(drill, verdict, note = '') {
  results.push({ drill, ok: verdict.ok, reason: verdict.reason, note });
  console.log(`${verdict.ok ? 'PASS' : 'FAIL'}  ${drill.padEnd(28)} ${verdict.reason}${note ? ` [${note}]` : ''}`);
}

// ── a dashboard login session, minted the way the board mints one ───────────
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function loginSession(handle, principalId, kind = 'human') {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ v: 2, handle, sub: principalId, kind, iat: now, exp: now + 3600 }));
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${body}.${signature}`;
}

const ROOT_JWT = loginSession(FIXTURES.admin.handle, FIXTURES.admin.id);
const MEMBER_JWT = loginSession(FIXTURES.member.handle, FIXTURES.member.id);
const STRANGER_JWT = loginSession(FIXTURES.stranger.handle, FIXTURES.stranger.id);

async function call(method, route, { token, bearer, body, retried = false } = {}) {
  if (retried) { /* one wait only: a second 429 is a real finding, not a pace problem */ }
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${BASE}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (response.status === 429) {
    const wait = Math.min(Number(response.headers.get('retry-after') || 60), 70);
    process.stdout.write(`  (rate ceiling reached — waiting ${wait}s)\n`);
    await new Promise((resolve) => { setTimeout(resolve, (wait + 1) * 1000); });
    return call(method, route, { token, bearer, body, retried: true });
  }
  const answer = { status: response.status, code: payload.code, message: payload.message, body: payload };
  // ATTRIBUTION. Every request is recorded, whether or not a refusal is
  // expected of it, because the oracle's other half asserts that NO row in the
  // run is unattributed - and a row written by an unrecorded request is
  // exactly the hole `5cfe851b` B1 found.
  if (RUN_BOUNDARY) {
    REQUEST_SEQ += 1;
    answer.seq = REQUEST_SEQ;
    REQUEST_LEDGER.push({
      seq: REQUEST_SEQ,
      method: method.toUpperCase(),
      path: canonicalPath(route),
      rowIds: await newRefusalRowIds(),
    });
  }
  return answer;
}

// ── the server under drill ──────────────────────────────────────────────────
let child = null;
let serverLog = [];

function serverEnv(extra = {}) {
  return {
    ...process.env,
    // NOT forced. `utils/credentialAcceptance` embeds the environment in the
    // key prefix (`rh_<env>_<keyId>.<secret>`), so a drill server on a
    // different NODE_ENV than the seeder answers 401 to every fixture
    // credential — and a 401 is not the arm's refusal. The bearer reach
    // control in D17 is what makes that impossible to miss again.
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: String(PORT),
    JWT_SECRET,
    RELAYHALL_SURFACE_ARM_TRACE: '1',
    RELAYHALL_CREDENTIAL_KEYS: process.env.RELAYHALL_CREDENTIAL_KEYS
      || JSON.stringify({ drillkey: Buffer.alloc(32, 7).toString('base64') }),
    RELAYHALL_CREDENTIAL_ACTIVE_KEY: process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY || 'drillkey',
    ...extra,
  };
}

/** Start the COMPILED build — the artefact the container runs. */
function startServer() {
  serverLog = [];
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['dist/server.js'], { cwd: BACKEND, env: serverEnv() });
    const onData = (chunk) => { serverLog.push(String(chunk)); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (code !== 0 && !child.killed) reject(new Error(`server exited ${code}\n${serverLog.join('')}`)); });
    const deadline = Date.now() + 40_000;
    const poll = async () => {
      try {
        const health = await fetch(`${BASE}/health`);
        if (health.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error(`server never became healthy\n${serverLog.join('')}`));
      setTimeout(poll, 300);
    };
    poll();
  });
}

async function stopServer() {
  if (!child) return;
  const dying = child;
  child = null;
  dying.kill('SIGTERM');
  await new Promise((resolve) => { dying.on('exit', resolve); setTimeout(resolve, 4000); });
}

/** Boot once and report how it went — the census's own gate (D2, D15). */
function bootOnce() {
  return new Promise((resolve) => {
    const lines = [];
    const proc = spawn(process.execPath, ['dist/server.js'], { cwd: BACKEND, env: serverEnv({ PORT: String(PORT + 1) }) });
    const onData = (chunk) => {
      lines.push(String(chunk));
      // A census PASS means the process will keep running; stop it and report.
      if (lines.join('').includes('Access-surface census passed')) { proc.kill('SIGTERM'); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code, signal) => {
      const output = lines.join('');
      // A census pass is a boot we cut short on purpose; report it as exit 0.
      resolve({ exitCode: output.includes('Access-surface census passed') ? 0 : (code ?? (signal ? 1 : 1)), output });
    });
    setTimeout(() => { proc.kill('SIGKILL'); }, 60_000);
  });
}

/**
 * Run `qa/setgov-d21-capture.mjs` — the escalation's OWN instrument — against
 * the live drill server, and return the JSON it prints.
 *
 * It is a separate process on purpose: it is the fixture ruling `70af4d82` §2
 * committed as D21's negative control, and re-running the drill's own probe
 * would answer a different question ("does my probe still refuse?") from the
 * one this answers ("does the instrument that captured the escalation still
 * capture it?").
 */
function runEscalationCapture() {
  return new Promise((resolve) => {
    const out = [];
    const errors = [];
    const proc = spawn(process.execPath, [path.join(REPO, 'qa', 'setgov-d21-capture.mjs')], {
      cwd: REPO,
      env: { ...process.env, RELAYHALL_REPO: REPO, DRILL_BASE: BASE },
    });
    proc.stdout.on('data', (chunk) => out.push(String(chunk)));
    proc.stderr.on('data', (chunk) => errors.push(String(chunk)));
    proc.on('exit', () => {
      let evidence = null;
      try { evidence = JSON.parse(out.join('')); } catch { evidence = null; }
      resolve({ evidence, error: errors.join('') });
    });
    setTimeout(() => { proc.kill('SIGKILL'); }, 120_000);
  });
}

// ── catalogue helpers ───────────────────────────────────────────────────────
const surfaceIdByKey = new Map(FIXTURES.surfaces.map((s) => [s.key, s.id]));
const bundleByKey = new Map(FIXTURES.bundles.map((b) => [b.key, b]));
const ADMINISTRATIVE = bundleByKey.get('administrative');

/** A snapshot of the whole catalogue, so a destructive drill can put it back. */
let CATALOGUE_SNAPSHOT = null;
async function snapshotCatalogue() {
  CATALOGUE_SNAPSHOT = {
    surfaces: (await sql('SELECT * FROM access_surfaces')).rows,
    members: (await sql('SELECT * FROM access_bundle_members')).rows,
  };
}
async function restoreCatalogue() {
  await sql('DELETE FROM access_bundle_members');
  await sql('DELETE FROM access_surfaces');
  for (const row of CATALOGUE_SNAPSHOT.surfaces) {
    await sql(
      `INSERT INTO access_surfaces (id, key, label, governance, locked_reference, read_families, write_families,
                                    excluded_families, menu_path, origin, plugin_name, retired_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.id, row.key, row.label, row.governance, row.locked_reference, row.read_families, row.write_families,
        JSON.stringify(row.excluded_families), row.menu_path, row.origin, row.plugin_name, row.retired_at, row.created_at],
    );
  }
  for (const row of CATALOGUE_SNAPSHOT.members) {
    await sql('INSERT INTO access_bundle_members (bundle_id, surface_id, created_at) VALUES ($1,$2,$3)',
      [row.bundle_id, row.surface_id, row.created_at]);
  }
}

/**
 * The capture probe set for D1 / D3 / D19: one read and one write family per
 * governable surface, DERIVED FROM THE CATALOGUE ROWS THE ARM READS rather
 * than from the fixture manifest.
 *
 * Every governable surface is represented in both directions, which is what
 * D1/D19's "every G family" is measuring; probing all thirty-nine adds no
 * distinguishing power to a never-grants comparison and costs several
 * rate-limit windows per capture. What round 3 showed is that the SET must be
 * declared to the comparator (`2a8087c3`), and `probeLabels()` below is what
 * `capturesIdentical` is now handed, so a probe list that silently shrank goes
 * red instead of comparing a shorter list to a shorter list.
 */
function governableProbes(contract, surfaceRows) {
  const probes = [];
  for (const row of surfaceRows) {
    if (row.governance !== 'governable') continue;
    const families = declaredFamilies(contract, row);
    for (const klass of ['read', 'write']) {
      const family = families.find((entry) => entry.familyClass === klass);
      if (!family) continue;
      probes.push({
        label: family.familyKey,
        method: family.method,
        route: family.route,
        family: klass,
        surfaceKey: row.key,
      });
    }
  }
  return probes.sort((a, b) => a.label.localeCompare(b.label));
}

/** The label set a capture over `probes` is REQUIRED to hold, exactly. */
const probeLabels = (probes) => probes.map((probe) => probe.label);

/**
 * A capture is the DECISION — admitted or refused — never the response shape.
 *
 * The design ratifies both halves of a tension and a shape-based capture
 * cannot satisfy them at once: §3.2's never-grants criterion says the
 * catalogue must not move a zero-authority principal's decision, while §3.3
 * REQUIRES the catalogue to change the refusal SHAPE on a governed read family
 * from the route stage's 403 to the surface stage's 404 (the 44d1bf89
 * concealment pattern). Both are ratified in the same document, deliberately.
 *
 * The reading that satisfies both is the one the MONOTONICITY COROLLARY
 * already uses — "no catalogue state makes any decision MORE PERMISSIVE" is an
 * allow/deny notion, not a status-code one. So the capture is admission, and
 * the shape difference is recorded separately, below, as the ratified
 * consequence it is: 404 discloses strictly LESS than 403.
 */
async function capture(token, probes) {
  const out = [];
  for (const probe of probes) {
    const answer = await call(probe.method, probe.route, { token });
    // The decision, plus the answer it was derived from. The evidence is what
    // `capturesIdentical` validates and never compares (regression `ff9b6437`):
    // without it, a server answering 500 everywhere recorded `admitted:false`
    // for every probe and satisfied D1, D10 and D19 at once.
    out.push({
      label: probe.label,
      // `eed02f4e` F2: a 3xx is not an admission and not a refusal — the
      // record says `false` and `capturesIdentical` excludes it BY NAME.
      admitted: answer.status >= 200 && answer.status < 300,
      evidence: { status: answer.status, code: answer.code ?? null },
    });
  }
  return out;
}

/** The shape beside the decision, so the concealment change is REPORTED
 * rather than silently absorbed by the admission reading above. */
async function captureShapes(token, probes) {
  const out = [];
  for (const probe of probes) {
    const answer = await call(probe.method, probe.route, { token });
    out.push({ label: probe.label, status: answer.status, code: answer.code ?? null });
  }
  return out;
}

async function assignGroup(profileId) {
  return call('POST', `/access-profiles/${profileId}/assignments`, {
    token: ROOT_JWT,
    body: { assigneeType: 'group', assigneeId: FIXTURES.group.id },
  });
}
async function unassignAll() {
  await sql('DELETE FROM access_profile_assignments WHERE assignee_id = $1', [FIXTURES.group.id]);
}

/**
 * The BEARER KINDS D17 must cover, derived from outside the drill.
 *
 * ROUND-4 REVIEW `5cfe851b` B2: the bearer list was a literal in the drill, so
 * a drill that tested one bearer produced a smaller matrix and a verdict that
 * said so cheerfully. The set now comes from the FIXTURE MANIFEST — written by
 * `environments/dev-setgov-fixtures` in the estate, never by this file — as
 * every principal it hands over with a live credential; and each one is then
 * required to hold an unrevoked `principal_credentials` row in the substrate,
 * so a manifest entry naming a principal that cannot actually present a bearer
 * credential fails loudly instead of quietly shrinking the matrix.
 */
async function ratifiedBearerKinds(contract) {
  // ROUND-4b REVIEW `252fe7e6` B1. This used to return the fixture manifest's
  // own credential-holders, and the caller then handed the SAME list to
  // `buildD17Census` as both the subject and the ratified set — an equality
  // whose ratified side came from the party it judges. The ratified side is now
  // production's `DELEGATED_BEARER_LAYERS`; this function's job is only to find
  // ONE live credential-holder per ratified layer, and to fail if it cannot.
  //
  // The LAYER of each candidate is decided by production's own classifier over
  // the principal's `kind` and `parent_principal_id` — the columns migrations
  // 062 and 096 define — never by the fixture's name in the manifest.
  const ratified = ratifiedBearerLayers(contract);
  const named = Object.entries(FIXTURES)
    .filter(([, value]) => value && typeof value === 'object'
      && typeof value.credential === 'string' && typeof value.id === 'string')
    .map(([fixture, value]) => ({ fixture, id: value.id, credential: value.credential }))
    .sort((a, b) => a.fixture.localeCompare(b.fixture));
  if (named.length === 0) {
    throw new Error('the fixture manifest names no credential-holding principal: D17 has no subject at all');
  }
  const { rows } = await sql(
    `SELECT p.id::text AS id, p.kind, p.parent_principal_id::text AS parent_principal_id,
            EXISTS (SELECT 1 FROM principal_credentials c
                     WHERE c.principal_id = p.id AND c.revoked_at IS NULL) AS has_credential
       FROM principals p WHERE p.id = ANY($1::uuid[])`, [named.map((entry) => entry.id)]);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const classified = [];
  for (const entry of named) {
    const row = byId.get(String(entry.id));
    if (!row) throw new Error(`the manifest names '${entry.fixture}', which is no principal in this database`);
    if (row.has_credential !== true) {
      throw new Error(`the manifest names '${entry.fixture}', which holds no live credential row, so its refusals would prove nothing`);
    }
    classified.push({ ...entry, layer: contract.bearerLayerFor(row.kind, row.parent_principal_id) });
  }
  const found = new Map();
  for (const entry of classified) {
    if (!ratified.includes(entry.layer)) continue;
    if (!found.has(entry.layer)) found.set(entry.layer, { bearer: entry.layer, ...entry });
  }
  const absent = ratified.filter((layer) => !found.has(layer));
  if (absent.length > 0) {
    throw new Error(`production ratifies ${ratified.length} delegated bearer layer(s) (${ratified.join(', ')}) and this substrate holds a live-credentialed principal for only ${found.size}: no matrix may be built without ${absent.join(', ')}`);
  }
  return ratified.map((layer) => found.get(layer));
}

/** The catalogue AS THE ARM READS IT: the rows, from the database. */
async function readCatalogue() {
  const surfaceRows = (await sql(
    `SELECT key, label, governance, read_families, write_families
       FROM access_surfaces WHERE retired_at IS NULL ORDER BY key`)).rows;
  const memberRows = (await sql(
    `SELECT b.key AS bundle_key, s.key AS surface_key
       FROM access_bundle_members m
       JOIN access_bundles b ON b.id = m.bundle_id
       JOIN access_surfaces s ON s.id = m.surface_id
      ORDER BY b.key, s.key`)).rows.map((row) => ({ bundleKey: row.bundle_key, surfaceKey: row.surface_key }));
  return { surfaceRows, memberRows };
}

/**
 * Is the catalogue in this database the catalogue migration 109 seeds?
 *
 * The live drill derives its expected sets from the DATABASE rows, because that
 * is where the arm reads them; the census printer derives the same sets from
 * the MIGRATION, because a reviewer sandbox has no database at all. Two sources
 * for one contract is a drift risk, so it is measured rather than assumed: if
 * the database this drill ran against is not the migration in the tree, every
 * count below is about something else and this drill says so.
 */
function seedAgreement(catalogue) {
  const seed = parseSeededCatalogue(readFileSync(path.join(BACKEND, 'src', 'migrations', '109_access_surfaces.sql'), 'utf8'));
  const shape = (rows) => rows.map((row) => [
    row.key, row.governance,
    [...(row.read_families ?? [])].join(','), [...(row.write_families ?? [])].join(','),
  ].join('|')).sort();
  const live = shape(catalogue.surfaceRows);
  const want = shape(seed.surfaceRows);
  const absent = want.filter((row) => !live.includes(row));
  const extra = live.filter((row) => !want.includes(row));
  if (absent.length > 0 || extra.length > 0) {
    return {
      ok: false,
      reason: `the database catalogue is not migration 109's: ${absent.length} seeded row(s) absent (${absent.slice(0, 2).join(' / ') || 'none'}), ${extra.length} row(s) the migration does not seed (${extra.slice(0, 2).join(' / ') || 'none'})`,
    };
  }
  const members = (rows) => rows.map((row) => `${row.bundleKey}|${row.surfaceKey}`).sort().join(';');
  if (members(catalogue.memberRows) !== members(seed.memberRows)) {
    return {
      ok: false,
      reason: `Access-bundle membership in the database is not migration 109's: database [${members(catalogue.memberRows)}] vs seed [${members(seed.memberRows)}]`,
    };
  }
  return {
    ok: true,
    reason: `${want.length} catalogue rows and ${seed.memberRows.length} membership rows in the database are migration 109's exactly, so the drill's expected sets and the census printer's are derived from ONE contract`,
  };
}

/**
 * The run boundary's own control (`93a7cbdb` DoD [2]): a row from OUTSIDE the
 * boundary must not satisfy an expectation.
 *
 * A decoy carrying THIS run's exact expectation - `GET /webhooks` refused at
 * `none` on `settings.webhooks` - is written an hour before the boundary. It
 * must be invisible to the run-bounded read and visible to an unbounded one:
 * without the second half, "excluded" could mean the row was never there.
 *
 * THE DECOY IS NOT REMOVED, AND CANNOT BE. Migration 087's
 * `reject_audit_event_mutation` trigger makes `audit_events` APPEND-ONLY, so a
 * DELETE raises `audit_events is append-only` - which this control discovered
 * on its first live run. Leaving it is the better shape anyway: on the SECOND
 * run against the same database it is a genuine earlier-run row carrying this
 * run's exact expectation, which is precisely the state `93a7cbdb` is about,
 * and the drill is required to pass twice against one database.
 */
async function runBoundaryControl() {
  const decoy = (await sql(
    `INSERT INTO audit_events (occurred_at, action, outcome, actor_handle, auth_method, resource_type, resource_id, metadata)
     VALUES (now() - interval '1 hour', 'surface.refused', 'denied', $1, 'dashboard_jwt', 'route', NULL, $2::jsonb)
     RETURNING id::text AS id`,
    [FIXTURES.member.handle, JSON.stringify({
      surfaceKey: 'settings.webhooks', accessLevel: 'none', family: 'read',
      refusal: 'SURFACE_CONCEALED', method: 'GET', path: '/webhooks',
      decoyFor: RUN_BOUNDARY.runId,
    })])).rows[0].id;
  const bounded = await auditRowsInRun('surface.refused');
  const unbounded = await auditRowsInRun('surface.refused', { bounded: false });
  if (bounded.some((row) => row.id === decoy)) {
    return { ok: false, reason: `a row written an hour BEFORE run ${RUN_BOUNDARY.runId} is visible to the run-bounded read: the boundary excludes nothing` };
  }
  if (!unbounded.some((row) => row.id === decoy)) {
    return { ok: false, reason: 'the decoy is invisible to the UNBOUNDED read too, so this control cannot show that the boundary is what excluded it' };
  }
  return {
    ok: true,
    reason: `a row carrying this run's exact expectation, written an hour before run ${RUN_BOUNDARY.runId}, is visible to an unbounded read (${unbounded.length} rows) and excluded from the run-bounded read (${bounded.length} rows)`,
  };
}

// ── the drills ──────────────────────────────────────────────────────────────
async function main() {
  await snapshotCatalogue();

  // ══ THE RUN BOUNDARY, captured before the first request ══════════════════
  RUN_BOUNDARY = await captureRunBoundary();

  // ══ THE CONTRACT — every expected set below is derived from these ════════
  const contract = loadProductionContract(BACKEND);
  // The authority paths to a surface level, from production's own exported inventory.
  const ratifiedStoreInventory = ratifiedAuthorityStores(contract);
  const ratifiedStores = ratifiedStoreInventory.map((entry) => entry.store);
  const catalogue = await readCatalogue();
  const levelFor = levelResolverFromMembership(catalogue.memberRows, 'administrative');
  const probes = governableProbes(contract, catalogue.surfaceRows);
  const captureLabels = probeLabels(probes);
  const governableFamilies = familiesOfClass(contract, catalogue.surfaceRows, 'governable');
  const withheldFamilies = governableFamilies.filter((family) => AUTHORITY_MUTATION_SURFACE_KEYS.includes(family.surfaceKey));
  const d6Census = buildD6Census(contract, {
    surfaceRows: catalogue.surfaceRows,
    callerStates: D6_CALLER_STATES,
    levelFor,
    excludeSurfaceKeys: AUTHORITY_MUTATION_SURFACE_KEYS,
  });
  // ROUND-4 EXTRA VERDICT `36e8588e` B5. The five escalation acts are
  // TRANSCRIBED in the oracle module from annex `85a2218d` D21; a transcription
  // is only worth as much as its agreement with the substrate, so before it is
  // used as an expected set every entry must be a DECLARED WRITE FAMILY of an
  // authority-mutation surface in the catalogue the arm itself reads.
  const escalationTranscriptionProblems = [];
  for (const want of RATIFIED_ESCALATION_ACTS) {
    if (!AUTHORITY_MUTATION_SURFACE_KEYS.includes(want.surfaceKey)) {
      escalationTranscriptionProblems.push(`'${want.familyKey}' is transcribed against '${want.surfaceKey}', which is not one of the withheld surfaces`);
      continue;
    }
    const row = catalogue.surfaceRows.find((entry) => entry.key === want.surfaceKey);
    if (!row) { escalationTranscriptionProblems.push(`'${want.surfaceKey}' is in no catalogue row`); continue; }
    if (!(row.write_families ?? []).includes(want.familyKey)) {
      escalationTranscriptionProblems.push(`'${want.familyKey}' is not a declared WRITE family of '${want.surfaceKey}' (${(row.write_families ?? []).length} declared)`);
    }
  }
  record('contract (the transcribed escalation acts are catalogue families)',
    escalationTranscriptionProblems.length === 0
      ? { ok: true, reason: `all ${RATIFIED_ESCALATION_ACTS.length} transcribed escalation acts are declared write families of the withheld surfaces the catalogue carries (${[...new Set(RATIFIED_ESCALATION_ACTS.map((w) => w.surfaceKey))].join(', ')})` }
      : { ok: false, reason: `the transcription does not match the catalogue, so it cannot be D21(iii)'s expected set: ${escalationTranscriptionProblems.join('; ')}` });

  const lockedCensus = buildLockedCensus(contract, catalogue.surfaceRows);
  const d21Attempts = buildD21WriteCensus(AUTHORITY_MUTATION_SURFACE_KEYS);

  console.log(`\nSETGOV live drill — run ${RUN_BOUNDARY.runId}`);
  console.log(`  ${catalogue.surfaceRows.length} catalogue surfaces; ${governableFamilies.length} governable families`);
  console.log(`  D6 census ${d6Census.length} cells (${withheldFamilies.length} withheld families are D21's); D10 ${lockedCensus.length} locked families`);
  console.log(`  D21(ii) ${d21Attempts.length} required attempts; D17 matrix over ${ratifiedStores.length} exported authority seams (${ratifiedStores.join(', ')})\n`);

  // ── the anchors are themselves drills ────────────────────────────────────
  const drift = normaliserDrift(contract, canonicalPath);
  record('contract (normaliser anchor)', drift.length === 0
    ? { ok: true, reason: `the drill layer's canonicalPath agrees with the COMPILED production normalizePathForScope on all ${CANONICAL_PATH_CORPUS.length} hostile inputs` }
    : { ok: false, reason: `the drill layer's path normaliser has DRIFTED from production: ${drift.join('; ')}` });

  const unserved = familiesAbsentFromRegistry(contract, [
    ...governableFamilies, ...familiesOfClass(contract, catalogue.surfaceRows, 'locked'),
  ]);
  record('contract (registry serves every family)', unserved.length === 0
    ? { ok: true, reason: `every declared family of every governable and locked surface is one of the ${contract.enumerateProtectedRouteFamilies().length} routes the protected registry serves` }
    : { ok: false, reason: `the catalogue declares families no router serves, so probing them observes nothing: ${unserved.join(', ')}` });

  record('contract (database is migration 109)', seedAgreement(catalogue));

  // ROUND-4b REVIEW `252fe7e6` B2. The EXPORTED seam inventory is only a
  // contract if the code composes it: this measures `AUTHORITY_SEAMS` against
  // the SQL `surfaceLevel` actually emits, so a path composed inline goes red
  // here even though every list in the tree still agrees with itself.
  const seamDrift = await authoritySeamCompositionDrift(contract);
  record('contract (authority seam composition)', seamDrift.problems.length === 0
    ? { ok: true, reason: `the ${ratifiedStoreInventory.length} exported authority seam(s) (${ratifiedStoreInventory.map((s) => `${s.store}->${s.table}`).join(', ')}) account for EVERYTHING \`surfaceLevel\` composes: each contributes its fragment exactly twice (read + write), and with all of them removed what is left EQUALS the ${ratifiedStoreInventory.length}-seam skeleton exactly (${seamDrift.actualExists} EXISTS subqueries, all declared)` }
    : { ok: false, reason: seamDrift.problems.join('; ') });

  record('audit run boundary (93a7cbdb)', await runBoundaryControl());

  // The D6 census and the withheld families must PARTITION the governable
  // catalogue: nothing may fall between D6 and D21 unmeasured.
  // ROUND-4 EXTRA VERDICT `36e8588e` B2: this compared a Set of SURFACE KEYS,
  // so dropping every state cell of ONE family of a multi-family surface left
  // the surface in the set and the family measured by nothing. The comparison
  // is over `(surfaceKey, familyKey)` pairs, both directions, disjointly.
  record('contract (D6 and D21 partition the governable catalogue)',
    governableCatalogueIsPartitioned({ governableFamilies, d6Cells: d6Census, withheldFamilies }));

  // ══ SETUP CONTROL — the probes address ROUTES THAT EXIST ═════════════════
  // A drill pointed at the wrong prefix answers a bare 404 "Not Found" for
  // every probe, and every capture comparison below would then be identical
  // for a reason that has nothing to do with authorization. A ROOT session
  // must reach at least one probe, and no probe may answer the framework's
  // own not-found.
  await startServer();
  const rootReach = [];
  for (const probe of probes) {
    const answer = await call(probe.method, probe.route, { token: ROOT_JWT });
    // Express's own 404 carries `{ error: 'Not Found', path }` and no code.
    // That is what a wrong mount prefix answers, and it is what would make
    // every capture below identical for a reason unrelated to authorization.
    rootReach.push({ label: probe.label, status: answer.status, noRoute: answer.body?.path !== undefined });
  }
  const missing = rootReach.filter((r) => r.noRoute);
  record('SETUP (probes address real routes)',
    (missing.length === 0 && rootReach.some((r) => r.status < 400))
      ? { ok: true, reason: `${rootReach.length} probes reach real routes; ${rootReach.filter((r) => r.status < 400).length} answered a root session 2xx/3xx` }
      : { ok: false, reason: `${missing.length} probes hit no route at all (${missing.map((r) => r.label).join(', ')}) — every capture below would be vacuously identical` });
  await stopServer();

  // ══ D2 / D15 — the boot census, and each red mutation ═════════════════════
  record('D2 setup (sound boot)', bootAccepted(await bootOnce()));

  const censusRed = async (label, mutate, fragment) => {
    await mutate();
    const boot = await bootOnce();
    await restoreCatalogue();
    record(label, bootRefused({ ...boot, expectedFragment: fragment }));
  };

  await censusRed('D2(iii) RED', async () => {
    await sql(`UPDATE access_surfaces SET read_families = read_families || ARRAY['GET /tasks']
                WHERE key = 'settings.appearance'`);
  }, "declares family 'GET /tasks'");

  await censusRed('D2(vii) RED', async () => {
    await sql(`UPDATE access_surfaces SET read_families = read_families || ARRAY['POST /webhooks']
                WHERE key = 'settings.webhooks'`);
  }, "'use' answers GET/HEAD only");

  await censusRed('D2(i) RED', async () => {
    await sql(`DELETE FROM access_bundle_members WHERE surface_id = $1`, [surfaceIdByKey.get('settings.webhooks')]);
    await sql(`DELETE FROM access_surfaces WHERE key = 'settings.webhooks'`);
  }, "is in no Access surface");

  await censusRed('D2(v) RED', async () => {
    await sql(`UPDATE access_surfaces
                  SET excluded_families = '[{"family": "GET /appearance", "requirement": "principals:read"}]'::jsonb
                WHERE key = 'settings.appearance'`);
  }, 'but the route map answers');

  await censusRed('D2(vi) RED', async () => {
    await sql(`UPDATE access_surfaces
                  SET excluded_families = '[{"family": "GET /webhooks", "requirement": "root"}]'::jsonb
                WHERE key = 'settings.webhooks'`);
  }, 'both governed and excluded');

  await censusRed('D15 RED (overlap)', async () => {
    await sql(`INSERT INTO access_surfaces (key, label, governance, read_families, write_families, origin)
               VALUES ('settings.webhooks-shadow', 'Shadow', 'governable', ARRAY['GET /webhooks'], '{}', 'core')`);
  }, 'resolves to more than one Access surface');

  await censusRed('D9/D2 RED (locked member)', async () => {
    await sql(`INSERT INTO access_bundle_members (bundle_id, surface_id) VALUES ($1, $2)`,
      [ADMINISTRATIVE.id, surfaceIdByKey.get('settings.identity-providers')]);
  }, 'locked surface');

  // ══ the running server, for every runtime drill ═══════════════════════════
  await startServer();

  // D15 clause 2 (regression `fd10af48`): a GET/POST ownership SPLIT across
  // two surfaces on ONE path. Distinct family keys, so clause 1 passes; both
  // resolve at runtime, because resolution is by PATH. The boot must refuse.
  //
  // The split must be a SPLIT. On this mutation's first run the thief
  // COPIED `POST /webhooks` from a surface that still declared it, so the
  // two keys collided, clause 1 caught it, and the drill passed with clause
  // 2 DELETED — a control that could not fail. Red mutation R4 is what
  // found that. The method is MOVED, so the keys are distinct and only
  // clause 2 can refuse this catalogue.
  await sql(
    `UPDATE access_surfaces SET write_families = array_remove(write_families, 'POST /webhooks')
      WHERE key = 'settings.webhooks'`);
  await sql(
    `INSERT INTO access_surfaces (key, label, governance, read_families, write_families, excluded_families, origin)
     VALUES ('drill.webhooks-post-thief', 'Webhooks POST thief', 'governable',
             '{}', ARRAY['POST /webhooks'], '[]'::jsonb, 'core')`);
  const splitBoot = await bootOnce();
  await sql("DELETE FROM access_surfaces WHERE key = 'drill.webhooks-post-thief'");
  await restoreCatalogue();
  record('D15 RED (path split)', bootRefused({
    exitCode: splitBoot.exitCode, output: splitBoot.output,
    expectedFragment: 'resolves to more than one Access surface',
  }));

  // ══ D1 — the catalogue never grants ══════════════════════════════════════
  await unassignAll();
  const baseline = await capture(MEMBER_JWT, probes);
  const mutations = [
    ['truncated', async () => { await sql('DELETE FROM access_bundle_members'); await sql('DELETE FROM access_surfaces'); }],
    ['families rewritten', async () => {
      await restoreCatalogue();
      await sql(`UPDATE access_surfaces SET read_families = ARRAY['GET /audit'], write_families = ARRAY['POST /tasks']`);
    }],
    ['governance flipped', async () => {
      await restoreCatalogue();
      await sql(`UPDATE access_surfaces SET governance = 'governable', locked_reference = NULL
                  WHERE governance <> 'governable'`);
    }],
    ['surfaces invented', async () => {
      await restoreCatalogue();
      await sql(`INSERT INTO access_surfaces (key, label, governance, read_families, write_families, origin)
                 VALUES ('invented.everything', 'Invented', 'governable', ARRAY['GET /audit','GET /dashboard'], ARRAY['POST /tasks'], 'core')`);
    }],
  ];
  let d1Ok = true;
  const d1Reasons = [];
  for (const [label, mutate] of mutations) {
    await mutate();
    const verdict = capturesIdentical(baseline, await capture(MEMBER_JWT, probes), { minimum: 5, expectedLabels: captureLabels });
    if (!verdict.ok) { d1Ok = false; d1Reasons.push(`${label}: ${verdict.reason}`); }
  }
  await restoreCatalogue();
  record('D1 (never-grants)', d1Ok
    ? { ok: true, reason: `${baseline.length} decisions byte-identical across ${mutations.length} catalogue states` }
    : { ok: false, reason: d1Reasons.join(' | ') });

  // The ratified consequence, REPORTED rather than absorbed: with the
  // catalogue in place a governed family answers the surface stage's 404
  // instead of the route stage's 403 for the same zero-authority caller.
  // Strictly less disclosure, and it is §3.3's whole point.
  const shapesWith = await captureShapes(MEMBER_JWT, probes);
  await sql('DELETE FROM access_bundle_members');
  await sql('DELETE FROM access_surfaces');
  const shapesWithout = await captureShapes(MEMBER_JWT, probes);
  await restoreCatalogue();
  const concealed = shapesWith.filter((row, i) => row.status === 404 && shapesWithout[i]?.status === 403).length;
  record('D1 (declared shape consequence)',
    { ok: true, reason: `${concealed}/${shapesWith.length} governed families answer 404 with the catalogue and 403 without it — the ratified §3.3 concealment, never a widening` });

  // D1 second half: authority granted, then removed by the two PERMITTED acts.
  const armed = await assignGroup(ADMINISTRATIVE.configure_profile_id);
  const withAuthority = await capture(MEMBER_JWT, probes);
  const movedByAssignment = JSON.stringify(withAuthority.map(decisionOf)) !== JSON.stringify(baseline.map(decisionOf));
  await unassignAll();
  record('D1 (revocation floor)', movedByAssignment
    ? capturesIdentical(baseline, await capture(MEMBER_JWT, probes), { minimum: 5, expectedLabels: captureLabels })
    : { ok: false, reason: `the assignment changed no decision (assign status ${armed.status}) — the removal below proves nothing` });

  // ══ D3 — `exact` only, both halves ═══════════════════════════════════════
  const profileForRules = ADMINISTRATIVE.use_profile_id;
  const allOfType = await call('POST', `/access-profiles/${profileForRules}/versions`, {
    token: ROOT_JWT,
    body: { rules: [{ resourceType: 'surface', selectorForm: 'all-of-type', verbs: ['read'] }] },
  });
  const allExcept = await call('POST', `/access-profiles/${profileForRules}/versions`, {
    token: ROOT_JWT,
    body: { rules: [{ resourceType: 'surface', selectorForm: 'all-except', selectorIds: [surfaceIdByKey.get('settings.webhooks')], verbs: ['read'] }] },
  });
  record('D3(a) write refusal', (allOfType.status === 422 && allExcept.status === 422)
    ? { ok: true, reason: `all-of-type ${allOfType.status}, all-except ${allExcept.status} — both refused at the write surface` }
    : { ok: false, reason: `all-of-type ${allOfType.status}, all-except ${allExcept.status} — the write surface admitted a future-inclusive surface rule` });

  // (b) the same rule inserted directly in SQL is ignored by the evaluator.
  await assignGroup(ADMINISTRATIVE.use_profile_id);
  const beforeSqlRule = await capture(MEMBER_JWT, probes);
  const publishedVersion = (await sql(
    'SELECT published_version_id FROM access_profiles WHERE id = $1', [ADMINISTRATIVE.use_profile_id])).rows[0].published_version_id;
  await sql(
    `INSERT INTO access_profile_rules (version_id, resource_type, selector_form, selector_ids, verbs)
     VALUES ($1, 'surface', 'all-of-type', '{}', ARRAY['read','write'])`, [publishedVersion]);
  record('D3(b) evaluator ignores', capturesIdentical(beforeSqlRule, await capture(MEMBER_JWT, probes), { minimum: 5, expectedLabels: captureLabels }));
  await sql(`DELETE FROM access_profile_rules WHERE version_id = $1 AND selector_form = 'all-of-type'`, [publishedVersion])
    .catch(() => undefined);
  await unassignAll();

  // ══ D19 — a wildcard surface grant confers nothing ═══════════════════════
  const wildcard = await call('POST', '/grants', {
    token: ROOT_JWT,
    body: { granteeType: 'group', granteeId: FIXTURES.group.id, resourceType: 'surface', verb: 'read' },
  });
  const zeroBaseline = await capture(MEMBER_JWT, probes);
  await sql(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
     VALUES ('group', $1, 'surface', NULL, 'read')`, [FIXTURES.group.id]);
  const withWildcard = await capture(MEMBER_JWT, probes);
  await sql(`DELETE FROM grants WHERE grantee_id = $1 AND resource_type = 'surface' AND resource_id IS NULL`, [FIXTURES.group.id]);
  record('D19 write refusal', wildcard.status === 422
    ? { ok: true, reason: `the generic /grants write surface refused the wildcard (${wildcard.status} ${wildcard.code})` }
    : { ok: false, reason: `the wildcard surface grant was ACCEPTED (${wildcard.status})` });
  record('D19 evaluator ignores', capturesIdentical(zeroBaseline, withWildcard, { minimum: 5, expectedLabels: captureLabels }));

  // D19 positive control: an `exact` grant moves exactly the surface it names.
  const webhooksSurface = surfaceIdByKey.get('settings.webhooks');
  await sql(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
     VALUES ('group', $1, 'surface', $2, 'read')`, [FIXTURES.group.id, webhooksSurface]);
  const withExact = await capture(MEMBER_JWT, probes);
  await sql(`DELETE FROM grants WHERE grantee_id = $1 AND resource_type = 'surface'`, [FIXTURES.group.id]);
  record('D19 positive control', exactlyOneDecisionMoved(zeroBaseline, withExact, 'GET /webhooks'));

  // ══ D10 — locked surfaces are outside the arm ════════════════════════════
  //
  // ROUND-3 REGRESSION `2a8087c3`. This captured only `settings.identity-providers`
  // and handed the comparator NO expected set, so the second RATIFIED locked
  // surface — `settings.notification-endpoints`, which the annex names in the
  // same sentence — was never measured at all, and removing its locked
  // short-circuit stayed green on "1 decisions byte-identical". The subject is
  // now every route of every `locked` row the catalogue carries, and the
  // comparator is told which labels it is required to hold.
  const lockedProbes = lockedCensus.map((family) => ({ label: family.label, method: family.method, route: family.route }));
  const lockedLabels = lockedCensus.map((family) => family.label);
  const lockedSurfaceIds = [...new Set(lockedCensus.map((family) => family.surfaceKey))].map((key) => surfaceIdByKey.get(key));
  const lockedBefore = await capture(MEMBER_JWT, lockedProbes);
  for (const surfaceId of lockedSurfaceIds) {
    await sql(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
       VALUES ('group', $1, 'surface', $2, 'read'), ('group', $1, 'surface', $2, 'write')`,
      [FIXTURES.group.id, surfaceId]);
  }
  const lockedAfter = await capture(MEMBER_JWT, lockedProbes);
  await sql(`DELETE FROM grants WHERE grantee_id = $1 AND resource_type = 'surface'`, [FIXTURES.group.id]);
  record('D10 (locked)',
    capturesIdentical(lockedBefore, lockedAfter, { minimum: lockedLabels.length, expectedLabels: lockedLabels }),
    `${lockedSurfaceIds.length} locked surfaces, ${lockedLabels.length} declared families`);

  // ══ D6 — the surface-stage refusal shape, exactly when insufficient ══════
  //
  // ROUND-3 REGRESSION `2bf39bb7`. The previous form exercised ONE Account, ONE
  // surface and TWO routes, and then judged each observation against its own
  // `level` / `family` LABELS: six records naming six cells while every one of
  // them issued the same physical `GET /webhooks` returned `ok:true`.
  //
  // The subject is now the CONTRACT CENSUS — every caller state in D5's table x
  // every governable surface the ruling leaves inside the arm x every family
  // that surface DECLARES — and each observation must equal its cell's own
  // method and canonical path. No body is sent: the surface stage runs before
  // any handler, so what a handler would have made of the body is not this
  // drill's subject, and a sufficient cell answering the handler's own 4xx is
  // exactly what "never the surface stage's shape" means.
  const webhookBody = { events: ['task.created'], description: 'setgov drill', active: false };
  const d6Observations = [];
  for (const callerState of D6_CALLER_STATES) {
    await unassignAll();
    if (callerState !== 'none') {
      await assignGroup(callerState === 'use' ? ADMINISTRATIVE.use_profile_id : ADMINISTRATIVE.configure_profile_id);
    }
    for (const cell of d6Census.filter((entry) => entry.callerState === callerState)) {
      const ledgerBefore = await surfaceRefusalCount();
      const answer = await call(cell.method, cell.route, { token: MEMBER_JWT });
      const ledgerAfter = await surfaceRefusalCount();
      d6Observations.push({
        label: `${callerState} ${cell.method} ${cell.route}`,
        callerState, surfaceKey: cell.surfaceKey, familyKey: cell.familyKey,
        method: cell.method, route: cell.route,
        // Which STAGE answered, measured rather than inferred from the code.
        surfaceRefusalRows: ledgerAfter - ledgerBefore,
        ...answer,
      });
      // A cell whose level does not answer its family class is a refusal this
      // drill CAUSED, and §3.6 must find its row inside this run.
      if (!levelAnswers(cell.level, cell.familyClass)) {
        expectRefusal(answer, cell.method, cell.route,
          { surfaceKey: cell.surfaceKey, family: cell.familyClass, accessLevel: cell.level });
      }
      if (answer.status === 201 && answer.body?.subscription?.id) {
        await sql('DELETE FROM webhook_subscriptions WHERE id = $1', [answer.body.subscription.id]).catch(() => undefined);
      }
    }
  }
  await unassignAll();
  record('D6 (surface stage)', d6Verdict(d6Observations, { census: d6Census }),
    `${d6Census.length} contract cells over ${new Set(d6Census.map((c) => c.surfaceKey)).size} surfaces`);

  // ══ D21 — no Access bundle confers an authority-mutation surface ═════════
  //
  // RESCOPED by owner ruling `70af4d82` §1.1 on escalation `94c77997`
  // (2026-09-02). The annex's original assertion — that a surface-stage
  // admission meets the handler's rule-4 refusal — was UNSATISFIABLE:
  // `routes/grants.ts`, `routes/groups.ts` and `routes/accessProfiles.ts` carry
  // no descendant-subtree check at all, so rule 4 has been satisfied vacuously
  // for those families since they were written. The arm is card `3e76cfcc`.
  //
  // Three assertions, drilled apart, plus the escalation's own capture as the
  // negative control. The catalogue read below is the SEEDED one: D1's
  // mutations were restored at line ~414 and nothing since has written these
  // tables.

  // ── (i) registered `governable`, member of nothing, Administrative = four ──
  const d21SurfaceRows = (await sql('SELECT key, governance FROM access_surfaces ORDER BY key')).rows
    .map((row) => ({ key: row.key, governance: row.governance }));
  const d21MemberRows = (await sql(
    `SELECT b.key AS bundle_key, s.key AS surface_key
       FROM access_bundle_members m
       JOIN access_bundles b ON b.id = m.bundle_id
       JOIN access_surfaces s ON s.id = m.surface_id
      ORDER BY b.key, s.key`)).rows
    .map((row) => ({ bundleKey: row.bundle_key, surfaceKey: row.surface_key }));
  record('D21 (i) unbundled', authorityMutationSurfacesUnbundled({
    surfaceRows: d21SurfaceRows,
    memberRows: d21MemberRows,
    administrativeMemberKeys: d21MemberRows.filter((row) => row.bundleKey === 'administrative').map((row) => row.surfaceKey),
  }), `${d21SurfaceRows.length} surfaces, ${d21MemberRows.length} membership rows`);

  // ── (ii) the matrix write refusal, EVERY withheld surface, BOTH stores ────
  //
  // §3.4 makes an Access bundle's profile pair the PROJECTION of its membership
  // onto its governable members, so a matrix write that adds a surface to a
  // bundle lands as an `exact` `surface` rule on that bundle's profile — the
  // write this drill issues. The `grants` store is the other authority path to the same
  // authority and is drilled beside it. Candidate B's `/access-bundles` router
  // calls the same closure for the `access_bundle_members` row itself.
  //
  // Every write here is issued by ROOT: this refusal binds the owner plane,
  // which is the whole point — the escalation was one root act away.
  //
  // ROUND-3 REGRESSION `2eb2061c`. Only #15 was ever attempted, and the control
  // was a write of a DIFFERENT surface through the same stores with no
  // correlation to the refusal's own operation — so one refusal covering only
  // #15 plus an unrelated `GET /health` 200 satisfied the oracle. The attempts
  // are now `buildD21WriteCensus`: every withheld surface x every write store,
  // and each refusal is controlled by the IDENTICAL operation through the
  // IDENTICAL store, naming a surface the bundle DOES carry.
  const surfaceRuleBody = (surfaceId) => ({
    rules: [{ resourceType: 'surface', selectorForm: 'exact', selectorIds: [surfaceId], verbs: ['read', 'write'] }],
  });
  const surfaceGrantBody = (surfaceId) => ({
    granteeType: 'group', granteeId: FIXTURES.group.id, resourceType: 'surface', resourceId: surfaceId, verb: 'write',
  });

  /** One matrix write, through one store, naming one surface. Anything it
   * manages to write is unwound at once, so nothing downstream inherits
   * authority from a control. */
  const attemptMatrixWrite = async (store, surfaceKey) => {
    const surfaceId = surfaceIdByKey.get(surfaceKey);
    if (store === 'profile-rule-projection') {
      const answer = await call('POST', `/access-profiles/${ADMINISTRATIVE.configure_profile_id}/versions`, {
        token: ROOT_JWT, body: surfaceRuleBody(surfaceId),
      });
      if (answer.body?.version?.id) {
        await sql('DELETE FROM access_profile_rules WHERE version_id = $1', [answer.body.version.id]).catch(() => undefined);
        await sql('DELETE FROM access_profile_events WHERE version_id = $1', [answer.body.version.id]).catch(() => undefined);
        await sql('DELETE FROM access_profile_versions WHERE id = $1', [answer.body.version.id]).catch(() => undefined);
      }
      return {
        // `...answer` FIRST: the response payload also arrives as `body`, and
        // the correlation is on the REQUEST body (`43520bf5` B1).
        ...answer,
        label: `${store} naming ${surfaceKey}`, store, surfaceKey, surfaceId,
        method: 'POST', route: `/access-profiles/${ADMINISTRATIVE.configure_profile_id}/versions`,
        body: surfaceRuleBody(surfaceId),
      };
    }
    const answer = await call('POST', '/grants', { token: ROOT_JWT, body: surfaceGrantBody(surfaceId) });
    if (answer.body?.grant?.id) await sql('DELETE FROM grants WHERE id = $1', [answer.body.grant.id]).catch(() => undefined);
    return {
      ...answer,
      label: `${store} naming ${surfaceKey}`, store, surfaceKey, surfaceId,
      method: 'POST', route: '/grants', body: surfaceGrantBody(surfaceId),
    };
  };

  const d21Refusals = [];
  for (const attempt of d21Attempts) d21Refusals.push(await attemptMatrixWrite(attempt.store, attempt.surfaceKey));
  const d21Controls = [];
  for (const store of D21_WRITE_STORES) d21Controls.push(await attemptMatrixWrite(store, 'settings.webhooks'));

  const d21WriteAudit = await auditRowsInRun('access_bundle.refused');
  record('D21 (ii) matrix write refused',
    authorityMutationWritesRefused({
      refusals: d21Refusals, controls: d21Controls, auditRows: d21WriteAudit, expectedAttempts: d21Attempts,
    }),
    `${d21Refusals.length} attempts refused, ${d21Controls.length} same-store controls admitted, ${d21WriteAudit.length} audit rows in run`);

  // ── (iii) the arm never admits them ───────────────────────────────────────
  await unassignAll();
  await assignGroup(ADMINISTRATIVE.configure_profile_id);

  // SETUP CONTROL: the caller really is at Administrative `configure` — proved
  // on #21, which the REDUCED bundle still confers. Without it, five refusals
  // prove only that the fixture holds nothing.
  const d21Setup = await call('POST', '/webhooks', { token: MEMBER_JWT, body: webhookBody });
  if (d21Setup.body?.subscription?.id) {
    await sql('DELETE FROM webhook_subscriptions WHERE id = $1', [d21Setup.body.subscription.id]).catch(() => undefined);
  }

  const authorityRowCount = async () => Number((await sql(
    `SELECT ((SELECT count(*) FROM grants) + (SELECT count(*) FROM groups)
           + (SELECT count(*) FROM group_members) + (SELECT count(*) FROM access_profiles))::int AS n`)).rows[0].n);

  /**
   * The escalation's five acts, verbatim in intent, for one caller.
   *
   * ROUND-3 REGRESSION `18d170f4` — a defect in the round-3 repair itself. The
   * two runs used to DIFFER BY DESIGN: each created its own Group and its own
   * profile and then addressed them, so the correlation needed a normaliser,
   * and that normaliser collapsed every uuid and therefore aliased a stable
   * fixture Group target with a freshly generated profile id.
   *
   * The two runs are now IDENTICAL BY CONSTRUCTION. Every act addresses a
   * STABLE fixture id, and the two names the escalation invents are minted
   * ONCE, above, so the replay and the ROOT control send the same method, the
   * same route and the same body. `normaliseActRoute` is withdrawn: the
   * correlation is exact and there is nothing left to alias.
   *
   * The request body is recorded AFTER `...answer` on purpose — the response
   * payload also arrives as `body`, and it is the REQUEST body that says which
   * act was performed.
   */
  const REPLAY_GROUP_NAME = `d21-replay-group-${Date.now()}`;
  const REPLAY_PROFILE_NAME = `d21-replay-profile-${Date.now()}`;
  const escalationActs = async (token) => {
    const acts = [];
    const act = async (label, method, route, body) => {
      const answer = await call(method, route, { token, body });
      acts.push({ label, method, route, ...answer, body });
      return answer;
    };
    await act('POST /grants (task/admin to a Group)', 'POST', '/grants',
      { granteeType: 'group', granteeId: FIXTURES.group.id, resourceType: 'task', resourceId: FIXTURES.task.id, verb: 'admin' });
    const madeGroup = await act('POST /groups', 'POST', '/groups',
      { name: REPLAY_GROUP_NAME, description: 'D21 replay' });
    await act('POST /groups/:id/members (a foreign Account)', 'POST', `/groups/${FIXTURES.group.id}/members`,
      { accountPrincipalId: FIXTURES.stranger.id });
    const madeProfile = await act('POST /access-profiles', 'POST', '/access-profiles',
      { name: REPLAY_PROFILE_NAME, description: 'D21 replay' });
    // A STABLE fixture profile in BOTH runs. Addressing the profile the run
    // just tried to create would put the two runs on different targets — only
    // the root run succeeds in creating one — which is exactly the divergence
    // `18d170f4` was about. The version is created, never published.
    const madeVersion = await act('POST /access-profiles/:id/versions (task/all-of-type/read+write+admin)', 'POST',
      `/access-profiles/${ADMINISTRATIVE.use_profile_id}/versions`,
      { rules: [{ resourceType: 'task', selectorForm: 'all-of-type', verbs: ['read', 'write', 'admin'] }] });
    return {
      acts,
      groupId: madeGroup.body?.group?.id ?? null,
      profileId: madeProfile.body?.profile?.id ?? null,
      versionId: madeVersion.body?.version?.id ?? null,
    };
  };

  // THE BYPASS. An `exact` `surface` grant naming EVERY withheld surface, read
  // AND write, inserted DIRECTLY IN SQL — bypassing the write refusal (ii)
  // proves — so the arm is drilled against authority rows that EXIST and would
  // compute `configure`. Without this, (iii) would be satisfied by "the seed
  // names no rule", which is true whether or not the arm's short-circuit is
  // there at all: the annex's red mutation for (iii) could be applied with
  // every drill still green. This is the D10/D19 shape at the rung the ruling
  // is about. Round 3 armed only two of the three; the census arms all of them.
  for (const surfaceKey of AUTHORITY_MUTATION_SURFACE_KEYS) {
    await sql(
      `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
       VALUES ('group', $1, 'surface', $2, 'read'), ('group', $1, 'surface', $2, 'write')
       ON CONFLICT DO NOTHING`, [FIXTURES.group.id, surfaceIdByKey.get(surfaceKey)]);
  }

  const d21MemberBefore = await authorityRowCount();
  const d21Member = await escalationActs(MEMBER_JWT);
  const d21MemberAfter = await authorityRowCount();
  // Step 4b writes a row for each: §3.6 must find all five too, not only
  // D21 (iii)'s own correlation.
  // Step 4b writes a row for each, BEFORE a family class or a level exists, so
  // the contract names the withheld surface, `family: null` and `none`. The
  // surface comes from the ratified transcription, matched with production's
  // own family matcher rather than by re-parsing the URL here.
  for (const act of d21Member.acts) {
    const want = RATIFIED_ESCALATION_ACTS.find((entry) => contract.familyMatchesRequest(
      entry.familyKey, String(act.method).toUpperCase(), canonicalPath(act.route)));
    expectRefusal(act, act.method, act.route,
      want ? { surfaceKey: want.surfaceKey, family: null, accessLevel: 'none' } : {});
  }

  // ── (iii) supplement — THE WITHHELD FAMILY SWEEP ──────────────────────────
  //
  // The five acts above are the escalation VERBATIM, and that is their value;
  // they are also only five requests, covering some write families of #15 and
  // #18 and nothing at all of #17. Owner ruling `70af4d82` §1.1 is a claim
  // about EVERY family of all three withheld surfaces, and annex D6's last
  // sentence puts those families here rather than in D6 — which is why D6's
  // census excludes exactly this set. So every one of them is measured, at
  // Administrative `configure`, with the bypass rows still in place: each must
  // answer the ratified ROOT refusal the family gave before SETGOV, never this
  // design's 404 concealment and never its 403 naming the surface.
  const withheldSweep = [];
  for (const family of withheldFamilies) {
    const answer = await call(family.method, family.route, { token: MEMBER_JWT });
    withheldSweep.push({ label: `${family.surfaceKey} ${family.familyKey}`, ...answer });
    expectRefusal(answer, family.method, family.route,
      { surfaceKey: family.surfaceKey, family: null, accessLevel: 'none' });
  }
  const notRootRefusal = withheldSweep.filter((row) => surfaceStageShape(row) !== 'route-refusal');
  record('D21 (iii) withheld family sweep', notRootRefusal.length === 0
    ? { ok: true, reason: `all ${withheldSweep.length} declared families of the ${AUTHORITY_MUTATION_SURFACE_KEYS.length} withheld surfaces answered the ratified ROOT refusal at Administrative configure, with read+write surface grants naming all three in place` }
    : { ok: false, reason: `${notRootRefusal.length} of ${withheldSweep.length} withheld families did not answer the ratified root refusal: ${notRootRefusal.map((row) => `${row.label} ${row.status} ${row.code ?? ''} (${surfaceStageShape(row)})`).join(', ')}` },
    `${withheldFamilies.length} families over ${AUTHORITY_MUTATION_SURFACE_KEYS.length} surfaces`);

  // ── the negative control: the escalation's OWN capture, re-run ────────────
  //
  // It runs HERE, while the bypass rows are still in place, so it is measured
  // under the same conditions the finding was: an instrument that ran with no
  // authority row present would refuse for a reason that has nothing to do
  // with this closure. DECLARED DEPENDENCY (annex §8.1): the arm mutation that
  // reddens (iii) also reddens this, so the negative control is NOT
  // independent evidence for (iii). It answers a different question — "does
  // the instrument that captured the escalation still capture it?" — and (iii)
  // owns the refusal SHAPE, which this does not judge.
  const d21Capture = await runEscalationCapture();
  record('D21 negative control', escalationCaptureRefused(d21Capture.evidence),
    d21Capture.error ? `capture stderr: ${d21Capture.error.slice(0, 120)}` : '');

  // The same five acts as ROOT, in the same run. Rule 4 exempts root and the
  // route ceiling admits it, so these MUST succeed and MUST move rows. The
  // bypass rows come out first: root does not need them and no later drill
  // should inherit them.
  await sql("DELETE FROM grants WHERE grantee_id = $1 AND resource_type = 'surface'", [FIXTURES.group.id]);
  const d21RootBefore = await authorityRowCount();
  const d21Root = await escalationActs(ROOT_JWT);
  const d21RootAfter = await authorityRowCount();

  const d21ArmAudit = await auditRowsInRun('surface.refused');
  record('D21 (iii) arm never admits', authorityMutationArmNeverAdmits({
    observations: d21Member.acts,
    rowsBefore: d21MemberBefore,
    rowsAfter: d21MemberAfter,
    sufficientControl: d21Setup,
    rootControl: { acts: d21Root.acts, rowsBefore: d21RootBefore, rowsAfter: d21RootAfter },
    auditRows: d21ArmAudit,
    ratifiedActs: RATIFIED_ESCALATION_ACTS,
    familyMatches: contract.familyMatchesRequest,
    expectedRefusals: d21Member.acts.map((a) => ({
      method: a.method,
      path: canonicalPath(a.route),
      // The rows THIS act's own request wrote (`5cfe851b` B1): five acts used
      // to be accepted against every row the run had written by then.
      rowIds: REQUEST_LEDGER.find((row) => row.seq === a.seq)?.rowIds ?? null,
    })),
  }), `non-root ${d21Member.acts.map((a) => a.status).join('/')}, root ${d21Root.acts.map((a) => a.status).join('/')}`);

  // Unwind everything the ROOT control created, so no later drill inherits it.
  await sql("DELETE FROM grants WHERE resource_type = 'task' AND grantee_id = $1", [FIXTURES.group.id]).catch(() => undefined);
  await sql('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
    [FIXTURES.group.id, FIXTURES.stranger.id]).catch(() => undefined);
  for (const profileId of [d21Root.profileId, d21Member.profileId].filter(Boolean)) {
    await sql('UPDATE access_profiles SET published_version_id = NULL WHERE id = $1', [profileId]).catch(() => undefined);
    await sql('DELETE FROM access_profile_events WHERE profile_id = $1', [profileId]).catch(() => undefined);
    await sql(`DELETE FROM access_profile_rules WHERE version_id IN
                 (SELECT id FROM access_profile_versions WHERE profile_id = $1)`, [profileId]).catch(() => undefined);
    await sql('DELETE FROM access_profile_versions WHERE profile_id = $1', [profileId]).catch(() => undefined);
    await sql('DELETE FROM access_profiles WHERE id = $1', [profileId]).catch(() => undefined);
  }
  for (const versionId of [d21Root.versionId, d21Member.versionId].filter(Boolean)) {
    await sql('DELETE FROM access_profile_rules WHERE version_id = $1', [versionId]).catch(() => undefined);
    await sql('DELETE FROM access_profile_events WHERE version_id = $1', [versionId]).catch(() => undefined);
    await sql('DELETE FROM access_profile_versions WHERE id = $1', [versionId]).catch(() => undefined);
  }
  for (const groupId of [d21Root.groupId, d21Member.groupId].filter(Boolean)) {
    await sql('DELETE FROM group_members WHERE group_id = $1', [groupId]).catch(() => undefined);
    await sql('DELETE FROM groups WHERE id = $1', [groupId]).catch(() => undefined);
  }

  // ══ D13 — a disable takes effect on the very next request ════════════════
  await unassignAll();
  await assignGroup(ADMINISTRATIVE.use_profile_id);
  const beforeDisable = await call('GET', '/webhooks', { token: MEMBER_JWT });
  await sql("UPDATE principals SET status = 'disabled' WHERE id = $1", [FIXTURES.member.id]);
  const afterDisable = await call('GET', '/webhooks', { token: MEMBER_JWT });
  // A disabled Account is refused by the AUTHENTICATION stage, which never
  // reaches the arm and writes no `surface.refused` row. Declaring it as a
  // caused surface-stage refusal would make §3.6 fail for the wrong reason -
  // and under the round-3 aggregate correlation it silently PASSED, covered by
  // a sibling `GET /webhooks` row. The attributed correlation is what made
  // that visible; the expectation is withdrawn because the stage table at the
  // top of this file says step 5's authentication refusal is the one that does
  // NOT write a row here.
  if ((afterDisable.seq ?? 0) > 0 && (REQUEST_LEDGER.find((row) => row.seq === afterDisable.seq)?.rowIds ?? []).length > 0) {
    expectRefusal(afterDisable, 'GET', '/webhooks');
  }
  await sql("UPDATE principals SET status = 'active' WHERE id = $1", [FIXTURES.member.id]);
  record('D13 (disable)', tookEffectImmediately({ before: beforeDisable, after: afterDisable }));

  // ══ D17 — a bearer credential is never widened onto a core surface ═══════
  //
  // ROUND-3 REGRESSION `1324ba78`. The `surface` grant and the direct profile
  // assignment used to be installed SIMULTANEOUSLY for each bearer, so a defect
  // isolated to either authority store could not be attributed to it; and the
  // oracle validated whatever it was handed, so ONE Connector GET refusal plus
  // ONE matched session GET returned `ok:true`. Each cell of
  // `buildD17Census` — bearer x authority store x family class — is now a
  // SEPARATE run with EXACTLY ONE store armed, and the isolation is measured
  // rather than claimed.
  await unassignAll();
  await assignGroup(ADMINISTRATIVE.configure_profile_id);
  const webhooksRow = catalogue.surfaceRows.find((row) => row.key === 'settings.webhooks');
  // Both dimensions are RATIFIED, not chosen: the stores are the two seams
  // `AccessSurfaceService.surfaceLevel` composes, read out of the SQL they
  // generate, and the bearers are every credential-holding principal the
  // manifest hands over (`5cfe851b` B2). `buildD17Census` REFUSES anything but
  // the ratified set, so a reduced matrix is an exception, not a smaller pass.
  const ratifiedBearers = await ratifiedBearerKinds(contract);
  const d17Census = buildD17Census(contract, {
    surfaceRow: webhooksRow,
    bearers: ratifiedBearers.map((entry) => entry.bearer),
    stores: ratifiedStores,
  });
  const d17ControlTargets = d17ControlUrls(d17Census);
  const bearerByName = Object.fromEntries(ratifiedBearers.map((entry) => [entry.bearer, entry]));
  /**
   * Arm ONE authority store at ONE ratified level for one principal.
   *
   * ROUND-4 EXTRA VERDICT `36e8588e` B3: the plugin half exercised `none` and
   * `configure` only, so `use` — the one level at which a read family and a
   * write family must answer differently — was never measured where the arm
   * narrows. `use` is `read` alone through the grant store and the
   * Administrative `use` profile through the assignment store; those are the
   * two ways the substrate expresses it, not a third mechanism invented here.
   */
  const armStore = async (store, principalId, level = 'configure') => {
    if (level === 'none') return;
    if (store === 'surface-grant') {
      const verbs = level === 'use' ? ["('principal', $1, 'surface', $2, 'read')"]
        : ["('principal', $1, 'surface', $2, 'read')", "('principal', $1, 'surface', $2, 'write')"];
      await sql(
        `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
         VALUES ${verbs.join(', ')} ON CONFLICT DO NOTHING`, [principalId, webhooksSurface]);
      return;
    }
    const profileId = level === 'use' ? ADMINISTRATIVE.use_profile_id : ADMINISTRATIVE.configure_profile_id;
    await sql(
      `INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id)
       VALUES ($1, 'principal', $2) ON CONFLICT DO NOTHING`, [profileId, principalId]);
  };
  const disarmStores = async (principalId) => {
    await sql(`DELETE FROM grants WHERE grantee_id = $1 AND resource_type = 'surface'`, [principalId]);
    await sql(`DELETE FROM access_profile_assignments WHERE assignee_id = $1`, [principalId]);
  };
  const storeRowCounts = async (principalId) => ({
    grants: Number((await sql(
      `SELECT count(*)::int AS n FROM grants WHERE grantee_id = $1 AND resource_type = 'surface'`, [principalId])).rows[0].n),
    assignments: Number((await sql(
      'SELECT count(*)::int AS n FROM access_profile_assignments WHERE assignee_id = $1', [principalId])).rows[0].n),
  });

  const bearerObservations = [];
  const isolationChecks = [];
  for (const bearerName of ratifiedBearers.map((entry) => entry.bearer)) {
    const who = bearerByName[bearerName];
    for (const store of ratifiedStores) {
      await disarmStores(who.id);
      await armStore(store, who.id);
      isolationChecks.push({ bearer: bearerName, store, ...(await storeRowCounts(who.id)) });
      for (const cell of d17Census.filter((entry) => entry.bearer === bearerName && entry.store === store)) {
        const answer = await call(cell.method, cell.route, { bearer: who.credential });
        bearerObservations.push({
          label: `${bearerName} via ${store}: ${cell.method} ${cell.route}`,
          bearer: bearerName, store, familyClass: cell.familyClass,
          method: cell.method, route: cell.route, ...answer,
        });
        // A CORE surface refuses every bearer at step 5, BEFORE a family class
        // or a level exists — so the row the contract requires carries the
        // surface, `family: null` and the level the pre-family rung records.
        expectRefusal(answer, cell.method, cell.route,
          { surfaceKey: cell.surfaceKey, family: null, accessLevel: 'none' });
      }
      await disarmStores(who.id);
    }
  }
  // THE ISOLATION CONTROL. Without it, "one store armed" is a sentence in a
  // comment: the drill could have armed both and the matrix would still look
  // complete. Exactly one store must hold rows in each run.
  const notIsolated = isolationChecks.filter((check) => (check.store === 'surface-grant'
    ? !(check.grants > 0 && check.assignments === 0)
    : !(check.assignments > 0 && check.grants === 0)));
  record('D17 (authority stores isolated)', notIsolated.length === 0
    ? { ok: true, reason: `${isolationChecks.length} runs, each with exactly ONE authority store holding rows for the bearer (${isolationChecks.map((c) => `${c.bearer}/${c.store} g${c.grants}/a${c.assignments}`).join(', ')})` }
    : { ok: false, reason: `${notIsolated.length} run(s) did not isolate the store, so a defect in either could not be attributed: ${notIsolated.map((c) => `${c.bearer}/${c.store} grants=${c.grants} assignments=${c.assignments}`).join('; ')}` });

  // The same-run positive control: the owning Account's LOGIN SESSION, holding
  // the same authority through its Group, on the SAME URLs.
  const sessionObservations = [];
  for (const target of d17ControlTargets) {
    const answer = await call(target.method, target.route, { token: MEMBER_JWT, body: target.method === 'POST' ? webhookBody : undefined });
    sessionObservations.push({ label: `session ${target.method} ${target.route}`, method: target.method, route: target.route, ...answer });
    if (answer.status === 201 && answer.body?.subscription?.id) {
      await sql('DELETE FROM webhook_subscriptions WHERE id = $1', [answer.body.subscription.id]).catch(() => undefined);
    }
  }
  // THE BEARER REACH CONTROL. Without it, a credential that fails to
  // authenticate at all answers 401 to every probe and the drill reads four
  // refusals as proof of the authentication-kind check. That is exactly what
  // happened on this drill's first run.
  const bearerReach = await call('GET', '/principals/me', { bearer: FIXTURES.connector.credential });
  record('D17 (bearer never widens)',
    surfaceStageShape(bearerReach) === 'admitted'
      ? bearerNeverWidensCore({ bearerObservations, sessionObservations, bearerReach, census: d17Census })
      : { ok: false, reason: `the connector's bearer credential did not authenticate at all (GET /principals/me answered ${bearerReach.status}) — its refusals above are not the arm's` },
    `${d17Census.length} matrix cells, bearer reach control ${bearerReach.status}`);

  // ── D17's PLUGIN half — the OPPOSITE expectation (annex D17, design I6) ───
  //
  // The annex's last D17 sentence: repeat the matrix for a PLUGIN surface,
  // where the bearer is admitted at `use` and refused at `none`, because there
  // the arm only NARROWS. It is installed the way D16's hostile fixture is —
  // directly in SQL, against the running server — by flipping
  // `settings.webhooks` to `origin='plugin'`: the same families, the same
  // routes, the same credential, so the ONLY thing that differs between the
  // two halves is the origin the arm branches on at step 5. Inventing a new
  // plugin surface on a fresh path would have added a route no router serves
  // (the registry control above would refuse it) or collided with a surface
  // that already owns that path (D15).
  //
  // ROUND-4 REVIEW `5cfe851b` B3: this used to arm ONE bearer through ONE
  // store, so a defect isolated to the Agent bearer or to the surface-grant
  // store stayed green in the half that proves the arm still NARROWS. It now
  // repeats the WHOLE matrix, one store armed per run, exactly as the core
  // half does.
  await sql("UPDATE access_surfaces SET origin = 'plugin', plugin_name = 'drill.plugin-fixture' WHERE key = 'settings.webhooks'");
  const pluginLevelCensus = buildPluginLevelCensus(contract, {
    coreCells: d17Census,
    levels: [...contract.ACCESS_LEVELS],
  });
  const pluginObservations = [];
  const pluginIsolation = [];
  for (const bearerName of ratifiedBearers.map((entry) => entry.bearer)) {
    const who = bearerByName[bearerName];
    for (const store of ratifiedStores) {
      for (const level of contract.ACCESS_LEVELS) {
        const cells = pluginLevelCensus.filter((cell) => cell.bearer === bearerName
          && cell.store === store && cell.level === level);
        await disarmStores(who.id);
        await armStore(store, who.id, level);
        // EXACTLY ONE store armed, measured — at `none` neither holds a row,
        // which is the state itself and is recorded as such.
        pluginIsolation.push({ bearer: bearerName, store, level, ...(await storeRowCounts(who.id)) });
        for (const cell of cells) {
          const answer = await call(cell.method, cell.route, {
            bearer: who.credential,
            body: cell.method === 'POST' && cell.expectAdmitted ? webhookBody : undefined,
          });
          pluginObservations.push({
            label: `plugin at ${level}, ${bearerName} via ${store}: ${cell.method} ${cell.route}`,
            bearer: bearerName, store, familyClass: cell.familyClass, level,
            method: cell.method, route: cell.route, ...answer,
          });
          if (!cell.expectAdmitted) {
            expectRefusal(answer, cell.method, cell.route,
              { surfaceKey: cell.surfaceKey, family: cell.familyClass, accessLevel: level });
          }
          if (answer.status === 201 && answer.body?.subscription?.id) {
            await sql('DELETE FROM webhook_subscriptions WHERE id = $1', [answer.body.subscription.id]).catch(() => undefined);
          }
        }
        await disarmStores(who.id);
      }
    }
  }
  const pluginNotIsolated = pluginIsolation.filter((check) => {
    if (check.level === 'none') return !(check.grants === 0 && check.assignments === 0);
    return check.store === 'surface-grant'
      ? !(check.grants > 0 && check.assignments === 0)
      : !(check.assignments > 0 && check.grants === 0);
  });
  record('D17 (plugin stores isolated)', pluginNotIsolated.length === 0
    ? { ok: true, reason: `${pluginIsolation.length} plugin runs, each holding rows in exactly the ONE store its level arms and nothing at \`none\` (${pluginIsolation.map((c) => `${c.bearer}/${c.store}@${c.level} g${c.grants}/a${c.assignments}`).join(', ')})` }
    : { ok: false, reason: `${pluginNotIsolated.length} plugin run(s) did not isolate the store: ${pluginNotIsolated.map((c) => `${c.bearer}/${c.store}@${c.level} grants=${c.grants} assignments=${c.assignments}`).join('; ')}` });

  // THE CORE CONTRAST: the identical credential, holding the identical
  // authority, on the identical URL, with the origin flipped back.
  const contrastBearer = bearerByName[ratifiedBearers[0].bearer];
  await armStore(ratifiedStores[0], contrastBearer.id, 'configure');
  await sql("UPDATE access_surfaces SET origin = 'core', plugin_name = NULL WHERE key = 'settings.webhooks'");
  const pluginCoreContrast = await call('GET', '/webhooks', { bearer: contrastBearer.credential });
  expectRefusal(pluginCoreContrast, 'GET', '/webhooks',
    { surfaceKey: 'settings.webhooks', family: null, accessLevel: 'none' });
  await disarmStores(contrastBearer.id);
  record('D17 (plugin half — the arm only narrows)',
    pluginBearerNarrowsOnly({
      observations: pluginObservations,
      coreContrast: pluginCoreContrast, census: pluginLevelCensus,
    }),
    `${pluginLevelCensus.length} plugin matrix cells over ${contract.ACCESS_LEVELS.length} ratified levels, core contrast ${pluginCoreContrast.status}`);

  // D17 supplement (§5.2, run packet decision 6): the `D-5` reachability  // D17 supplement (§5.2, run packet decision 6): the `D-5` reachability
  // widening, ridden on this fixture set without renumbering the annex.
  const bearerSelf = await call('GET', '/principals/me/effective-access', { bearer: FIXTURES.connector.credential });
  const bearerBrief = await call('POST', '/principals/me/brief', { bearer: FIXTURES.connector.credential, body: {} });
  record('D17 supplement (D-5 ripple)',
    (surfaceStageShape(bearerSelf) === 'admitted' && bearerBrief.status === 403)
      ? { ok: true, reason: `a bearer holding no principals:read now reaches its OWN effective access (${bearerSelf.status}) and still cannot compile a Brief (${bearerBrief.status})` }
      : { ok: false, reason: `effective-access ${bearerSelf.status}, brief ${bearerBrief.status} — the declared widening is not what shipped` });

  // ══ D16 — the ORDERING guard, not the census ═════════════════════════════
  // A hostile surface installed by direct SQL, bypassing the boot census that
  // would have refused it, declaring the scope-gated family `/tasks`.
  // The scope-gated family is `POST /tasks` (`tasks:write`), not `GET /tasks`.
  // `principals_role_check` admits no role that lacks `tasks:read`, so a
  // fixture Account whose GET /tasks is refused at the route stage cannot
  // exist in this substrate — and a caller the route stage ADMITS never
  // reaches the arm for an uninteresting reason, which is the vacuity the
  // v2.0 form of this drill was rejected for. A `viewer` holds `tasks:read`
  // and not `tasks:write`, so `POST /tasks` is the same control, refused at
  // exactly the rung D16 is about.
  const hostile = (await sql(
    `INSERT INTO access_surfaces (key, label, governance, read_families, write_families, origin)
     VALUES ('hostile.fixture', 'Hostile fixture', 'governable', '{}', ARRAY['POST /tasks'], 'core')
     RETURNING id::text AS id`)).rows[0].id;
  await sql(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
     VALUES ('group', $1, 'surface', $2, 'read'), ('group', $1, 'surface', $2, 'write')`,
    [FIXTURES.group.id, hostile]);
  const marker = serverLog.length;
  const hostileAnswer = await call('POST', '/tasks', { token: MEMBER_JWT, body: { title: 'setgov drill hostile probe' } });
  // Something must reach the arm in the same window, or the record is empty for
  // an uninteresting reason and the drill would pass vacuously.
  await call('GET', '/webhooks', { token: MEMBER_JWT });
  const window = serverLog.slice(marker).join('').split('\n');
  await sql(`DELETE FROM grants WHERE resource_type = 'surface' AND resource_id = $1`, [hostile]);
  await sql('DELETE FROM access_surfaces WHERE id = $1', [hostile]);
  record('D16 (ordering guard)',
    hostileAnswer.status >= 400
      ? armRecordExcludes(window, ['/tasks'])
      : { ok: false, reason: `POST /tasks was ADMITTED (${hostileAnswer.status}); the route stage never refused, so the arm's absence proves nothing about ordering` },
    `POST /tasks answered ${hostileAnswer.status}`);

  // ── D16's AMENDMENT CONTROL — why the row is `POST /tasks` ───────────────
  //
  // ROUND-4 EXTRA VERDICT `36e8588e` B4, and run packet `f58303dc` §1.3, which
  // rules: amend the annex row to what the substrate argues, or re-drill
  // `GET /tasks` if it does not. The substrate argues for the amendment — but
  // NOT for the reason the source used to give, which was wrong twice:
  // `062_identity_substrate.sql:16-19` makes `principals.role` NULLABLE (a CHECK
  // admits NULL), and `identityScopes.ts:58-60`'s empty fallback is not reached
  // for a session, because `resolveActorRole` resolves a role-less Account to
  // `'agent'` first (`taskAutomationRole.ts:37-43`). This round MEASURED that:
  // a role-less Account, with a hostile surface declaring `GET /tasks` and
  // read+write grants naming it, answered 200.
  //
  // So the amendment stands on a stronger and now DRILLED argument, below.
  const rolelessHandle = `setgov-d16-roleless-${Date.now()}`;
  const roleless = (await sql(
    `INSERT INTO principals (kind, handle, display_name, status)
     VALUES ('human', $1, 'SETGOV D16 role-less account', 'active')
     RETURNING id::text AS id, role`, [rolelessHandle])).rows[0];
  const ROLELESS_JWT = loginSession(rolelessHandle, roleless.id);
  const hostileRead = (await sql(
    `INSERT INTO access_surfaces (key, label, governance, read_families, write_families, origin)
     VALUES ('hostile.fixture.read', 'Hostile fixture (read)', 'governable', ARRAY['GET /tasks'], '{}', 'core')
     RETURNING id::text AS id`)).rows[0].id;
  await sql(
    `INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb)
     VALUES ('principal', $1, 'surface', $2, 'read'), ('principal', $1, 'surface', $2, 'write')`,
    [roleless.id, hostileRead]);
  const rolelessAnswer = await call('GET', '/tasks', { token: ROLELESS_JWT });
  // The SAME caller on a route the arm DOES serve, so its own refusal proves
  // the session is live rather than rejected at authentication.
  const rolelessReach = await call('GET', '/webhooks', { token: ROLELESS_JWT });
  await sql(`DELETE FROM grants WHERE resource_type = 'surface' AND resource_id = $1`, [hostileRead]);
  await sql('DELETE FROM access_surfaces WHERE id = $1', [hostileRead]);
  await sql('DELETE FROM principals WHERE id = $1', [roleless.id]).catch(() => undefined);

  // THE STATIC HALF: every role the substrate admits, and the role a role-less
  // Account resolves to on each handle branch, derived through PRODUCTION'S OWN
  // route-stage predicates. The role vocabulary is read out of migration 062's
  // CHECK rather than listed here, so a tenth role added tomorrow is measured.
  const roleCheck = /role\s+VARCHAR\(\d+\)\s+CHECK\s*\(role\s+IN\s*\(([\s\S]*?)\)\)/i
    .exec(readFileSync(path.join(BACKEND, 'src', 'migrations', '062_identity_substrate.sql'), 'utf8'));
  const substrateRoles = roleCheck ? [...roleCheck[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
  const HANDLE_BRANCHES = ['dashboard_user', 'clawbeat_reviewer', 'hermes_qa', 'setgov-d16-roleless-x'];
  const requiredForRead = contract.requiredScopeFor('GET', '/tasks');
  const requiredForWrite = contract.requiredScopeFor('POST', '/tasks');
  const readSatisfiers = [
    ...substrateRoles.map((role) => ({ who: `role '${role}'`, scopes: contract.scopesForRole(role) })),
    ...HANDLE_BRANCHES.map((handle) => ({
      who: `role-less Account handled '${handle}'`,
      scopes: contract.scopesForRole(contract.resolveActorRole({ handle, principalRole: undefined })),
    })),
  ];
  const readRefusable = readSatisfiers.filter((entry) => !contract.scopesSatisfy(entry.scopes, requiredForRead));
  const writeRefusable = readSatisfiers.filter((entry) => !contract.scopesSatisfy(entry.scopes, requiredForWrite));

  /**
   * D16's AMENDMENT CONTROL (run packet `f58303dc` §1.3).
   *
   * Annex `85a2218d` D16 names `GET /tasks`; this drill exercises
   * `POST /tasks`. The substitution is now AMENDED rather than assumed, and
   * this is the amendment's evidence, measured every run in two halves:
   *
   *   STATIC — no login-session caller this substrate admits can be refused at
   *   the ROUTE STAGE on `GET /tasks`. Every role migration 062's CHECK admits
   *   derives a set holding `tasks:read`, and a role-less Account does NOT fail
   *   closed to `[]`: `resolveActorRole` falls through to `'agent'`
   *   (`utils/taskAutomationRole.ts:43`), whose set is every mintable non-root
   *   non-`:admin` scope (`utils/identityScopes.ts:49-51`).
   *
   *   LIVE — the weakest login session the substrate admits (a role-less
   *   Account) is ADMITTED on `GET /tasks` even with a hostile surface
   *   declaring that family and read+write grants naming it. The arm is
   *   therefore never reached on that family for an UNINTERESTING reason,
   *   which is precisely the vacuity the v2.0 form of this drill was rejected
   *   for — not evidence of ordering.
   *
   * And `POST /tasks` IS refusable: `viewer` holds `tasks:read` and not
   * `tasks:write`, so the drill above measures the same guard at the same rung
   * on a caller the route stage really does refuse.
   */
  record('D16 (amendment control: GET /tasks cannot be route-refused, POST /tasks can)',
    (substrateRoles.length > 0 && readRefusable.length === 0 && writeRefusable.length > 0
      && roleless.role === null && rolelessAnswer.status === 200 && rolelessReach.status !== 401)
      ? {
        ok: true,
        reason: `no caller this substrate admits is route-refused on GET /tasks (${requiredForRead}): all ${substrateRoles.length} roles of migration 062's CHECK and all ${HANDLE_BRANCHES.length} role-less handle branches satisfy it, and the weakest of them — a role-less Account resolving to '${contract.resolveActorRole({ handle: 'setgov-d16-roleless-x', principalRole: undefined })}' — was ADMITTED (${rolelessAnswer.status}) with a hostile surface declaring GET /tasks and read+write grants naming it; POST /tasks (${requiredForWrite}) IS refusable for ${writeRefusable.length} of them, so the annex row is amended to the write family`,
      }
      : {
        ok: false,
        reason: `the amendment's premise does not hold: ${substrateRoles.length} roles parsed from 062, ${readRefusable.length} of them route-refusable on GET /tasks (${readRefusable.map((e) => e.who).join(', ') || 'none'}), ${writeRefusable.length} refusable on POST /tasks, role-less fixture role ${JSON.stringify(roleless.role)} answered ${rolelessAnswer.status} on GET /tasks and ${rolelessReach.status} on GET /webhooks`,
      },
    `${substrateRoles.length} substrate roles; role-less Account GET /tasks ${rolelessAnswer.status}, GET /webhooks ${rolelessReach.status}`);

  // ══ §3.6 — every refusal is audited with the surface key and the level ═══
  //
  // Every `surface.refused` row THIS RUN wrote, and no other. Round 3's form
  // read every row in the table (finding `93a7cbdb`, self-filed): on a reused
  // database an earlier run's rows covered this run's refusals, so a stage that
  // silently stopped auditing would still have been correlated by history. The
  // boundary was captured before the first request and its own control ran
  // above.
  const auditRows = await auditRowsInRun('surface.refused');
  record('audit (§3.6)', refusalsAudited(auditRows, {
    expected: causedRefusals, minimum: causedRefusals.length,
    runBoundary: RUN_BOUNDARY, ledger: REQUEST_LEDGER,
    accessLevels: [...contract.ACCESS_LEVELS],
  }), `${causedRefusals.length} caused refusals attributed across ${REQUEST_LEDGER.length} recorded requests, ${auditRows.length} rows inside run ${RUN_BOUNDARY.runId}`);

  // ── close ────────────────────────────────────────────────────────────────
  await unassignAll();
  await restoreCatalogue();
  await stopServer();
  await pool.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} drills pass`);
  if (failed.length > 0) {
    console.log(`FAILING: ${failed.map((r) => r.drill).join(', ')}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await stopServer().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
