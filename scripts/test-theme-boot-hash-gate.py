#!/usr/bin/env python3
"""Self-proof for scripts/check-theme-boot-hash.py (A15.2 pattern).

The gate's whole value is that it notices a one-byte change, so the fixtures
change one byte. It also has to notice the shapes that would make a CSP hash
meaningless: no snippet, two snippets, no recorded hash.
"""
from __future__ import annotations

import base64
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().parent / "check-theme-boot-hash.py"

SNIPPET = '!function(){document.documentElement.setAttribute("data-theme","relay-dark")}();'

NESTED_HEADERS = (
    "            add_header Content-Security-Policy $relayhall_csp always;\n"
    '            add_header X-Content-Type-Options "nosniff" always;\n'
)


def html_with(*snippets: str) -> str:
    scripts = "\n".join(f"    <script data-theme-boot>{s}</script>" for s in snippets)
    return f"<!DOCTYPE html>\n<html>\n  <head>\n{scripts}\n  </head>\n  <body></body>\n</html>\n"


def doc_with(record: str | None) -> str:
    line = f"theme-boot-csp-hash: {record}\n" if record else ""
    return f"# fixture\n\nSome prose.\n\n{line}\nMore prose.\n"


def expected_hash(snippet: str) -> str:
    return f"sha256-{base64.b64encode(hashlib.sha256(snippet.encode()).digest()).decode()}"


def nginx_with(policy: str, nested_headers: str = NESTED_HEADERS) -> str:
    """A miniature of the real config: a policy variable and a nested location."""
    return (
        "server {\n"
        f'    set $relayhall_csp "{policy}";\n'
        "    location /dashboard/ {\n"
        "        add_header Content-Security-Policy $relayhall_csp always;\n"
        '        add_header X-Content-Type-Options "nosniff" always;\n'
        "        location ~* \\.(js|css|woff2)$ {\n"
        '            add_header Cache-Control "public, immutable";\n'
        f"{nested_headers}"
        "        }\n"
        "    }\n"
        "}\n"
    )


def run_gate(tmp: Path, tag: str, html: str, doc: str, extra: list[str] | None = None,
             nginx: str | None = None):
    scope = tmp / tag
    scope.mkdir()
    html_path = scope / "index.html"
    doc_path = scope / "ds.md"
    html_path.write_text(html, encoding="utf-8")
    doc_path.write_text(doc, encoding="utf-8")
    # The nginx check is part of the gate now (RH-UI.4), so every fixture run
    # supplies its own config. Pointing a fixture at the REAL nginx.conf would
    # compare a fixture hash against the served policy and fail every case for
    # the wrong reason — which is exactly what happened when this was added.
    nginx_path = scope / "nginx.conf"
    nginx_path.write_text(nginx if nginx is not None else nginx_with(policy_for(html)),
                          encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(GATE), "--html", str(html_path), "--doc", str(doc_path),
         "--nginx", str(nginx_path)]
        + (extra or []),
        capture_output=True, text=True)


def policy_for(html: str) -> str:
    """A policy carrying whatever hash this fixture's snippet actually produces."""
    import re as _re
    found = _re.findall(r"<script data-theme-boot>(.*?)</script>", html, _re.DOTALL)
    digest = expected_hash(found[0]) if found else "sha256-absent"
    return (f"default-src 'self'; script-src 'self' '{digest}'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'")


def main() -> int:
    problems: list[str] = []

    # The repository's own snippet must match its recorded hash.
    live = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
    if live.returncode != 0:
        problems.append(f"repository run failed: {live.stderr.strip()}")

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        good = expected_hash(SNIPPET)

        result = run_gate(tmp, "match", html_with(SNIPPET), doc_with(good))
        if result.returncode != 0:
            problems.append(f"a matching snippet failed: {result.stderr.strip()}")

        # One byte of whitespace is a different CSP hash and a blocked script.
        result = run_gate(tmp, "one-byte", html_with(SNIPPET + " "), doc_with(good))
        if result.returncode == 0:
            problems.append("a one-byte change passed")
        elif "records" not in result.stderr:
            problems.append("the mismatch message does not name the recorded hash")

        result = run_gate(tmp, "no-snippet",
                          "<!DOCTYPE html><html><head></head><body></body></html>",
                          doc_with(good))
        if result.returncode == 0:
            problems.append("a document with no boot snippet passed")

        # Two snippets means two hashes; the CSP admits exactly one.
        result = run_gate(tmp, "two-snippets", html_with(SNIPPET, SNIPPET), doc_with(good))
        if result.returncode == 0:
            problems.append("two boot snippets passed")

        result = run_gate(tmp, "no-record", html_with(SNIPPET), doc_with(None))
        if result.returncode == 0:
            problems.append("an unrecorded hash passed")

        # --print never compares, and prints the hash the CSP needs.
        result = run_gate(tmp, "print", html_with(SNIPPET), doc_with(None), ["--print"])
        if result.returncode != 0 or result.stdout.strip() != good:
            problems.append(f"--print did not emit the computed hash: {result.stdout.strip()!r}")

        missing = subprocess.run(
            [sys.executable, str(GATE), "--html", str(tmp / "absent.html")],
            capture_output=True, text=True)
        if missing.returncode == 0:
            problems.append("a missing HTML file passed")

        # ---- the served-policy rules (RH-UI.4, §5.6) -----------------------
        # Each of these three shipped as a real defect in some product
        # somewhere, and each is silent: the page renders, and the protection
        # simply is not there.

        # The recorded hash and the policy nginx actually serves must be one
        # string. Proving the snippet against a DOCUMENT while the served policy
        # carries something else proves nothing about the running product.
        drifted = nginx_with(
            "default-src 'self'; script-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='")
        result = run_gate(tmp, "csp-drift", html_with(SNIPPET), doc_with(good), nginx=drifted)
        if result.returncode == 0:
            problems.append("a served CSP carrying a different hash passed")
        elif "drifted apart" not in result.stderr:
            problems.append("the CSP-drift message does not say the two have drifted")

        # `wss:` permits a socket to ANY host (S-F2).
        result = run_gate(tmp, "wss", html_with(SNIPPET), doc_with(good),
                          nginx=nginx_with(policy_for(html_with(SNIPPET)) + "; connect-src 'self' wss:"))
        if result.returncode == 0:
            problems.append("a CSP naming the bare wss: scheme passed")

        # A child add_header block DISCARDS every inherited header (S-F3), so a
        # nested location that sets only Cache-Control ships assets with no
        # policy at all while the document above looks protected.
        result = run_gate(tmp, "nested-discard", html_with(SNIPPET), doc_with(good),
                          nginx=nginx_with(policy_for(html_with(SNIPPET)), nested_headers=""))
        if result.returncode == 0:
            problems.append("a nested asset location that drops the CSP passed")
        elif "discards" not in result.stderr:
            problems.append("the nested-location message does not explain the inheritance rule")

        # Losing the nested location entirely must be loud too: a gate that
        # stops finding its subject has stopped working.
        result = run_gate(tmp, "no-nested", html_with(SNIPPET), doc_with(good),
                          nginx=f'server {{\n    set $relayhall_csp "{policy_for(html_with(SNIPPET))}";\n}}\n')
        if result.returncode == 0:
            problems.append("a config with no nested asset location passed")

        # And a config with no policy at all.
        result = run_gate(tmp, "no-policy", html_with(SNIPPET), doc_with(good),
                          nginx="server {\n    location / { return 200; }\n}\n")
        if result.returncode == 0:
            problems.append("a config defining no CSP passed")

    if problems:
        print("Theme boot-hash gate self-test FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print("Theme boot-hash gate self-test passed (13 fixtures: repository run, exact match, "
          "one-byte drift, missing snippet, duplicate snippet, missing record, --print, "
          "missing file, served-CSP drift, bare wss:, nested location dropping the policy, "
          "nested location absent, no policy at all).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
