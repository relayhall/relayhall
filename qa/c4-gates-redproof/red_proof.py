#!/usr/bin/env python3
"""ON-DISK red-mutation proof for the fb06c930 retry contract.

Design record `bf8928ee` v5 §4.4, plus the rows the carried obligations added.
Owner rulings `94ecf329` Batch 1, `1d8dcd5c`, `0464ad54`.

WHY THIS EXISTS BESIDE THE SUITE. The suite's own controls mutate a value and
re-check a comparison; that proves the comparison reacts, not that the GATE goes
red. This drill edits the real files on disk, runs the real command the gate
chain runs, and records the exit code AND WHICH ASSERTION FAILED. A row that
went red because the tree stopped compiling has proved nothing (round-2 verdict
`7c2d4dbb`), and a row whose mutation reddened somebody else's assertion has
proved something other than what it claims.

THE RULE, unchanged since round 1: ONE mutation, ONE credited assertion, and the
harness checks that THAT assertion is the one that failed. Two rows share a
credited assertion exactly once, deliberately — rows 16 and 17 drill the writer
census in its two opposite directions, which is a census that would otherwise
pass one-sidedly.

Every mutation is reverted from a saved original and the drill re-verifies a
clean green afterwards.

Usage:  RELAYHALL_TEST_DB_URL=postgres://... red_proof.py [BACKEND_DIR]

The contract suite is a REAL-PostgreSQL gate: without the URL it FAILS rather
than skipping, so this drill refuses to start without one — a red-proof run
against a suite that cannot connect would report every row red for the same
uninformative reason.
"""
import os
import subprocess
import sys
import urllib.parse

# Derived from THIS file's own location, never from a deployment path: this
# file is publication-allowlisted, and the public residue contract refuses a
# private path in a shipped file (CI run 689 caught exactly that line). The
# drill still takes an explicit backend directory as argv[1], which is how it is
# pointed at a SEPARATE clone — the gate chain and the red-proof drill must
# never run against one worktree.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKEND = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO_ROOT, 'backend')

CONTRACT = 'src/__tests__/idempotencyContract.test.ts'
POSTURE = 'src/__tests__/c4McpPostureGate.test.ts'

if not os.environ.get('RELAYHALL_TEST_DB_URL'):
    print('RELAYHALL_TEST_DB_URL is not set — the contract suite cannot run, and every row '
          'would go red for that reason rather than for its mutation. Refusing to start.')
    sys.exit(2)

# (label, file, old, new, suite, credited assertion substring)
MUTATIONS = [
    ('1 — the reserve INSERT is skipped for one operation',
     'src/middleware/idempotency.ts',
     "  const result = await pool.query<{ request_id: string }>(\n    `INSERT INTO operation_idempotency_records",
     "  if (operation === 'task.create') return '00000000-0000-4000-8000-000000000000';\n  const result = await pool.query<{ request_id: string }>(\n    `INSERT INTO operation_idempotency_records",
     CONTRACT, 'task.create replays the exact bytes'),

    ('2 — the hash is computed over req.params only, ignoring the body',
     'src/middleware/idempotency.ts',
     ".update(stableJson({ params: req.params, body: req.body ?? {} }))",
     ".update(stableJson({ params: req.params }))",
     CONTRACT, 'IDEMPOTENCY_KEY_REUSED'),

    ('3 — the scope resolver returns one constant principal for every caller',
     'src/middleware/idempotency.ts',
     "  if (auth.principal?.id) return `prin:${auth.principal.id}`;",
     "  if (auth.principal?.id) return 'prin:11111111-1111-4111-8111-111111111111';",
     CONTRACT, 'two DIFFERENT principals'),

    ('4 — agent.mint.collect is re-declared scope: principal',
     'src/middleware/idempotency.ts',
     "  'agent.mint.collect':      { scope: 'credential', replay: 'refuse' },",
     "  'agent.mint.collect':      { scope: 'principal', replay: 'refuse' },",
     CONTRACT, 'scope-declaration census'),

    ('5 — a credential-scoped operation resolves its scope from the PRINCIPAL',
     'src/middleware/idempotency.ts',
     "    if (auth.credentialId) return `cred:${auth.credentialId}`;",
     "    if (auth.principal?.id) return `cred:${auth.principal.id}`;\n    if (auth.credentialId) return `cred:${auth.credentialId}`;",
     CONTRACT, 'SECOND credential of the same principal gets its OWN row'),

    ('6 — expires_at is not consulted on read',
     'src/middleware/idempotency.ts',
     "        if (row && row.expires_at.getTime() <= Date.now()) {",
     "        if (row && row.expires_at.getTime() <= 0) {",
     CONTRACT, 'treated as ABSENT'),

    ('7 — agent.mint.request is re-declared replay: return',
     'src/middleware/idempotency.ts',
     "  'agent.mint.request':      { scope: 'credential', replay: 'refuse' },",
     "  'agent.mint.request':      { scope: 'credential', replay: 'return' },",
     CONTRACT, 'a repeated key is REFUSED and never re-mints'),

    ('8 — operation_idempotency_refuse_stores_nothing is dropped from the migration',
     'src/migrations/110_operation_idempotency_records.sql',
     "  CONSTRAINT operation_idempotency_refuse_stores_nothing\n    CHECK (replay_policy <> 'refuse'\n           OR (response_status IS NULL AND response_body IS NULL AND response_content_type IS NULL)),",
     "",
     CONTRACT, 'migration 110 created the table with the constraints'),

    ('9 — operation_idempotency_return_completes_with_a_body is dropped',
     'src/migrations/110_operation_idempotency_records.sql',
     "  CONSTRAINT operation_idempotency_return_completes_with_a_body\n    CHECK (state <> 'completed' OR replay_policy = 'refuse'\n           OR (response_status IS NOT NULL AND response_body IS NOT NULL AND response_content_type IS NOT NULL))",
     "  CONSTRAINT operation_idempotency_return_completes_with_a_body\n    CHECK (true)",
     # Row 8 DELETES the constraint, so its NAME vanishes and the constraint
     # census fires. This row keeps the name and empties the RULE, which no
     # census can see - only the drill that attempts the forbidden write can.
     # Two rows, two different assertions, deliberately.
     CONTRACT, 'the return direction is a CHECK too'),

    ('10 - response_body is declared JSONB',
     'src/migrations/110_operation_idempotency_records.sql',
     "  response_body         TEXT,",
     "  response_body         JSONB,",
     CONTRACT, 'migration 110 created the table with the constraints'),

    ('11 — one tool stops reading idempotencyKey while the schema keeps required',
     'src/mcp/registry.ts',
     "      const idempotencyKey = req(args, 'idempotencyKey');\n      const { idempotencyKey: _key, ...reportArgs } = args;",
     "      const idempotencyKey = String(args.idempotencyKey ?? 'silently-defaulted-key');\n      const { idempotencyKey: _key, ...reportArgs } = args;",
     CONTRACT, 'enforced in the HANDLER'),

    ('12 — one §3.8 sentence in the registry is overwritten with another tool\'s',
     'src/mcp/registry.ts',
     "  relayhall_task_claim: 'Retry contract: an exact retry by the same identity is accepted and the Task ends in the same state; each call emits one task.updated event.',",
     "  relayhall_task_claim: 'Retry contract: an exact retry returns the already-released Lease.',",
     CONTRACT, 'the sentence in the LIVE registry'),

    ('13 — the server INSTRUCTIONS text is edited',
     'src/mcp/server.ts',
     'const INSTRUCTIONS = [',
     "const INSTRUCTIONS = ['A line no reviewer approved.',",
     POSTURE, 'pins ALL model-facing text'),

    ('14 — the task_move handler stops forwarding the key on the notes limb',
     'src/mcp/registry.ts',
     "        await board(ctx, { method: 'POST', path: `/tasks/${encodeURIComponent(taskId)}/notes`, body: { text: feedback }, headers, requiredScope: 'tasks:write' });",
     "        await board(ctx, { method: 'POST', path: `/tasks/${encodeURIComponent(taskId)}/notes`, body: { text: feedback }, requiredScope: 'tasks:write' });",
     CONTRACT, 'FORWARDS the key to BOTH limbs'),

    ('15 — the sweep loses its WHERE expires_at <= now()',
     'src/middleware/idempotency.ts',
     "        SELECT ctid FROM operation_idempotency_records WHERE expires_at <= now() LIMIT 1000",
     "        SELECT ctid FROM operation_idempotency_records LIMIT 1000",
     CONTRACT, 'the sweep deletes only expired rows'),

    ('16 — DECLARED_DURABLE_STATE loses the retry-records entry',
     'src/__tests__/c4McpPostureGate.test.ts',
     "  operation_idempotency_records:\n    'operation retry records (fb06c930) — scope-keyed, expire, served only behind the same guard chain, and refuse-policy rows store no response at all',",
     "",
     POSTURE, 'declares the durable state'),

    ('17 — a SECOND writer of the table appears in a new module',
     'src/utils/retryRecordsShadowWriter.ts',
     None,
     "import { pool } from '../db/connection';\n\n/** A second writer, added to prove the census is sink-anchored. */\nexport async function shadowComplete(key: string): Promise<void> {\n  await pool.query(\"UPDATE operation_idempotency_records SET state = 'completed' WHERE idempotency_key = $1\", [key]);\n}\n",
     POSTURE, 'declares the durable state'),

    ('18 — lease_renew\'s exempt column list is widened to the whole row',
     'src/__tests__/idempotencyContract.test.ts',
     "    exempt: ['reports.updated_at'],",
     "    exempt: ['reports.updated_at', 'reports.content', 'reports.title'],",
     CONTRACT, 'column-exemption set is pinned BY VALUE'),

    # The design credited this row to 4.2(b) for `task_recover`. This build's
    # oracle does not measure `task_recover` (its DECLARED COVERAGE assertion
    # says so and why), so the row is credited to the assertion that DOES stand
    # over the guard — the five-conjunct source pin — rather than to one that
    # would never have fired. `if (false)` does not compile here (unreachable
    # code, unused binding); falsifying a conjunct does.
    ('19 — a conjunct of the alreadyRecovered guard is inverted',
     'src/services/TaskManagerDB.ts',
     "        && previousWarrant === nextWarrant;",
     "        && previousWarrant !== nextWarrant;",
     CONTRACT, 'THE OBLIGATION: an exact retry whose Warrant is UPPER-CASE'),

    ('20 — the operation_idempotency_scope_prefix CHECK is dropped',
     'src/migrations/110_operation_idempotency_records.sql',
     "  CONSTRAINT operation_idempotency_scope_prefix\n    CHECK (split_part(scope, ':', 1) IN ('cred', 'prin', 'user') AND char_length(split_part(scope, ':', 2)) > 0),",
     "  CONSTRAINT operation_idempotency_scope_prefix\n    CHECK (true),",
     CONTRACT, 'The scope PREFIX has its own control'),

    ('21 — the replay comparison becomes a parsed deep-equal',
     'src/__tests__/idempotencyContract.test.ts',
     "    expect(replay.text).not.toBe(first.text);",
     "    expect(JSON.parse(replay.text)).not.toEqual(JSON.parse(first.text));",
     CONTRACT, 'BYTE-level'),

    # The bytes leave FIRST and the completion row is written afterwards — sent
    # exactly once, so the mutation is the ORDERING and nothing else. (An
    # earlier version of this row sent twice, which broke the middleware
    # everywhere and reddened 35 assertions instead of the one it claimed.)
    ('22 — the completion UPDATE is moved to AFTER the original res.send',
     'src/middleware/idempotency.ts',
     # TWO edits, ONE mutation: the bytes leave FIRST and the completion row is
     # written afterwards. Sent exactly once, so what changes is the ORDERING and
     # nothing else. (`red_proof` treats a list of pairs as a single mutation.)
     [("    return void pool.query(", "    originalSend(body as never);\n    return void pool.query("),
      ("    ).then(\n      () => { resolved = true; originalSend(body as never); },",
       "    ).then(\n      () => { resolved = true; /* the ORDERING mutation: the bytes left above */ },")],
     None,
     CONTRACT, 'the send boundary tells them apart'),

    ('23 — one tool\'s feed-event allowance is widened by one',
     'src/__tests__/idempotencyContract.test.ts',
     "    exempt: [...TASK_CLOCK_EXEMPTIONS, 'subtasks.updated_at'],\n    allowance: { feed_events: 1 },",
     "    exempt: [...TASK_CLOCK_EXEMPTIONS, 'subtasks.updated_at'],\n    allowance: { feed_events: 2 },",
     CONTRACT, 'feed-event allowance map is pinned BY VALUE'),

    ('24 — task.patch also rewrites a mirrored profile column on every call',
     'src/routes/tasks.ts',
     "router.patch('/:id', idempotent('task.patch'), async (req: Request, res: Response): Promise<void> => {\n  try {",
     "router.patch('/:id', idempotent('task.patch'), async (req: Request, res: Response): Promise<void> => {\n  try {\n    await (await import('../db/connection')).pool.query(\"UPDATE task_execution_profiles SET descriptor_version = COALESCE(descriptor_version, '0') || 'x' WHERE task_id = $1\", [req.params.id]);",
     CONTRACT, 'relayhall_task_update converges'),

    ('25 — the seam\'s advisory key becomes a constant again',
     'src/__tests__/idempotencyContract.test.ts',
     "async function installSeam(keyExpression = \"hashtext('rh-completion-gate:' || NEW.idempotency_key)\"): Promise<void> {",
     "async function installSeam(keyExpression = '42'): Promise<void> {",
     CONTRACT, 'the send boundary tells them apart'),

    # ── ROUND-1 REVIEW REPAIRS, each with the mutation that reddens it ──
    ('r1-B1 — the operation is no longer bound to its policy at the write',
     'src/migrations/110_operation_idempotency_records.sql',
     "      (operation IN ('task.create', 'task.stream.append', 'task.reference.create',",
     "      (true OR operation IN ('task.create', 'task.stream.append', 'task.reference.create',",
     CONTRACT, 'a mint row claiming return-policy is NOT REPRESENTABLE'),

    ('r1-B1b — the SQL binding and the declaration table are allowed to disagree',
     'src/middleware/idempotency.ts',
     # Adding a KEY does not compile (the OpenAPI mount map is exhaustive over
     # the declared set — itself a control). Flipping a declared POLICY does,
     # and policy drift is what this row is about.
     "  'report.create':           { scope: 'principal',  replay: 'return' },",
     "  'report.create':           { scope: 'principal',  replay: 'refuse' },",
     CONTRACT, 'the SQL binding and the declaration table are the SAME closed set'),

    ('r1-B2 — the middleware sends the nominal answer when the completion write failed',
     'src/middleware/idempotency.ts',
     "      (err) => { failClosed(err, 'completing a retry record failed'); },",
     "      (err) => { logCaughtFailure('[idempotency] completing failed', err); originalSend(body as never); },",
     CONTRACT, 'fails closed when the completion write does not land'),

    # ── THE ROUND-3 AMENDMENT (ruling 623632b0): revert the scope, redden the gate ──
    ('r3-AMEND — task.create is returned to PRINCIPAL scope in the declaration',
     'src/middleware/idempotency.ts',
     "  'task.create':             { scope: 'credential', replay: 'return' },",
     "  'task.create':             { scope: 'principal', replay: 'return' },",
     CONTRACT, 'the AMENDMENT — the three field-gated operations are credential-scoped'),

    ('r3-AMEND-b — task.stream.append is returned to PRINCIPAL scope',
     'src/middleware/idempotency.ts',
     "  'task.stream.append':      { scope: 'credential', replay: 'return' },",
     "  'task.stream.append':      { scope: 'principal', replay: 'return' },",
     CONTRACT, 'the AMENDMENT — the three field-gated operations are credential-scoped'),

    ('r3-AMEND-c — the migration stops binding the operation to its scope kind',
     'src/migrations/110_operation_idempotency_records.sql',
     "  CONSTRAINT operation_idempotency_operation_scope\n    CHECK (\n      (operation IN ('task.create', 'task.patch', 'task.stream.append',",
     "  CONSTRAINT operation_idempotency_operation_scope\n    CHECK (\n      true OR (operation IN ('task.create', 'task.patch', 'task.stream.append',",
     CONTRACT, 'the AMENDMENT — the three field-gated operations are credential-scoped'),

    ('r3-AMEND-d — the no-record baseline runs its field-gated cases as a FULL-authority credential',
     'src/__tests__/idempotencyContract.test.ts',
     # The anchor moved when the case ARRAY became a per-operation fixture
     # table keyed by the declaration (round 4). Same mutation, new home:
     # run task.create's field-gated case as a FULL-authority credential.
     '    as: () => REDUCED_CREDENTIAL,\n    body: () => ({ title: `base ${tag()}`, project: PROJECT_ID,',
     '    as: () => SECOND_CREDENTIAL,\n    body: () => ({ title: `base ${tag()}`, project: PROJECT_ID,',
     CONTRACT, 'the universal claim is measured against a NO-RECORD baseline'),

    # ── ROUND 4: the baseline is DERIVED, so a missing case is a failure ──
    ('r4-DERIVED — a declared return operation loses its baseline fixture (task.note.append)',
     'src/__tests__/idempotencyContract.test.ts',
     "  'task.note.append': {\n    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/notes`,",
     "  'task.note.append.WITHDRAWN': {\n    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/notes`,",
     CONTRACT, 'the universal claim is measured against a NO-RECORD baseline'),

    ('r4-DERIVED-b — a FIELD-GATED operation loses its baseline fixture (task.stream.append)',
     'src/__tests__/idempotencyContract.test.ts',
     "  'task.stream.append': {\n    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/stream`, fieldGate: 'services:write',",
     "  'task.stream.append.WITHDRAWN': {\n    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/stream`, fieldGate: 'services:write',",
     CONTRACT, 'the universal claim is measured against a NO-RECORD baseline'),

    # ── ROUND 5: the fixture's LABEL is bound to the act, by the row the
    # ── middleware wrote. This is the reviewer's own substitution: keep the
    # ── `task.note.append` KEY and give it report.create's route and body.
    # ── Before the row anchor this stayed GREEN with that operation never
    # ── reached; now the row comes back under `report.create` and the
    # ── baseline reddens.
    ("r5-ANCHOR — a fixture keeps its key but takes another operation's route and body",
     'src/__tests__/idempotencyContract.test.ts',
     "  'task.note.append': {\n    method: 'POST', path: () => `/tasks/${FIELD_GATE_TASK}/notes`,\n    as: () => SECOND_CREDENTIAL,\n    body: () => ({ text: `base note ${tag()}` }),\n  },",
     "  'task.note.append': {\n    method: 'POST', path: () => '/reports',\n    as: () => SECOND_CREDENTIAL,\n    body: () => ({ title: `base ${tag()}`, content: 'x' }),\n  },",
     CONTRACT, 'the universal claim is measured against a NO-RECORD baseline'),

    ('B-1 — the Warrant identity is compared as raw caller text again',
     'src/services/TaskManagerDB.ts',
     "        ? await canonicalWarrantId(client, String(input.executionWarrantId))",
     "        ? String(input.executionWarrantId)",
     CONTRACT, 'THE OBLIGATION: an exact retry whose Warrant is UPPER-CASE'),

    ('B-2 — the assignment mirror is dropped from the exemption register',
     'src/__tests__/idempotencyContract.test.ts',
     "  'task_assignments.updated_at',            // trg_tasks_assignment_compat mirrors it too (B-2)",
     "",
     CONTRACT, 'BOTH compat mirrors'),
]


DB_CONTAINER = os.environ.get('RH_DB_CONTAINER', 'rh-retry-pg2')
DB_USER = os.environ.get('RH_DB_USER', 'relayhall_test')
DB_NAME = os.environ.get('RH_DB_NAME', 'relayhall_redproof')
REPO_ROOT = os.path.dirname(os.path.abspath(BACKEND.rstrip('/')))


def rebuild_database():
    """Drop and rebuild the disposable database from `database/init.sql` and
    `npm run migrate`.

    A migration mutation is invisible to a database that already ran the
    ORIGINAL migration: the constraint is still there, the suite still passes
    the drill it was supposed to fail, and the row scores as a false green (or,
    worse, reddens something unrelated). Every row that edits a `.sql` file
    therefore rebuilds first — the mutation has to reach the substrate before it
    can be said to have been drilled."""
    subprocess.run(
        ['sudo', '-n', 'docker', 'exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', 'postgres',
         '-c', f'DROP DATABASE IF EXISTS {DB_NAME}', '-c', f'CREATE DATABASE {DB_NAME}'],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, check=True)
    with open(os.path.join(REPO_ROOT, 'database', 'init.sql'), 'rb') as handle:
        subprocess.run(
            ['sudo', '-n', 'docker', 'exec', '-i', DB_CONTAINER, 'psql', '-U', DB_USER,
             '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-q'],
            stdin=handle, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, check=True)
    env = dict(os.environ)
    parsed = urllib.parse.urlparse(os.environ['RELAYHALL_TEST_DB_URL'])
    env.update({'DB_HOST': parsed.hostname, 'DB_PORT': str(parsed.port or 5432),
                'DB_NAME': DB_NAME, 'DB_USER': DB_USER,
                'DB_PASSWORD': urllib.parse.unquote(parsed.password or '')})
    subprocess.run(['npm', 'run', 'migrate'], cwd=BACKEND, env=env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, check=True)


def run(suite):
    env = dict(os.environ)
    result = subprocess.run(
        # `--testPathIgnorePatterns` is overridden the way `npm run
        # test:idempotency` overrides it: the contract suite is EXCLUDED from
        # the default run by config, and running it needs that exclusion lifted.
        ['npx', 'jest', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
         '--runTestsByPath', suite],
        cwd=BACKEND, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return result.returncode, result.stdout


def failed_assertions(output):
    """Jest prints a per-test ✕ list on a small run and only ● failure blocks
    once many tests fail. Read BOTH, or a mutation that breaks a lot is scored
    as having broken nothing."""
    ticks = [line.strip() for line in output.splitlines() if line.strip().startswith('✕')]
    bullets = [line.strip() for line in output.splitlines()
               if line.strip().startswith('●') and '›' in line]
    return ticks + bullets


def score(label, expected, code, output, failures):
    failed = failed_assertions(output)
    if code == 0:
        print(f'  [GREEN — FALSE GREEN] {label}')
        failures.append(f'FALSE GREEN: {label}')
        return
    if not failed:
        print(f'  [RED WITHOUT AN ASSERTION] {label}  (a compile error proves nothing)')
        failures.append(f'RED FOR THE WRONG REASON: {label}')
        return
    credited = [line for line in failed if expected.lower() in line.lower()]
    if not credited:
        print(f'  [RED, BUT THE WRONG ASSERTION] {label}\n'
              f'      expected: {expected}\n      fired:    {failed[0][:150]}')
        failures.append(f'WRONG ASSERTION REDDENED: {label}')
        return
    spread = '' if len(failed) <= 1 else f'  (+{len(failed) - 1} other assertion(s) also red)'
    print(f'  [RED (correct)] {label}{spread}\n      credited: {credited[0][:150]}')


def main():
    failures = []
    print(f'=== fb06c930 red-proof drill — backend {BACKEND} ===\n')
    print('baseline: both suites must be GREEN before any mutation')
    for suite in (CONTRACT, POSTURE):
        code, _ = run(suite)
        print(f'  baseline {suite}: exit {code}')
        if code != 0:
            print('  ABORT: the tree is not green to begin with; a red proof against a red tree says nothing.')
            return 1

    print('\n=== mutations ===')
    for label, relative, old, new, suite, expected in MUTATIONS:
        path = os.path.join(BACKEND, relative)
        if old is None:
            # A CREATED file: nothing to revert, everything to delete.
            try:
                with open(path, 'w', encoding='utf-8', newline='\n') as handle:
                    handle.write(new)
                code, output = run(suite)
                score(label, expected, code, output, failures)
            finally:
                if os.path.exists(path):
                    os.remove(path)
            continue

        with open(path, encoding='utf-8') as handle:
            original = handle.read()
        # A LIST of (old, new) pairs is ONE mutation touching several places.
        # Some shapes need two edits to stay compile-clean while changing only
        # the one property the row claims — row 22 sends the bytes early AND
        # drops the send from the completion callback, so it sends exactly
        # once and the ORDERING is all that moved. Every anchor must still
        # match exactly once, or the row is stale rather than clever.
        pairs = old if isinstance(old, list) else [(old, new)]
        if any(original.count(one_old) != 1 for one_old, _ in pairs):
            print(f'  [SKIP] {label} — an anchor did not match exactly once; the mutation is stale')
            failures.append(f'ANCHOR NOT UNIQUE: {label}')
            continue
        mutated = original
        for one_old, one_new in pairs:
            mutated = mutated.replace(one_old, one_new)
        try:
            with open(path, 'w', encoding='utf-8', newline='\n') as handle:
                handle.write(mutated)
            if relative.endswith('.sql'):
                rebuild_database()
            code, output = run(suite)
            score(label, expected, code, output, failures)
        finally:
            with open(path, 'w', encoding='utf-8', newline='\n') as handle:
                handle.write(original)
            if relative.endswith('.sql'):
                rebuild_database()

    print('\n=== after revert: both suites must be GREEN again ===')
    for suite in (CONTRACT, POSTURE):
        code, _ = run(suite)
        print(f'  restored {suite}: exit {code}')
        if code != 0:
            failures.append(f'NOT RESTORED: {suite}')

    print('\n' + ('DRILL PASSED — every mutation reddened the assertion credited to it'
                  if not failures else 'DRILL FAILED:\n  ' + '\n  '.join(failures)))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
