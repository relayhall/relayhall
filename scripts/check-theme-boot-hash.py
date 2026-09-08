#!/usr/bin/env python3
"""Theme boot-snippet hash gate (task 07113036, RH-DESIGN.6 §5.5/§5.6).

The FOUC guard is the one inline script RelayHall serves, and §5.6 admits it
into the dashboard CSP by hash:

    script-src 'self' 'sha256-<theme-boot-snippet>'

A CSP hash that does not match the bytes actually served does not degrade
gracefully — the snippet is silently blocked, and the failure looks like a
theme flash nobody can reproduce. So the hash is not a number somebody copies
once: it is recorded in docs/design-system.md and proved here against

  * frontend/index.html  — the source of truth for the snippet, and
  * frontend/dist/index.html — what the build actually emits, because Vite
    minifies inline scripts and a minifier that reformats one byte changes
    the hash, and
  * frontend/nginx.conf — the CSP that ACTUALLY admits it (RH-UI.4). Proving
    the snippet against a document while the served policy carries a different
    hash would prove nothing about the running product: the record and the
    policy have to be the same string, and here they are compared.

The nginx check also holds two §5.6 rules that are invisible until something
breaks: `wss:` must NOT appear (modern CSP resolves the same-origin socket
against `connect-src 'self'`, while the bare scheme permits a socket to any
host — review S-F2), and the nested asset `location` must REPEAT the policy,
because an `add_header` in a child block discards every inherited header (S-F3).

Modes:
  (default)          check the source HTML against the recorded hash
  --html <path>      check that HTML instead (CI runs this over dist/)
  --print            print the computed hash for the source (no comparison)

Fails closed on a missing snippet, a missing record, or a mismatch.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = ROOT / "frontend" / "index.html"
DOC_PATH = ROOT / "docs" / "design-system.md"
NGINX_PATH = ROOT / "frontend" / "nginx.conf"

# The snippet is identified by its marker attribute, not by position or by
# content matching: the marker is what survives a build, a reformat and a
# rewrite of the snippet itself.
SNIPPET_RE = re.compile(r"<script data-theme-boot>(.*?)</script>", re.DOTALL)
RECORD_RE = re.compile(r"^theme-boot-csp-hash:\s*(sha256-[A-Za-z0-9+/=]+)\s*$", re.MULTILINE)


def extract_snippet(html: str, where: str) -> str:
    matches = SNIPPET_RE.findall(html)
    if not matches:
        raise SystemExit(
            f"theme boot-hash gate FAILED: no <script data-theme-boot> in {where}")
    if len(matches) > 1:
        raise SystemExit(
            f"theme boot-hash gate FAILED: {len(matches)} boot snippets in {where}; "
            "the CSP admits exactly one hash")
    return matches[0]


def csp_hash(snippet: str) -> str:
    digest = hashlib.sha256(snippet.encode("utf-8")).digest()
    return f"sha256-{base64.b64encode(digest).decode('ascii')}"


def recorded_hash(doc_text: str) -> str:
    match = RECORD_RE.search(doc_text)
    if not match:
        raise SystemExit(
            "theme boot-hash gate FAILED: docs/design-system.md carries no "
            "`theme-boot-csp-hash:` record")
    return match.group(1)


def check_nginx(nginx_text: str, expected: str) -> list[str]:
    """The served policy must carry the recorded hash, and obey §5.6's two traps."""
    failures: list[str] = []

    policies = re.findall(r"set\s+\$relayhall_csp\s+\"([^\"]+)\"", nginx_text)
    if not policies:
        return ["frontend/nginx.conf: no $relayhall_csp policy is defined"]
    for policy in policies:
        if expected not in policy:
            failures.append(
                f"frontend/nginx.conf: the CSP does not carry {expected} — "
                "the served policy and the recorded hash have drifted apart")
        if "wss:" in policy:
            failures.append(
                "frontend/nginx.conf: the CSP names the bare `wss:` scheme, which "
                "permits a socket to ANY host. `connect-src 'self'` already covers "
                "the same-origin WebSocket (§5.6, review S-F2).")

    # The nested asset location must repeat what it would otherwise discard.
    # Found by brace-matching rather than by a regex over the location pattern:
    # the extension list contains digits and pipes and will be edited, and a
    # gate that stops finding its subject is a gate that stops working.
    marker = re.search(r"location\s+~\*[^{]*\{", nginx_text)
    if not marker:
        failures.append("frontend/nginx.conf: the nested asset location is gone — "
                        "if it moved, this check has to move with it")
    else:
        depth, index = 0, marker.end() - 1
        while index < len(nginx_text):
            if nginx_text[index] == "{":
                depth += 1
            elif nginx_text[index] == "}":
                depth -= 1
                if depth == 0:
                    break
            index += 1
        body = nginx_text[marker.end():index]
        if "Content-Security-Policy" not in body:
            failures.append(
                "frontend/nginx.conf: the nested asset location sets add_header but does "
                "NOT repeat Content-Security-Policy. A child add_header block discards "
                "every inherited header, so assets would ship with no policy at all "
                "while the document looked protected (§5.6, review S-F3).")
        if "X-Content-Type-Options" not in body:
            failures.append(
                "frontend/nginx.conf: the nested asset location does not repeat "
                "X-Content-Type-Options, for the same inheritance reason.")
    return failures


def run(html: str, doc_text: str, where: str) -> list[str]:
    actual = csp_hash(extract_snippet(html, where))
    expected = recorded_hash(doc_text)
    if actual != expected:
        return [
            f"{where}: snippet hashes to {actual}",
            f"  docs/design-system.md records {expected}",
            "  update the record (and RH-UI.4's CSP) in the same change as the snippet",
        ]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, default=HTML_PATH,
                        help="HTML carrying the snippet (CI passes frontend/dist/index.html)")
    parser.add_argument("--doc", type=Path, default=DOC_PATH,
                        help="document carrying the hash record (fixture override)")
    parser.add_argument("--nginx", type=Path, default=NGINX_PATH,
                        help="nginx config carrying the served CSP (fixture override)")
    parser.add_argument("--print", dest="print_only", action="store_true",
                        help="print the computed hash instead of comparing")
    args = parser.parse_args()

    if not args.html.exists():
        raise SystemExit(f"theme boot-hash gate FAILED: {args.html} does not exist")
    html = args.html.read_text(encoding="utf-8")

    if args.print_only:
        print(csp_hash(extract_snippet(html, str(args.html))))
        return 0

    doc_text = args.doc.read_text(encoding="utf-8")
    failures = run(html, doc_text, str(args.html))
    if args.nginx.exists():
        failures += check_nginx(args.nginx.read_text(encoding="utf-8"), recorded_hash(doc_text))
    if failures:
        print("Theme boot-hash gate FAILED:", file=sys.stderr)
        for line in failures:
            print(f"  {line}", file=sys.stderr)
        return 1
    served = " and the served nginx policy" if args.nginx.exists() else ""
    print(f"Theme boot-hash gate passed ({args.html.name}{served} match the recorded CSP hash)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
