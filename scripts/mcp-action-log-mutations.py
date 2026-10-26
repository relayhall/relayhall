#!/usr/bin/env python3
"""Mutation drill for the per-session MCP action log (card ab8f78e9; owner
rulings E91 and E89 (c); migration 161).

Each control below edits literal anchors in a disposable copy of the tree, runs
the unit suite `backend/src/__tests__/mcpActionLog.test.ts` and the live suite
`backend/src/__tests__/mcpActionLogLive.test.ts` (against a REAL disposable
PostgreSQL, through the production MCP server and router) in one jest run, and
requires the run to go red at EXACTLY the predeclared set of tests, for an
assertion (not a compile error, a timeout or a crashed fixture). Every control
reddens a different set, so no two controls can be satisfied by one assertion.

The controls withdraw, one at a time, what the card binds the log to:
  1. ARGUMENTS ARE STORED: the session observer hands the call's arguments to
     the row builder and the row carries them;
  2. A NON-ALLOWLISTED TARGET IS ACCEPTED: a tool with no allowlist entry
     records the first UUID-valued argument it was sent as its target;
  3. AN ALLOWLISTED TOOL READS ANOTHER ARGUMENT: a tool whose allowlisted
     argument is absent falls back to any other UUID-valued argument;
  4. THE VISIBILITY CHECK IS DROPPED: the session's action rows are read with
     the root narrowing instead of the caller's Account;
  5. RETENTION IGNORES THE BOUND: the sweep removes rows still inside the
     retention window.
The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  RELAYHALL_TEST_DB_URL=postgres://...@127.0.0.1:<port>/<name containing test> \\
    python3 scripts/mcp-action-log-mutations.py --output-dir /tmp/mcp-action-log-drill
  python3 scripts/mcp-action-log-mutations.py --describe   # checks every anchor, no database
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SUITES = ['src/__tests__/mcpActionLog.test.ts', 'src/__tests__/mcpActionLogLive.test.ts']
LOG = 'backend/src/services/McpActionLog.ts'
OBSERVER = 'backend/src/services/McpSessionTelemetry.ts'
PROJECTION = 'backend/src/services/TelemetryProjectionService.ts'
RETENTION = 'backend/src/services/TelemetryRetentionService.ts'

# The tests each control must turn red, by title (assertionResults[].title).
U_ELEVEN = 'a call carrying secret-looking arguments yields exactly the eleven columns, none holding them'
U_UNLISTED = 'a tool that is NOT allowlisted records no target, even with a UUID in every declared argument'
U_OTHER_ARG = 'an allowlisted tool never reads a target from any OTHER argument, even a UUID-valued one'
U_BRIEF = 'the Brief records the altitude it compiled, and the session altitude names nothing'
U_READ = 'an mcp session that resolved reads its log narrowed by the caller Account, and returns it newest first'
L4 = 'L4: report_search sent a project UUID records the call and no target'
L5C = 'L5c: a row written under ANOTHER Account for the same session is not shown to the owner'
L6 = 'L6: rows just past the bound go with a receipt over their ids; rows just inside it and today stay'

# (name, [(file, anchor, replacement), ...], must-fail titles). The two suites run
# in one jest invocation whose file order follows jest's own timing cache, so the
# test lists are compared as sets of unique titles, never by position.
CONTROLS = [
    ('1. arguments are stored: the row carries the call arguments', [
        (OBSERVER,
         "      durationMs: outcome.durationMs,\n      observedAt: this.deps.clock(),\n    }));\n",
         "      durationMs: outcome.durationMs,\n      observedAt: this.deps.clock(),\n      args,\n    } as never));\n"),
        (LOG,
         "    observed_at: input.observedAt,\n  };\n}\n",
         "    observed_at: input.observedAt,\n    ...((input as unknown as { args?: Record<string, unknown> }).args ?? {}),\n  };\n}\n"),
    ], {U_ELEVEN}),
    ('2. a non-allowlisted target is accepted: an unlisted tool records a UUID argument', [
        (LOG,
         "  if (!Object.prototype.hasOwnProperty.call(MCP_ACTION_TARGET_ARGUMENTS, toolName)) return null;\n",
         "  if (!Object.prototype.hasOwnProperty.call(MCP_ACTION_TARGET_ARGUMENTS, toolName)) {\n"
         "    for (const value of Object.values(args)) {\n"
         "      if (typeof value === 'string' && UUID_RE.test(value)) return { type: 'project', id: value.toLowerCase() };\n"
         "    }\n"
         "    return null;\n"
         "  }\n"),
    ], {U_UNLISTED, L4}),
    ('3. an allowlisted tool reads another argument when its own is absent', [
        (LOG,
         "    if (typeof value === 'string' && UUID_RE.test(value)) return { type, id: value.toLowerCase() };\n  }\n  return null;\n}\n",
         "    if (typeof value === 'string' && UUID_RE.test(value)) return { type, id: value.toLowerCase() };\n  }\n"
         "  for (const value of Object.values(args)) {\n"
         "    if (typeof value === 'string' && UUID_RE.test(value)) return { type: MCP_ACTION_TARGET_ARGUMENTS[toolName][0][1], id: value.toLowerCase() };\n"
         "  }\n"
         "  return null;\n}\n"),
    ], {U_OTHER_ARG, U_BRIEF}),
    ("4. the visibility check is dropped: the action rows are read with the root narrowing", [
        (PROJECTION,
         "    const narrowing = renderTelemetryScopeSql(scope, 'a.account_id', params.length + 1);\n",
         "    const narrowing = renderTelemetryScopeSql(scope.kind ? { kind: 'root' } as TelemetryReadScope : scope, 'a.account_id', params.length + 1);\n"),
    ], {U_READ, L5C}),
    ('5. retention ignores the bound: rows inside the window are removed', [
        (RETENTION,
         "              WHERE observed_at < $1\n          RETURNING id\n",
         "              WHERE observed_at < $1::timestamptz + interval '2 days'\n          RETURNING id\n"),
    ], {L6}),
]

IGNORED = ('.git', 'graphify-out', 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache')


def once(text, anchor, replacement):
    count = text.count(anchor)
    if count != 1:
        raise SystemExit(f'anchor matched {count} times, expected 1: {anchor[:100]!r}')
    return text.replace(anchor, replacement, 1)


def fingerprints(tree):
    found = {}
    for path in tree.rglob('*'):
        relative = path.relative_to(tree)
        if path.is_file() and not any(part in IGNORED for part in relative.parts) and not path.name.endswith('.log'):
            found[str(relative)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


def require_disposable_database():
    url = urlparse(os.environ.get('RELAYHALL_TEST_DB_URL', ''))
    name = unquote(url.path.lstrip('/'))
    local = url.hostname in ('127.0.0.1', 'localhost', '::1') and re.search('test|contract|fixture', name)
    ci = os.environ.get('CI') == 'true' and url.hostname == 'postgres' and name == 'relayhall_ci'
    if url.scheme not in ('postgres', 'postgresql') or name in ('relayhall', 'relayhall_dev', 'relayhall_tst', 'relayhall_prod') \
            or not (local or ci):
        raise SystemExit('RELAYHALL_TEST_DB_URL must name a disposable local test database')


def run_suites(copy, out, label):
    report = out / f'{label}.json'
    command = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--testPathIgnorePatterns=/node_modules/',
               '--runTestsByPath', *SUITES, '--json', f'--outputFile={report}']
    with (out / f'{label}.log').open('w') as log:
        code = subprocess.run(command, cwd=copy / 'backend', stdout=log, stderr=subprocess.STDOUT, timeout=900).returncode
    result = json.loads(report.read_text()) if report.exists() else {}
    tests = [a for f in result.get('testResults', []) for a in f.get('assertionResults', [])]
    suite_messages = ' '.join(str(f.get('message', '')) for f in result.get('testResults', []))
    return code, tests, re.sub(r'\x1b\[[0-9;]*m', '', suite_messages)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--discover', action='store_true',
                        help='report what each control reddens and continue (for writing the must-fail sets)')
    args = parser.parse_args()

    for _, edits, _ in CONTROLS:
        texts = {}
        for path, anchor, replacement in edits:
            texts[path] = once(texts.get(path, (ROOT / path).read_text()), anchor, replacement)
    sets = [frozenset(c[2]) for c in CONTROLS]
    if len(set(sets)) != len(sets) or any(not s for s in sets):
        raise SystemExit('every control must declare a non-empty must-fail set that no other control shares')
    if args.describe:
        print(json.dumps([{'control': c[0], 'files': sorted({e[0] for e in c[1]}), 'mustFail': sorted(c[2])}
                          for c in CONTROLS], indent=2))
        print(f'{len(CONTROLS)} controls, every anchor found exactly once, every must-fail set distinct')
        return

    require_disposable_database()
    if not args.output_dir:
        raise SystemExit('--output-dir is required')
    out = args.output_dir.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit('--output-dir must lie outside the repository')
    out.mkdir(parents=True, exist_ok=False)

    before = fingerprints(ROOT)
    copy = Path(tempfile.mkdtemp(prefix='mcp-action-log-drill-'))
    receipts = []
    try:
        shutil.copytree(ROOT, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns(*IGNORED, '*.log'))
        (copy / 'backend/node_modules').symlink_to((ROOT / 'backend/node_modules').resolve(), target_is_directory=True)

        code, tests, _ = run_suites(copy, out, 'baseline')
        titles = [t['title'] for t in tests]
        if code != 0 or not tests or any(t['status'] != 'passed' for t in tests):
            raise SystemExit('baseline is not green')
        if len(set(titles)) != len(titles):
            raise SystemExit('two tests share a title, so a declared title would not name one test')
        for _, _, must_fail in CONTROLS:
            if not set(must_fail) <= set(titles):
                raise SystemExit(f'a declared test is absent from the suites: {sorted(set(must_fail) - set(titles))}')

        for index, (name, edits, must_fail) in enumerate(CONTROLS, start=1):
            originals = {}
            for path, anchor, replacement in edits:
                target = copy / path
                originals.setdefault(path, target.read_text())
                target.write_text(once(target.read_text(), anchor, replacement))
            try:
                code, tests, suite_messages = run_suites(copy, out, f'control-{index}')
            finally:
                for path, original in originals.items():
                    (copy / path).write_text(original)
            failed = {t['title'] for t in tests if t['status'] == 'failed'}
            messages = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(
                m for t in tests if t['status'] == 'failed' for m in t.get('failureMessages', [])))
            semantic = code != 0 and sorted(t['title'] for t in tests) == sorted(titles) and failed == set(must_fail) \
                and all('expect(' in '\n'.join(t.get('failureMessages', [])) for t in tests if t['status'] == 'failed') \
                and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED',
                                  messages + suite_messages)
            receipts.append({'control': name, 'files': sorted(originals), 'mustFail': sorted(must_fail),
                             'failed': sorted(failed), 'red': semantic})
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            print(f"{'RED ' if semantic else 'MISS'} {name} -> {sorted(failed)}", flush=True)
            if not semantic and not args.discover:
                raise SystemExit(f'control did not fail at its declared assertions: {name}')
    finally:
        shutil.rmtree(copy, ignore_errors=True)
        after = fingerprints(ROOT)
        (out / 'closure.json').write_text(json.dumps({
            'sourceUnchanged': before == after, 'copyRemoved': not copy.exists(), 'controls': len(receipts),
        }, indent=2))
    if before != fingerprints(ROOT):
        raise SystemExit('the source tree changed during the drill')
    red = sum(1 for receipt in receipts if receipt['red'])
    if red != len(CONTROLS):
        raise SystemExit(f'{red} of {len(CONTROLS)} controls red at their declared assertions (discovery run)')
    print(f'all {red} controls red at their declared assertions; source unchanged')


if __name__ == '__main__':
    main()
