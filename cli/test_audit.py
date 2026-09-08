"""Audit CLI coverage for RH-P2.7."""
import importlib.machinery
import importlib.util
import io
import json
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
EVENT_1 = "11111111-1111-4111-8111-111111111111"
EVENT_2 = "22222222-2222-4222-8222-222222222222"


def load_cli():
    loader = importlib.machinery.SourceFileLoader("relayhall_cli_audit", str(CLI_PATH))
    spec = importlib.util.spec_from_loader("relayhall_cli_audit", loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


def event(event_id, action):
    return {
        "id": event_id,
        "occurredAt": "2026-08-13T00:00:00.000Z",
        "action": action,
        "actorHandle": "owner",
        "resourceType": "grant",
        "resourceId": "resource-1",
        "metadata": {},
    }


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


def test_audit_list_passes_filters(monkeypatch):
    calls = []

    def fake(method, path, data=None, headers=None):
        calls.append((method, path, data))
        return 200, json.dumps({
            "success": True,
            "events": [event(EVENT_1, "grant.create")],
            "nextCursor": EVENT_1,
            "retention": "indefinite",
            "purgeAvailable": False,
        })

    monkeypatch.setattr(cli, "resource_api", fake)
    out, err, code = run_main([
        "audit", "list", "--action", "grant.create",
        "--resource-type", "grant", "--limit", "25",
    ])
    assert code in (None, 0), err
    assert calls[0][0] == "GET"
    assert calls[0][1] == "/audit?limit=25&action=grant.create&resourceType=grant"
    assert "retention indefinite; purge unavailable" in out
    assert EVENT_1 in out


def test_audit_export_pages_to_ndjson_atomically(monkeypatch, tmp_path):
    calls = []

    def fake(method, path, data=None, headers=None):
        calls.append(path)
        if "before=" not in path:
            return 200, json.dumps({"success": True, "events": [event(EVENT_1, "grant.create")], "nextCursor": EVENT_1})
        return 200, json.dumps({"success": True, "events": [event(EVENT_2, "grant.revoke")], "nextCursor": None})

    monkeypatch.setattr(cli, "resource_api", fake)
    output = tmp_path / "audit.ndjson"
    out, err, code = run_main(["audit", "export", "--output", str(output), "--limit", "1"])
    assert code in (None, 0), err
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert [row["id"] for row in rows] == [EVENT_1, EVENT_2]
    assert len(calls) == 2 and f"before={EVENT_1}" in calls[1]
    assert "Exported 2 audit events" in out
    assert not list(tmp_path.glob(".relayhall-audit-*"))


def test_audit_export_refuses_overwrite_without_force(monkeypatch, tmp_path):
    output = tmp_path / "audit.ndjson"
    output.write_text("keep\n", encoding="utf-8")
    calls = []
    monkeypatch.setattr(cli, "resource_api", lambda *args, **kwargs: calls.append(args))
    _out, err, code = run_main(["audit", "export", "--output", str(output)])
    assert code == 1
    assert "Refusing to overwrite" in err
    assert output.read_text(encoding="utf-8") == "keep\n"
    assert calls == []


@pytest.mark.parametrize("limit", ["0", "201"])
def test_audit_limit_is_bounded_by_argparse(monkeypatch, limit):
    calls = []
    monkeypatch.setattr(cli, "resource_api", lambda *args, **kwargs: calls.append(args))
    _out, _err, code = run_main(["audit", "list", "--limit", limit])
    assert code == 2
    assert calls == []
