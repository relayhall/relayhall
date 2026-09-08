#!/usr/bin/env node
/**
 * setgov-d21-capture — THE ESCALATION'S OWN INSTRUMENT, kept as D21's negative
 * control (owner ruling `70af4d82` §2, annex `85a2218d` D21).
 *
 * This is the script that produced escalation `94c77997` §2: a `viewer`-role
 * Account holding no `root`, no `:write` and no `:admin` scope, in a Group
 * placed at Administrative `configure` by an ordinary root matrix act, doing
 * five things it must not — five 201s, on a real migrated PostgreSQL over the
 * HTTP seam. It is committed unchanged in what it ASKS FOR, so that the D21
 * drill's pass answers "the instrument that captured the escalation no longer
 * captures it", not "my new probe refuses".
 *
 * Two changes from the capture as it ran at `b408220`, both declared:
 *   1. the base URL, the JWT secret and the repository root come from the
 *      environment instead of being hardcoded to one worktree path;
 *   2. the caller's ROLE is read from the database rather than from a response
 *      body, because a shape that stops carrying `role` would otherwise read
 *      as "not root" for the wrong reason.
 *
 * Environment (all required except DRILL_BASE / JWT_SECRET):
 *   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD   a DISPOSABLE database
 *   DRILL_FIXTURES   the manifest from `environments/dev-setgov-fixtures`
 *   RELAYHALL_REPO   the product checkout whose `pg` this borrows
 *   DRILL_BASE       default http://127.0.0.1:3996
 *
 * It prints ONE JSON object on stdout and judges nothing: the verdict is
 * `escalationCaptureRefused` in `scripts/setgov-drill-oracles.mjs`, which has
 * its own controls. It cleans up every row it creates.
 */
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.RELAYHALL_REPO || path.join(HERE, '..');
const BASE = process.env.DRILL_BASE || 'http://127.0.0.1:3996';
const SECRET = process.env.JWT_SECRET || 'setgov-drill-secret-not-for-production-0123456789abcdef';

const FORBIDDEN_DB_NAMES = new Set(['relayhall_tst', 'relayhall_prod', 'relayhall', 'clawboard']);
if (!process.env.DB_NAME || FORBIDDEN_DB_NAMES.has(process.env.DB_NAME)) {
  console.error(`DB_NAME must name a DISPOSABLE database (got '${process.env.DB_NAME ?? '(unset)'}')`);
  process.exit(2);
}
if (!process.env.DRILL_FIXTURES) {
  console.error('DRILL_FIXTURES must point at the manifest written by environments/dev-setgov-fixtures');
  process.exit(2);
}

const F = JSON.parse(readFileSync(process.env.DRILL_FIXTURES, 'utf8'));
const require_ = createRequire(path.join(REPO, 'backend', 'package.json'));
const { Pool } = require_('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});

const b64 = (x) => Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwt(handle, sub) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const n = Math.floor(Date.now() / 1000);
  const b = b64(JSON.stringify({ v: 2, handle, sub, kind: 'human', iat: n, exp: n + 3600 }));
  const s = createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${b}.${s}`;
}
const MEMBER = jwt(F.member.handle, F.member.id);

async function call(method, route, token, body) {
  const r = await fetch(BASE + route, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try { payload = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: payload };
}

const admin = F.bundles.find((b) => b.key === 'administrative');

// Place the Group at Administrative `configure` — the ordinary matrix act the
// design intends candidate C to make routine.
await pool.query(
  `INSERT INTO access_profile_assignments (profile_id, assignee_type, assignee_id)
   VALUES ($1, 'group', $2) ON CONFLICT DO NOTHING`, [admin.configure_profile_id, F.group.id]);

const evidence = {};

// 1 · /grants — grant an ADMIN verb over a Task to a Group.
const before = await pool.query('SELECT count(*)::int n FROM grants');
const grant = await call('POST', '/grants', MEMBER, {
  granteeType: 'group', granteeId: F.group.id,
  resourceType: 'task', resourceId: F.task.id, verb: 'admin',
});
const after = await pool.query('SELECT count(*)::int n FROM grants');
evidence.grants = {
  status: grant.status,
  code: grant.body?.code ?? null,
  rowsBefore: before.rows[0].n,
  rowsAfter: after.rows[0].n,
  createdGrant: grant.body?.grant
    ? { resourceType: grant.body.grant.resourceType, verb: grant.body.grant.verb, granteeType: grant.body.grant.granteeType }
    : null,
};

// 2 · /groups — create a Group, then add an Account this caller does not own.
const group = await call('POST', '/groups', MEMBER, { name: `d21-evidence-${Date.now()}`, description: 'D21 evidence' });
evidence.groups = { status: group.status, code: group.body?.code ?? null, createdId: group.body?.group?.id ?? null };
// The foreign-membership act is issued against the caller's OWN Group when the
// creation above is refused, so the act is always attempted: an act skipped
// because a previous one refused would read as a pass it never earned.
const membershipTarget = group.body?.group?.id ?? F.group.id;
const member = await call('POST', `/groups/${membershipTarget}/members`, MEMBER, {
  accountPrincipalId: F.stranger.id,
});
evidence.groupMembers = { status: member.status, code: member.body?.code ?? null, targetIsForeignAccount: true };

// 3 · /access-profiles — create a profile and publish a version granting
//     `task` admin over everything.
const profile = await call('POST', '/access-profiles', MEMBER, { name: `d21-evidence-${Date.now()}`, description: 'D21 evidence' });
evidence.accessProfiles = { status: profile.status, code: profile.body?.code ?? null, createdId: profile.body?.profile?.id ?? null };
const versionTarget = profile.body?.profile?.id ?? admin.use_profile_id;
const version = await call('POST', `/access-profiles/${versionTarget}/versions`, MEMBER, {
  rules: [{ resourceType: 'task', selectorForm: 'all-of-type', verbs: ['read', 'write', 'admin'] }],
});
evidence.accessProfileVersion = {
  status: version.status, code: version.body?.code ?? null, ruleSpanned: 'task / all-of-type / read+write+admin',
};

// 4 · the control: is the caller root? It must not be. Read from the DATABASE,
//     not from a response body whose shape could change under us.
// `scopes` live on principal_credentials, not on principals: the role is the
// principals column, the scope set is the union of the Account's live keys.
const who = await pool.query(
  `SELECT p.role,
          (SELECT jsonb_agg(DISTINCT scope)
             FROM principal_credentials c,
                  LATERAL jsonb_array_elements_text(c.scopes) AS scope
            WHERE c.principal_id = p.id AND c.revoked_at IS NULL) AS scopes
     FROM principals p WHERE p.id = $1`, [F.member.id]);
evidence.caller = {
  handle: F.member.handle,
  role: who.rows[0]?.role ?? null,
  scopes: who.rows[0]?.scopes ?? null,
};

console.log(JSON.stringify(evidence, null, 2));

// Clean every row this evidence capture created.
await pool.query("DELETE FROM grants WHERE resource_type = 'task' AND grantee_id = $1", [F.group.id]);
if (evidence.groups.createdId) {
  await pool.query('DELETE FROM group_members WHERE group_id = $1', [evidence.groups.createdId]);
  await pool.query('DELETE FROM groups WHERE id = $1', [evidence.groups.createdId]);
}
await pool.query('DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2',
  [F.group.id, F.stranger.id]);
if (evidence.accessProfiles.createdId) {
  await pool.query('UPDATE access_profiles SET published_version_id = NULL WHERE id = $1', [evidence.accessProfiles.createdId]);
  await pool.query('DELETE FROM access_profile_events WHERE profile_id = $1', [evidence.accessProfiles.createdId]).catch(() => undefined);
  await pool.query(`DELETE FROM access_profile_rules WHERE version_id IN
                      (SELECT id FROM access_profile_versions WHERE profile_id = $1)`, [evidence.accessProfiles.createdId]).catch(() => undefined);
  await pool.query('DELETE FROM access_profile_versions WHERE profile_id = $1', [evidence.accessProfiles.createdId]).catch(() => undefined);
  await pool.query('DELETE FROM access_profiles WHERE id = $1', [evidence.accessProfiles.createdId]).catch(() => undefined);
}
await pool.query('DELETE FROM access_profile_assignments WHERE assignee_id = $1', [F.group.id]);
await pool.end();
