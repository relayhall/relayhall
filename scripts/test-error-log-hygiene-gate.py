#!/usr/bin/env python3
"""Self-proof for scripts/check-error-log-hygiene.py (A15.2 pattern).

A ratchet is only worth anything if it (a) sees the shapes it claims to see,
(b) refuses to loosen, and (c) does not fire on the sanctioned sink. Each of
those gets a fixture, and the gate runs as a subprocess so the proof covers
the CLI surface.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().parent / "check-error-log-hygiene.py"
REPO_ROOT = GATE.resolve().parents[1]

# The sanctioned sink: a fixed context string plus a bounded category. Nothing
# exception-derived reaches the logger.
SAFE = """
function logFailure(context: string, error: unknown): void {
  const category = error instanceof Error ? 'Error' : 'NonError';
  console.error(`[Widgets API] ${context} failed (${category})`);
}
export function get() {
  try { work(); } catch (error) { logFailure('read', error); }
}
"""

LEAKY_SHAPES = {
    "bare-argument": "catch (error) { console.error('read failed:', error); }",
    "message-member": "catch (error) { console.error('read failed:', error.message); }",
    "stack-member": "catch (err) { console.warn('boom', err.stack); }",
    "template-interpolation": "catch (e) { console.error(`read failed: ${e}`); }",
    "template-member": "catch (error) { console.log(`x ${error.message}`); }",
    "string-wrapped": "catch (ex) { console.error('read failed:', String(ex)); }",
    "multiline-call": "catch (error) {\n  console.error(\n    'read failed:',\n    error,\n  );\n}",
    "arbitrary-catch-name": "catch (failure) { console.error('failed', failure); }",
    "object-shorthand": "catch (error) { console.error({ error }); }",
    "logger-call": "catch (error) { logger.error('failed', error); }",
    "nested-logger-call": "catch (failure) { this.auditLogger.warn({ failure }); }",
    "promise-catch-binding": ".catch((failure) => logger.error('failed', failure))",
    "promise-async-parenthesized": ".catch(async (failure) => logger.error('failed', failure))",
    "promise-async-bare": ".catch(async failure => logger.error('failed', failure))",
    "promise-typed-binding": ".catch((failure: unknown) => logger.error('failed', failure))",
    "promise-function-expression": ".catch(function (failure) { logger.error('failed', failure); })",
    "promise-async-named-function": ".catch(async function rejected(failure) { logger.error('failed', failure); })",
}

SAFE_SHAPES = {
    "fixed-error-word": "console.error('fixed error while reading');",
    "bounded-object-field": "catch (error) { console.error({ error: 'Error' }); }",
    "unrelated-member": "catch (error) { console.error(result.error); }",
    "logger-bounded-category": "catch (failure) { const category = failure instanceof Error ? 'Error' : 'NonError'; logger.error('failed', category); }",
    "async-logger-bounded-category": ".catch(async (failure) => { const category = failure instanceof Error ? 'Error' : 'NonError'; logger.error('failed', category); })",
}


def run(src: Path, baseline: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GATE), "--src", str(src), "--baseline", str(baseline), *extra],
        capture_output=True, text=True)


def make_tree(root: Path, files: dict[str, str]) -> Path:
    src = root / "src"
    src.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        path = src / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return src


def check_live_source_invariants(problems: list[str]) -> None:
    """Pin semantic leaks that are deliberately outside the syntactic gate.

    These values are aliased before the logger call (or arrive as the global
    rejection callback binding), so the logger-call scanner cannot reliably
    prove their derivation without becoming a TypeScript data-flow engine.
    """
    server = (REPO_ROOT / "backend/src/server.ts").read_text(encoding="utf-8")
    rejection_start = server.find("process.on('unhandledRejection'")
    rejection_end = server.find("const app: Express", rejection_start)
    if rejection_start < 0 or rejection_end < 0:
        problems.append("server unhandled-rejection handler boundaries are missing")
    else:
        rejection = server[rejection_start:rejection_end]
        if "logCaughtFailure('[Server] unhandled promise rejection', reason)" not in rejection:
            problems.append("server unhandled-rejection reason is not routed through the safe sink")
        if re.search(r"console\.(?:error|warn|log)\([^;\n]*,\s*(?:reason|_?promise)\b", rejection, re.I):
            problems.append("server unhandled-rejection handler logs the raw reason or Promise")
        if re.search(r"console\.(?:error|warn|log)\(\s*(?:reason|_?promise)\b", rejection, re.I):
            problems.append("server unhandled-rejection handler logs the raw reason or Promise")

    tasks = (REPO_ROOT / "backend/src/routes/tasks.ts").read_text(encoding="utf-8")
    runtime_start = tasks.find("canonicalRuntimeSignalService.listTaskSignals")
    runtime_end = tasks.find("res.json({", runtime_start)
    if runtime_start < 0 or runtime_end < 0:
        problems.append("tasks canonical-runtime failure block boundaries are missing")
    else:
        runtime = tasks[runtime_start:runtime_end]
        if "canonicalRuntimeError = 'canonical runtime lookup failed'" not in runtime:
            problems.append("tasks canonical-runtime response reason is not fixed")
        if "logCaughtWarning('[Tasks API] Canonical runtime lookup failed', error)" not in runtime:
            problems.append("tasks canonical-runtime failure is not routed through the safe sink")
        if re.search(r"error\.message|String\(error\)|\$\{canonicalRuntimeError\}", runtime):
            problems.append("tasks canonical-runtime block aliases or logs exception detail")

    catalog = (REPO_ROOT / "backend/src/services/modelCatalog.ts").read_text(encoding="utf-8")
    catalog_start = catalog.find("} catch (err: any)")
    catalog_end = catalog.find("} finally {", catalog_start)
    if catalog_start < 0 or catalog_end < 0:
        problems.append("model-catalog failure block boundaries are missing")
    else:
        failure = catalog[catalog_start:catalog_end]
        if "logCaughtWarning('[ModelCatalog] LiteLLM model discovery failed', err)" not in failure:
            problems.append("model-catalog failure is not routed through the safe sink")
        if re.search(r"\b(?:const|let)\s+msg\b|err\??\.message|String\(err\)", failure):
            problems.append("model-catalog failure aliases exception detail before logging")


def main() -> int:
    problems: list[str] = []

    live = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
    if live.returncode != 0:
        problems.append(f"repository run failed: {live.stderr.strip()}")
    check_live_source_invariants(problems)

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)

        # The sanctioned sink must not trip the gate, or nobody will adopt it.
        scope = tmp / "safe"
        src = make_tree(scope, {"widgets.ts": SAFE})
        baseline = scope / "baseline.json"
        baseline.write_text("{}\n", encoding="utf-8")
        result = run(src, baseline)
        if result.returncode != 0:
            problems.append(f"the secret-safe sink was flagged: {result.stderr.strip()}")

        for tag, body in SAFE_SHAPES.items():
            scope = tmp / f"safe-{tag}"
            src = make_tree(scope, {"widgets.ts": f"export function get() {{ {body} }}"})
            baseline = scope / "baseline.json"
            baseline.write_text("{}\n", encoding="utf-8")
            result = run(src, baseline)
            if result.returncode != 0:
                problems.append(f"safe shape {tag!r} was flagged: {result.stderr.strip()}")

        # Every leaky shape is seen, one fixture each.
        for tag, body in LEAKY_SHAPES.items():
            scope = tmp / f"leak-{tag}"
            src = make_tree(scope, {"widgets.ts": f"export function get() {{ try {{ work(); }} {body} }}"})
            baseline = scope / "baseline.json"
            baseline.write_text("{}\n", encoding="utf-8")
            result = run(src, baseline)
            if result.returncode == 0:
                problems.append(f"leaky shape {tag!r} passed")

        # A covered file may shrink but never grow.
        scope = tmp / "ratchet"
        src = make_tree(scope, {
            "widgets.ts": "export function a() { try { w(); } catch (error) "
                          "{ console.error('a', error); console.warn('b', error); } }",
        })
        baseline = scope / "baseline.json"
        key = "src/widgets.ts"
        baseline.write_text(json.dumps({key: 2}) + "\n", encoding="utf-8")
        if run(src, baseline).returncode != 0:
            problems.append("a file exactly at its baseline failed")

        baseline.write_text(json.dumps({key: 1}) + "\n", encoding="utf-8")
        if run(src, baseline).returncode == 0:
            problems.append("a file above its baseline passed")
        if run(src, baseline, "--update").returncode == 0:
            problems.append("--update recorded an increase")
        if json.loads(baseline.read_text())[key] != 1:
            problems.append("--update wrote a loosened baseline anyway")

        baseline.write_text(json.dumps({key: 5}) + "\n", encoding="utf-8")
        if run(src, baseline).returncode == 0:
            problems.append("a stale over-generous baseline entry passed")
        if run(src, baseline, "--update").returncode != 0:
            problems.append("--update refused to record an improvement")
        if json.loads(baseline.read_text())[key] != 2:
            problems.append("--update did not tighten to the real count")

        # Fail closed with no baseline at all.
        scope = tmp / "no-baseline"
        src = make_tree(scope, {"widgets.ts": SAFE})
        if run(src, scope / "absent.json").returncode == 0:
            problems.append("a missing baseline passed")

    if problems:
        print("Error-log hygiene gate self-test FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print(f"Error-log hygiene gate self-test passed (repository run, the sanctioned sink, "
          f"{len(LEAKY_SHAPES)} leaky shapes, {len(SAFE_SHAPES)} safe landmines, "
          "3 detector-blind source invariants, at/above/below baseline, two --update "
          "directions, missing baseline).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
