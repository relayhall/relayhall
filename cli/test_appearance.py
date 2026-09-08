"""Appearance CLI grammar and REST parity (RH-UI.4)."""
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
        "relayhall_cli_appearance",
        importlib.machinery.SourceFileLoader("relayhall_cli_appearance", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

cli = load_cli()

def run_main(argv):
    out, err = io.StringIO(), io.StringIO()
    old = sys.argv
    sys.argv = ["relayhall"] + argv
    code = None
    try:
        with redirect_stdout(out), redirect_stderr(err):
            try:
                cli.main()
            except SystemExit as exc:
                code = exc.code
    finally:
        sys.argv = old
    return out.getvalue(), err.getvalue(), code

@pytest.fixture
def recorder(monkeypatch):
    calls = []
    def fake(method, path, data=None, **_kwargs):
        calls.append((method, path, data))
        if path == "/appearance":
            appearance = {"effective": {"displayName": "Hall"}, "assets": {}}
            return {"success": True, "data": appearance if method == "GET" else {"appearance": appearance}}
        if path == "/appearance/versions":
            return {"success": True, "data": []}
        return {"success": True, "data": {"appearance": {}, "version": {"versionNo": 2}}}
    monkeypatch.setattr(cli, "api", fake)
    monkeypatch.setattr(cli, "confirm_prompt", lambda _message: True)
    return calls

def test_show_versions_revert_and_reset_routes(recorder):
    for argv in (["appearance", "show", "--json"], ["appearance", "versions"],
                 ["appearance", "revert", "3"], ["appearance", "reset"]):
        _out, _err, code = run_main(argv)
        assert code is None
    assert [(c[0], c[1]) for c in recorder] == [
        ("GET", "/appearance"),
        ("GET", "/appearance/versions"),
        ("POST", "/appearance/versions/3/revert"),
        ("POST", "/appearance/reset"),
    ]

def test_set_sends_the_complete_json_object(tmp_path, recorder):
    payload = {"displayName": "North Hall", "links": [], "defaultTheme": "relay-dark"}
    source = tmp_path / "appearance.json"
    source.write_text(json.dumps(payload), encoding="utf-8")
    _out, _err, code = run_main(["appearance", "set", "--file", str(source)])
    assert code is None
    assert recorder[-1] == ("PUT", "/appearance", payload)

def test_upload_uses_the_single_asset_field(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "multipart_upload", lambda path, field, file: calls.append((path, field, file)) or {"data": {}})
    source = tmp_path / "logo.png"
    source.write_bytes(b"png")
    _out, _err, code = run_main(["appearance", "upload", "logo", str(source), "--json"])
    assert code is None
    assert calls == [("/appearance/assets/logo", "asset", str(source))]

def test_asset_history_is_kind_bounded(recorder):
    _out, _err, code = run_main(["appearance", "asset-history", "favicon", "--json"])
    assert code is None
    assert recorder[-1][:2] == ("GET", "/appearance/asset-history/favicon")
    _out, _err, code = run_main(["appearance", "upload", "svg", "x"])
    assert code == 2
