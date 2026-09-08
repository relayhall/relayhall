#!/usr/bin/env python3
"""Red proof for the value-scoping leg of test-public-residue-gate.py.

Not a CI gate — it mutates a tracked file, so it is a manual drill, run and
recorded the way this wave's other red proofs are (backend/scripts/w2-red-proofs.js).

House shape: copy -> mutate on a single-occurrence anchor -> require the
EXPECTED failure -> byte-verified restore -> require green.

Mutation: turn the production value-scoped check back into a path-scoped one,
so any private literal passes as long as its FILE has an exemption set. That is
precisely the hole review 6fe97bc5 B2 found by hand. The self-test must go red
and name it; if it stays green, the value-scoping leg is decorative.
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
TARGET = SCRIPTS / "check-public-residue.py"
SELFTEST = SCRIPTS / "test-public-residue-gate.py"

ANCHOR = """                if literal in allowed_values:
                    continue"""
MUTANT = """                if allowed_values:
                    continue"""
EXPECTED = "exemption is path-scoped, not value-scoped"


def run_selftest() -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(SELFTEST)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original = TARGET.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    text = original.decode()

    occurrences = text.count(ANCHOR)
    if occurrences != 1:
        print(f"FAIL: anchor occurs {occurrences} times, expected exactly 1", file=sys.stderr)
        return 1

    code, out = run_selftest()
    if code != 0:
        print(f"FAIL: self-test is not green before the mutation (exit {code})\n{out}", file=sys.stderr)
        return 1
    print("  pre-mutation: self-test GREEN")

    try:
        TARGET.write_text(text.replace(ANCHOR, MUTANT))
        code, out = run_selftest()
    finally:
        TARGET.write_bytes(original)

    restored = hashlib.sha256(TARGET.read_bytes()).hexdigest()
    if restored != digest:
        print(f"FAIL: restore is not byte-identical ({restored} != {digest})", file=sys.stderr)
        return 1
    print("  restore: byte-verified")

    if code == 0:
        print(
            "FAIL: the mutation left the self-test GREEN — the value-scoping leg is vacuous",
            file=sys.stderr,
        )
        return 1
    if EXPECTED not in out:
        print(f"FAIL: self-test went red for the wrong reason (expected {EXPECTED!r}):\n{out}", file=sys.stderr)
        return 1
    print(f"  mutation: self-test RED by name (exit {code})")

    code, out = run_selftest()
    if code != 0:
        print(f"FAIL: self-test is not green after restore (exit {code})\n{out}", file=sys.stderr)
        return 1
    print("  post-restore: self-test GREEN")
    print("RED PROOF PROVEN: the value-scoping leg turns red on a path-scoped mutation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
