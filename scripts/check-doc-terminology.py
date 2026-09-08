#!/usr/bin/env python3
"""Enforce RelayHall public terminology, branding, and local Markdown links."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_FILES: set[str] = set()  # CHANGELOG.md was excluded while it carried
# predecessor release history; it was reset to a RelayHall-native changelog
# (RH-P1.6a) and is now gated like every other Markdown file.
EXCLUDED_PARTS = {".git", "node_modules", "dist", "coverage", "design-history", ".pytest_cache"}
# A7: the compiled working context is a Brief. Defined ONCE and used by both
# the Markdown pass and the runtime pass, so a word cannot be retired in prose
# and legal in code. Punctuation-tolerant and clause-bounded; the auxiliary
# guard keeps the English verb legal ("the compiler will prompt for a target").
A7_BRIEF_COLLOCATIONS = re.compile(
    r"\bcompiled[- ]prompts?\b"
    # A7/§7 retires "bootstrap payload" outright — the session Brief is the
    # Brief family's fourth altitude and has a ratified name. Added after
    # review de782259 B2 found the retired words in new RH-P3.C4 comments,
    # written by the same candidate that quotes the retirement rule.
    r"|\bbootstrap[- ]payloads?\b"
    r"|\bprompts?[- ]compil\w*\b"
    r"|\bcompil\w*(?:[^\w.!?\n]+(?!(?:will|would|may|might|can|could|shall|should|must|to|then|also|not|never)\b)\w+){0,3}[^\w.!?\n]+prompts?\b"
    r"|\btask\s+prompts?\b|\bspawn\s+prompts?\b",
    re.IGNORECASE,
)

# `completed` and `archived` are ordinary English participles as well as
# lifecycle tokens. Unlabelled proximity to `blocked` is therefore evidence
# only for unambiguous tokens, or when the participles occur in a syntactic
# list made solely from lifecycle tokens and punctuation-required separators.
_CLEAR_LIFECYCLE = r"(?:ideas|todo|in-progress|stuck)"
_LIFECYCLE_ITEM = r"(?:ideas|todo|in-progress|stuck|completed|archived)"
_LIST_SEPARATOR = r"(?:\s*[,/|]\s*(?:(?:and|or)\s+)?)"
_LIST_TERMINATION = r"(?=\s*(?:[.;:!?)]|\n|$))"
BLOCKED_STATE_CONTEXT = re.compile(
    rf"\b{_CLEAR_LIFECYCLE}\b[^.\n]{{0,60}}\bblocked\b"
    rf"|\bblocked\b[^.\n]{{0,60}}\b{_CLEAR_LIFECYCLE}\b"
    rf"|\b(?:completed|archived)\b(?:{_LIST_SEPARATOR}\b{_LIFECYCLE_ITEM}\b){{0,5}}{_LIST_SEPARATOR}\bblocked\b{_LIST_TERMINATION}"
    rf"|\bblocked\b(?:{_LIST_SEPARATOR}\b{_LIFECYCLE_ITEM}\b){{0,5}}{_LIST_SEPARATOR}\b(?:completed|archived)\b{_LIST_TERMINATION}"
    r"|\b(?:states?|status(?:es)?|lifecycles?|columns?)\b[^.\n]{0,80}\bblocked\b"
    r"|\bblocked\b[^.\n]{0,40}\b(?:states?|status(?:es)?|columns?)\b",
    re.IGNORECASE,
)

PROSE_PATTERNS = (
    # A26.3: Blueprint is the reusable-template sense only. Keep ordinary
    # process/CI/n8n vocabulary legal; existing code-span/fence masking quotes
    # descriptor values and CI filenames without exempting whole documents.
    (re.compile(r"\bworkflow\s+(?:templates?|instantiations?|versions?|parameters?)\b"
                r"|\breusable\s+workflows?\b|\binstantiate\s+a\s+workflow\b", re.IGNORECASE),
     "use 'Blueprint' for the reusable template (A26.3)"),
    (re.compile(r"\bwork[-_ ]?items?\b", re.IGNORECASE), "the term is retired: use 'task'; code spans may quote immutable history"),
    (re.compile(r"\bclawboard\b", re.IGNORECASE), "use the RelayHall product name"),
    (re.compile(r"\bagent[-_ ]?types?\b", re.IGNORECASE), "the term is retired: use 'personality' (D-1)"),
    # \bpersonas?\b (not a bare substring) deliberately excludes the ratified
    # words personality/personalities and English 'personal'.
    (re.compile(r"\bpersonas?\b", re.IGNORECASE), "the term is retired: use 'personality' (D-1, D-4)"),
    # D-2/A14: the instruction registry is Skills; the word Tool is reserved
    # for a Service's callable operation (Phase 2, exactly MCP's sense). Only
    # the registry-sense collocations are banned — bare 'tool' stays legal for
    # the MCP-protocol and harness senses.
    (re.compile(r"\btools?\s+registr(?:y|ies)\b", re.IGNORECASE), "the registry is Skills (D-2, A14)"),
    (re.compile(r"\btool\s+instructions?\b", re.IGNORECASE), "use 'skill instructions' (D-2, A14)"),
    (re.compile(r"\btool\s+cards?\b", re.IGNORECASE), "use 'skill instructions' or 'skill entries' (D-2, A14)"),
    # D-9/A13 (A15): the rest of the estate family joins the prose rules. The
    # masking above keeps DEPLOYMENT.md's pre-A13 volume literals (code spans
    # and fenced procedure blocks) legal — protect that twice-repaired outcome.
    (re.compile(r"CLAWBOARD_|\bcb_(?:live|dev)_|nim-status|bot-status|\bhomelab\b", re.IGNORECASE),
     "estate vocabulary is retired (D-9, A13): use the RelayHall-native name"),
    # A3/D-6 (A15): the grouping word is Phase.
    (re.compile(r"\bepics?\b", re.IGNORECASE), "the grouping word is 'Phase' (D-6); 'epic' is retired"),
    # A7 (A15, tightened by d0378b78): the compiled working context is a
    # Brief. Collocations ONLY — bare 'prompt' stays legal: window.prompt, the
    # CLI's own confirmation prompts and the English verb ('will prompt for
    # confirmation') are all legitimate. (The route and CLI verb that used to
    # be listed here as legitimate were RENAMED to `brief` in RH-P3.C4 (ii)
    # per owner decision D4; the rule is unchanged because bare 'prompt' was
    # never what it fired on.) The compile→prompt window is punctuation-
    # tolerant (a comma must not hide the collocation) and clause-bounded; the
    # auxiliary guard keeps the English verb legal ('the compiler will prompt
    # for a target').
    (A7_BRIEF_COLLOCATIONS,
     "the compiled working context is a 'Brief' (A7); reword the collocation"),
    # D-11 (A15): the judging role is Verifier. Prose-only by construction —
    # the frozen reviewer-named code identifiers (ReviewerHeartbeatService,
    # REVIEWER_HEARTBEAT_*, --run-reviewer, ledger filenames) always sit in
    # code spans or fences, which this pass masks.
    (re.compile(r"\breviewers?\b", re.IGNORECASE), "the role word is 'Verifier' (D-11)"),
    # D-11/G5 (A15): 'owner' stays ratified as the deployment's human
    # authority; only the task-holder collocations are retired.
    (re.compile(r"\btask\s+owners?\b|\bowners?\s+of\s+(?:a|the)\s+task\b|\bowning\s+agent\b", re.IGNORECASE),
     "a Task's holder is the 'Assignee' (D-11); 'owner' means the deployment's human authority"),
    # D-12/A11.3 (A15, tightened by d0378b78): 'blocked' is retired as a
    # STATE word. The rule fires only in state position: beside a RATIFIED
    # lifecycle token (the pre-D12 pseudo-states 'planned'/'active' were
    # false-positive bait — ordinary English past tense is not a state), or
    # under a state/status/lifecycle/column label. English uses ('the owner
    # planned the rollout, which remains blocked until approval') and the
    # kept A11.3 identifiers (hasBlocked, blockedReason — code-spanned)
    # stay legal. 'review' is deliberately not in the token set — it is
    # pervasive legitimate English here; the label branch covers it.
    (BLOCKED_STATE_CONTEXT,
     "the state word is 'stuck' (D-12); 'blocked' may not appear in a lifecycle-state position"),
)
# The protocol capability is always written in full, capitalised: the
# capitalisation is the entire disambiguation from a RelayHall task.
EXTENSION_EXACT = "MCP Tasks extension"
EXTENSION_LOOSE = re.compile(r"\b(?:MCP\s+)?tasks?\s+extensions?\b", re.IGNORECASE)
# PUBLIC_ARTIFACTS get branding/release-manifest checks ONLY — never the
# vocabulary rules. database/init.sql is doctrine-protected (its header notes,
# tasks 468faa10 and daefcdf6): the baseline deliberately keeps retired names
# and seeds so historical migrations replay, and the chain renames at the end.
# Extending vocabulary rules here would fight that doctrine (A15/D8).
PUBLIC_ARTIFACTS = (
    ROOT / "backend" / "Dockerfile",
    ROOT / "backend" / "package.json",
    ROOT / "cli" / "relayhall_doctor.py",
    ROOT / "database" / "init.sql",
    ROOT / "frontend" / "Dockerfile",
    ROOT / "frontend" / "index.html",
    ROOT / "frontend" / "package.json",
    ROOT / "relayhall.config.example.json",
    ROOT / "scripts" / "hash-password.js",
)
LINK_PATTERN = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")


def excluded(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return path.name in EXCLUDED_FILES or any(part in EXCLUDED_PARTS for part in relative.parts)


def visible_prose_text(text: str) -> list[tuple[int, str]]:
    """Prose lines with fences skipped and code spans/link targets/URLs masked.
    Text-based so the CI self-test (scripts/test-terminology-gate.py, A15) can
    feed fixture strings through the exact production masking."""
    visible: list[tuple[int, str]] = []
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        if re.match(r"^\s*(```|~~~)", line):
            fenced = not fenced
            continue
        if fenced:
            continue
        masked = re.sub(r"`[^`]*`", "", line)
        masked = re.sub(r"(?<=\]\()[^)]+(?=\))", "", masked)
        masked = re.sub(r"https?://\S+", "", masked)
        visible.append((number, masked))
    return visible


def visible_prose(path: Path) -> list[tuple[int, str]]:
    return visible_prose_text(path.read_text(encoding="utf-8"))


def check_markdown_text(relative: str, text: str, failures: list[str]) -> None:
    """All content rules (prose vocabulary + whole-text identifier/branding
    rules) over an in-memory document. The local-link check needs a real path
    and lives in check_markdown below."""
    for number, prose in visible_prose_text(text):
        for pattern, advice in PROSE_PATTERNS:
            if pattern.search(prose):
                failures.append(f"{relative}:{number}: {advice}: {prose.strip()}")
        for match in EXTENSION_LOOSE.finditer(prose):
            if match.group() != EXTENSION_EXACT:
                failures.append(
                    f"{relative}:{number}: write the protocol capability as '{EXTENSION_EXACT}', in full and capitalised: {prose.strip()}"
                )

    # Fenced examples are exempt from prose vocabulary but not stale product
    # branding or fabricated compatibility filenames.
    for number, line in enumerate(text.splitlines(), 1):
        if re.search(r"\bClawBoard\b", line):
            failures.append(f"{relative}:{number}: stale public ClawBoard branding: {line.strip()}")
        if re.search(r"\bwork items?\.json\b", line, re.IGNORECASE):
            failures.append(f"{relative}:{number}: use the literal compatibility filename tasks.json: {line.strip()}")
        # D-12: one kebab-case state vocabulary; the underscore spelling is
        # retired on every surface, including code spans and fenced examples.
        if re.search(r"\bin_progress\b", line):
            failures.append(f"{relative}:{number}: the state token is 'in-progress' (D-12); in_progress is retired: {line.strip()}")
        # D-1/D-4: retired identifiers must not appear even in code spans or
        # fenced examples. Historical migration FILENAMES are ledger keys and
        # exempt (DP-13): 034_agent_types.sql, 042_agent_type_..., 043_session_agent_type.sql.
        identifier_line = re.sub(r"0\d\d_[a-z_]*agent_types?[a-z_]*\.sql", "", line)
        if re.search(r"/agent-types\b|\bagent_type_id\b|\bagentTypeIds?\b|\bagent_types\b|relayhall_persona_", identifier_line):
            failures.append(f"{relative}:{number}: retired identifier (D-1/D-4); use the personality form: {line.strip()}")


def check_markdown(path: Path, failures: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    relative = path.relative_to(ROOT)
    check_markdown_text(str(relative), text, failures)

    for match in LINK_PATTERN.finditer(text):
        target = match.group(1).split(maxsplit=1)[0].strip("<>")
        if not target or target.startswith(("#", "http://", "https://", "mailto:")):
            continue
        target_path = (path.parent / target.split("#", 1)[0]).resolve()
        if not target_path.exists():
            line = text.count("\n", 0, match.start()) + 1
            failures.append(f"{relative}:{line}: broken local link target: {target}")


RUNTIME_RETIRED = (
    (re.compile(r"\bagent[ _-]?types?\b", re.IGNORECASE), "the term is retired: use 'personality' (D-1)"),
    (re.compile(r"\bpersonas?\b", re.IGNORECASE), "the term is retired: use 'personality' (D-1, D-4)"),
    # D-9/A13: the estate family may not reappear on runtime surfaces.
    (re.compile(r"\bclawboard\b|CLAWBOARD_|\bcb_(?:live|dev)_|nim-status|bot-status|\bhomelab\b", re.IGNORECASE),
     "estate vocabulary is retired (D-9, A13): use the RelayHall-native name"),
    # A7 (added by RH-P2.4 after review 1a786ae4 F3): the compiled working
    # context is a Brief on runtime surfaces too. Until this rule existed the
    # ratified naming gate could pass green while new CODE reintroduced the
    # retired words — which is exactly what happened.
    #
    # COLLOCATIONS ONLY, and the SAME expression the Markdown pass uses, so
    # the two cannot diverge. Bare 'prompt' stays legal by design: window.prompt,
    # the CLI's confirmation prompts and the English verb are all legitimate.
    # The Phase-3 removal the earlier note pointed at HAS NOW HAPPENED — the
    # route, the CLI verb and the response key are all `brief` (RH-P3.C4 (ii),
    # D4) — and the rule is unchanged, because it never fired on bare 'prompt'.
    (A7_BRIEF_COLLOCATIONS,
     "the compiled working context is a 'Brief' (A7); reword the collocation"),
    # A16/§4.4 (added by RH-UI.1c): the plugin theme contract publishes
    # semantic tokens under --rh-* names. The estate-era --cb-* custom
    # properties are retired everywhere, including PluginLoader's generator
    # and the plugin-development docs.
    (re.compile(r"--cb-"),
     "the --cb-* plugin variables are retired (§4.4): publish --rh-* semantic tokens"),
)
RUNTIME_TREES = ("backend/src", "frontend/src", "cli", "mcp")
RUNTIME_EXCLUDED_PARTS = {"migrations", "__tests__", "fixtures", "node_modules", "dist", "coverage"}
RUNTIME_SUFFIXES = {".ts", ".tsx", ".py", ".css", ".sh", ""}


def check_runtime_sources(failures: list[str]) -> None:
    """Owner-reachable runtime/API/UI surfaces must not regress to retired
    vocabulary (review 90d8abd9 finding 2). Historical migrations, tests and
    fixtures replay or pin history and are exempt."""
    for tree in RUNTIME_TREES:
        base = ROOT / tree
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.suffix not in RUNTIME_SUFFIXES:
                continue
            relative = path.relative_to(ROOT)
            if any(part in RUNTIME_EXCLUDED_PARTS for part in relative.parts) or path.name.startswith("test_"):
                continue
            if path.name.endswith((".test.ts", ".test.tsx")):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for number, line in enumerate(text.splitlines(), 1):
                for pattern, advice in RUNTIME_RETIRED:
                    if pattern.search(line):
                        failures.append(f"{relative}:{number}: {advice}: {line.strip()}")


# Docs whose CODE BLOCKS are themselves the contract: the Markdown pass masks
# fences and code spans (correctly — they quote immutable history), so a
# retired token published inside a fenced example would slip through. These
# files get a RAW-TEXT check for the patterns listed with them.
RAW_TEXT_CHECKS = (
    ("docs/plugin-development.md", re.compile(r"--cb-"),
     "the --cb-* plugin variables are retired (§4.4): document --rh-* semantic tokens"),
)


def check_raw_text(failures: list[str]) -> None:
    for relative, pattern, advice in RAW_TEXT_CHECKS:
        path = ROOT / relative
        if not path.exists():
            failures.append(f"{relative}: listed in RAW_TEXT_CHECKS but missing from the tree")
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if pattern.search(line):
                failures.append(f"{relative}:{number}: {advice}: {line.strip()}")


def main() -> int:
    failures: list[str] = []
    markdown_paths = [path for path in sorted(ROOT.rglob("*.md")) if not excluded(path)]
    for path in markdown_paths:
        check_markdown(path, failures)
    check_runtime_sources(failures)
    check_raw_text(failures)

    public_paths = list(PUBLIC_ARTIFACTS)
    public_paths.extend(path for path in (ROOT / "docs" / "example-plugin").rglob("*") if path.is_file())
    for path in public_paths:
        if not path.exists() or excluded(path):
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\bClawBoard\b", line):
                failures.append(f"{path.relative_to(ROOT)}:{number}: stale public ClawBoard branding: {line.strip()}")
            if '"service":"clawboard-' in line:
                failures.append(f"{path.relative_to(ROOT)}:{number}: stale public release-manifest service: {line.strip()}")

    if failures:
        print("Public documentation contract failed:", file=sys.stderr)
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"Public documentation contract passed ({len(markdown_paths)} Markdown files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
