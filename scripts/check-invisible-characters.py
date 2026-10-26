#!/usr/bin/env python3
"""Invisible-character gate for the repository's gate machinery.

WHY THIS EXISTS. A pre-publication scan (card c3cdcf88) found one U+200B ZERO
WIDTH SPACE inside `scripts/check-theme-parity.py`. It was harmless where it
stood, in a docstring, but a published gate script is exactly what a reviewer
reads and diffs, and an invisible character is the one edit nobody can see:
inside a string literal or a regular expression it changes what the gate
matches, and a bidirectional control can make the code a reviewer reads differ
from the code that runs. So the files that DECIDE whether something passes -
the gate scripts and the workflows that run them - carry no invisible
characters at all.

WHAT IT REJECTS, in every tracked text file under the scanned directories:
  - every Unicode FORMAT character (category Cf): zero-width space, joiner and
    non-joiner, word joiner, soft hyphen, byte order mark anywhere, the
    left-to-right and right-to-left marks, and every bidirectional embedding,
    override and isolate;
  - every CONTROL character (category Cc) other than tab, line feed and
    carriage return;
  - the characters that render as nothing although they are letters or marks:
    the combining grapheme joiner and the Hangul fillers.

What it keeps: an emoji's variation selector (U+FE0F, a nonspacing mark) is not
invisible text, so a script that prints a warning sign keeps it.

A character is reported by file, line, column, code point and name, and the
gate exits 1. Write an escape (\\u200b) where a script needs one of them.

Its control is `scripts/test-invisible-characters-gate.py`.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The gate machinery: repository gates and drills, the backend's drill and
# guard scripts, and both forges' workflows.
SCANNED = ('scripts/', 'backend/scripts/', '.github/', '.gitea/')

ALLOWED_CONTROLS = {'\t', '\n', '\r'}
INVISIBLE_LETTERS_AND_MARKS = {'\u034f', '\u115f', '\u1160', '\u3164', '\uffa0'}


def invisible(ch: str) -> bool:
    category = unicodedata.category(ch)
    if category == 'Cf':
        return True
    if category == 'Cc':
        return ch not in ALLOWED_CONTROLS
    return ch in INVISIBLE_LETTERS_AND_MARKS


def tracked(root: Path) -> list[str]:
    out = subprocess.run(['git', 'ls-files', '-z', '--', *SCANNED], cwd=root,
                         capture_output=True, check=True).stdout
    return sorted(p for p in out.decode('utf-8').split('\0') if p)


def findings(root: Path) -> tuple[list[str], int]:
    found: list[str] = []
    scanned = 0
    for relative in tracked(root):
        try:
            text = (root / relative).read_bytes().decode('utf-8')
        except UnicodeDecodeError:
            continue  # binary; not text a reviewer reads
        except FileNotFoundError:
            continue  # deleted in the working tree; git still lists it
        scanned += 1
        for number, line in enumerate(text.split('\n'), start=1):
            for column, ch in enumerate(line, start=1):
                if invisible(ch):
                    name = unicodedata.name(ch, 'UNNAMED')
                    found.append(f'{relative}:{number}:{column}: U+{ord(ch):04X} {name}')
    return found, scanned


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', type=Path, default=ROOT, help='repository root (default: this checkout)')
    args = parser.parse_args()
    found, scanned = findings(args.root.resolve())
    if scanned == 0:
        print('invisible-character gate: no tracked file under the scanned directories - refusing to pass on nothing')
        return 1
    if found:
        print(f'invisible-character gate: {len(found)} invisible character(s) in the gate machinery:')
        for line in found:
            print(f'  {line}')
        print('Delete the character, or write it as an escape where a script needs it.')
        return 1
    print(f'invisible-character gate: {scanned} tracked text files under {", ".join(SCANNED)} carry no invisible characters')
    return 0


if __name__ == '__main__':
    sys.exit(main())
