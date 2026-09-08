"""Charter family CLI coverage (task f2735f1b, vocabulary A9).

Pins the `relayhall charter <verb>` grammar, the /projects/{id}/charter REST
wiring (If-Match plumbing included), and documentation/argparse parity: every
canonical command in docs/charter.md must parse AND perform its advertised
operation through the real handlers. Loads the extensionless `relayhall`
script the same way test_skills.py does and runs offline: api() and
resource_api() are replaced with recording fakes, never a live API.
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
PROJECT_ID = "11111111-2222-4333-8444-555555555555"
REVISION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_charter",
        importlib.machinery.SourceFileLoader("relayhall_cli_charter", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


def sample_charter(**kw):
    charter = {
        "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "projectId": PROJECT_ID,
        "content": "# Fixture Charter\n\nIndex, not copy.",
        "contentHash": "hash",
        "version": 2,
        "revision": REVISION,
        "updatedByPrincipalId": "owner",
        "createdAt": "2026-08-09T00:00:00Z",
        "updatedAt": "2026-08-09T00:00:00Z",
    }
    charter.update(kw)
    return charter


def run_main(argv):
    """Drive main() through argparse, capturing streams and the exit code."""
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
    """Records charter REST calls; api() serves only the project resolver."""
    calls = []

    def fake_api(method, path, data=None, timeout=30, exit_on_error=True):
        if method == "GET" and path.startswith("/projects?"):
            return {"success": True, "projects": [{"id": PROJECT_ID, "name": "proj", "status": "active"}]}
        raise AssertionError(f"unexpected api() call: {method} {path}")

    def fake_resource_api(method, path, data=None, headers=None):
        calls.append((method, path, data, headers or {}))
        if method == "GET" and path.endswith("/charter"):
            return 200, json.dumps({"success": True, "charter": sample_charter()})
        if method == "PUT" and path.endswith("/charter"):
            return 200, json.dumps({"success": True, "charter": sample_charter(version=3), "created": False, "changed": True})
        if method == "GET" and path.endswith("/charter/versions"):
            return 200, json.dumps({"success": True, "versions": [
                {"version": 2, "contentHash": "hash", "actorPrincipalId": "owner", "createdAt": "now"},
                {"version": 1, "contentHash": "old", "actorPrincipalId": "owner", "createdAt": "then"},
            ]})
        if method == "GET" and "/charter/versions/" in path:
            return 200, json.dumps({"success": True, "version": {"version": 1, "content": "# v1", "contentHash": "old", "actorPrincipalId": "owner", "createdAt": "then"}})
        raise AssertionError(f"unexpected resource_api() call: {method} {path}")

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resource_api", fake_resource_api)
    return calls


def test_charter_get_hits_head_route(rest):
    out, err, code = run_main(["charter", "get", "proj"])
    assert code in (None, 0), err
    assert ("GET", f"/projects/{PROJECT_ID}/charter", None, {}) in rest
    assert "version 2" in out
    assert "Fixture Charter" in out


def test_charter_get_content_only_prints_raw_content(rest):
    out, err, code = run_main(["charter", "get", "proj", "--content-only"])
    assert code in (None, 0), err
    assert out.strip() == "# Fixture Charter\n\nIndex, not copy."


def test_charter_set_inline_without_revision_creates(rest):
    out, err, code = run_main(["charter", "set", "proj", "--content", "# New charter"])
    assert code in (None, 0), err
    method, path, data, headers = rest[0]
    assert (method, path) == ("PUT", f"/projects/{PROJECT_ID}/charter")
    assert data == {"content": "# New charter"}
    assert "If-Match" not in headers


def test_charter_set_with_revision_sends_if_match(rest):
    out, err, code = run_main(["charter", "set", "proj", "--content", "# v3", "--revision", REVISION])
    assert code in (None, 0), err
    method, path, data, headers = rest[0]
    assert headers == {"If-Match": REVISION}


def test_charter_set_from_file(rest, tmp_path):
    f = tmp_path / "charter.md"
    f.write_text("# From file")
    out, err, code = run_main(["charter", "set", "proj", "--file", str(f)])
    assert code in (None, 0), err
    assert rest[0][2] == {"content": "# From file"}


def test_charter_set_without_content_or_file_fails_closed(rest):
    out, err, code = run_main(["charter", "set", "proj"])
    assert code == 1
    assert "--file or --content" in err
    assert rest == []


def test_charter_versions_lists_metadata(rest):
    out, err, code = run_main(["charter", "versions", "proj"])
    assert code in (None, 0), err
    assert ("GET", f"/projects/{PROJECT_ID}/charter/versions", None, {}) in rest
    assert "v2" in out and "v1" in out


def test_charter_show_version_hits_version_route(rest):
    out, err, code = run_main(["charter", "show-version", "proj", "1"])
    assert code in (None, 0), err
    assert ("GET", f"/projects/{PROJECT_ID}/charter/versions/1", None, {}) in rest
    assert "# v1" in out


def test_stale_revision_maps_to_conflict_exit_code(monkeypatch):
    def fake_api(method, path, data=None, timeout=30, exit_on_error=True):
        return {"success": True, "projects": [{"id": PROJECT_ID, "name": "proj", "status": "active"}]}

    def fake_resource_api(method, path, data=None, headers=None):
        return 412, json.dumps({"success": False, "error": "stale", "code": "REVISION_MISMATCH", "message": "stale"})

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resource_api", fake_resource_api)
    out, err, code = run_main(["charter", "set", "proj", "--content", "# x", "--revision", "stale"])
    assert code == 5
    assert "REVISION_MISMATCH" in err


# ─── docs/charter.md canonical commands run verbatim (parity, skills model) ───

DOCS_CHARTER_MD = Path(__file__).parent.parent / "docs" / "charter.md"


def documented_charter_commands():
    """Every `relayhall charter…` line inside fenced blocks of docs/charter.md."""
    commands = []
    fenced = False
    for raw in DOCS_CHARTER_MD.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped.startswith("```"):
            fenced = not fenced
            continue
        if fenced and stripped.startswith("relayhall charter"):
            commands.append(stripped.split("#", 1)[0].strip())
    return commands


def materialise(tokens, tmp_path):
    """Substitute doc placeholders with concrete values so argparse can parse."""
    charter_file = tmp_path / "charter-doc.md"
    charter_file.write_text("# Doc charter")
    subs = {
        "<project>": "proj",
        "<file>": str(charter_file),
        "<revision>": REVISION,
        "<version>": "1",
    }
    return [subs.get(token, token) for token in tokens]


def test_documented_charter_commands_run_verbatim(monkeypatch, tmp_path):
    """Documentation/argparse parity: each canonical command in docs/charter.md
    must parse AND perform its advertised HTTP operation through the real
    handlers (the skills-family standard from review 70d9a309)."""
    commands = documented_charter_commands()
    assert commands, "docs/charter.md lost its canonical charter command block"
    documented_verbs = {shlex.split(c)[2] for c in commands if len(shlex.split(c)) > 2}
    for verb in ("get", "set", "versions", "show-version"):
        assert verb in documented_verbs, f"docs/charter.md no longer documents `charter {verb}`"

    for line in commands:
        calls = []

        def fake_api(method, path, data=None, timeout=30, exit_on_error=True):
            return {"success": True, "projects": [{"id": PROJECT_ID, "name": "proj", "status": "active"}]}

        def fake_resource_api(method, path, data=None, headers=None):
            calls.append((method, path))
            if method == "PUT":
                return 200, json.dumps({"success": True, "charter": sample_charter(), "created": False, "changed": True})
            if path.endswith("/versions"):
                return 200, json.dumps({"success": True, "versions": []})
            if "/versions/" in path:
                return 200, json.dumps({"success": True, "version": {"version": 1, "content": "# v1", "contentHash": "h", "actorPrincipalId": None, "createdAt": "now"}})
            return 200, json.dumps({"success": True, "charter": sample_charter()})

        monkeypatch.setattr(cli, "api", fake_api)
        monkeypatch.setattr(cli, "resource_api", fake_resource_api)
        tokens = materialise(shlex.split(line), tmp_path)
        assert tokens[0] == "relayhall", f"unexpected doc line: {line!r}"
        out, err, code = run_main(tokens[1:])
        assert code in (None, 0), (
            f"documented command does not run verbatim: {line!r} -> exit {code}, stderr: {err.strip()}"
        )
        assert calls, f"documented command performed no API operation: {line!r}"
        verb = tokens[2]
        if verb == "set":
            assert any(m == "PUT" for m, _ in calls), f"documented set form did not PUT: {line!r}"
        else:
            assert all(m == "GET" for m, _ in calls), f"documented read form issued a non-GET: {line!r}"
