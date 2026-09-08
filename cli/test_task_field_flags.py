"""The Task body fields the CLI can set on CREATE as well as on UPDATE.

Card 9c3a1aa4: `relayhall create` had no `--notes` at all, because the server
dropped the field, so the only way to put notes on a new Task was to create it
and then update it. The repair gives create the same fields update has — and
this file states that as a property of the two commands rather than as a list
of flags, so a field added to one and forgotten on the other fails here.

Runs offline against a recording fake: what is measured is the REQUEST BODY the
CLI builds, which is the whole of the CLI's part in the contract.
"""
import importlib.machinery
import importlib.util
import io
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_task_field_flags",
        importlib.machinery.SourceFileLoader("relayhall_cli_task_field_flags", str(CLI_PATH)),
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


def body_of(calls, method, path_prefix):
    for call_method, path, data in calls:
        if call_method == method and path.startswith(path_prefix):
            return data or {}
    return None


# The fields both commands must carry, and the flag each is spelled with.
# A field added to `update` and forgotten on `create` fails the parity test at
# the bottom, which is the shape card 9c3a1aa4 was.
SHARED_FIELDS = [
    ("notes", "--notes", "a note written at creation time", "a note written at creation time"),
    # Card 7d38a6e0: the deadline. Sent verbatim - the CLI does not parse or
    # normalize the instant, because the server is the one place that decides
    # what a valid instant is, and two parsers would eventually disagree.
    ("dueAt", "--due", "2026-12-24T09:00:00Z", "2026-12-24T09:00:00Z"),
]


@pytest.mark.parametrize("field,flag,given,sent", SHARED_FIELDS)
def test_create_sends_the_field(api_calls, field, flag, given, sent):
    out, err, code = run_main(["create", "t", "--no-subtasks", flag, given])
    assert code in (None, 0), err
    body = body_of(api_calls, "POST", "/tasks")
    assert body is not None, "create made no POST /tasks"
    assert body.get(field) == sent


@pytest.mark.parametrize("field,flag,given,sent", SHARED_FIELDS)
def test_update_sends_the_same_field_the_same_way(api_calls, field, flag, given, sent):
    out, err, code = run_main(["update", TASK_ID, flag, given])
    assert code in (None, 0), err
    body = body_of(api_calls, "PATCH", "/tasks/")
    assert body is not None, "update made no PATCH /tasks/:id"
    assert body.get(field) == sent


@pytest.mark.parametrize("field,flag,given,sent", SHARED_FIELDS)
def test_omitting_the_flag_sends_no_such_key(api_calls, field, flag, given, sent):
    # The non-vacuity control: a CLI that put the field in every body would
    # satisfy both tests above and would overwrite the column on every create.
    out, err, code = run_main(["create", "t", "--no-subtasks"])
    assert code in (None, 0), err
    body = body_of(api_calls, "POST", "/tasks")
    assert field not in body


@pytest.mark.parametrize("field,flag,given,sent", SHARED_FIELDS)
def test_both_commands_declare_the_flag(field, flag, given, sent):
    # The parity statement, read off the parsers themselves through the only
    # interface that always exposes them: `--help`. A flag that exists on one
    # command and not the other fails here even when no behavioural test
    # happens to exercise it — which is the exact shape card 9c3a1aa4 was.
    for command in ("create", "update"):
        out, err, code = run_main([command, "--help"])
        assert code in (None, 0), err
        assert flag in out, f"{command} does not declare {flag}"


def test_the_help_scan_is_not_vacuous():
    # The control for the parity test above: `--help` must actually print the
    # flags, or "the flag is in the help text" is satisfied by nothing at all.
    out, _err, _code = run_main(["create", "--help"])
    assert "--project" in out and "--tags" in out
    out, _err, _code = run_main(["update", "--help"])
    assert "--project" in out and "--tags" in out
    assert "--definitely-not-a-flag" not in out


def test_due_can_be_cleared_but_notes_are_not_cleared_by_omission(api_calls):
    """`--due ""` REMOVES a deadline; that is why the update path tests the
    flag's presence rather than its truthiness. The pairing matters: an
    omitted flag must still send nothing at all, or every update would wipe
    the field it did not mention."""
    out, err, code = run_main(["update", TASK_ID, "--due", ""])
    assert code in (None, 0), err
    body = body_of(api_calls, "PATCH", "/tasks/")
    assert body["dueAt"] is None

    api_calls.clear()
    out, err, code = run_main(["update", TASK_ID, "--priority", "high"])
    assert code in (None, 0), err
    body = body_of(api_calls, "PATCH", "/tasks/")
    assert "dueAt" not in body
    assert "notes" not in body
