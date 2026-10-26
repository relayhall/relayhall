"""Owner intent is distinct from Verifier approval and never retries a refusal."""
import importlib.machinery
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest

spec = importlib.util.spec_from_loader("relayhall_owner_cli", importlib.machinery.SourceFileLoader("relayhall_owner_cli", str(Path(__file__).parent / "relayhall")))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
TASK = "cccccccc-0000-4000-8000-000000000003"

@pytest.fixture
def calls(monkeypatch):
    records = []
    monkeypatch.setattr(cli, "api", lambda method, path, data=None, **kw: records.append((method, path, data)) or {})
    monkeypatch.setattr(cli, "format_task", lambda *a, **kw: "task")
    return records

def test_owner_completion_selects_stable_id_and_retains_evidence(calls, monkeypatch):
    monkeypatch.setattr(cli, "is_agent_context", lambda: True)
    cli.cmd_owner_complete_subtask(SimpleNamespace(task_id=TASK, subtask_id="708", note="Independent report PASS"))
    assert calls == [("PATCH", f"/tasks/{TASK}/subtasks/by-id/708/status", {"status": "completed", "completionMode": "owner", "reviewNote": "Independent report PASS"})]

@pytest.mark.parametrize("value", ["-1", "1/approve", "1.2", "2147483648", "１２", ""])
def test_invalid_stable_id_never_calls_server(calls, value):
    with pytest.raises(SystemExit):
        cli.cmd_owner_complete_subtask(SimpleNamespace(task_id=TASK, subtask_id=value, note=None))
    assert calls == []

def test_owner_refusal_is_not_retried_as_verifier_or_move(monkeypatch):
    calls = []
    def denied(*args, **kwargs):
        calls.append(args)
        raise SystemExit(1)
    monkeypatch.setattr(cli, "api", denied)
    with pytest.raises(SystemExit):
        cli.cmd_owner_complete_subtask(SimpleNamespace(task_id=TASK, subtask_id="708", note=None))
    assert len(calls) == 1
    assert calls[0][1].endswith("/by-id/708/status")

def test_existing_verifier_approval_stays_distinct(calls, monkeypatch):
    monkeypatch.setattr(cli, "is_agent_context", lambda: False)
    cli.cmd_approve_subtask(SimpleNamespace(task_id=TASK, index="2"))
    assert calls == [("POST", f"/tasks/{TASK}/subtasks/2/approve", None)]

def test_task_restore_uses_dedicated_provenance_endpoint(calls):
    cli.cmd_unarchive(SimpleNamespace(id=TASK))
    assert calls == [("POST", f"/tasks/{TASK}/unarchive", {})]

@pytest.mark.parametrize("command,tail,expected", [("owner-complete-subtask", ["708", "--note", "checked"], "/subtasks/by-id/708/status"), ("unarchive", [], "/unarchive")])
def test_commands_are_wired_through_main(calls, monkeypatch, command, tail, expected):
    monkeypatch.setattr(cli.sys, "argv", ["relayhall", command, TASK, *tail])
    cli.main()
    assert calls[-1][1] == f"/tasks/{TASK}" + expected


def test_account_owner_change_preserves_exact_revision_and_null_owner(calls, monkeypatch):
    monkeypatch.setattr(cli.sys, "argv", ["relayhall", "task-account-owner", "change", TASK,
        "--account", "dddddddd-0000-4000-8000-000000000004", "--expected-owner", "none",
        "--expected-updated-at", "2026-10-08 03:00:00.123456+00", "--reason", "Confirmed owner correction"])
    cli.main()
    assert calls == [("PUT", f"/tasks/{TASK}/account-owner", {
        "accountOwnerPrincipalId": "dddddddd-0000-4000-8000-000000000004",
        "expectedAccountOwnerPrincipalId": None,
        "expectedUpdatedAt": "2026-10-08 03:00:00.123456+00", "reason": "Confirmed owner correction"})]


def test_account_owner_read_uses_supported_route(calls, monkeypatch):
    monkeypatch.setattr(cli.sys, "argv", ["relayhall", "task-account-owner", "get", TASK])
    cli.main()
    assert calls == [("GET", f"/tasks/{TASK}/account-owner", None)]


def test_account_owner_missing_conditions_never_writes(calls, monkeypatch):
    monkeypatch.setattr(cli.sys, "argv", ["relayhall", "task-account-owner", "change", TASK,
        "--account", "dddddddd-0000-4000-8000-000000000004", "--reason", "Confirmed correction"])
    with pytest.raises(ValueError):
        cli.main()
    assert calls == []


def test_completed_creation_reaches_server_without_verifier_impersonation(calls, monkeypatch):
    monkeypatch.setattr(cli, "_fetch_personalities", lambda: [])
    monkeypatch.setattr(cli, "get_dashboard_url", lambda: None)
    monkeypatch.setattr(cli.sys, "argv", ["relayhall", "create", "Recorded completed work", "--status", "completed", "--no-subtasks"])
    cli.main()
    writes = [c for c in calls if c[0] == "POST"]
    assert len(writes) == 1
    assert writes[0][1] == "/tasks"
    assert writes[0][2]["status"] == "completed"
    assert writes[0][2]["autoStart"] is False
    assert "role" not in writes[0][2]
