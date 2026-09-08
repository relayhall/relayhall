#!/usr/bin/env python3
"""Semantic self-proof for scripts/colour-sweep-map.json (review 2a83b89b F2).

Independently classifies every SOURCE value in the mapping table and asserts
its TARGET tokens carry the right meaning class:

  - dark surfaces (low value) and near-gray/slate neutrals may map only to
    background/overlay/scrim/shadow/border/neutral-text tokens — never to a
    status or accent token;
  - white veils (light, near-gray) map only to overlay/border/neutral-text;
  - saturated status hues (red/green/amber/blue) stay inside their own status
    or danger family;
  - every mapping target is a var(--token) whose token is defined in
    frontend/src/styles/variables.css;
  - the legacy section keeps the ratified re-binds (orange/purple/cyan ramps
    to the accent family, blue ramps to status-info, green/yellow/red ramps
    to their status families).

The classifier here is deliberately independent of the generator that
produced the table: it encodes the review's expectations, not the
generator's implementation.
"""
from __future__ import annotations

import colorsys
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "scripts" / "colour-sweep-map.json"
VARS_PATH = ROOT / "frontend" / "src" / "styles" / "variables.css"

NEUTRAL_TOKENS = re.compile(
    r"var\(--(bg|overlay|scrim|shadow|border|text-(primary|secondary|tertiary|quaternary))")
STATUS_FAMILY = {
    "red": re.compile(r"var\(--(danger|status-danger|text-error)"),
    "green": re.compile(r"var\(--(status-success|text-success)"),
    "yellow": re.compile(r"var\(--(status-warning|text-warning)"),
    "blue": re.compile(r"var\(--(status-info|text-info)"),
}
ACCENT_FAMILY = re.compile(r"var\(--(accent|text-accent|focus-ring)")


def parse(value: str):
    if value.startswith("#"):
        h = value[1:]
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return r, g, b, a
    m = re.match(r"rgba?\(([\d.]+),([\d.]+),([\d.]+)(?:,([\d.]+))?\)", value)
    if not m:
        return None
    return (float(m.group(1)), float(m.group(2)), float(m.group(3)),
            float(m.group(4)) if m.group(4) else 1.0)


def classify(r, g, b) -> str | None:
    """Reviewer-expectation classes; None = no constraint asserted."""
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    deg = h * 360
    if v <= 0.26 and max(r, g, b) < 82:
        return "neutral"
    if s < 0.12:
        return "white-veil" if min(r, g, b) > 200 else "neutral"
    if 190 <= deg <= 262 and (s < 0.22 or (s < 0.38 and v < 0.58)):
        return "neutral"
    if s > 0.45 and v > 0.55:
        if deg < 14 or deg >= 340:
            return "red"
        if 90 < deg < 160:
            return "green"
        if 38 < deg < 62:
            return "yellow"
        if 205 < deg < 235:
            return "blue"
    return None


def targets_of(entry) -> list[str]:
    if isinstance(entry, str):
        return [entry]
    return list(entry.values())


def main() -> int:
    mapping = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    defined = set(re.findall(r"(--[\w-]+)\s*:", VARS_PATH.read_text(encoding="utf-8")))
    problems: list[str] = []

    # EXACT-PRIMITIVE RULE (review d92c0168): a source value that IS a defined
    # palette primitive must map into that primitive's own family. Hue
    # heuristics have boundary error (amber-500 sits at 37.7 deg, inside the
    # retired-orange arc); the declared palette does not.
    FAMILY_OF_RAMP = {
        "slate": NEUTRAL_TOKENS, "teal": ACCENT_FAMILY,
        "green": STATUS_FAMILY["green"], "amber": STATUS_FAMILY["yellow"],
        "red": STATUS_FAMILY["red"], "cyan": STATUS_FAMILY["blue"],
    }
    # Match by RGB TRIPLE, so both notations and every alpha form of a
    # primitive are covered (review 7679ac29: rgba(245,158,11,.14) escaped a
    # hex-only rule and leaked accent styling into warning surfaces).
    primitives = {}
    for ramp, hex_value in re.findall(
            r"--(slate|teal|green|amber|red|cyan)-\d+:\s*(#[0-9a-fA-F]{6})",
            VARS_PATH.read_text(encoding="utf-8")):
        h = hex_value[1:]
        primitives[(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))] = ramp

    for section in ("hex", "rgb"):
        for value, entry in mapping.get(section, {}).items():
            parsed = parse(value)
            if parsed is None:
                continue
            r, g, b, a = parsed
            ramp = primitives.get((int(r), int(g), int(b)))
            if ramp is None or a == 0:
                continue
            expect = FAMILY_OF_RAMP[ramp]
            for target in targets_of(entry):
                if not expect.match(target):
                    problems.append(
                        f"{value} carries the declared {ramp} primitive but maps "
                        f"to {target} (outside the {ramp} family)")

    for section in ("hex", "rgb"):
        for value, entry in mapping.get(section, {}).items():
            parsed = parse(value)
            if parsed is None:
                problems.append(f"{value}: unparsable source value")
                continue
            r, g, b, a = parsed
            cls = classify(r, g, b)
            if a == 0:
                # A fully transparent source carries NO colour: it is a
                # gradient/animation endpoint. Mapping it to any visible token
                # destroys the fade (review c9c258dc).
                for target in targets_of(entry):
                    if target != "transparent":
                        problems.append(
                            f"{value}: fully transparent source mapped to {target}")
                continue
            for target in targets_of(entry):
                if target == "transparent":
                    problems.append(
                        f"{value}: opaque/alpha source mapped to transparent")
                    continue
                name = re.match(r"var\((--[\w-]+)\)", target)
                if name is None or name.group(1) not in defined:
                    problems.append(f"{value}: target {target} is not a defined token")
                    continue
                if cls in ("neutral", "white-veil"):
                    if not NEUTRAL_TOKENS.match(target):
                        problems.append(
                            f"{value}: {cls} source mapped to non-neutral {target}")
                elif cls in STATUS_FAMILY:
                    ok = STATUS_FAMILY[cls].match(target)
                    if not ok:
                        problems.append(
                            f"{value}: {cls}-status source escaped its family -> {target}")

    legacy = mapping.get("legacy", {})
    for prefix, expect in (("--orange-", ACCENT_FAMILY), ("--purple-", ACCENT_FAMILY),
                           ("--blue-", STATUS_FAMILY["blue"]),
                           ("--green-", STATUS_FAMILY["green"]),
                           ("--yellow-", STATUS_FAMILY["yellow"]),
                           ("--red-", STATUS_FAMILY["red"])):
        for token, entry in legacy.items():
            if not token.startswith(prefix):
                continue
            for target in targets_of(entry):
                if not expect.match(target):
                    problems.append(f"legacy {token}: {target} outside its ratified family")

    # Composite sources (glow/shadow tokens = full box-shadow values) must map
    # to composite tokens, never bare colours (review c562131e).
    var_values = dict(re.findall(r"(--[\w-]+)\s*:\s*([^;}]*)",
                                 VARS_PATH.read_text(encoding="utf-8")))

    def is_composite(token: str, depth: int = 0) -> bool:
        if depth > 10:
            return False
        value = var_values.get(token, "")
        if re.search(r"(?<![\w-])-?[\d.]+(px|rem|em)", value):
            return True
        return any(is_composite(n, depth + 1) for n in re.findall(r"var\((--[\w-]+)", value))

    for token, entry in legacy.items():
        if "shadow-glow" not in token and not token.startswith("--shadow-"):
            continue
        for target in targets_of(entry):
            name = re.match(r"var\((--[\w-]+)\)", target)
            if name is None or not is_composite(name.group(1)):
                problems.append(
                    f"legacy {token}: composite source mapped to non-composite {target}")

    if problems:
        print("colour-sweep-map self-test FAILED:", file=sys.stderr)
        for x in problems:
            print(f"  {x}", file=sys.stderr)
        return 1
    total = len(mapping.get("hex", {})) + len(mapping.get("rgb", {}))
    print(f"colour-sweep-map self-test passed ({total} literal mappings + "
          f"{len(legacy)} legacy re-binds semantically constrained)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
