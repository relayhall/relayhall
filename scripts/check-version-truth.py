#!/usr/bin/env python3
"""Keep RelayHall's displayed versions bound to what each artefact was built as.

Card 6d549392 (owner ruling E81): Version and API version show the release
version the release tooling passed AT BUILD TIME (RELAYHALL_RELEASE_VERSION,
docs/build-identity.md), recorded in each image's release manifest. The
package version is only the base of the `+unreleased` fallback; it is never
shown as a deployed version. This gate pins the chain from build argument to
page, and the package parity it always held.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
VISIBLE_VERSION = re.compile(r"\bv\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b")
WRITERS = ("backend/scripts/write-release-manifest.cjs", "frontend/scripts/write-release-manifest.cjs")
COMPOSE_ARG = "RELAYHALL_RELEASE_VERSION: ${RELAYHALL_RELEASE_VERSION:-}"


def read(path: Path, failures: list[str]) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        if f"missing {path}" not in failures:
            failures.append(f"missing {path}")
        return ""


def require(path: Path, needle: str, failures: list[str]) -> str:
    text = read(path, failures)
    if text and needle not in text:
        failures.append(f"{path}: missing {needle!r}")
    return text


def forbid(path: Path, text: str, pattern: str, reason: str, failures: list[str]) -> None:
    if re.search(pattern, text, re.MULTILINE):
        failures.append(f"{path}: {reason}")


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

    # Backend: the version is the one the image recorded, read from the image
    # file - never from the environment, never the bare package version.
    version_path = root / "backend/src/version.ts"
    backend_truth = require(version_path, "readImageBuildIdentity(", failures)
    require(version_path, "require('../package.json')", failures)
    require(version_path, "export const RELAYHALL_VERSION", failures)
    forbid(version_path, backend_truth, r"process\.env", "the backend version may not come from the environment", failures)
    identity_path = root / "backend/src/utils/releaseIdentity.ts"
    identity = require(identity_path, "IMAGE_MANIFEST_PATH = '/release-manifest.json'", failures)
    require(identity_path, "UNRELEASED_SUFFIX = '+unreleased'", failures)
    forbid(identity_path, identity, r"process\.env", "the backend build identity may not come from the environment", failures)
    api_root_path = root / "backend/src/routes/apiRoot.ts"
    api_root = require(api_root_path, "import { BACKEND_BUILD_IDENTITY, RELAYHALL_VERSION } from '../version'", failures)
    require(api_root_path, "createApiRootHandler(RELAYHALL_VERSION, BACKEND_BUILD_IDENTITY)", failures)
    require(api_root_path, "res.setHeader('Cache-Control', 'no-store')", failures)
    server = require(root / "backend/src/server.ts", "app.get('/', apiRootHandler)", failures)
    openapi = require(root / "backend/src/openapi/spec.ts", "import { RELAYHALL_VERSION } from '../version'", failures)
    require(root / "backend/src/openapi/spec.ts", "version: RELAYHALL_VERSION", failures)

    # Frontend: the bundle constant is the stamped release or `+unreleased`,
    # and About never shows it - About reads each artefact's served record.
    release_info_path = root / "frontend/src/utils/releaseInfo.ts"
    frontend_truth = require(release_info_path, "import.meta.env.VITE_RELAYHALL_RELEASE_VERSION", failures)
    require(release_info_path, "import packageInfo from '../../package.json'", failures)
    require(release_info_path, "export const RELAYHALL_VERSION", failures)
    require(release_info_path, "UNRELEASED_SUFFIX = '+unreleased'", failures)
    login = require(root / "frontend/src/pages/LoginPage.tsx", "v{RELAYHALL_VERSION}", failures)
    about_path = root / "frontend/src/pages/AboutPage.tsx"
    about = require(about_path, "version={facts.manifest?.version}", failures)
    require(about_path, "version={facts.api?.version}", failures)
    forbid(about_path, about, r"\bRELAYHALL_VERSION\b",
           "About shows the bundled version constant; it must show the versions the artefacts report", failures)

    # Build: both images take the release version as a build argument, record
    # it through the committed writer, and never carry it as runtime ENV.
    for service in ("frontend", "backend"):
        path = root / f"{service}/Dockerfile"
        dockerfile = require(path, "ARG RELAYHALL_RELEASE_VERSION=", failures)
        require(path, f"scripts/write-release-manifest.cjs relayhall-{service} ", failures)
        forbid(path, dockerfile, r"^\s*RUN\s+printf\s+'\{", "builds the release manifest by hand instead of with the writer", failures)
        forbid(path, dockerfile, r"^\s*ENV\s+RELAYHALL_RELEASE_VERSION\b",
               "sets the release version as runtime ENV; it belongs in the manifest only", failures)
    require(root / "frontend/Dockerfile", "ENV VITE_RELAYHALL_RELEASE_VERSION=$RELAYHALL_RELEASE_VERSION", failures)
    compose_path = root / "docker-compose.yml"
    compose = read(compose_path, failures)
    if compose and compose.count(COMPOSE_ARG) != 2:
        failures.append(f"{compose_path}: {COMPOSE_ARG!r} must be a build arg of both services")
    writers = [read(root / writer, failures) for writer in WRITERS]
    if all(writers):
        if writers[0] != writers[1]:
            failures.append("the two write-release-manifest.cjs copies differ")
        if "JSON.stringify(manifest)" not in writers[0]:
            failures.append(f"{WRITERS[0]}: missing 'JSON.stringify(manifest)'")

    for path, text in (
        (root / "backend/src/server.ts", server),
        (api_root_path, api_root),
        (root / "backend/src/openapi/spec.ts", openapi),
        (root / "frontend/src/pages/LoginPage.tsx", login),
        (about_path, about),
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
    print("Version truth: package parity, the build-argument chain and the displayed versions are bound")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
