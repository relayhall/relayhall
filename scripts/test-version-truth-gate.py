#!/usr/bin/env python3
"""Self-proof for check-version-truth.py.

A valid fixture must pass, and each mutation must fail with ITS OWN message -
a mutation that reddened some other assertion would prove nothing about the
rule it names. Card 6d549392 added the build-argument chain: the release
version is a build input recorded by the writer and shown from the
artefacts, never a constant, never runtime environment.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).with_name("check-version-truth.py")
WRITER = "const manifest = {}; const text = `${JSON.stringify(manifest)}\\n`;\n"
COMPOSE_ARG = "        RELAYHALL_RELEASE_VERSION: ${RELAYHALL_RELEASE_VERSION:-}\n"

VALID = {
    "frontend/package.json": json.dumps({"version": "2.0.0"}),
    "backend/package.json": json.dumps({"version": "2.0.0"}),
    "backend/src/version.ts": (
        "import { readImageBuildIdentity, reportedVersion } from './utils/releaseIdentity';\n"
        "const packageIdentity = require('../package.json');\n"
        "export const BACKEND_BUILD_IDENTITY = readImageBuildIdentity();\n"
        "export const RELAYHALL_VERSION = reportedVersion(BACKEND_BUILD_IDENTITY, packageIdentity.version);\n"
    ),
    "backend/src/utils/releaseIdentity.ts": (
        "export const IMAGE_MANIFEST_PATH = '/release-manifest.json';\n"
        "export const UNRELEASED_SUFFIX = '+unreleased';\n"
    ),
    "backend/src/routes/apiRoot.ts": (
        "import { BACKEND_BUILD_IDENTITY, RELAYHALL_VERSION } from '../version';\n"
        "res.setHeader('Cache-Control', 'no-store');\n"
        "export const apiRootHandler = createApiRootHandler(RELAYHALL_VERSION, BACKEND_BUILD_IDENTITY);\n"
    ),
    "backend/src/server.ts": "import { apiRootHandler } from './routes/apiRoot';\napp.get('/', apiRootHandler);\n",
    "backend/src/openapi/spec.ts": "import { RELAYHALL_VERSION } from '../version'; version: RELAYHALL_VERSION",
    "frontend/src/utils/releaseInfo.ts": (
        "import packageInfo from '../../package.json';\n"
        "export const UNRELEASED_SUFFIX = '+unreleased';\n"
        "export const RELAYHALL_VERSION = bundleVersion(import.meta.env.VITE_RELAYHALL_RELEASE_VERSION, packageInfo.version);\n"
    ),
    "frontend/src/pages/LoginPage.tsx": "import { RELAYHALL_VERSION } from '../utils/releaseInfo'; <>v{RELAYHALL_VERSION}</>",
    "frontend/src/pages/AboutPage.tsx": (
        "<VersionValue version={facts.manifest?.version} />\n"
        "<VersionValue version={facts.api?.version} />\n"
    ),
    "frontend/Dockerfile": (
        "ARG RELAYHALL_RELEASE_VERSION=\n"
        "ENV VITE_RELAYHALL_RELEASE_VERSION=$RELAYHALL_RELEASE_VERSION\n"
        "RUN npm run build\n"
        "RUN node scripts/write-release-manifest.cjs relayhall-frontend package.json /app/release-manifest.json\n"
    ),
    "backend/Dockerfile": (
        "ARG RELAYHALL_RELEASE_VERSION=\n"
        "RUN node /app/scripts/write-release-manifest.cjs relayhall-backend /app/package.json /release-manifest.json\n"
    ),
    "docker-compose.yml": "services:\n  backend:\n    build:\n      args:\n" + COMPOSE_ARG
                          + "  frontend:\n    build:\n      args:\n" + COMPOSE_ARG,
    "backend/scripts/write-release-manifest.cjs": WRITER,
    "frontend/scripts/write-release-manifest.cjs": WRITER,
}


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


# (name, file, replacement text, the message that must appear)
MUTATIONS = [
    ("stale visible literal", "frontend/src/pages/LoginPage.tsx",
     "const footer = 'Dashboard v1" + ".2.0'; // v{RELAYHALL_VERSION}", "stale visible version literal"),
    ("package parity", "backend/package.json", json.dumps({"version": "2.1.0"}), "package versions differ"),
    # M1: the bundle constant shown on About as the deployed version.
    ("stale constant on About", "frontend/src/pages/AboutPage.tsx",
     VALID["frontend/src/pages/AboutPage.tsx"] + "<dd>{RELAYHALL_VERSION}</dd>\n",
     "About shows the bundled version constant"),
    # M3: the backend version taken from the runtime environment.
    ("environment version", "backend/src/version.ts",
     VALID["backend/src/version.ts"].replace(
         "reportedVersion(BACKEND_BUILD_IDENTITY, packageIdentity.version)",
         "process.env.RELAYHALL_RELEASE_VERSION ?? packageIdentity.version"),
     "the backend version may not come from the environment"),
    # M3: the backend version no longer read from the image file.
    ("package constant as backend version", "backend/src/version.ts",
     "const packageIdentity = require('../package.json');\n"
     "export const RELAYHALL_VERSION = packageIdentity.version;\n",
     "missing 'readImageBuildIdentity('"),
    ("hand-built manifest", "backend/Dockerfile",
     "ARG RELAYHALL_RELEASE_VERSION=\n"
     "RUN printf '{\"service\":\"relayhall-backend\",\"sha\":\"%s\"}\\n' \"$RELEASE_SHA\" > /release-manifest.json\n",
     "builds the release manifest by hand"),
    ("runtime ENV version", "backend/Dockerfile",
     VALID["backend/Dockerfile"] + "ENV RELAYHALL_RELEASE_VERSION=$RELAYHALL_RELEASE_VERSION\n",
     "sets the release version as runtime ENV"),
    ("version not a build argument", "frontend/Dockerfile",
     VALID["frontend/Dockerfile"].replace("ARG RELAYHALL_RELEASE_VERSION=\n", ""),
     "missing 'ARG RELAYHALL_RELEASE_VERSION='"),
    ("compose omits the argument", "docker-compose.yml",
     VALID["docker-compose.yml"].replace(COMPOSE_ARG, "", 1),
     "must be a build arg of both services"),
    ("writer copies drift", "frontend/scripts/write-release-manifest.cjs",
     WRITER + "// drift\n", "copies differ"),
    ("bundle constant ignores the build argument", "frontend/src/utils/releaseInfo.ts",
     "import packageInfo from '../../package.json';\nexport const UNRELEASED_SUFFIX = '+unreleased';\n"
     "export const RELAYHALL_VERSION = packageInfo.version;\n",
     "missing 'import.meta.env.VITE_RELAYHALL_RELEASE_VERSION'"),
]

with tempfile.TemporaryDirectory(prefix="relayhall-version-gate-") as temp:
    root = Path(temp)
    for relative, text in VALID.items():
        put(root, relative, text)

    clean = run(root)
    if clean.returncode != 0:
        raise SystemExit(f"valid fixture rejected:\n{clean.stdout}{clean.stderr}")

    for name, relative, text, message in MUTATIONS:
        put(root, relative, text)
        result = run(root)
        if result.returncode == 0 or message not in result.stdout:
            raise SystemExit(f"{name} fixture was not rejected with {message!r}:\n{result.stdout}{result.stderr}")
        put(root, relative, VALID[relative])
        if run(root).returncode != 0:
            raise SystemExit(f"fixture did not recover after {name}")

print(f"Version-truth gate self-proof: valid fixture passes; {len(MUTATIONS)} mutations each fail with their own message")
