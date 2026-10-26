#!/usr/bin/env python3
"""Control for scripts/check-invisible-characters.py.

Each case builds a throwaway Git repository, commits one file and runs the
gate against it with --root. A case passes only when the gate's exit status
and its report are the ones the case names; a gate that went green on
everything (or red on everything) fails here. The real repository must pass.

Every invisible character below is written as an escape, so this file obeys
the rule it tests.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / 'scripts' / 'check-invisible-characters.py'

RED = [
    ('zero width space in a gate script (the c3cdcf88 finding)', 'scripts/check-x.py', 'PATTERN = "a\u200bb"\n', 'U+200B'),
    ('right-to-left override in a drill', 'scripts/x-mutations.py', 'x = 1  # \u202e)"evil"(\n', 'U+202E'),
    ('first strong isolate in a workflow', '.gitea/workflows/ci.yml', 'name: a\u2068b\n', 'U+2068'),
    ('byte order mark mid-file in a backend script', 'backend/scripts/drill.js', 'const a = 1;\n\ufeffconst b = 2;\n', 'U+FEFF'),
    ('zero width joiner in a GitHub workflow', '.github/workflows/ci.yml', 'run: echo a\u200db\n', 'U+200D'),
    ('word joiner', 'scripts/check-y.py', 'a\u2060b\n', 'U+2060'),
    ('soft hyphen', 'scripts/check-z.sh', 'echo co\u00adoperate\n', 'U+00AD'),
    ('a C0 control other than tab, LF and CR', 'scripts/check-c.py', 'x = "\u0007"\n', 'U+0007'),
    ('a C1 control', 'scripts/check-d.py', 'x = "\u0085"\n', 'U+0085'),
    ('Hangul filler (renders as nothing)', 'scripts/check-e.py', 'x\u3164 = 1\n', 'U+3164'),
    ('combining grapheme joiner', 'scripts/check-f.py', 'x = "a\u034fb"\n', 'U+034F'),
]

GREEN = [
    ('an emoji with its variation selector', 'scripts/check-g.py', 'print("\u26a0\ufe0f warning")\n'),
    ('tab, LF and CRLF line ends', 'scripts/check-h.sh', 'a\tb\r\nc\n'),
    ('typographic marks: dash, arrow, ellipsis', 'scripts/check-i.py', '# a \u2014 b \u2192 c \u2026\n'),
    ('an invisible character OUTSIDE the scanned directories', 'frontend/src/x.ts', 'const a = "\u200b";\n'),
]


def run(files: dict[str, str]) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory(prefix='invisible-gate-') as tmp:
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
    anchor = {'scripts/clean.py': 'print("clean")\n'}
    for label, relative, text, code in RED:
        result = run({**anchor, relative: text})
        if result.returncode != 1 or f'{relative}:' not in result.stdout or code not in result.stdout:
            failures.append(f'RED case not red by name: {label}\n{result.stdout}{result.stderr}')
    for label, relative, text in GREEN:
        result = run({**anchor, relative: text})
        if result.returncode != 0:
            failures.append(f'GREEN case went red: {label}\n{result.stdout}{result.stderr}')
    empty = run({'frontend/src/x.ts': 'const a = 1;\n'})
    if empty.returncode != 1 or 'refusing to pass on nothing' not in empty.stdout:
        failures.append(f'a tree with nothing to scan must not pass\n{empty.stdout}')
    real = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True)
    if real.returncode != 0:
        failures.append(f'the repository itself does not pass\n{real.stdout}')
    if failures:
        print('\n'.join(failures))
        return 1
    print(f'invisible-character gate control: {len(RED)} red cases red by name, {len(GREEN)} green cases green, '
          'empty scope refused, repository green')
    return 0


if __name__ == '__main__':
    sys.exit(main())
