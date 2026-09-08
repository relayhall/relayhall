"""Phase CLI coverage (RH-P2.4).

Pins the `relayhall phase <verb>` grammar, the bare-plural alias, the task-side
--phase/--clear-phase contract, the /phases REST wiring, and documentation
parity: every canonical command in docs/phases.md must parse AND perform its
advertised operation. Runs offline against a recording fake.
"""
import importlib.machinery
import importlib.util
import io
import json
import shlex
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PHASE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
REVISION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_phases",
        importlib.machinery.SourceFileLoader("relayhall_cli_phases", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


def sample_phase(**kw):
    phase = {
        "id": PHASE_ID, "projectId": PROJECT_ID, "name": "Substrate",
        "goal": "Get the substrate into target shape", "status": "todo",
        "position": 0, "revision": REVISION,
        "createdAt": "now", "updatedAt": "now",
    }
    phase.update(kw)
    return phase


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


def phase_rest_fake(calls):
    def fake_resource_api(method, path, data=None, headers=None):
        calls.append((method, path, data))
        base = path.split("?")[0]
        if method == "GET" and base == "/phases":
            return 200, json.dumps({"success": True, "phases": [sample_phase()]})
        if method == "GET" and base.endswith("/tasks"):
            return 200, json.dumps({"success": True, "tasks": [
                {"id": TASK_ID, "title": "Wire the predicate", "status": "todo"},
            ]})
        if method == "GET" and base.startswith("/phases/"):
            return 200, json.dumps({"success": True, "phase": sample_phase()})
        if method == "POST" and base.endswith("/brief"):
            return 200, json.dumps({"success": True, "brief": "## Phase brief", "tokenEstimate": 4})
        if method == "POST" and base == "/phases":
            return 201, json.dumps({"success": True, "phase": sample_phase(name=(data or {}).get("name"))})
        if method == "POST":
            return 200, json.dumps({"success": True, "phase": sample_phase()})
        if method == "PATCH":
            return 200, json.dumps({"success": True, "phase": sample_phase()})
        if method == "DELETE":
            return 200, json.dumps({"success": True, "phase": sample_phase()})
        raise AssertionError(f"unexpected resource_api call: {method} {path}")
    return fake_resource_api


@pytest.fixture
def rest(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "resource_api", phase_rest_fake(calls))
    monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)
    return calls


def test_phase_list(rest):
    out, err, code = run_main(["phase", "list"])
    assert code in (None, 0), err
    assert rest[0][:2] == ("GET", "/phases")


def test_phase_list_filters(rest):
    out, err, code = run_main(["phase", "list", "--project", "relayhall", "--status", "in-progress"])
    assert code in (None, 0), err
    assert rest[0][1] == f"/phases?projectId={PROJECT_ID}&status=in-progress"


def test_phase_list_include_archived(rest):
    out, err, code = run_main(["phase", "list", "--include-archived"])
    assert code in (None, 0), err
    assert "includeArchived=true" in rest[0][1]


def test_bare_plural_is_the_list_alias(rest):
    out, err, code = run_main(["phases"])
    assert code in (None, 0), err
    assert rest[0][:2] == ("GET", "/phases")


def test_phase_create_sends_project_and_goal(rest):
    out, err, code = run_main([
        "phase", "create", "Substrate", "--project", "relayhall", "--goal", "One predicate",
    ])
    assert code in (None, 0), err
    method, path, data = rest[0]
    assert (method, path) == ("POST", "/phases")
    assert data == {"projectId": PROJECT_ID, "name": "Substrate", "goal": "One predicate"}


def test_phase_get_also_lists_members(rest):
    out, err, code = run_main(["phase", "get", PHASE_ID])
    assert code in (None, 0), err
    assert ("GET", f"/phases/{PHASE_ID}", None) in rest
    assert ("GET", f"/phases/{PHASE_ID}/tasks", None) in rest


def test_phase_update_reads_the_revision_when_not_supplied(rest):
    out, err, code = run_main(["phase", "update", PHASE_ID, "--status", "in-progress"])
    assert code in (None, 0), err
    patch = [c for c in rest if c[0] == "PATCH"][0]
    assert patch[2]["revision"] == REVISION
    assert patch[2]["status"] == "in-progress"


def test_phase_update_honours_an_explicit_revision(rest):
    out, err, code = run_main(["phase", "update", PHASE_ID, "--name", "Renamed", "--revision", "stale-rev"])
    assert code in (None, 0), err
    patch = [c for c in rest if c[0] == "PATCH"][0]
    assert patch[2]["revision"] == "stale-rev"
    # A supplied revision must not trigger a read that would overwrite it.
    assert not [c for c in rest if c[0] == "GET"]


def test_phase_clear_goal_sends_null_not_empty_string(rest):
    out, err, code = run_main(["phase", "update", PHASE_ID, "--clear-goal"])
    assert code in (None, 0), err
    patch = [c for c in rest if c[0] == "PATCH"][0]
    assert patch[2]["goal"] is None


def test_phase_archive_and_unarchive_carry_the_revision(rest):
    for verb in ("archive", "unarchive"):
        rest.clear()
        out, err, code = run_main(["phase", verb, PHASE_ID])
        assert code in (None, 0), err
        post = [c for c in rest if c[0] == "POST"][0]
        assert post[1] == f"/phases/{PHASE_ID}/{verb}"
        assert post[2]["revision"] == REVISION


def test_phase_delete(rest):
    out, err, code = run_main(["phase", "delete", PHASE_ID])
    assert code in (None, 0), err
    assert rest[0][:2] == ("DELETE", f"/phases/{PHASE_ID}")


def test_phase_brief_prints_the_brief(rest):
    out, err, code = run_main(["phase", "brief", PHASE_ID])
    assert code in (None, 0), err
    assert rest[0][:2] == ("POST", f"/phases/{PHASE_ID}/brief")
    assert "Phase brief" in out


def test_archived_is_not_a_settable_status(rest):
    out, err, code = run_main(["phase", "update", PHASE_ID, "--status", "archived"])
    assert code == 2  # argparse choices rejection: archiving has its own verb
    assert rest == []


# ─── task-side membership ───

@pytest.fixture
def task_rest(monkeypatch):
    calls = []

    def fake_api(method, path, data=None, **kwargs):
        calls.append((method, path, data))
        if method == "POST":
            return {"success": True, "task": {"id": TASK_ID, "title": "T", "subtasks": []}}
        if method == "PATCH":
            return {"success": True, "task": {"id": TASK_ID, "title": "T", "subtasks": []}}
        if method == "GET":
            return {"success": True, "tasks": []}
        raise AssertionError(f"unexpected api call: {method} {path}")

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resolve_project", lambda value: "relayhall")
    monkeypatch.setattr(cli, "resolve_task_id", lambda value: TASK_ID)
    # `create` asks for confirmation when a task has no subtasks; that prompt
    # is not what these tests are about.
    monkeypatch.setattr(cli, "confirm_prompt", lambda message: True)
    return calls


def test_task_create_sends_phase_id(task_rest):
    out, err, code = run_main(["create", "Wire the predicate", "--project", "relayhall", "--phase", PHASE_ID])
    assert code in (None, 0), err
    post = [c for c in task_rest if c[0] == "POST"][0]
    assert post[2]["phaseId"] == PHASE_ID


def test_task_update_clear_phase_sends_null(task_rest):
    out, err, code = run_main(["update", TASK_ID, "--clear-phase"])
    assert code in (None, 0), err
    patch = [c for c in task_rest if c[0] == "PATCH"][0]
    assert patch[2]["phaseId"] is None


def test_task_list_filters_by_phase(task_rest):
    out, err, code = run_main(["list", "--phase", PHASE_ID])
    assert code in (None, 0), err
    assert f"phaseId={PHASE_ID}" in task_rest[0][1]


def test_task_list_backlog_view(task_rest):
    out, err, code = run_main(["list", "--phase", "null"])
    assert code in (None, 0), err
    assert "phaseId=null" in task_rest[0][1]


# ─── create-multiphase uses the Phase object ───

def test_create_multiphase_creates_real_phases_and_bound_tasks(monkeypatch):
    calls = []
    phase_ids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    ]
    task_ids = [
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
    ]

    def fake_api(method, path, data=None, **kwargs):
        calls.append((method, path, data))
        if (method, path) == ("POST", "/phases"):
            index = len([call for call in calls if call[:2] == ("POST", "/phases")]) - 1
            return {"success": True, "phase": {"id": phase_ids[index], "name": data["name"]}}
        if (method, path) == ("POST", "/tasks"):
            index = len([call for call in calls if call[:2] == ("POST", "/tasks")]) - 1
            return {"success": True, "task": {"id": task_ids[index], "title": data["title"]}}
        raise AssertionError(f"unexpected API call: {method} {path}")

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resolve_project", lambda value: "RelayHall")
    monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)

    out, err, code = run_main([
        "create-multiphase", "Release", "--project", "relayhall", "--tag", "release",
        "--phases", "Build;Verify;Publish",
    ])
    assert code in (None, 0), err

    phase_calls = [call for call in calls if call[:2] == ("POST", "/phases")]
    task_calls = [call for call in calls if call[:2] == ("POST", "/tasks")]
    assert [call[2] for call in phase_calls] == [
        {"projectId": PROJECT_ID, "name": "Build", "position": 0},
        {"projectId": PROJECT_ID, "name": "Verify", "position": 1},
        {"projectId": PROJECT_ID, "name": "Publish", "position": 2},
    ]
    assert len(task_calls) == len(phase_calls) == 3  # no master Task
    for index, (_, _, data) in enumerate(task_calls):
        assert data["phaseId"] == phase_ids[index]
        assert data["tags"] == ["release"]
        assert not any(tag.startswith("phase-") for tag in data["tags"])
        assert data["autoStart"] is (index == 0)
        if index == 0:
            # TaskManagerDB.getAutoStartQueue selects only status=todo. This
            # assertion binds the CLI payload to that real scheduler contract;
            # autoStart=true on an ideas Task is inert.
            assert data["status"] == "todo"
            assert "dependsOn" not in data
        else:
            assert data["status"] == "ideas"
            assert data["dependsOn"] == [task_ids[index - 1]]
    assert not [call for call in calls if call[0] == "PATCH"]
    assert not hasattr(cli, "create_tracker_doc")
    assert "Phase sequence created" in out


def test_create_multiphase_rejects_a_single_phase_without_writes(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "api", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(cli, "resolve_project", lambda value: "RelayHall")
    monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)
    out, err, code = run_main([
        "create-multiphase", "Release", "--project", "relayhall", "--tag", "release",
        "--phases", "Build",
    ])
    assert code == 1
    assert calls == []
    assert "at least 2 phases" in err


# ─── docs/phases.md canonical commands run verbatim (parity) ───

DOCS_PHASES_MD = Path(__file__).parent.parent / "docs" / "phases.md"


def documented_phase_commands():
    commands = []
    fenced = False
    for raw in DOCS_PHASES_MD.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped.startswith("```"):
            fenced = not fenced
            continue
        if fenced and stripped.startswith("relayhall "):
            commands.append(stripped.split("#", 1)[0].strip())
    return commands


def materialise(tokens):
    subs = {
        "<phase-uuid>": PHASE_ID,
        "<task-id>": TASK_ID,
        "<project>": "relayhall",
        "<revision>": REVISION,
    }
    return [subs.get(t, t) for t in tokens]


def test_documented_phase_commands_run_verbatim(monkeypatch):
    commands = documented_phase_commands()
    assert commands, "docs/phases.md lost its canonical command blocks"
    for line in commands:
        calls = []
        monkeypatch.setattr(cli, "resource_api", phase_rest_fake(calls))
        monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)
        monkeypatch.setattr(cli, "resolve_project", lambda value: "relayhall")
        monkeypatch.setattr(cli, "resolve_task_id", lambda value: TASK_ID)
        monkeypatch.setattr(cli, "confirm_prompt", lambda message: True)
        monkeypatch.setattr(cli, "api", lambda method, path, data=None, **kw: (
            calls.append((method, path, data))
            or {"success": True, "task": {"id": TASK_ID, "title": "T", "subtasks": []},
                "phase": sample_phase(),
                "tasks": [], "project": {"id": PROJECT_ID, "name": "relayhall"}}
        ))
        tokens = materialise(shlex.split(line))
        assert tokens[0] == "relayhall", f"unexpected doc line: {line!r}"
        out, err, code = run_main(tokens[1:])
        assert code in (None, 0), f"documented command does not run verbatim: {line!r} -> exit {code}, {err.strip()}"
        assert calls, f"documented command performed no REST call: {line!r}"
