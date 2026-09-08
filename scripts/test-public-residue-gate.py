#!/usr/bin/env python3
"""Self-proof for scripts/check-public-residue.py's pattern loader (RH-P1.6a,
review 9eac4b51 blocking finding 1: a malformed-but-parseable set must never
fail open).

Feeds fixture values through the production load_deployment_patterns()
function via the environment — no repository files are written or read, so
the proof is deterministic and independent of tree state. Every malformed
shape must exit 2; valid sets must compile; an absent set must load as the
distinct generic-only mode.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path

GATE_PATH = Path(__file__).resolve().parent / "check-public-residue.py"
loader = SourceFileLoader("public_residue_gate", str(GATE_PATH))
spec = importlib.util.spec_from_loader("public_residue_gate", loader)
assert spec is not None
gate = importlib.util.module_from_spec(spec)
loader.exec_module(gate)

# A directory that cannot contain a local pattern file, so "absent" is real.
EMPTY_ROOT = Path("/nonexistent-residue-selftest-root")

# Each entry: (label, RELAYHALL_RESIDUE_PATTERNS value). MUST exit 2.
MUST_REJECT = [
    ("json object", '{"☃x": "ignored"}'),
    ("json scalar", '"just-a-string"'),
    ("json number", "42"),
    ("empty list", "[]"),
    ("entry too short", '[["only-pattern"]]'),
    ("entry too long", '[["p", "label", "extra"]]'),
    ("non-string pattern", '[[123, "label"]]'),
    ("non-string label", '[["p", 456]]'),
    ("empty pattern string", '[["", "label"]]'),
    ("empty label string", '[["p", ""]]'),
    ("entry is object", '[{"pattern": "p", "label": "l"}]'),
    ("invalid regex", '[["([unclosed", "label"]]'),
    ("invalid json", "{not json"),
]

# Each entry: (label, value, expected pattern count). MUST load.
MUST_ACCEPT = [
    ("single pair", '[["private-host", "private host name"]]', 1),
    ("multiple pairs", '[["a+", "label a"], ["b{2}", "label b"]]', 2),
]


def load_with_env(value: str | None):
    saved = {
        key: os.environ.pop(key, None)
        for key in ("RELAYHALL_RESIDUE_PATTERNS", "RELAYHALL_RESIDUE_PATTERNS_FILE")
    }
    try:
        if value is not None:
            os.environ["RELAYHALL_RESIDUE_PATTERNS"] = value
        return gate.load_deployment_patterns(EMPTY_ROOT)
    finally:
        for key, prior in saved.items():
            if prior is not None:
                os.environ[key] = prior
            else:
                os.environ.pop(key, None)


# ── Value-scoping proof (review 6fe97bc5 B2, drilled for EVERY entry) ──────
#
# A whole-file exemption skips every private literal in that file, including
# ones nobody reviewed; the reviewer proved that hole by inserting one by hand.
# This drills it permanently against the PRODUCTION scan, for every path in
# RFC1918_FIXTURE_VALUES rather than for the one path that prompted it: each
# listed value must pass, and an UNLISTED private literal in the SAME file must
# still fail, naming its own line and not the listed one. Fixture trees are
# built in a temporary directory — no repository file is written or read.
#
# The probe address is DERIVED from the gate's own RFC1918_NETWORKS rather than
# written as a literal: a private literal here would itself be residue, and
# exempting it would grow the very list this proof exists to distrust. Deriving
# it also means the probe is private by the production definition of private.


def probe_address(excluded: set[str]) -> str:
    network = gate.RFC1918_NETWORKS[0]
    for offset in range(1, 4096):
        candidate = network.network_address + offset
        if candidate in network and str(candidate) not in excluded:
            return str(candidate)
    raise AssertionError("no probe address available outside the exemption set")


def run_gate(root: Path) -> tuple[int, str]:
    """Run the production main() over `root`, with any configured deployment
    pattern set removed so the RFC1918 leg is what is being measured."""
    saved = {
        key: os.environ.pop(key, None)
        for key in ("RELAYHALL_RESIDUE_PATTERNS", "RELAYHALL_RESIDUE_PATTERNS_FILE")
    }
    argv = sys.argv
    buffer = io.StringIO()
    try:
        sys.argv = ["check-public-residue.py", "--root", str(root)]
        with contextlib.redirect_stdout(buffer):
            code = gate.main()
    finally:
        sys.argv = argv
        for key, prior in saved.items():
            if prior is not None:
                os.environ[key] = prior
            else:
                os.environ.pop(key, None)
    return code, buffer.getvalue()


def value_scoping_problems() -> list[str]:
    found: list[str] = []
    if not gate.RFC1918_FIXTURE_VALUES:
        return ["RFC1918_FIXTURE_VALUES is empty — this proof would be vacuous"]
    for rel, allowed in sorted(gate.RFC1918_FIXTURE_VALUES.items()):
        if not allowed:
            found.append(f"{rel}: exemption set is empty")
            continue
        listed = sorted(allowed)[0]
        unlisted = probe_address(allowed)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)

            # (a) Positive control: the listed value alone must PASS, or the
            # proof below would be measuring a gate that rejects everything.
            target.write_text(f"const listed = '{listed}';\n")
            code, out = run_gate(root)
            if code != 0:
                found.append(f"{rel}: listed value {listed} was rejected: {out.strip()}")
                continue

            # (b) The proof: an UNLISTED private literal in the SAME file fails.
            target.write_text(
                f"const listed = '{listed}';\n"
                f"const unlisted = '{unlisted}';\n"
            )
            code, out = run_gate(root)
            if code != 1:
                found.append(
                    f"{rel}: unlisted private literal was ACCEPTED (exemption is "
                    f"path-scoped, not value-scoped) — exit {code}"
                )
                continue
            if f"{rel}:2:" not in out:
                found.append(f"{rel}: failure did not name the unlisted literal's line: {out.strip()}")
            if f"{rel}:1:" in out:
                found.append(f"{rel}: the LISTED value was reported as an offender: {out.strip()}")

            # Non-vacuity control. The same bytes under the OTHER production
            # mechanism — RFC1918_FIXTURE_PATHS, which IS whole-file — must
            # pass. Without this, "the unlisted literal failed" could be true
            # because the harness fails on anything, and the proof would not be
            # measuring value-scoping at all.
            saved_paths = gate.RFC1918_FIXTURE_PATHS
            try:
                gate.RFC1918_FIXTURE_PATHS = saved_paths | {rel}
                code, out = run_gate(root)
            finally:
                gate.RFC1918_FIXTURE_PATHS = saved_paths
            if code != 0:
                found.append(
                    f"{rel}: control failed — the same file passes nothing even under a "
                    f"whole-file exemption, so the proof above measured something else: {out.strip()}"
                )
    return found


def nul_byte_problems() -> list[str]:
    """Prove the NUL-byte leg, including that its exemption is not vacuous.

    The defect this leg exists for was invisible to every other control: a
    source file with NUL bytes compiles, passes its tests, and passes CI, while
    git reports it as binary and shows no diff. So the proof has to show three
    things — that a clean file passes, that the same file with one NUL fails and
    names its line, and that a genuinely binary file is still allowed to contain
    NULs, or the check would simply reject the tree's images.
    """
    found: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / "src" / "example.ts"
        source.parent.mkdir(parents=True, exist_ok=True)

        # (a) Positive control: the same file, clean, must PASS.
        source.write_bytes(b"const greeting = 'hello';\nconst other = 1;\n")
        code, out = run_gate(root)
        if code != 0:
            found.append(f"a clean text file was rejected: {out.strip()}")
            return found

        # (b) The proof: one NUL where a space belongs.
        source.write_bytes(b"const greeting = 'hello';\nconst other =\x001;\n")
        code, out = run_gate(root)
        if code != 1:
            found.append(f"a NUL byte in a .ts file was ACCEPTED — exit {code}")
        elif "src/example.ts:2:" not in out:
            found.append(f"the failure did not name the NUL's line: {out.strip()}")
        elif "NUL byte" not in out:
            found.append(f"the failure did not say what was wrong: {out.strip()}")

        # (c) Non-vacuity: a real binary file may still contain NULs, or this
        # leg would reject every image in the tree and the proof above would be
        # measuring a gate that fails on everything.
        source.unlink()
        image = root / "assets" / "logo.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00")
        code, out = run_gate(root)
        if code != 0:
            found.append(f"a genuine binary file was rejected for its NULs: {out.strip()}")
    return found


def undecodable_problems() -> list[str]:
    """Prove the gate FAILS CLOSED on a file it cannot decode.

    Review 7b0ea9dd G5: the scanner used to catch UnicodeDecodeError and
    continue, so one undecodable byte in a tracked extensionless or mislabelled
    file hid every deployment regex and every RFC1918 literal behind it — and
    the run reported success. The reviewer demonstrated it with an
    extensionless file beginning 0xff that scanned "0 text files" and exited 0.

    This is that file, plus the two controls that keep the proof honest: the
    same path with decodable bytes must PASS (or the check is just rejecting
    extensionless files), and a genuine binary EXTENSION must still be skipped
    (or the gate would reject every image in the tree).
    """
    found: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        # (a) Positive control: an extensionless file that DOES decode passes.
        mystery = root / "mystery"
        mystery.write_bytes(b"just some ordinary text" + b"\n")
        code, out = run_gate(root)
        if code != 0:
            found.append(f"a decodable extensionless file was rejected: {out.strip()}")
            return found

        # (b) The proof: the reviewer's own hostile file.
        mystery.write_bytes(b"\xff" + b"some text")
        code, out = run_gate(root)
        if code != 1:
            found.append(f"an UNDECODABLE extensionless file was ACCEPTED — exit {code}: {out.strip()}")
        elif "mystery:1:" not in out:
            found.append(f"the failure did not name the file and line: {out.strip()}")
        elif "undecodable byte" not in out:
            found.append(f"the failure did not say what was wrong: {out.strip()}")

        # (c) Non-vacuity: the SAME bytes under a known-binary extension are
        # skipped, or this leg would reject every image in the tree.
        mystery.unlink()
        image = root / "assets" / "logo.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"\xff" + b"not really a png")
        code, out = run_gate(root)
        if code != 0:
            found.append(f"a known-binary extension was rejected for undecodable bytes: {out.strip()}")
    return found


def run_gate_with_patterns(root: Path, value: str) -> tuple[int, str]:
    """Run the production main() over `root` with an explicit deployment
    pattern set in the environment — the deployment leg is what is measured."""
    saved = {
        key: os.environ.pop(key, None)
        for key in ("RELAYHALL_RESIDUE_PATTERNS", "RELAYHALL_RESIDUE_PATTERNS_FILE")
    }
    os.environ["RELAYHALL_RESIDUE_PATTERNS"] = value
    argv = sys.argv
    buffer = io.StringIO()
    try:
        sys.argv = ["check-public-residue.py", "--root", str(root)]
        with contextlib.redirect_stdout(buffer):
            code = gate.main()
    finally:
        sys.argv = argv
        os.environ.pop("RELAYHALL_RESIDUE_PATTERNS", None)
        for key, prior in saved.items():
            if prior is not None:
                os.environ[key] = prior
    return code, buffer.getvalue()


def license_attribution_problems() -> list[str]:
    """The LICENSE copyright-line allowance is scoped by path, label AND line.
    The probe name is invented; it stands for whatever the deployment set
    classifies as attribution."""
    found: list[str] = []
    name = "Probe Attribution Person"
    attribution_set = f'[["{name}", "personal operator attribution"]]'
    other_label_set = f'[["{name}", "private host"]]'
    body = "MIT License\n\nCopyright (c) 2026 {name}\n\nPermission is hereby granted.\n"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        lic = root / gate.LICENSE_ATTRIBUTION_PATH

        # (a) Positive control: the name on LICENSE's copyright line, under an
        # attribution label, PASSES.
        lic.write_text(body.format(name=name))
        code, out = run_gate_with_patterns(root, attribution_set)
        if code != 0:
            found.append(f"LICENSE copyright line was rejected: {out.strip()}")
            return found

        # (b) LINE scope: the same name on a NON-copyright line of LICENSE fails,
        # and the copyright line is not reported.
        lic.write_text(body.format(name=name) + f"\nAuthors: {name}\n")
        code, out = run_gate_with_patterns(root, attribution_set)
        if code != 1:
            found.append(f"attribution off the copyright line was ACCEPTED (exit {code})")
        else:
            if "LICENSE:7:" not in out:
                found.append(f"failure did not name the Authors line: {out.strip()}")
            if "LICENSE:3:" in out:
                found.append(f"the copyright line was reported as an offender: {out.strip()}")

        # (c) LABEL scope: a non-attribution label matching on the copyright line fails.
        lic.write_text(body.format(name=name))
        code, out = run_gate_with_patterns(root, other_label_set)
        if code != 1:
            found.append(f"a non-attribution label on the copyright line was ACCEPTED (exit {code})")

        # (d) PATH scope: the same copyright line in another file fails.
        lic.unlink()
        (root / "README.md").write_text(body.format(name=name))
        code, out = run_gate_with_patterns(root, attribution_set)
        if code != 1:
            found.append(f"the copyright line in README.md was ACCEPTED (exit {code})")
        elif "README.md:3:" not in out:
            found.append(f"failure did not name README.md:3: {out.strip()}")
    return found


def main() -> int:
    problems: list[str] = []

    problems.extend(nul_byte_problems())
    problems.extend(undecodable_problems())

    for label, value in MUST_REJECT:
        try:
            load_with_env(value)
        except SystemExit as exc:
            if exc.code != 2:
                problems.append(f"malformed set exited {exc.code}, not 2: {label}")
        else:
            problems.append(f"malformed set was ACCEPTED (fail-open): {label}")

    for label, value, expected in MUST_ACCEPT:
        try:
            patterns, source = load_with_env(value)
        except SystemExit:
            problems.append(f"valid set was rejected: {label}")
            continue
        if len(patterns) != expected or source != "env":
            problems.append(f"valid set mis-loaded ({len(patterns)} from {source}): {label}")

    # Absent must stay distinct from configured-but-empty: no set at all loads
    # the generic-only mode instead of exiting.
    try:
        patterns, source = load_with_env(None)
    except SystemExit:
        problems.append("absent set exited instead of loading generic-only mode")
    else:
        if patterns or source != "none":
            problems.append(f"absent set produced patterns ({len(patterns)} from {source})")

    problems.extend(value_scoping_problems())
    problems.extend(license_attribution_problems())

    if problems:
        print("Public residue gate self-test FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(
        f"Public residue gate self-test passed ({len(MUST_REJECT)} malformed sets exit 2, "
        f"{len(MUST_ACCEPT)} valid sets load, absent set stays generic-only, "
        f"{len(gate.RFC1918_FIXTURE_VALUES)} fixture-value exemptions proved value-scoped, "
        f"the LICENSE copyright allowance proved path-, label- and line-scoped, the NUL-byte leg proved on a clean file, a poisoned one and a genuine binary, "
        f"and the undecodable leg proved fail-closed on an extensionless 0xff file)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
