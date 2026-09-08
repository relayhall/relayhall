#!/usr/bin/env python3
"""Reject private deployment provenance from the curated public source tree.

Generic, non-disclosing checks (private IPv4 literals) are built in. The
deployment-specific pattern set — operator names, private hosts, private
paths — is deliberately NOT embedded in this file: a published scanner must
not disclose the very strings it guards (RH-P1.6 verification finding).
Deployment patterns load from, in precedence order:

  1. RELAYHALL_RESIDUE_PATTERNS      — env var, JSON list of [pattern, label]
  2. RELAYHALL_RESIDUE_PATTERNS_FILE — path to a JSON file of the same shape
  3. .residue-patterns.local.json    — untracked file at the repository root

CI supplies (1) from a repository secret. When no deployment set is present
the scan still runs its generic checks and prints a warning, so public forks
work without the secret while the private tree keeps full coverage.
"""

from __future__ import annotations

import ipaddress
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
LOCAL_PATTERNS_NAME = ".residue-patterns.local.json"

IP_PATTERN = re.compile(r"(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9.])")
RFC1918_NETWORKS = tuple(
    ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
RFC1918_FIXTURE_PATHS = {
    "backend/src/__tests__/loginRateLimit.test.ts",
    "backend/src/__tests__/pluginProxyAuthorization.test.ts",
    "backend/src/middleware/loginRateLimit.ts",
    "docs/design-history/acp-integration-design.md",
    # This scanner's own generic RFC1918 range constants (nothing else in the
    # file is deployment-specific — the deployment pattern set is external).
    "scripts/check-public-residue.py",
}

# ── VALUE-scoped fixture allowances (review 6fe97bc5 B2) ───────────────────
#
# A whole-file exemption skips EVERY private literal in that file, including
# ones nobody reviewed. The reviewer proved it: `10.99.88.77` inserted into
# `outboundAddressPolicy.ts` still passed, because the path was exempt.
#
# These files are exempted BY VALUE instead. Each literal below is a range
# boundary the code or its suite exists to talk about, listed with the RFC
# range it stands for, and ANY OTHER private literal in the same file still
# fails. That keeps the gate able to catch a real deployment address appearing
# next to the fixtures — which is the whole point of the gate.
RFC1918_FIXTURE_VALUES: dict[str, set[str]] = {
    # RH-P3.C6: the OAuth authorization server's outbound-address policy. The
    # private ranges are the SUBJECT here, not provenance — the policy exists
    # to refuse them when a caller-supplied Client ID Metadata Document URL
    # resolves into one.
    "backend/src/utils/outboundAddressPolicy.ts": {
        "10.0.0.0",       # 10.0.0.0/8
        "172.16.0.0",     # 172.16.0.0/12
        "192.168.0.0",    # 192.168.0.0/16
    },
    # ...and the suite that enumerates each refused range with a public
    # control beside it. The estate's own address is deliberately absent: it
    # was REMOVED from the suite rather than listed here.
    "backend/src/__tests__/c6OAuthAuthorizationServer.test.ts": {
        "10.0.0.0",       # 10.0.0.0/8 (range label)
        "10.0.0.1",       # 10.0.0.0/8 sample
        "10.1.2.3",       # 10.0.0.0/8 sample, reason-classification case
        "172.16.0.0",     # 172.16.0.0/12 (range label)
        "172.16.0.1",     # 172.16.0.0/12 lower edge
        "172.31.255.254", # 172.16.0.0/12 upper edge
        "192.168.0.0",    # 192.168.0.0/16 (range label)
        "192.168.1.1",    # 192.168.0.0/16 sample
    },
    # RH-P5.SSO.W2: the §4.5(a) conformance gate's shape class 7 — "the issuer
    # really is deployed on an address the public internet cannot reach". The
    # address IS the provider characteristic the class observes, so it is
    # fixture data by design; the class asserts it is refused with the private
    # -address flag off and pinned with it on, against a public control.
    "backend/src/__tests__/conformance/fixtures.ts": {
        "10.0.0.5",       # 10.0.0.0/8 — class 7 private-issuer-address fixture
    },
    # ...and the red-proof driver, whose class-7 hollowing must match that
    # fixture line byte-for-byte to substitute a public address for it.
    "backend/scripts/w2-red-proofs.js": {
        "10.0.0.5",       # 10.0.0.0/8 — the M-v.7 hollowing anchor
    },
    # RH-KW1 candidate A: the knowledge plane's outbound policy suites. The
    # private ranges are the SUBJECT — acceptance item 5 requires an
    # allow-listed private CIDR to be admitted for one source and refused
    # for another, which cannot be drilled without naming one. The estate's
    # own address is deliberately absent: the fixture discovers this host's
    # address at run time from os.networkInterfaces() and never writes it
    # into the tree.
    "backend/src/__tests__/kw1KnowledgeOutboundPolicy.test.ts": {
        "10.0.0.0",       # 10.0.0.0/8 (allow-list range label)
        "10.0.0.7",       # 10.0.0.0/8 sample, the not-allow-listed case
        "172.16.0.0",     # 172.16.0.0/12 (range label, no-second-table census)
        "172.16.0.1",     # 172.16.0.0/12 sample, agrees-with-shipped-verdict pair
        "192.168.0.0",    # 192.168.0.0/16 (range label, no-second-table census)
        "192.168.1.1",    # 192.168.0.0/16 sample, agrees-with-shipped-verdict pair
    },
    "backend/src/__tests__/kw1KnowledgeSourcePlane.test.ts": {
        "10.0.0.0",       # 10.0.0.0/8 — the owner-plane allow-list value
    },
    # conformance/gate.ts is deliberately ABSENT: its two address defaults were
    # REMOVED rather than exempted, so the gate now takes both addresses from
    # the fixture and cannot supply a private literal of its own at all.
}


# ── The LICENSE copyright line (owner ruling 2026-09-05, register PART 4) ────
#
# The public repository's LICENSE carries the owner's name on its copyright
# line by the owner's explicit decision, and the beta publishes that text
# verbatim. The deployment pattern set — which is never embedded here —
# classifies that name as personal operator attribution. This allowance is
# scoped THREE ways so nothing else rides on it: the path must be exactly
# LICENSE, the pattern's label must name attribution, and the match must sit
# on a line that begins with "Copyright". The same name anywhere else in
# LICENSE, any other pattern on the copyright line, and this name in any other
# file all still fail. No private literal appears in this file.
LICENSE_ATTRIBUTION_PATH = "LICENSE"
LICENSE_ATTRIBUTION_LABEL_TOKEN = "attribution"


def license_copyright_allowance(rel: str, label: str, text: str, start: int) -> bool:
    if rel != LICENSE_ATTRIBUTION_PATH:
        return False
    if LICENSE_ATTRIBUTION_LABEL_TOKEN not in label.lower():
        return False
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", start)
    if line_end == -1:
        line_end = len(text)
    return text[line_start:line_end].lstrip().lower().startswith("copyright")


def load_deployment_patterns(root: Path) -> tuple[list[tuple[re.Pattern[str], str]], str]:
    raw: str | None = None
    source = "none"
    if os.environ.get("RELAYHALL_RESIDUE_PATTERNS"):
        raw = os.environ["RELAYHALL_RESIDUE_PATTERNS"]
        source = "env"
    else:
        file_candidates = []
        if os.environ.get("RELAYHALL_RESIDUE_PATTERNS_FILE"):
            file_candidates.append(Path(os.environ["RELAYHALL_RESIDUE_PATTERNS_FILE"]))
        file_candidates.append(root / LOCAL_PATTERNS_NAME)
        for candidate in file_candidates:
            if candidate.is_file():
                raw = candidate.read_text()
                source = str(candidate)
                break
    if raw is None:
        return [], source
    try:
        entries = json.loads(raw)
    except ValueError as err:
        print(f"Public residue contract: invalid deployment pattern set ({err})", file=sys.stderr)
        raise SystemExit(2)
    # Strict shape validation — a configured set that is not exactly a
    # non-empty JSON list of [pattern, label] string pairs is rejected, never
    # silently coerced: fail-open here would defeat the gate (review 9eac4b51).
    if not isinstance(entries, list) or not entries:
        print(
            "Public residue contract: invalid deployment pattern set "
            "(must be a non-empty JSON list of [pattern, label] pairs)",
            file=sys.stderr,
        )
        raise SystemExit(2)
    patterns: list[tuple[re.Pattern[str], str]] = []
    for index, entry in enumerate(entries):
        if (
            not isinstance(entry, list)
            or len(entry) != 2
            or not isinstance(entry[0], str)
            or not isinstance(entry[1], str)
            or not entry[0]
            or not entry[1]
        ):
            print(
                f"Public residue contract: invalid deployment pattern set "
                f"(entry {index} must be a [pattern, label] pair of non-empty strings)",
                file=sys.stderr,
            )
            raise SystemExit(2)
        try:
            compiled = re.compile(entry[0], re.IGNORECASE)
        except re.error as err:
            print(
                f"Public residue contract: invalid deployment pattern set "
                f"(entry {index}: bad regex — {err})",
                file=sys.stderr,
            )
            raise SystemExit(2)
        patterns.append((compiled, entry[1]))
    return patterns, source


# Extensions whose files are BINARY on purpose. Everything else in the tree is
# expected to be text, and a NUL byte in it is a defect (see the check in
# main()).
BINARY_SUFFIXES = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif", ".bmp",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".tar",
    ".mp3", ".mp4", ".mov", ".webm", ".wav", ".ogg",
    ".jar", ".class", ".so", ".dylib", ".dll", ".exe", ".wasm",
    ".pyc", ".node", ".bin", ".db", ".sqlite", ".sqlite3",
})


def tracked_files(root: Path) -> list[str]:
    if root != DEFAULT_ROOT:
        return sorted(
            path.relative_to(root).as_posix()
            for path in root.rglob("*")
            if path.is_file() or path.is_symlink()
        )
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        check=True,
        stdout=subprocess.PIPE,
    )
    return sorted(part.decode() for part in result.stdout.split(b"\0") if part)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    root = args.root.resolve()
    deployment_patterns, source = load_deployment_patterns(root)
    failures: list[str] = []
    checked = 0
    for rel in tracked_files(root):
        path = root / rel
        if rel == LOCAL_PATTERNS_NAME:
            continue
        if not path.is_file() or path.is_symlink():
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue

        # A file with a known-binary extension is not text and has nothing here
        # to scan. Saying so EXPLICITLY is the point: it is the ONLY exemption,
        # and everything else must decode.
        if path.suffix.lower() in BINARY_SUFFIXES:
            continue

        # A NUL BYTE IN A TEXT FILE IS A DEFECT. Git treats such a file as
        # binary, so it has no reviewable diff at all: a change inside it
        # reaches a reviewer as "Bin 0 -> 8097 bytes" and nothing more.
        #
        # This is a GIT-REVIEWABILITY defect, not a decoding one. U+0000 is
        # perfectly valid UTF-8 and the decode below accepts it happily; review
        # 7b0ea9dd G6 corrected an earlier comment here that conflated the two.
        # The decode bypass is the SEPARATE check that follows.
        #
        # RH-TW1a found this the expensive way: a test file was committed with
        # three spaces written as U+0000. Every test passed, `tsc` passed, CI
        # passed; the only thing that noticed was a human reading
        # `git diff --stat` and seeing "Bin 0 -> 8097 bytes".
        if b"\x00" in raw:
            offset = raw.index(b"\x00")
            line = raw.count(b"\n", 0, offset) + 1
            failures.append(
                f"{rel}:{line}: NUL byte in a text file — git treats it as binary, "
                "so it has no reviewable diff"
            )
            continue

        # AND A FILE THIS GATE CANNOT DECODE IS A FILE IT CANNOT SCAN.
        #
        # The previous version caught UnicodeDecodeError and continued, which
        # made the scanner FAIL OPEN: a tracked extensionless or mislabelled
        # file hid every deployment regex and every RFC1918 literal behind one
        # undecodable byte, and the run still reported success. Review 7b0ea9dd
        # G5 demonstrated it with an extensionless file beginning 0xff, which
        # scanned "0 text files" and exited 0. Skipping is now reserved for the
        # explicit binary extensions above; anything else that will not decode
        # is a named failure with a location.
        try:
            text = raw.decode()
        except UnicodeDecodeError as exc:
            line = raw.count(b"\n", 0, exc.start) + 1
            failures.append(
                f"{rel}:{line}: undecodable byte at offset {exc.start} in a file with no "
                "known-binary extension — this gate cannot scan what it cannot decode, "
                "so residue could hide here"
            )
            continue
        checked += 1
        for pattern, label in deployment_patterns:
            for match in pattern.finditer(text):
                if license_copyright_allowance(rel, label, text, match.start()):
                    continue
                line = text.count("\n", 0, match.start()) + 1
                failures.append(f"{rel}:{line}: {label}")
        if rel not in RFC1918_FIXTURE_PATHS:
            allowed_values = RFC1918_FIXTURE_VALUES.get(rel, frozenset())
            for match in IP_PATTERN.finditer(text):
                literal = match.group(0)
                try:
                    address = ipaddress.ip_address(literal)
                except ValueError:
                    continue
                if not any(address in network for network in RFC1918_NETWORKS):
                    continue
                # Value-scoped, not path-scoped: an UNLISTED private literal in
                # a fixture file still fails (review 6fe97bc5 B2).
                if literal in allowed_values:
                    continue
                line = text.count("\n", 0, match.start()) + 1
                failures.append(f"{rel}:{line}: private IPv4 literal")
    if failures:
        print("Public residue contract failed:")
        for failure in failures:
            print(f"  {failure}")
        return 1
    if not deployment_patterns:
        print(
            "Public residue contract passed with GENERIC checks only "
            f"({checked} text files) — no deployment pattern set present "
            "(set RELAYHALL_RESIDUE_PATTERNS or provide "
            f"{LOCAL_PATTERNS_NAME})"
        )
    else:
        print(
            f"Public residue contract passed ({checked} text files, "
            f"deployment patterns: {len(deployment_patterns)} from {source})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
