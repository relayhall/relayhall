#!/usr/bin/env python3
"""Self-proof for scripts/check-emoji-chrome.py (A15.2 pattern)."""
from __future__ import annotations

import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

GATE = SourceFileLoader(
    "emoji_gate",
    str(Path(__file__).resolve().parent / "check-emoji-chrome.py")).load_module()

MUST_FAIL = [
    ("emoji in JSX text", "<h3>📋 Activity</h3>"),
    ("emoji in an option label", '<option value="a">✅ Done</option>'),
    ("emoji in a title attribute", '<span title="⚠️ careful">x</span>'),
    ("emoji in a console log", "console.log('🔌 connected');"),
    ("emoji in an icon data table", "const M = { ideas: '💡' };"),
    ("dingbat emoji", "const check = '✅';"),
    ("geometric emoji block", "const box = '⬜';"),
    ("media-control emoji", "const skip = '⏭';"),
]
MUST_PASS = [
    ("lucide component", '<h3><ClipboardList size={16} aria-hidden="true" /> Activity</h3>'),
    ("arrow is typography", "const label = `priority → ${next}`;"),
    ("bidirectional arrow is typography", "// Basic↔Connector transitions"),
    ("geometric bullet is typography", '<span className="work-dot">●</span>'),
    ("line comment about emoji", "// emoji 📋 discussed here is prose, not chrome"),
    ("block comment about emoji", "/* mapping: 📋 -> ClipboardList */"),
    ("plain text label", '<option value="a">Completed</option>'),
]


def main() -> int:
    problems: list[str] = []
    for label, src in MUST_FAIL:
        failures: list[str] = []
        GATE.check_text("fixture.tsx", src, failures)
        if not failures:
            problems.append(f"known-bad fixture passed: {label}")
    for label, src in MUST_PASS:
        failures = []
        GATE.check_text("fixture.tsx", src, failures)
        if failures:
            problems.append(f"known-good fixture failed: {label} -> {failures}")

    # A multi-line block comment must not leak into the following code line.
    failures = []
    GATE.check_text("fixture.tsx", "/* a\n   📋 b\n*/\nconst x = '📋';", failures)
    if len(failures) != 1:
        problems.append(f"block-comment handling wrong: {failures}")

    # Icon size grid (§4.2): chrome sizes must be 16/20/24; illustration
    # scale above 24 is exempt; anything below the grid is the defect.
    for bad in ("<Icon size={12} />", "<Icon size={14} />", "<Icon size={13} />", "<Icon size={22} />"):
        failures = []
        GATE.check_icon_sizes("fixture.tsx", bad, failures)
        if not failures:
            problems.append(f"off-grid icon size accepted: {bad}")
    for good in ("<Icon size={16} />", "<Icon size={20} />", "<Icon size={24} />",
                 "<Hero size={48} />", "<Avatar size={100} />"):
        failures = []
        GATE.check_icon_sizes("fixture.tsx", good, failures)
        if failures:
            problems.append(f"grid/illustration size rejected: {good} -> {failures}")

    if problems:
        print("Iconography gate self-test FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    print(f"Iconography gate self-test passed ({len(MUST_FAIL)} emoji fixtures fail, "
          f"{len(MUST_PASS)} typography/comment fixtures pass, block comments scoped, "
          f"4 off-grid sizes rejected, 5 grid/illustration sizes accepted).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
