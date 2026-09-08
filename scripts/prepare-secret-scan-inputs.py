#!/usr/bin/env python3
"""Expand encoded blobs for secret scanning and reject archive payloads.

The public source tree must not contain archive containers. Base64-like blobs are
decoded recursively until no new payloads remain; every decoded payload is written
to an output directory so gitleaks scans it alongside the original tree.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import os
import re
import sys
from collections import deque
from pathlib import Path

MAX_SOURCE_FILE = 32 * 1024 * 1024
MAX_DECODED_TOTAL = 64 * 1024 * 1024
BASE64_TOKEN = re.compile(rb"(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/-]{16,}={0,2}(?![A-Za-z0-9_+/=-])")


def archive_kind(data: bytes) -> str | None:
    if data.startswith(b"PK\x03\x04") or data.startswith(b"PK\x05\x06") or data.startswith(b"PK\x07\x08"):
        return "zip"
    if data.startswith(b"\x1f\x8b"):
        return "gzip"
    if data.startswith(b"BZh"):
        return "bzip2"
    if data.startswith(b"\xfd7zXZ\x00"):
        return "xz"
    if data.startswith(b"7z\xbc\xaf\x27\x1c"):
        return "7zip"
    if data.startswith(b"Rar!\x1a\x07"):
        return "rar"
    if len(data) >= 262 and data[257:262] == b"ustar":
        return "tar"
    return None


def decode_candidate(value: bytes) -> bytes | None:
    compact = b"".join(value.split())
    if len(compact) < 16 or len(compact) % 4:
        return None
    try:
        decoded = base64.b64decode(compact, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        return None
    if not decoded or decoded == value:
        return None
    return decoded


def candidates(data: bytes) -> list[bytes]:
    found = [match.group(0) for match in BASE64_TOKEN.finditer(data)]
    compact = b"".join(data.split())
    if compact and compact not in found:
        found.append(compact)
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    queue: deque[tuple[str, bytes]] = deque()
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            print(f"Symbolic links are not permitted in the public tree: {path.relative_to(source)}", file=sys.stderr)
            return 2
        if not path.is_file():
            continue
        size = path.stat().st_size
        if size > MAX_SOURCE_FILE:
            print(f"Secret-scan input exceeds {MAX_SOURCE_FILE} bytes: {path.relative_to(source)}", file=sys.stderr)
            return 2
        queue.append((path.relative_to(source).as_posix(), path.read_bytes()))

    seen: set[str] = set()
    decoded_total = 0
    while queue:
        origin, data = queue.popleft()
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)

        kind = archive_kind(data)
        if kind:
            print(f"Archive payloads are not permitted in the public tree: {origin} ({kind})", file=sys.stderr)
            return 2

        for candidate in candidates(data):
            decoded = decode_candidate(candidate)
            if decoded is None:
                continue
            decoded_total += len(decoded)
            if decoded_total > MAX_DECODED_TOTAL:
                print("Decoded secret-scan input exceeded the fail-closed 64 MiB budget", file=sys.stderr)
                return 2
            child_digest = hashlib.sha256(decoded).hexdigest()
            child_origin = f"{origin}.decoded-{child_digest[:16]}"
            (output / child_digest).write_bytes(decoded)
            queue.append((child_origin, decoded))

    for path in output.iterdir():
        os.chmod(path, 0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
