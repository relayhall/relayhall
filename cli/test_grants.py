"""Grant CLI coverage (RH-P2.3).

Pins the `relayhall grant <verb>` and `relayhall principal grants` grammar,
the /grants REST wiring, and documentation/argparse parity: every canonical
command in docs/grants.md must parse AND perform its advertised operation.
Runs offline against a recording fake.
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
PRINCIPAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
RESOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
GRANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_grants",
        importlib.machinery.SourceFileLoader("relayhall_cli_grants", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


def sample_grant(**kw):
    grant = {
        "id": GRANT_ID, "granteeType": "principal", "granteeId": PRINCIPAL,
        "resourceType": "report", "resourceId": None, "verb": "read",
        "grantedByPrincipalId": "owner", "expiresAt": None, "createdAt": "now",
    }
    grant.update(kw)
    return grant


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


def grant_rest_fake(calls):
    def fake_resource_api(method, path, data=None, headers=None):
        calls.append((method, path, data))
        if method == "GET" and "/principals/" in path:
            return 200, json.dumps({"success": True, "grants": [sample_grant()]})
        if method == "GET" and path.split("?")[0] == "/grants":
            return 200, json.dumps({"success": True, "grants": [sample_grant()]})
        if method == "POST":
            return 201, json.dumps({"success": True, "grant": sample_grant(resourceId=data.get("resourceId"))})
        if method == "DELETE":
            return 200, json.dumps({"success": True, "grant": sample_grant()})
        raise AssertionError(f"unexpected resource_api call: {method} {path}")
    return fake_resource_api


@pytest.fixture
def rest(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "resource_api", grant_rest_fake(calls))
    return calls


def test_grant_list(rest):
    out, err, code = run_main(["grant", "list"])
    assert code in (None, 0), err
    assert ("GET", "/grants", None) in rest


def test_grant_list_filters(rest):
    out, err, code = run_main(["grant", "list", "--grantee", PRINCIPAL, "--resource-type", "task"])
    assert code in (None, 0), err
    assert rest[0][1] == f"/grants?granteeId={PRINCIPAL}&resourceType=task"


def test_grant_add_wildcard(rest):
    out, err, code = run_main(["grant", "add", PRINCIPAL, "report", "read"])
    assert code in (None, 0), err
    method, path, data = rest[0]
    assert (method, path) == ("POST", "/grants")
    assert data == {"granteeId": PRINCIPAL, "resourceType": "report", "verb": "read"}
    assert "resourceId" not in data  # omitted = wildcard


def test_grant_add_specific_with_expiry(rest):
    out, err, code = run_main([
        "grant", "add", PRINCIPAL, "task", "write", "--resource", RESOURCE, "--expires-at", "2030-01-01T00:00:00Z",
    ])
    assert code in (None, 0), err
    data = rest[0][2]
    assert data["resourceId"] == RESOURCE
    assert data["expiresAt"] == "2030-01-01T00:00:00Z"


def test_grant_remove(rest):
    out, err, code = run_main(["grant", "remove", GRANT_ID])
    assert code in (None, 0), err
    assert rest[0][0] == "DELETE" and rest[0][1] == f"/grants/{GRANT_ID}"


def test_principal_grants(rest):
    out, err, code = run_main(["principal", "grants", PRINCIPAL])
    assert code in (None, 0), err
    assert ("GET", f"/principals/{PRINCIPAL}/grants", None) in rest


def test_invalid_resource_type_rejected_by_argparse(rest):
    out, err, code = run_main(["grant", "add", PRINCIPAL, "session", "read"])
    assert code == 2  # argparse choices rejection
    assert rest == []


# ─── docs/grants.md canonical commands run verbatim (parity) ───

DOCS_GRANTS_MD = Path(__file__).parent.parent / "docs" / "grants.md"


def documented_grant_commands():
    commands = []
    fenced = False
    for raw in DOCS_GRANTS_MD.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped.startswith("```"):
            fenced = not fenced
            continue
        if fenced and (stripped.startswith("relayhall grant") or stripped.startswith("relayhall principal grants")):
            commands.append(stripped.split("#", 1)[0].strip())
    return commands


def materialise(tokens):
    subs = {
        "<principal-uuid>": PRINCIPAL, "<principal>": PRINCIPAL,
        "<task-uuid>": RESOURCE, "<grant-uuid>": GRANT_ID,
        "<iso>": "2030-01-01T00:00:00Z",
    }
    return [subs.get(t, t) for t in tokens]


def test_documented_grant_commands_run_verbatim(monkeypatch):
    commands = documented_grant_commands()
    assert commands, "docs/grants.md lost its canonical grant command block"
    for line in commands:
        calls = []
        monkeypatch.setattr(cli, "resource_api", grant_rest_fake(calls))
        tokens = materialise(shlex.split(line))
        assert tokens[0] == "relayhall", f"unexpected doc line: {line!r}"
        out, err, code = run_main(tokens[1:])
        assert code in (None, 0), f"documented command does not run verbatim: {line!r} -> exit {code}, {err.strip()}"
        assert calls, f"documented command performed no REST call: {line!r}"
