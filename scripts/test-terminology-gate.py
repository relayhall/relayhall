#!/usr/bin/env python3
"""Self-test for scripts/check-doc-terminology.py (RH-VOCAB.9, amendment A15.2).

Proves, in CI, that the terminology gate FAILS on retired vocabulary and
PASSES on the ratified words and the known legitimate landmines. Fixture
strings run through the exact production masking (visible_prose_text /
check_markdown_text) — no repository files are written or read, so the proof
is deterministic and independent of tree state.

Run: python3 scripts/test-terminology-gate.py   (exit 0 = gate behaves)
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

GATE_PATH = Path(__file__).resolve().parent / "check-doc-terminology.py"


def load_gate():
    loader = importlib.machinery.SourceFileLoader("terminology_gate", str(GATE_PATH))
    spec = importlib.util.spec_from_loader("terminology_gate", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


gate = load_gate()

# Each entry: (label, markdown text). MUST produce at least one failure.
MUST_FAIL = [
    ("blueprint workflow template", "Create a workflow template for the project."),
    ("blueprint reusable workflow", "Save a reusable workflow for future projects."),
    ("blueprint workflow instantiation", "Review the workflow instantiation plan."),
    ("blueprint instantiate a workflow", "Choose parameters to instantiate a workflow."),
    ("blueprint workflow version", "Publish the workflow version."),
    ("blueprint workflow parameter", "Set a workflow parameter before creating tasks."),
    ("blueprint plural case", "The WORKFLOW TEMPLATES have workflow parameters."),
    ("blueprint value exemption stays local", 'The n8n descriptor says `"workflow template"`; publish a workflow version here.'),
    ("blueprint fence exemption stays local", '```json\n{"kind":"workflow template"}\n```\nCreate a reusable workflow here.'),
    ("work item", "Create a work item for it."),
    ("clawboard prose", "The clawboard dashboard shows it."),
    ("estate env var", "Set CLAWBOARD_API_URL before running."),
    ("estate key prefix", "Keys start with cb_live_ here."),
    ("estate host word", "Deploy it on the homelab first."),
    ("agent type", "Pick an agent type for the run."),
    ("persona", "Assign a persona to the task."),
    ("tools registry", "Edit the Tools Registry entry."),
    ("tool instructions", "Update the tool instructions text."),
    ("tool card", "Open the tool card in the dashboard."),
    ("epic", "Group the tasks under one epic."),
    ("compiled prompt", "The harness pulls a compiled prompt."),
    # A7/§7, added with the rule after review de782259 B2.
    ("bootstrap payload", "The bootstrap payload is assembled server-side."),
    ("bootstrap-payload hyphenated", "It returns the bootstrap-payload for the session."),
    ("prompt compilation", "Prompt compilation resolves the policy."),
    ("compiles a prompt", "The board compiles a prompt for the agent."),
    ("compiles task prompts", "It compiles complete task prompts."),
    ("task prompt", "Include it in the task prompt."),
    ("prompt-compile", "Applied at prompt-compile time."),
    # d0378b78 exact adversarial string: punctuation inside the compile→prompt
    # window must not hide the collocation.
    ("compiles punctuated prompt", "The board compiles the final, complete prompt for the harness."),
    ("compiling gerund prompt", "Compiling the final prompt happens server-side."),
    ("compilation returns prompt", "Brief compilation returns the full prompt text."),
    ("semicolon stays inside compile context", "Compilation finished; prompt text follows."),
    ("colon stays inside compile context", "Compilation result: prompt text follows."),
    ("reviewer role", "The reviewer approves the task."),
    ("task owner", "Ping the task owner about it."),
    ("owner of the task", "The owner of the task hands it back."),
    ("blocked in state list", "States: planned, active, blocked, and verified."),
    ("blocked beside state", "It covers blocked/stuck work."),
    ("blocked under state label", "Set the state to blocked when a dependency is missing."),
    ("two-item comma participle forward", "Supported values are completed, blocked."),
    ("two-item slash participle forward", "Supported values are completed / blocked."),
    ("two-item pipe participle forward", "Supported values are archived | blocked."),
    ("two-item comma participle reverse", "Supported values are blocked, completed."),
    ("two-item slash participle reverse", "Supported values are blocked / archived."),
    ("two-item pipe participle reverse", "Supported values are blocked | completed."),
    ("participles in lifecycle list", "Supported values are completed, archived, and blocked."),
    ("blocked before participle list", "Supported values are blocked / completed / archived."),
    ("in_progress token", "Set it to `in_progress` now."),
    ("retired identifier", "Query the agent_types table."),
    ("extension capitalisation", "Use the MCP tasks extension for this."),
    ("stale branding", "ClawBoard ships this surface."),
]

# Each entry: (label, markdown text). MUST produce zero failures.
MUST_PASS = [
    ("blueprint ratified names", "Publish a Blueprint version and instantiate a Blueprint with its parameters."),
    ("blueprint ci reference", "The CI workflow is `.github/workflows/workflow template.yml`; it runs checks."),
    ("blueprint n8n quoted descriptor", 'The n8n descriptor reports `"workflow template"` as its exact capability value.'),
    ("blueprint n8n fenced descriptor", 'The n8n descriptor value is:\n```json\n{"kind":"workflow template"}\n```\nUse the Connector capability as declared.'),
    ("blueprint english process", "The review workflow begins when the author requests review."),
    ("ratified words", "A Task in a Phase compiles a Brief; the Verifier judges the review state; the Skill teaches it."),
    ("bare prompt verb", "The script will prompt for confirmation."),
    ("window.prompt in span", "It calls `window.prompt(...)` to ask."),
    # Both entries here used to name the live /prompt route and CLI verb; D4
    # renamed those to `brief`, so the fixtures now use shapes that are still
    # in the tree. What they cover is unchanged: a bare 'prompt' inside a code
    # span must not fire the A7 rule.
    ("bare prompt in span", "The CLI calls `confirm_prompt(message)` before destructive acts."),
    ("interactive prompt in span", "Pass `--yes` to skip the interactive `prompt`."),
    ("retired scope in span", "The `tasks:prompt` scope folded into read."),
    ("mcp protocol tools", "The server answers `tools/list` and `tools/call`; see the Tools section of the MCP spec."),
    ("phase-2 tool sense", "A Tool is one callable operation a Service exposes."),
    ("reviewer identifier in span", "Configure `REVIEWER_HEARTBEAT_INTERVAL_MS` and `ReviewerHeartbeatService` stays frozen."),
    ("reviewer ledger filename", "History lives in `038_task_reviewer_fields.sql`."),
    ("blocked as english", "Owner-gated actions stay blocked until explicit approval."),
    # d0378b78 exact adversarial string: ordinary English past tense is not a
    # lifecycle token.
    ("planned as english past tense", "The owner planned the rollout, which remains blocked until approval."),
    ("completed as english participle", "The restore completed, but the follow-up stays blocked until approval."),
    ("archived as english participle", "The archive was archived, but retrieval remains blocked until approval."),
    ("completed and blocked as verbs", "The restore completed and blocked access to the stale archive."),
    ("archived and blocked as verbs", "The job archived the bundle and blocked deletion during transfer."),
    ("comma list has non-lifecycle tail", "Supported values are completed, blocked, pending."),
    ("slash list has non-lifecycle tail", "Supported values are blocked / archived / pending."),
    ("pipe list has non-lifecycle tail", "Supported values are completed | blocked | queued."),
    ("compiler will prompt aux guard", "The compiler will prompt for a target."),
    ("compilation then prompt aux guard", "After compilation the installer may prompt you."),
    ("exclamation ends compile context", "Compilation finished! Prompt the operator."),
    ("question ends compile context", "Compilation finished? Prompt the operator."),
    ("period ends compile context", "Compilation finished. Prompt the operator."),
    ("newline ends compile context", "Compilation finished\nPrompt the operator."),
    ("blocked gloss with masked token", "`stuck` — blocked or waiting on human input."),
    ("blocked identifiers in span", "The `hasBlocked` flag and `blockedReason` field are kept by A11.3."),
    ("deployment literals in fence", "Upgrade steps:\n\n```bash\ndocker volume inspect clawboard_postgres_data\ndocker stop clawboard-db\n```\n\nThen continue."),
    ("deployment literal in span", "The old volume is `clawboard_postgres_data`."),
    ("owner authority sense", "The owner approves the gate; owner-gated actions wait."),
    ("ci workflow english", "The CI workflow runs the migration tests; see .github/workflows/ci.yml."),
    ("workflow process english", "The recommended workflow is to branch first."),
    ("n8n connector sense", "An n8n Connector declares its own workflows as capability values."),
    ("extension exact form", "This uses the MCP Tasks extension as specified."),
    ("skill seed category", "The task-management skill sits in the workflow category."),
    ("in-progress ratified", "Move it to in-progress when you start."),
]


def main() -> int:
    problems: list[str] = []

    for label, text in MUST_FAIL:
        failures: list[str] = []
        gate.check_markdown_text(f"fixture/{label}.md", text, failures)
        if not failures:
            problems.append(f"MUST-FAIL fixture produced no failure: [{label}] {text!r}")

    for label, text in MUST_PASS:
        failures = []
        gate.check_markdown_text(f"fixture/{label}.md", text, failures)
        if failures:
            problems.append(
                f"MUST-PASS fixture tripped the gate: [{label}] {text!r} -> " + "; ".join(failures)
            )

    # The runtime rule set must keep covering the estate family and the
    # personality renames (review 90d8abd9 finding 2 pinned this coverage).
    # The A7 collocations joined the runtime set with RH-P2.4 (review
    # 1a786ae4 F3): until then, ratified naming could pass green while new
    # CODE reintroduced 'prompt'/'compiler' for the Brief family.
    runtime_bad = ["const x = 'agent_type';", "persona = load()", "CLAWBOARD_TOKEN", "cb_live_abc", "homelab",
                   "// the goal->prompt compiler seed", "* Compile the agent prompt for a task",
                   "// part of their task prompt", "spawn prompt builder",
                   "* the SERVER-ASSEMBLED BOOTSTRAP PAYLOAD", "// the bootstrap payload rides here",
                   # §4.4 (RH-UI.1c): the retired plugin variable prefix
                   "  --cb-accent: #7c3aed;", "var(--cb-bg-primary)"]
    for snippet in runtime_bad:
        if not any(pattern.search(snippet) for pattern, _ in gate.RUNTIME_RETIRED):
            problems.append(f"RUNTIME_RETIRED misses: {snippet!r}")
    # Bare 'prompt' stays legal on runtime surfaces: window.prompt, the CLI's
    # own confirmation prompts and the English verb. (The route, CLI verb and
    # response key that used to appear here were renamed to `brief` by D4 in
    # RH-P3.C4 (ii); these snippets are live shapes again.)
    runtime_good = ["window.prompt('x')", "ReviewerHeartbeatService.run()", "hasBlocked = true", "tools/list",
                    "def confirm_prompt(message):", "help='or interactive prompt'",
                    "// the compiler will prompt for a target", "relayhall brief ID",
                    "Compilation finished! Prompt the operator.",
                    "Compilation finished? Prompt the operator."]
    for snippet in runtime_good:
        if any(pattern.search(snippet) for pattern, _ in gate.RUNTIME_RETIRED):
            problems.append(f"RUNTIME_RETIRED false-positives on: {snippet!r}")

    # RAW_TEXT_CHECKS (§4.4): fenced examples are masked by the Markdown pass,
    # so the raw-text pass is what protects a doc whose code blocks ARE the
    # contract. Prove the pattern fires on a fenced line, and that the file it
    # names exists (a stale entry must fail, not silently pass).
    for relative, pattern, _ in gate.RAW_TEXT_CHECKS:
        if not (gate.ROOT / relative).exists():
            problems.append(f"RAW_TEXT_CHECKS names a missing file: {relative}")
        if not pattern.search("  --cb-accent: #7c3aed;"):
            problems.append(f"RAW_TEXT_CHECKS pattern for {relative} misses a fenced retired token")
        if pattern.search("  --rh-accent-color: #14b8a6;"):
            problems.append(f"RAW_TEXT_CHECKS pattern for {relative} false-positives on the ratified prefix")
    stale: list[str] = []
    gate.check_raw_text(stale)
    if stale:
        problems.append(f"raw-text check fails on the live tree: {stale[:2]}")

    if problems:
        print("Terminology-gate self-test FAILED:", file=sys.stderr)
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(
        f"Terminology-gate self-test passed "
        f"({len(MUST_FAIL)} retired-word fixtures fail, {len(MUST_PASS)} ratified/landmine fixtures pass)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
