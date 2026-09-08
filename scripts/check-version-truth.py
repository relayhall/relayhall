#!/usr/bin/env python3
"""Keep RelayHall's product/API version surfaces bound to package truth."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
VISIBLE_VERSION = re.compile(r"\bv\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b")


def require(path: Path, needle: str, failures: list[str]) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        failures.append(f"missing {path}")
        return ""
    if needle not in text:
        failures.append(f"{path}: missing {needle!r}")
    return text


def check(root: Path) -> list[str]:
    failures: list[str] = []
    try:
        frontend_version = json.loads((root / "frontend/package.json").read_text(encoding="utf-8"))["version"]
        backend_version = json.loads((root / "backend/package.json").read_text(encoding="utf-8"))["version"]
    except (OSError, KeyError, json.JSONDecodeError) as error:
        return [f"package version unreadable: {error}"]

    if not isinstance(frontend_version, str) or not SEMVER.fullmatch(frontend_version):
        failures.append("frontend package version is not semantic")
    if frontend_version != backend_version:
        failures.append(f"frontend/backend package versions differ: {frontend_version!r} != {backend_version!r}")

    backend_truth = require(root / "backend/src/version.ts", "require('../package.json')", failures)
    require(root / "backend/src/version.ts", "export const RELAYHALL_VERSION", failures)
    server = require(root / "backend/src/server.ts", "import { RELAYHALL_VERSION } from './version'", failures)
    require(root / "backend/src/server.ts", "version: RELAYHALL_VERSION", failures)
    require(root / "backend/src/server.ts", "res.setHeader('Cache-Control', 'no-store')", failures)
    openapi = require(root / "backend/src/openapi/spec.ts", "import { RELAYHALL_VERSION } from '../version'", failures)
    require(root / "backend/src/openapi/spec.ts", "version: RELAYHALL_VERSION", failures)
    frontend_truth = require(root / "frontend/src/utils/releaseInfo.ts", "import packageInfo from '../../package.json'", failures)
    require(root / "frontend/src/utils/releaseInfo.ts", "export const RELAYHALL_VERSION", failures)
    login = require(root / "frontend/src/pages/LoginPage.tsx", "v{RELAYHALL_VERSION}", failures)
    about = require(root / "frontend/src/pages/AboutPage.tsx", "{RELAYHALL_VERSION}", failures)

    for path, text in (
        (root / "backend/src/server.ts", server),
        (root / "backend/src/openapi/spec.ts", openapi),
        (root / "frontend/src/pages/LoginPage.tsx", login),
        (root / "frontend/src/pages/AboutPage.tsx", about),
    ):
        if re.search(rf"['\"]{re.escape(frontend_version)}['\"]", text):
            failures.append(f"{path}: duplicated semantic version literal")

    if not backend_truth or not frontend_truth:
        failures.append("version source modules are empty")

    for path in (root / "frontend/src").rglob("*"):
        if path.suffix not in {".ts", ".tsx"} or ".test." in path.name:
            continue
        text = path.read_text(encoding="utf-8")
        if VISIBLE_VERSION.search(text):
            failures.append(f"{path}: stale visible version literal")

    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    failures = check(args.root.resolve())
    if failures:
        print("Version-truth gate failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("Version truth: package parity, API consumers and visible surfaces are centralized")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
