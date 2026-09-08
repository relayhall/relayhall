"""Connector-first execution-profile CLI flags (RH-P2.2; review 66c78a1d F2).

Pins the typed-value contract: `key=value` preserves the EXACT string —
including "true", "false", "001" and "1.5", which a Connector may declare as
string values — while `key:=json` supplies typed booleans/numbers. Covers
create and update, --parameter paths, --clear-profile, and the flags-without-
--service usage error. Runs offline against recording fakes.
"""
import importlib.machinery
import importlib.util
import io
import json
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_profile_flags",
        importlib.machinery.SourceFileLoader("relayhall_cli_profile_flags", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()

TASK_ID = "12345678-1234-4321-8765-123456789012"


def run_main(argv):
    out, err = io.StringIO(), io.StringIO()
    code = None
    old_argv = sys.argv
    sys.argv = ["relayhall"] + argv
    try:
        with redirect_stdout(out), redirect_stderr(err):
            try:
                cli.main()
            except SystemExit as exc:
                code = exc.code
    finally:
        sys.argv = old_argv
    return out.getvalue(), err.getvalue(), code


@pytest.fixture
def api_calls(monkeypatch):
    calls = []

    def fake_api(method, path, data=None, timeout=30, exit_on_error=True):
        calls.append((method, path, data))
        if method == "GET" and path.startswith("/personalities"):
            return {"success": True, "personalities": []}
        if method == "GET" and path.startswith("/tasks/"):
            return {"success": True, "task": {"id": TASK_ID, "title": "t", "status": "todo"}}
        return {"success": True, "task": {"id": TASK_ID, "title": "t", "status": "ideas", "subtasks": []}}

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resolve_task_id", lambda _id: TASK_ID)
    monkeypatch.setattr(cli, "_fetch_personalities", lambda: [])
    return calls


def created_profile(calls):
    for method, path, data in calls:
        if method == "POST" and path == "/tasks":
            return (data or {}).get("executionProfile")
    for method, path, data in calls:
        if method in ("PATCH", "PUT") and path.startswith("/tasks/"):
            return (data or {}).get("executionProfile", "ABSENT")
    return None


def test_create_equals_preserves_exact_strings(api_calls):
    out, err, code = run_main([
        "create", "t", "--no-subtasks", "--service", "my-runner",
        "--option", "flag=true", "--option", "zeroes=001", "--option", "rate=1.5",
    ])
    assert code in (None, 0), err
    profile = created_profile(api_calls)
    assert profile["options"] == {"flag": "true", "zeroes": "001", "rate": "1.5"}
    for value in profile["options"].values():
        assert isinstance(value, str)


def test_create_typed_json_syntax_supplies_booleans_and_numbers(api_calls):
    out, err, code = run_main([
        "create", "t", "--no-subtasks", "--service", "my-runner",
        "--option", "flag:=true", "--option", "off:=false", "--option", "rate:=1.5", "--option", "count:=2",
    ])
    assert code in (None, 0), err
    profile = created_profile(api_calls)
    assert profile["options"] == {"flag": True, "off": False, "rate": 1.5, "count": 2}


def test_parameter_paths_support_both_syntaxes(api_calls):
    out, err, code = run_main([
        "create", "t", "--no-subtasks", "--service", "my-runner",
        "--option", "template=patch-fleet",
        "--parameter", "template.limit=001",
        "--parameter", "template.dryRun:=true",
    ])
    assert code in (None, 0), err
    profile = created_profile(api_calls)
    assert profile["parameters"] == {"template": {"limit": "001", "dryRun": True}}


def test_update_uses_same_contract(api_calls):
    out, err, code = run_main([
        "update", TASK_ID, "--service", "my-runner",
        "--option", "flag=false", "--option", "count:=3",
    ])
    assert code in (None, 0), err
    profile = created_profile(api_calls)
    assert profile["options"] == {"flag": "false", "count": 3}


def test_update_clear_profile_sends_null(api_calls):
    out, err, code = run_main(["update", TASK_ID, "--clear-profile"])
    assert code in (None, 0), err
    for method, path, data in api_calls:
        if method in ("PATCH", "PUT") and path.startswith("/tasks/"):
            assert "executionProfile" in data and data["executionProfile"] is None
            return
    raise AssertionError("no task update call recorded")


def test_malformed_typed_value_fails_closed(api_calls):
    out, err, code = run_main([
        "create", "t", "--no-subtasks", "--service", "my-runner", "--option", "flag:=notjson",
    ])
    assert code == 2
    assert "JSON literal" in err


def test_profile_flags_without_service_fail_closed(api_calls):
    out, err, code = run_main(["create", "t", "--no-subtasks", "--option", "a=b"])
    assert code == 2
    assert "--service" in err
