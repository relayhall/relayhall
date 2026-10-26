"""Default Verifier CLI coverage (card 41e24358; design ba22fd01 Part 8).

Pins `relayhall project set-default-verifier`, `relayhall phase
set-default-verifier`, `relayhall tasks --without-usable-verifier` (the
morning census) and `relayhall create --verifier`, against a recording fake:
the dedicated PUT routes with If-Match (never the generic PATCH), the census
filter on GET /tasks with the failed arm printed per card, and the explicit
Verifier carried on POST /tasks.
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
PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PHASE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
PRINCIPAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
REVISION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
TASK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_default_verifier",
        importlib.machinery.SourceFileLoader("relayhall_cli_default_verifier", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


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
def rest(monkeypatch):
    calls = []

    def fake_resource_api(method, path, data=None, headers=None):
        calls.append((method, path, data, headers))
        if method == "GET" and path == f"/projects/{PROJECT_ID}":
            return 200, json.dumps({"success": True, "project": {"id": PROJECT_ID, "revision": REVISION}})
        if method == "GET" and path == f"/phases/{PHASE_ID}":
            return 200, json.dumps({"success": True, "phase": {"id": PHASE_ID, "revision": REVISION}})
        if method == "PUT" and path.endswith("/default-verifier"):
            if (data or {}).get("principalId") == "refuse":
                return 403, json.dumps({"success": False, "code": "SESSION_ONLY", "error": "login-session act"})
            noun = "project" if path.startswith("/projects/") else "phase"
            return 200, json.dumps({"success": True, noun: {
                "id": PROJECT_ID if noun == "project" else PHASE_ID,
                "defaultVerifierPrincipalId": (data or {}).get("principalId"), "revision": "rev-2"}})
        raise AssertionError(f"unexpected resource_api call: {method} {path}")

    monkeypatch.setattr(cli, "resource_api", fake_resource_api)
    monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)
    monkeypatch.setattr(cli, "_resolve_principal_id", lambda value: PRINCIPAL_ID)
    return calls


def test_project_set_default_verifier_puts_with_the_read_revision(rest):
    out, err, code = run_main(["project", "set-default-verifier", "relayhall", "ada"])
    assert code == 0, err
    assert rest[0][:2] == ("GET", f"/projects/{PROJECT_ID}")
    method, path, data, headers = rest[1]
    assert (method, path, data) == ("PUT", f"/projects/{PROJECT_ID}/default-verifier", {"principalId": PRINCIPAL_ID})
    assert headers == {"If-Match": REVISION}
    assert "existing cards are unchanged" in out


def test_project_clear_with_none_or_flag(rest):
    for argv in (["project", "set-default-verifier", PROJECT_ID, "none", "--revision", REVISION],
                 ["project", "set-default-verifier", PROJECT_ID, "--clear", "--revision", REVISION]):
        rest.clear()
        out, err, code = run_main(argv)
        assert code == 0, err
        assert rest == [("PUT", f"/projects/{PROJECT_ID}/default-verifier", {"principalId": None}, {"If-Match": REVISION})]


def test_phase_set_default_verifier_uses_the_phase_route(rest):
    out, err, code = run_main(["phase", "set-default-verifier", PHASE_ID, PRINCIPAL_ID])
    assert code == 0, err
    assert rest[0][:2] == ("GET", f"/phases/{PHASE_ID}")
    assert rest[1][:3] == ("PUT", f"/phases/{PHASE_ID}/default-verifier", {"principalId": PRINCIPAL_ID})


def test_a_refusal_is_printed_with_its_code_and_a_stable_exit(rest):
    # A bearer credential is refused by the server; the CLI prints the code and exits 3.
    err = io.StringIO()
    with redirect_stdout(io.StringIO()), redirect_stderr(err):
        with pytest.raises(SystemExit) as exited:
            cli._set_default_verifier("phases", PHASE_ID, REVISION, "refuse", False)
    assert exited.value.code == 3
    assert "SESSION_ONLY" in err.getvalue()


def test_principal_and_clear_together_is_a_usage_error(rest):
    out, err, code = run_main(["project", "set-default-verifier", PROJECT_ID, PRINCIPAL_ID, "--clear",
                               "--revision", REVISION])
    assert code == 2
    assert rest == []


def test_the_census_filters_server_side_and_prints_the_failed_arm(monkeypatch):
    seen = []

    def fake_api(method, path, data=None, **kwargs):
        seen.append((method, path))
        return {"success": True, "tasks": [
            {"id": TASK_ID, "title": "Stranded", "status": "review", "priority": "normal",
             "verifierUsability": {"usable": False, "failedArm": "chain", "principalId": PRINCIPAL_ID}},
        ]}

    monkeypatch.setattr(cli, "api", fake_api)
    out, err, code = run_main(["tasks", "--without-usable-verifier", "--status", "todo,review"])
    assert code in (None, 0), err
    assert seen == [("GET", "/tasks?statuses=todo%2Creview&verifierUnusable=true")]
    assert "Verifier disabled or without a live credential [chain]" in out


def test_create_carries_an_explicit_verifier(monkeypatch):
    sent = []

    def fake_api(method, path, data=None, **kwargs):
        sent.append((method, path, data))
        if method == "POST" and path == "/tasks":
            return {"success": True, "task": {"id": TASK_ID, "title": data.get("title"), "status": "todo"}}
        return {"success": True, "tasks": [], "projects": [], "personalities": []}

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resolve_project", lambda value: value)
    out, err, code = run_main(["create", "Card", "--project", "relayhall", "--verifier", PRINCIPAL_ID, "--no-subtasks"])
    posts = [entry for entry in sent if entry[:2] == ("POST", "/tasks")]
    assert posts, (out, err, code)
    assert posts[0][2]["verifierPrincipalId"] == PRINCIPAL_ID
