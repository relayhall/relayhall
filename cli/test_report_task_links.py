"""Report task-link CLI tests.

Covers the 2026-07-26 defect: `relayhall report update <id> --add-task X
--add-task Y --add-task Z` reported success but linked only the LAST task,
because --add-task/--remove-task were single-value argparse options.
"""

import importlib.util
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).with_name("relayhall")


def _load_cli():
    """Import the extension-less `relayhall` script as a module."""
    loader = SourceFileLoader("relayhall_cli", str(CLI_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


cli = _load_cli()

# Captured before any monkeypatching: _parse() replaces cmd_report_update to
# intercept parsed args, so the end-to-end tests need the original handler.
REAL_CMD_REPORT_UPDATE = cli.cmd_report_update


# ─── resolve_task_id_list ───

@pytest.fixture
def resolver(monkeypatch):
    """Resolve short ids to a deterministic full id without hitting the API."""
    monkeypatch.setattr(cli, "resolve_task_id", lambda s: f"{s}-full")


def test_none_and_empty_yield_no_ids(resolver):
    assert cli.resolve_task_id_list(None) == []
    assert cli.resolve_task_id_list([]) == []
    assert cli.resolve_task_id_list("") == []
    assert cli.resolve_task_id_list([" ", ","]) == []


def test_repeated_flags_all_resolve_in_order(resolver):
    assert cli.resolve_task_id_list(["a", "b", "c"]) == ["a-full", "b-full", "c-full"]


def test_comma_separated_matches_the_tags_convention(resolver):
    assert cli.resolve_task_id_list(["a,b, c"]) == ["a-full", "b-full", "c-full"]


def test_repeated_and_comma_separated_combine(resolver):
    assert cli.resolve_task_id_list(["a,b", "c"]) == ["a-full", "b-full", "c-full"]


def test_duplicates_collapse_preserving_first_position(resolver):
    assert cli.resolve_task_id_list(["a", "b", "a"]) == ["a-full", "b-full"]


def test_plain_string_stays_supported(resolver):
    """Backwards compatibility with single-value callers."""
    assert cli.resolve_task_id_list("a") == ["a-full"]


# ─── argparse wiring ───

def _parse(argv, monkeypatch):
    """Run the real parser and capture the args handed to cmd_report_update."""
    captured = {}
    monkeypatch.setattr(cli, "cmd_report_update", lambda args: captured.setdefault("args", args))
    monkeypatch.setattr(sys, "argv", ["relayhall", *argv])
    cli.main()
    return captured["args"]


def test_repeated_add_task_flags_accumulate(monkeypatch):
    args = _parse(["report", "update", "abc12345", "--add-task", "a", "--add-task", "b", "--add-task", "c"], monkeypatch)
    assert args.add_task == ["a", "b", "c"]


def test_repeated_remove_task_flags_accumulate(monkeypatch):
    args = _parse(["report", "update", "abc12345", "--remove-task", "a", "--remove-task", "b"], monkeypatch)
    assert args.remove_task == ["a", "b"]


def test_single_flag_still_parses(monkeypatch):
    args = _parse(["report", "update", "abc12345", "--add-task", "a"], monkeypatch)
    assert args.add_task == ["a"]


def test_absent_flags_default_to_none(monkeypatch):
    args = _parse(["report", "update", "abc12345", "--title", "t"], monkeypatch)
    assert args.add_task is None
    assert args.remove_task is None


# ─── end-to-end handler behaviour ───

def test_update_links_every_requested_task(monkeypatch):
    """The regression itself: 3 requested, 3 linked — not just the last."""
    calls = {}

    def fake_api(method, path, data=None):
        if method == "GET":
            return {"report": {"id": "r1", "task_ids": ["existing-full"]}}
        calls["payload"] = data
        return {"report": {"id": "r1", "title": "R"}}

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resolve_report_id", lambda s: "r1")
    monkeypatch.setattr(cli, "resolve_task_id", lambda s: f"{s}-full")
    monkeypatch.setattr(cli, "is_automation_context", lambda: False)

    args = _parse_args_for_update(monkeypatch, add_task=["a", "b", "c"])
    REAL_CMD_REPORT_UPDATE(args)

    assert calls["payload"]["task_ids"] == ["existing-full", "a-full", "b-full", "c-full"]


def test_update_removes_every_requested_task(monkeypatch):
    calls = {}

    def fake_api(method, path, data=None):
        if method == "GET":
            return {"report": {"id": "r1", "task_ids": ["a-full", "b-full", "c-full"]}}
        calls["payload"] = data
        return {"report": {"id": "r1", "title": "R"}}

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resolve_report_id", lambda s: "r1")
    monkeypatch.setattr(cli, "resolve_task_id", lambda s: f"{s}-full")
    monkeypatch.setattr(cli, "is_automation_context", lambda: False)

    args = _parse_args_for_update(monkeypatch, remove_task=["a", "c"])
    REAL_CMD_REPORT_UPDATE(args)

    assert calls["payload"]["task_ids"] == ["b-full"]


def _parse_args_for_update(monkeypatch, **overrides):
    """Build a real parsed-args object for `report update`, then override fields."""
    argv = ["report", "update", "abc12345"]
    args = _parse(argv, monkeypatch)
    for key, value in overrides.items():
        setattr(args, key, value)
    return args
