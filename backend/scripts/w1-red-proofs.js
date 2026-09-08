#!/usr/bin/env node
'use strict';

/**
 * w1-red-proofs.js — SS-W1's red proofs, as a rerunnable procedure.
 *
 * The acceptance annex asks for red proofs in one exact shape: "mutate that
 * check, that one test goes red, `cmp`-verified restore, green again". Doing
 * that by hand produces a paragraph in an evidence report that a reviewer has
 * to take on trust. Doing it here produces a command a reviewer can run.
 *
 * For each declared mutation this script:
 *   1. copies the production file byte-for-byte;
 *   2. applies the mutation, refusing unless its anchor appears EXACTLY once;
 *   3. runs the named suite and requires it to FAIL, naming the expected test;
 *   4. restores the copy and verifies the restore with a byte comparison;
 *   5. runs the suite again and requires it to PASS.
 *
 * A mutation whose suite stays green in step 3 is the finding: the test does
 * not depend on the check it claims to pin.
 *
 * Usage (from backend/):  node scripts/w1-red-proofs.js [--only <id>]
 * The live-database proof (L1) is skipped unless DB_NAME names a disposable
 * database; every other proof needs nothing but the repository.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');

/**
 * Each entry names the CLAIM it breaks, not just the bytes it edits. A
 * mutation that cannot be stated as a claim is not a red proof of anything.
 */
const MUTATIONS = [
  {
    id: 'M1',
    claim: 'an empty or unknown role_snapshot fails closed instead of inheriting the Account role',
    file: 'src/utils/taskAutomationRole.ts',
    find: 'if (input.sessionRole !== null && input.sessionRole !== undefined) return input.sessionRole;',
    replace: 'if (input.sessionRole) return input.sessionRole;',
    suite: 'src/__tests__/sessionRoleSnapshot.test.ts',
    expect: 'yields no scopes for an empty string',
  },
  {
    id: 'M2',
    claim: 'a NULL role_snapshot falls through to principals.role',
    file: 'src/middleware/auth.ts',
    find: `    req.scopes = scopesForRole(resolveActorRole({
      handle: req.userId,
      principalRole: principal.role,
      sessionRole: req.sessionRole,
    }));
    req.authMethod = 'session';`,
    replace: `    req.scopes = scopesForRole(resolveActorRole({
      handle: req.userId,
      sessionRole: req.sessionRole,
    }));
    req.authMethod = 'session';`,
    suite: 'src/__tests__/sessionRoleSnapshot.test.ts',
    expect: 'gives the orchestrator Account its own root ceiling',
  },
  {
    id: 'M3',
    claim: 'an unknown session role never becomes an implicit writer',
    file: 'src/utils/identityScopes.ts',
    find: `  // Unknown externally supplied session roles never become an implicit
  // writer. Authenticated-only self-service routes may still admit them.
  return [];`,
    replace: `  // Unknown externally supplied session roles never become an implicit
  // writer. Authenticated-only self-service routes may still admit them.
  return MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);`,
    suite: 'src/__tests__/sessionRoleSnapshot.test.ts',
    expect: 'yields no scopes for an unknown role string',
  },
  {
    id: 'M4',
    claim: 'the two login doors carry byte-identical authority for one Account',
    file: 'src/middleware/auth.ts',
    find: `    req.scopes = scopesForRole(resolveActorRole({
      handle: req.userId,
      principalRole: principal.role,
      sessionRole: req.sessionRole,
    }));
    req.authMethod = 'session';`,
    replace: `    req.scopes = scopesForRole(resolveActorRole({
      handle: req.userId,
      principalRole: 'viewer',
      sessionRole: req.sessionRole,
    }));
    req.authMethod = 'session';`,
    suite: 'src/__tests__/loginPathAuthorityParity.test.ts',
    expect: 'byte-identical scopes through both doors',
  },
  {
    id: 'M5',
    claim: 'the session mint never writes a role snapshot (SS-9)',
    file: 'src/services/LoginSessionService.ts',
    find: `INSERT INTO auth_sessions (principal_id, token_hash, credential_id, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    replace: `INSERT INTO auth_sessions (principal_id, token_hash, credential_id, ip, user_agent, expires_at, role_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
    suite: 'src/__tests__/sessionRoleSnapshot.test.ts',
    expect: 'the mint statement never names the column',
  },
  {
    id: 'M6',
    claim: 'the public /auth surface is exactly the enumerated route set',
    file: 'src/routes/auth.ts',
    find: `export default router;`,
    replace: `router.post('/backdoor', (_req, res) => { res.status(204).send(); });

export default router;`,
    suite: 'src/__tests__/authRouteSurface.test.ts',
    expect: 'exposes exactly the enumerated public routes',
  },
  {
    id: 'L1',
    live: true,
    claim: 'the idle window alone refuses a session, with no sweep running',
    file: 'src/services/LoginSessionService.ts',
    find: `        WHERE s.token_hash = $1 AND s.revoked_at IS NULL
          AND s.expires_at > now() AND s.last_seen_at > $2`,
    replace: `        WHERE s.token_hash = $1 AND s.revoked_at IS NULL
          AND s.expires_at > now() AND ($2::timestamptz IS NOT NULL)`,
    script: 'scripts/test-w1-sessions-live.js',
    expect: 'idleSessionRefusedAfter',
  },
];

function run(argv) {
  return spawnSync('npx', argv, { cwd: BACKEND, encoding: 'utf8', env: process.env, shell: false });
}

function runSuite(mutation) {
  if (mutation.live) {
    const result = spawnSync('node', [mutation.script], { cwd: BACKEND, encoding: 'utf8', env: process.env });
    return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
  }
  // `--runInBand` is not a preference. Jest sizes its worker pool from
  // `nproc`, which is 32 inside the review harness's agent container, and the
  // fan-out kills the agent session outright — it took down three consecutive
  // reviewer spawns before a capacity probe isolated it. A verification tool
  // the reviewer cannot execute is not a verification tool.
  const result = run(['jest', '--runInBand', mutation.suite]);
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function main() {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
  // `DB_NAME` merely being SET is not "points at a migrated disposable
  // database". A red proof proves nothing without a green baseline, so the
  // live arm establishes one before it mutates anything and skips loudly
  // otherwise — reporting "RED" for a run that failed because there was no
  // database would be worse than reporting nothing.
  let liveAvailable = false;
  let liveSkipReason = 'no DB_NAME: point DB_* at a migrated disposable database';
  if (process.env.DB_NAME && MUTATIONS.some((m) => m.live && (!only || m.id === only))) {
    const baseline = spawnSync('node', ['scripts/test-w1-sessions-live.js'], {
      cwd: BACKEND, encoding: 'utf8', env: process.env,
    });
    liveAvailable = baseline.status === 0;
    if (!liveAvailable) {
      const lines = `${baseline.stdout || ''}${baseline.stderr || ''}`.split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^[{}\[\],]*$/.test(line));
      const tail = lines[lines.length - 1] || 'no output';
      liveSkipReason = `live baseline is not green, so no mutation of it can prove anything (${tail.slice(0, 120)})`;
    }
  }
  const results = [];
  let failed = false;

  for (const mutation of MUTATIONS) {
    if (only && mutation.id !== only) continue;
    if (mutation.live && !liveAvailable) {
      results.push({ id: mutation.id, verdict: `SKIPPED (${liveSkipReason})` });
      continue;
    }

    const target = path.join(BACKEND, mutation.file);
    const original = fs.readFileSync(target);
    const text = original.toString('utf8');
    const occurrences = text.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      results.push({ id: mutation.id, verdict: `ANCHOR NOT UNIQUE (${occurrences}) in ${mutation.file}` });
      failed = true;
      continue;
    }

    let verdict;
    try {
      fs.writeFileSync(target, text.replace(mutation.find, mutation.replace), 'utf8');
      const red = runSuite(mutation);
      const wentRed = red.status !== 0;
      const namedIt = red.output.includes(mutation.expect);
      // Restore FIRST, then judge: a thrown assertion must never leave a
      // mutated production file behind.
      fs.writeFileSync(target, original);
      const restored = fs.readFileSync(target).equals(original);
      const green = runSuite(mutation);

      if (!wentRed) verdict = 'NOT A PROOF: the suite stayed green under the mutation';
      else if (!namedIt) verdict = `RED, but did not name "${mutation.expect}"`;
      else if (!restored) verdict = 'RESTORE MISMATCH';
      else if (green.status !== 0) verdict = 'GREEN CHECK FAILED after restore';
      else verdict = 'PROVEN (red under mutation, byte-identical restore, green again)';
    } catch (error) {
      fs.writeFileSync(target, original);
      verdict = `ERROR: ${error.message}`;
    }

    if (!verdict.startsWith('PROVEN')) failed = true;
    results.push({ id: mutation.id, claim: mutation.claim, file: mutation.file, verdict });
  }

  for (const result of results) {
    console.log(`${result.id}  ${result.verdict}`);
    if (result.claim) console.log(`     claim: ${result.claim}`);
    if (result.file) console.log(`     file:  ${result.file}`);
  }
  process.exit(failed ? 1 : 0);
}

main();
