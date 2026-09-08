#!/usr/bin/env python3
"""Error-log hygiene ratchet (review 241ce388 F2, task 07113036).

THE RULE. A caught exception is untrusted, private data. Postgres puts the
OFFENDING ROW in `detail` on CHECK and unique violations, drivers put
connection strings in messages, and upstream clients put request bodies in
theirs. Handing the caught object — or its `.message`, `.stack` or `.name` —
to a logger publishes whatever it happens to carry. The repository's standard
(set by reviews f52e44db and b82cb8bd, and used by `routes/phases.ts` and
`routes/grants.ts`) is a **secret-safe sink**: a fixed context string plus a
bounded category, nothing exception-derived.

ZERO BASELINE. The historical exception-log population has been retired, so
the repository baseline is now empty and every production source file admits
zero exception-derived log calls. The per-file ratchet machinery remains to
self-prove exact/above/below-baseline behaviour and to fail closed if this gate
is reused against a partially migrated tree. `--update` still refuses to
record an increase, so the baseline cannot be "fixed" by re-running it.

Detection is deliberately syntactic and slightly broad. It learns arbitrary
bindings from `catch (...)` and promise `.catch(...)`, retains the conventional
error-name family, and inspects console plus logger-like calls. Bare/member,
object-shorthand, wrapped and template-interpolated references all count.
Strings, comments, template raw text, fixed object keys and unrelated member
properties are masked so fixed context remains legal. False positives are
cheap (use the sink); a missed leak is not.

Self-proved by scripts/test-error-log-hygiene-gate.py. Fails closed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "backend" / "src"
BASELINE_PATH = Path(__file__).resolve().parent / "error-log-baseline.json"

EXCLUDED_PARTS = {"node_modules", "dist", "coverage", "__tests__"}

LOGGER_CALL_RE = re.compile(
    r"(?:\bconsole|\b(?:[\w$]+\.)*[\w$]*logger|\blog)\."
    r"(?:error|warn|log|info|debug|trace)\s*\(",
    re.IGNORECASE,
)
DEFAULT_ERROR_NAMES = {"e", "err", "error", "ex", "exception", "caught"}
CATCH_CLAUSE_BINDING_RE = re.compile(
    r"(?<![.\w$])catch\s*\(\s*([A-Za-z_$][\w$]*)",
    re.IGNORECASE,
)
PROMISE_ARROW_BINDING_RE = re.compile(
    r"\.catch\s*\(\s*(?:async\s+)?\(?\s*"
    r"([A-Za-z_$][\w$]*)(?:\s*:\s*[^)=]+)?\s*\)?\s*=>",
    re.IGNORECASE,
)
PROMISE_FUNCTION_BINDING_RE = re.compile(
    r"\.catch\s*\(\s*(?:async\s+)?function"
    r"(?:\s+[A-Za-z_$][\w$]*)?\s*\(\s*([A-Za-z_$][\w$]*)",
    re.IGNORECASE,
)


def caught_names(code: str) -> set[str]:
    """Return inline catch bindings without mistaking callback modifiers for
    the caught value. In particular, `async` and `function` are syntax, while
    the first arrow/function parameter is the exception-derived binding."""
    names: set[str] = set()
    for pattern in (
        CATCH_CLAUSE_BINDING_RE,
        PROMISE_ARROW_BINDING_RE,
        PROMISE_FUNCTION_BINDING_RE,
    ):
        names.update(match.group(1) for match in pattern.finditer(code))
    return names


def source_files(root: Path) -> list[Path]:
    return sorted(
        path for path in root.rglob("*.ts")
        if not EXCLUDED_PARTS & set(path.parts) and not path.name.endswith(".test.ts")
    )


def mask_non_code(text: str) -> str:
    """Mask strings/comments/template raw text while retaining ${...} code."""
    masked = list(text)

    def blank(start: int, end: int) -> None:
        for position in range(start, end):
            if masked[position] not in "\r\n":
                masked[position] = " "

    def quoted(index: int, quote: str) -> int:
        end = index + 1
        while end < len(text):
            if text[end] == "\\":
                end = min(len(text), end + 2)
                continue
            if text[end] == quote:
                return end + 1
            end += 1
        return len(text)

    def code(index: int, stop_on_brace: bool = False) -> int:
        depth = 1
        while index < len(text):
            char = text[index]
            if char in "\"'":
                end = quoted(index, char)
                blank(index, end)
                index = end
                continue
            if char == "`":
                index = template(index)
                continue
            if text.startswith("//", index):
                newline = text.find("\n", index + 2)
                end = len(text) if newline < 0 else newline
                blank(index, end)
                index = end
                continue
            if text.startswith("/*", index):
                close = text.find("*/", index + 2)
                end = len(text) if close < 0 else close + 2
                blank(index, end)
                index = end
                continue
            if stop_on_brace and char == "{":
                depth += 1
            elif stop_on_brace and char == "}":
                depth -= 1
                if depth == 0:
                    blank(index, index + 1)
                    return index + 1
            index += 1
        return len(text)

    def template(index: int) -> int:
        blank(index, index + 1)
        index += 1
        while index < len(text):
            if text[index] == "\\":
                end = min(len(text), index + 2)
                blank(index, end)
                index = end
                continue
            if text[index] == "`":
                blank(index, index + 1)
                return index + 1
            if text.startswith("${", index):
                blank(index, index + 2)
                index = code(index + 2, stop_on_brace=True)
                continue
            blank(index, index + 1)
            index += 1
        return len(text)

    code(0)
    return "".join(masked)


def call_spans(text: str) -> list[str]:
    """Code-bearing argument text from console/logger calls."""
    code = mask_non_code(text)
    spans: list[str] = []
    for match in LOGGER_CALL_RE.finditer(code):
        depth = 1
        index = match.end()
        while index < len(code) and depth:
            character = code[index]
            if character == "(":
                depth += 1
            elif character == ")":
                depth -= 1
            index += 1
        spans.append(code[match.end():index - 1])
    return spans


def count_violations(text: str) -> int:
    code = mask_non_code(text)
    names = DEFAULT_ERROR_NAMES | caught_names(code)
    reference = re.compile(
        r"(?<![\w$.])(?:" + "|".join(sorted(map(re.escape, names), key=len, reverse=True))
        + r")(?![\w$])",
        re.IGNORECASE,
    )

    def leaks(span: str) -> bool:
        for match in reference.finditer(span):
            # `{ error: boundedCategory }` names a fixed object field; it does
            # not pass the caught value. Shorthand `{ error }` still fails.
            if re.match(r"\s*[:=]", span[match.end():]):
                continue
            return True
        return False

    return sum(1 for span in call_spans(text) if leaks(span))


def relativity(root: Path) -> Path:
    """Baseline keys are repository-relative for the real tree. A fixture tree
    lives outside the repository, so it is keyed from its own parent — the
    self-test needs the same code path, not a special case inside it."""
    try:
        root.resolve().relative_to(ROOT)
        return ROOT
    except ValueError:
        return root.resolve().parent


def scan(root: Path) -> dict[str, int]:
    base = relativity(root)
    counts: dict[str, int] = {}
    for path in source_files(root):
        total = count_violations(path.read_text(encoding="utf-8"))
        if total:
            counts[str(path.resolve().relative_to(base))] = total
    return counts


def load_baseline(path: Path) -> dict[str, int]:
    if not path.exists():
        raise SystemExit(f"error-log hygiene gate FAILED: baseline missing at {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def compare(counts: dict[str, int], baseline: dict[str, int]) -> list[str]:
    failures: list[str] = []
    for path, total in sorted(counts.items()):
        allowed = baseline.get(path)
        if allowed is None:
            failures.append(
                f"{path}: {total} exception-derived log argument(s) in a file the baseline "
                "does not cover. New and newly-touched code uses the secret-safe sink — a "
                "fixed context string plus a bounded category (see routes/preferences.ts).")
        elif total > allowed:
            failures.append(
                f"{path}: {total} exception-derived log argument(s), baseline allows {allowed}. "
                "This ratchet only ever tightens.")
        elif total < allowed:
            # Headroom is how a ratchet rots: a baseline of 5 over a file of 2
            # silently licenses three future leaks. An improvement must be
            # RECORDED, not merely tolerated.
            failures.append(
                f"{path}: improved to {total} but the baseline still allows {allowed} — "
                "run --update so the ratchet sits tight.")
    for path, allowed in sorted(baseline.items()):
        if path not in counts and allowed:
            failures.append(
                f"{path}: baseline claims {allowed} but the file is clean or gone — "
                "run --update to record the improvement.")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, default=SOURCE_ROOT)
    parser.add_argument("--baseline", type=Path, default=BASELINE_PATH)
    parser.add_argument("--update", action="store_true",
                        help="record improvements; refuses to record any increase")
    args = parser.parse_args()

    counts = scan(args.src)

    if args.update:
        baseline = load_baseline(args.baseline)
        rejected = [
            f"{path}: {total} > {baseline[path]}" for path, total in counts.items()
            if path in baseline and total > baseline[path]
        ] + [f"{path}: {total} in an uncovered file" for path in counts if path not in baseline]
        if rejected:
            print("Refusing to loosen the error-log baseline:", file=sys.stderr)
            for line in rejected:
                print(f"  {line}", file=sys.stderr)
            return 1
        args.baseline.write_text(json.dumps(counts, indent=2, sort_keys=True) + "\n",
                                 encoding="utf-8")
        print(f"Error-log baseline updated ({sum(counts.values())} remaining across "
              f"{len(counts)} file(s)).")
        return 0

    failures = compare(counts, load_baseline(args.baseline))
    if failures:
        print("Error-log hygiene gate FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print(f"Error-log hygiene gate passed ({sum(counts.values())} exception-derived "
          f"log arguments across {len(counts)} file(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
