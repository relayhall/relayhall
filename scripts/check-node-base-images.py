#!/usr/bin/env python3
"""Node base-image gate: every Node image this repository builds on or runs is
a patched release, pinned by digest.

WHY THIS EXISTS. CVE-2026-111497 is a flaw in the Node.js Brotli decoder that
can allow remote code execution where a process decompresses attacker-controlled
Brotli data. It is fixed in 22.23.4, 24.22.1 and 26.12.1. The images here were
written as floating tags (`node:22-bookworm-slim`, `node:20-alpine`), so the
Node that actually ran was whatever the builder's cache held on the day: one
environment ran the patched 22.23.4 while another, built from the same file,
ran 22.23.3. A floating tag cannot be read as a version, and a version without
a digest can be re-pushed. So every Node image reference names an exact
release AND the digest it resolved to, and that release is at or above the
patched minimum for its major line.

WHAT IT CHECKS, over the tracked files that name container images:
  - every Dockerfile (`Dockerfile`, `Dockerfile.*`, `*.Dockerfile`): each
    `FROM` whose image is `node` (bare, `library/node` or `docker.io/library/node`).
    A `FROM` whose image is a build variable (`FROM ${IMAGE}`) is refused too,
    because nothing can read its version;
  - the workflows of both forges and every compose file: each `container:` or
    `image:` value naming a Node image;
  - shell scripts: each Node image reference (`node:<tag>` or `node@sha256:`),
    such as a `docker run` in the setup script.

A reference passes only when ALL of these hold:
  1. it carries a digest, `@sha256:` and 64 lowercase hex characters;
  2. its tag starts with an exact `MAJOR.MINOR.PATCH` release (`22.23.4-bookworm-slim`
     is read as 22.23.4; `22`, `22-bookworm-slim`, `lts` and no tag at all are not);
  3. its major line has a patched minimum in PATCHED_MINIMUM below. A line with
     no entry fails closed: Node 20 is past its end of life and receives no
     fixes, so the remedy for a Node 20 image is the patched 22 line;
  4. its release is at or above that minimum.

Every finding names file, line, the reference and the rule, and the gate exits
1. A tree with no Node image reference at all is refused rather than passed.

Its control is `scripts/test-node-base-image-gate.py`.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The first release of each supported major line that carries the fix for
# CVE-2026-111497. Raise a value when a later advisory raises the floor; add a
# line before any image may use it.
PATCHED_MINIMUM: dict[int, tuple[int, int, int]] = {
    22: (22, 23, 4),
    24: (24, 22, 1),
    26: (26, 12, 1),
}

NODE_NAMES = {'node', 'library/node', 'docker.io/library/node', 'index.docker.io/library/node'}
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
RELEASE = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9._-]+)?$')
# An image token that names Node: the repository part, an optional tag and an
# optional digest. The look-behind keeps `node-version:` and `foo/node:` out.
NODE_REFERENCE = re.compile(
    r'(?<![\w./-])((?:(?:index\.)?docker\.io/)?(?:library/)?node)(?::([\w.-]+))?(@[\w:]+)?(?![\w./:@-])'
)
CONTAINER_KEY = re.compile(r'^\s*(?:-\s+)?(?:container|image)\s*:\s*["\']?([^\s"\'#]+)')


def dockerfile(relative: str) -> bool:
    name = relative.rsplit('/', 1)[-1]
    return name == 'Dockerfile' or name.startswith('Dockerfile.') or name.endswith('.Dockerfile')


def manifest_kind(relative: str) -> str | None:
    name = relative.rsplit('/', 1)[-1]
    if dockerfile(relative):
        return 'dockerfile'
    if relative.startswith(('.github/workflows/', '.gitea/workflows/')) and name.endswith(('.yml', '.yaml')):
        return 'yaml'
    if (name.startswith('docker-compose') or name.startswith('compose')) and name.endswith(('.yml', '.yaml')):
        return 'yaml'
    if name.endswith('.sh'):
        return 'shell'
    return None


def tracked(root: Path) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout
    return sorted(p for p in out.decode('utf-8').split('\0') if p)


def split_image(token: str) -> tuple[str, str | None, str | None]:
    """name, tag, digest of one image token."""
    digest = None
    if '@' in token:
        token, digest = token.split('@', 1)
    tag = None
    slash = token.rfind('/')
    colon = token.rfind(':')
    if colon > slash:
        token, tag = token[:colon], token[colon + 1:]
    return token, tag, digest


def verdict(tag: str | None, digest: str | None) -> str | None:
    """None when the reference passes, otherwise the rule it breaks."""
    if digest is None or not DIGEST.match(digest):
        return 'not pinned by digest (append @sha256:<digest> of the resolved image)'
    match = RELEASE.match(tag or '')
    if not match:
        return 'tag is not an exact MAJOR.MINOR.PATCH release (floating tags cannot be read as a version)'
    release = tuple(int(part) for part in match.groups())
    floor = PATCHED_MINIMUM.get(release[0])
    if floor is None:
        return (f'Node {release[0]}.x has no patched minimum here (supported lines: '
                + ', '.join(f'{major}.x >= {".".join(map(str, low))}' for major, low in sorted(PATCHED_MINIMUM.items()))
                + ')')
    if release < floor:
        return f'Node {".".join(map(str, release))} is below the patched minimum {".".join(map(str, floor))} (CVE-2026-111497)'
    return None


def from_image(line: str) -> str | None:
    """The image token of a Dockerfile FROM line, skipping --flags."""
    words = line.split()
    if not words or words[0].upper() != 'FROM':
        return None
    rest = [word for word in words[1:] if not word.startswith('--')]
    return rest[0] if rest else None


def scan(root: Path) -> tuple[list[str], int]:
    found: list[str] = []
    references = 0
    for relative in tracked(root):
        kind = manifest_kind(relative)
        if kind is None:
            continue
        try:
            text = (root / relative).read_text(encoding='utf-8')
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        stages: set[str] = set()
        for number, raw in enumerate(text.split('\n'), start=1):
            line = raw.strip()
            if kind == 'dockerfile':
                token = from_image(line)
                if token is None:
                    continue
                words = line.split()
                if len(words) >= 3 and words[-2].upper() == 'AS':
                    stages.add(words[-1].lower())
                if '$' in token:
                    references += 1
                    found.append(f'{relative}:{number}: {token}: base image is a build variable; its Node version cannot be checked')
                    continue
                name, tag, digest = split_image(token)
                if name.lower() in stages or name.lower() not in NODE_NAMES:
                    continue
                references += 1
                problem = verdict(tag, digest)
                if problem:
                    found.append(f'{relative}:{number}: {token}: {problem}')
                continue
            if line.startswith('#'):
                continue
            tokens: list[str] = []
            if kind == 'yaml':
                match = CONTAINER_KEY.match(raw)
                if match and split_image(match.group(1))[0].lower() in NODE_NAMES:
                    tokens.append(match.group(1))
            else:
                tokens.extend(m.group(0) for m in NODE_REFERENCE.finditer(raw) if m.group(2) or m.group(3))
            for token in tokens:
                references += 1
                name, tag, digest = split_image(token)
                problem = verdict(tag, digest)
                if problem:
                    found.append(f'{relative}:{number}: {token}: {problem}')
    return found, references


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', type=Path, default=ROOT, help='repository root (default: this checkout)')
    args = parser.parse_args()
    found, references = scan(args.root.resolve())
    if references == 0:
        print('node base-image gate: no Node image reference in any tracked Dockerfile, workflow, compose file '
              'or shell script - refusing to pass on nothing')
        return 1
    if found:
        print(f'node base-image gate: {len(found)} of {references} Node image reference(s) fail:')
        for line in found:
            print(f'  {line}')
        print('Pin each one as node:<MAJOR.MINOR.PATCH>-<variant>@sha256:<digest> at or above the patched minimum.')
        return 1
    print(f'node base-image gate: {references} Node image reference(s), each an exact patched release pinned by digest')
    return 0


if __name__ == '__main__':
    sys.exit(main())
