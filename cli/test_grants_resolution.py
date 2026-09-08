"""`relayhall principal grants` identifier resolution (review 6988bb66 F1).

The command advertises "Principal id, prefix or handle"; the REST contract
accepts only a canonical UUID. These probes drive the real handler for all
three advertised forms and assert the outgoing path is always the resolved
UUID — the exact contract the round-1 review found broken. A full UUID takes
the fast path and costs no extra lookup call.
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
PRINCIPAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
HANDLE = "reports_reader"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_grant_resolution",
        importlib.machinery.SourceFileLoader("relayhall_cli_grant_resolution", str(CLI_PATH)),
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
def wired(monkeypatch):
    """Records the directory lookups and the final grants path."""
    state = {"api_calls": [], "rest_calls": []}

    def fake_api(method, path, data=None, timeout=30, exit_on_error=True):
        state["api_calls"].append((method, path))
        if method == "GET" and path == "/principals":
            return {"success": True, "principals": [
                {"id": PRINCIPAL_ID, "handle": HANDLE},
                {"id": OTHER_ID, "handle": "service_account"},
            ]}
        raise AssertionError(f"unexpected api() call: {method} {path}")

    def fake_resource_api(method, path, data=None, headers=None):
        state["rest_calls"].append((method, path))
        return 200, json.dumps({"success": True, "grants": [
            {"resourceType": "report", "resourceId": None, "verb": "read"},
        ]})

    monkeypatch.setattr(cli, "api", fake_api)
    monkeypatch.setattr(cli, "resource_api", fake_resource_api)
    return state


def test_full_uuid_takes_the_fast_path(wired):
    out, err, code = run_main(["principal", "grants", PRINCIPAL_ID])
    assert code in (None, 0), err
    assert wired["rest_calls"] == [("GET", f"/principals/{PRINCIPAL_ID}/grants")]
    assert wired["api_calls"] == []  # no directory lookup needed


def test_handle_resolves_to_the_uuid(wired):
    out, err, code = run_main(["principal", "grants", HANDLE])
    assert code in (None, 0), err
    assert wired["rest_calls"] == [("GET", f"/principals/{PRINCIPAL_ID}/grants")]
    assert ("GET", "/principals") in wired["api_calls"]


def test_id_prefix_resolves_to_the_uuid(wired):
    out, err, code = run_main(["principal", "grants", PRINCIPAL_ID[:8]])
    assert code in (None, 0), err
    assert wired["rest_calls"] == [("GET", f"/principals/{PRINCIPAL_ID}/grants")]


def test_unknown_identifier_fails_closed_before_any_rest_call(wired):
    out, err, code = run_main(["principal", "grants", "no-such-principal"])
    assert code == 1
    assert "No principal matching" in err
    assert wired["rest_calls"] == []
