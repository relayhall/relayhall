"""CLI and MCP parity for Report structured handover v1."""

import importlib.util
import json
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).with_name("relayhall")
REPORT_ID = "11111111-1111-4111-8111-111111111111"
PROJECT_ID = "22222222-2222-4222-8222-222222222222"
TASK_ID = "33333333-3333-4333-8333-333333333333"
HANDOVER = {
    "schema_version": 1,
    "decisions": ["Use JSONB."],
    "assumptions": [],
    "alternatives_rejected": ["A free-form footer."],
    "unresolved_questions": ["Who verifies it?"],
}


def load_cli():
    loader = SourceFileLoader("relayhall_cli_handover", str(CLI_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


cli = load_cli()
REAL_CREATE = cli.cmd_report_create
REAL_UPDATE = cli.cmd_report_update


def parse_args(argv, monkeypatch, handler):
    captured = {}
    monkeypatch.setattr(cli, handler, lambda args: captured.setdefault("args", args))
    monkeypatch.setattr(sys, "argv", ["relayhall", *argv])
    cli.main()
    return captured["args"]


def test_report_create_inline_handover_reaches_rest(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "api", lambda method, path, data=None: calls.append((method, path, data)) or {"report": {"id": REPORT_ID}})
    monkeypatch.setattr(cli, "is_automation_context", lambda: True)
    args = parse_args([
        "report", "create", "Handoff", "--content", "Body",
        "--handover", json.dumps(HANDOVER),
    ], monkeypatch, "cmd_report_create")
    REAL_CREATE(args)
    assert calls == [("POST", "/reports", {"title": "Handoff", "content": "Body", "handover": HANDOVER})]


def test_report_update_handover_file_and_clear(monkeypatch, tmp_path):
    handover_file = tmp_path / "handover.json"
    handover_file.write_text(json.dumps(HANDOVER), encoding="utf-8")
    payloads = []
    monkeypatch.setattr(cli, "api", lambda method, path, data=None: payloads.append(data) or {"report": {"id": REPORT_ID, "title": "Handoff"}})
    monkeypatch.setattr(cli, "resolve_report_id", lambda _value: REPORT_ID)

    args = parse_args(["report", "update", REPORT_ID, "--handover-file", str(handover_file)], monkeypatch, "cmd_report_update")
    REAL_UPDATE(args)
    assert payloads[-1] == {"handover": HANDOVER}

    args = parse_args(["report", "update", REPORT_ID, "--clear-handover"], monkeypatch, "cmd_report_update")
    REAL_UPDATE(args)
    assert payloads[-1] == {"handover": None}


def test_cli_rejects_non_object_and_mutually_exclusive_handover(capsys, monkeypatch):
    args = parse_args(["report", "create", "Handoff", "--content", "Body", "--handover", "[]"], monkeypatch, "cmd_report_create")
    with pytest.raises(SystemExit):
        REAL_CREATE(args)
    assert "must be an object" in capsys.readouterr().err

    with pytest.raises(SystemExit):
        parse_args([
            "report", "update", REPORT_ID, "--handover", "{}", "--clear-handover",
        ], monkeypatch, "cmd_report_update")


# The MCP half of this suite moved with the surface it tested (RH-P3.C4, owner
# decision D1): the out-of-process adapter is retired, and the report-tool
# schema, the camelCase-to-REST translation and the unknown-field refusal are
# pinned against the TypeScript registry in
# backend/src/__tests__/c4McpDispatchMapping.test.ts. The CLI tests above stay
# — they test the CLI, which did not move.
