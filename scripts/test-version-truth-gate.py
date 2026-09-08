#!/usr/bin/env python3
"""Self-proof for check-version-truth.py."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).with_name("check-version-truth.py")


def put(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GATE), "--root", str(root)],
        capture_output=True,
        text=True,
        check=False,
    )


with tempfile.TemporaryDirectory(prefix="relayhall-version-gate-") as temp:
    root = Path(temp)
    for package in ("frontend/package.json", "backend/package.json"):
        put(root, package, json.dumps({"version": "2.0.0"}))
    put(root, "backend/src/version.ts", "require('../package.json'); export const RELAYHALL_VERSION = packageIdentity.version;")
    put(root, "backend/src/server.ts", "import { RELAYHALL_VERSION } from './version'; res.setHeader('Cache-Control', 'no-store'); version: RELAYHALL_VERSION")
    put(root, "backend/src/openapi/spec.ts", "import { RELAYHALL_VERSION } from '../version'; version: RELAYHALL_VERSION")
    put(root, "frontend/src/utils/releaseInfo.ts", "import packageInfo from '../../package.json'; export const RELAYHALL_VERSION = packageInfo.version;")
    put(root, "frontend/src/pages/LoginPage.tsx", "import { RELAYHALL_VERSION } from '../utils/releaseInfo'; <>v{RELAYHALL_VERSION}</>")
    put(root, "frontend/src/pages/AboutPage.tsx", "import { RELAYHALL_VERSION } from '../utils/releaseInfo'; <dd>{RELAYHALL_VERSION}</dd>")

    clean = run(root)
    if clean.returncode != 0:
        raise SystemExit(f"valid fixture rejected:\n{clean.stdout}{clean.stderr}")

    stale_literal = "Dashboard v1" + ".2.0"
    put(root, "frontend/src/pages/LoginPage.tsx", f"const footer = '{stale_literal}'; // v{{RELAYHALL_VERSION}}")
    stale = run(root)
    if stale.returncode == 0 or "stale visible version literal" not in stale.stdout:
        raise SystemExit("stale-version fixture was not rejected")

    put(root, "frontend/src/pages/LoginPage.tsx", "<>v{RELAYHALL_VERSION}</>")
    put(root, "backend/package.json", json.dumps({"version": "2.1.0"}))
    mismatch = run(root)
    if mismatch.returncode == 0 or "package versions differ" not in mismatch.stdout:
        raise SystemExit("package-parity fixture was not rejected")

print("Version-truth gate self-proof: valid fixture passes; stale and divergent fixtures fail")
