#!/usr/bin/env python3
"""Control for scripts/check-node-base-images.py.

Each case builds a throwaway Git repository, commits its files and runs the
gate against it with --root. A red case passes only when the gate exits 1 AND
names the planted file and line; a green case only when it exits 0. A gate that
went green on everything (or red on everything) fails here. A tree with no Node
image must be refused, and the real repository must pass.

The digest below is a well-formed placeholder: the gate checks the shape of a
pin, never the registry.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / 'scripts' / 'check-node-base-images.py'

PIN = '@sha256:' + 'ab' * 32
GOOD = f'node:22.23.4-bookworm-slim{PIN}'

# label, file, text, the line the gate must name, a word its reason must carry
RED = [
    ('an unpinned floating tag (the shape this repository had)', 'backend/Dockerfile',
     'FROM node:22-bookworm-slim AS builder\nRUN true\n', 1, 'digest'),
    ('a pinned 22.23.3, one patch below the fix', 'backend/Dockerfile',
     f'FROM {GOOD} AS builder\nFROM node:22.23.3-bookworm-slim{PIN}\n', 2, 'below the patched minimum'),
    ('an exact patched release with no digest', 'frontend/Dockerfile',
     'FROM node:22.23.4-bookworm-slim AS builder\n', 1, 'digest'),
    ('a floating tag with a digest', 'frontend/Dockerfile.dev',
     f'FROM node:22-bookworm-slim{PIN}\n', 1, 'exact MAJOR.MINOR.PATCH'),
    ('Node 20, a line with no patched minimum', 'docs/example-plugin/Dockerfile',
     f'FROM node:20.20.2-alpine{PIN}\n', 1, 'no patched minimum'),
    ('a 24 line below 24.22.1', 'plugin/Dockerfile',
     f'FROM node:24.22.0-bookworm-slim{PIN}\n', 1, 'below the patched minimum'),
    ('a 26 line below 26.12.1', 'plugin/Dockerfile',
     f'FROM node:26.12.0{PIN}\n', 1, 'below the patched minimum'),
    ('bare node, no tag and no digest', 'tools/Dockerfile', 'FROM node\n', 1, 'digest'),
    ('a digest with no readable release', 'tools/Dockerfile', f'FROM node{PIN}\n', 1, 'exact MAJOR.MINOR.PATCH'),
    ('a platform flag before an old image', 'tools/app.Dockerfile',
     f'FROM --platform=linux/amd64 node:22.23.3{PIN} AS build\n', 1, 'below the patched minimum'),
    ('the fully qualified registry name', 'tools/Dockerfile',
     f'FROM docker.io/library/node:22.23.3-bookworm{PIN}\n', 1, 'below the patched minimum'),
    ('a lower-case from', 'tools/Dockerfile', 'from node:22-bookworm-slim\n', 1, 'digest'),
    ('a base image hidden behind a build variable', 'tools/Dockerfile',
     'ARG BASE=node:22\nFROM ${BASE}\n', 2, 'build variable'),
    ('a floating job container in a GitHub workflow', '.github/workflows/ci-full.yml',
     'jobs:\n  a:\n    container: node:22-bookworm\n', 3, 'digest'),
    ('an old job container image in a Gitea workflow', '.gitea/workflows/ci.yml',
     f'jobs:\n  a:\n    container:\n      image: node:22.23.3-bookworm{PIN}\n', 4, 'below the patched minimum'),
    ('a floating Node service in a compose file', 'docker-compose.yml',
     'services:\n  tool:\n    image: "node:22"\n', 3, 'digest'),
    ('a floating docker run in the setup script', 'setup.sh',
     'docker run --rm node:22-alpine node -v\n', 1, 'digest'),
]

GREEN = [
    ('the patched 22 line, pinned', 'backend/Dockerfile', f'FROM {GOOD} AS builder\nFROM {GOOD}\n'),
    ('the patched 24 and 26 lines, pinned', 'plugin/Dockerfile',
     f'FROM node:24.22.1-bookworm-slim{PIN} AS a\nFROM node:26.12.1{PIN}\n'),
    ('a later 22 release', 'plugin/Dockerfile', f'FROM node:22.24.0-alpine3.24{PIN}\n'),
    ('a non-Node final stage and a stage name', 'frontend/Dockerfile',
     f'FROM {GOOD} AS builder\nFROM nginx:alpine\nCOPY --from=builder /a /b\nFROM builder\n'),
    ('setup-node versions and postgres services in a workflow', '.github/workflows/ci.yml',
     'steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 20\nservices:\n  postgres:\n    image: postgres:16\n'),
    ('a node module path and a node command in a script', 'scripts/x.sh',
     'node -e 1\nls /tmp/a/node_modules\nnode scripts/a.js\n'),
    ('node: prefixed imports outside the scanned kinds', 'backend/src/a.ts', "import fs from 'node:fs';\n"),
    ('a commented-out floating image in a workflow', '.gitea/workflows/ci.yml', '# container: node:22\n'),
]


def run(files: dict[str, str]) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory(prefix='node-image-gate-') as tmp:
        root = Path(tmp)
        for relative, text in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(text.encode('utf-8'))
        git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
        subprocess.run([*git, 'init', '-q'], cwd=root, check=True)
        subprocess.run([*git, 'add', '-A'], cwd=root, check=True)
        subprocess.run([*git, 'commit', '-q', '-m', 'case'], cwd=root, check=True)
        return subprocess.run([sys.executable, str(GATE), '--root', str(root)], capture_output=True, text=True)


def main() -> int:
    failures: list[str] = []
    anchor = {'anchor/Dockerfile': f'FROM {GOOD}\n'}
    for label, relative, text, line, reason in RED:
        result = run({**anchor, relative: text})
        if result.returncode != 1 or f'{relative}:{line}:' not in result.stdout or reason not in result.stdout:
            failures.append(f'RED case not red by name: {label}\n{result.stdout}{result.stderr}')
        if 'anchor/Dockerfile' in result.stdout:
            failures.append(f'RED case also flagged the pinned anchor: {label}\n{result.stdout}')
    for label, relative, text in GREEN:
        result = run({**anchor, relative: text})
        if result.returncode != 0:
            failures.append(f'GREEN case went red: {label}\n{result.stdout}{result.stderr}')
    empty = run({'frontend/Dockerfile': 'FROM nginx:alpine\n', 'scripts/x.sh': 'node -v\n'})
    if empty.returncode != 1 or 'refusing to pass on nothing' not in empty.stdout:
        failures.append(f'a tree with no Node image must not pass\n{empty.stdout}')
    real = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
    if real.returncode != 0:
        failures.append(f'the repository itself does not pass\n{real.stdout}')
    if failures:
        print('\n'.join(failures))
        return 1
    print(f'node base-image gate control: {len(RED)} red cases red by file and line, {len(GREEN)} green cases green, '
          'empty scope refused, repository green')
    return 0


if __name__ == '__main__':
    sys.exit(main())
