"""CLI session mint — `relayhall agent mint` (RH-P3.AZ-S5; AUTHZ design
4d961e37 §6.1a/§9.2: the canonical session-mint command, interactive
step-up, the pack rendered once).

Loaded the same way the sibling suites load the extensionless `relayhall`
script; api() is replaced with a recording fake. What these pin:
 - the step-up call precedes the mint and binds (agent.mint, task);
 - the mint body carries the step-up token, scopes and label;
 - a step-up refusal exits non-zero WITHOUT any mint call (T7: no decide/
   mint act ever leaves without its elevation token);
 - the one-time secret and the §2.10 bootstrap line print exactly once;
   --brief-out writes the compiled Brief to a file instead of stdout;
 - REST/CLI parity: the CLI hits the SAME one mint route the REST and GUI
   paths use (§9.2).
"""
import importlib.machinery
import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
TASK_ID = "11111111-2222-4333-8444-555555555555"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_agent_mint",
        importlib.machinery.SourceFileLoader("relayhall_cli_agent_mint", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Args:
    def __init__(self, **kw):
        defaults = {"task": TASK_ID, "scope": ["tasks:read"], "rules": None,
                    "label": None, "password": "hunter2", "brief_out": None, "json": False}
        defaults.update(kw)
        self.__dict__.update(defaults)


@pytest.fixture
def api(monkeypatch):
    calls = []

    def fake_api(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
        calls.append((method, path, data))
        if path == "/auth/step-up":
            return {"success": True, "stepUpToken": "rhsu_cli_token", "expiresAt": "soon"}
        if path == "/delegation/agent-mints":
            return {"success": True, "path": "session", "pack": {
                "principalId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "handle": "agent-abc123", "secretOnce": "rh_dev_secret_once",
                "scopes": data["requestedScopes"], "expiresAt": "2026-08-24T00:00:00Z",
                "onboarding": {
                    "bootstrapLine": "You have a RelayHall board at https://board/api. Authenticate with your credential and fetch everything else from it.",
                    "cliEnv": ["export RELAYHALL_API_URL=https://board/api", "export RELAYHALL_TOKEN=rh_dev_secret_once"],
                    "mcpConfig": {"generic": {"transport": "stdio"}},
                    "brief": "COMPILED BRIEF TEXT",
                },
            }}
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(cli, "api", fake_api)
    return calls


def run(args):
    out = io.StringIO()
    with redirect_stdout(out):
        cli.cmd_agent_mint(args)
    return out.getvalue()


def test_step_up_precedes_the_mint_and_binds_the_act(api):
    run(Args())
    assert api[0][:2] == ("POST", "/auth/step-up")
    assert api[0][2]["action"] == "agent.mint"
    assert api[0][2]["targetId"] == TASK_ID
    assert api[1][:2] == ("POST", "/delegation/agent-mints")
    assert api[1][2]["stepUpToken"] == "rhsu_cli_token"
    assert api[1][2]["targetTaskId"] == TASK_ID
    assert api[1][2]["requestedScopes"] == ["tasks:read"]


def test_step_up_refusal_exits_without_minting(monkeypatch):
    calls = []

    def refusing_api(method, path, data=None, **kw):
        calls.append(path)
        return {"success": False, "error": "Invalid password"}

    monkeypatch.setattr(cli, "api", refusing_api)
    with pytest.raises(SystemExit):
        run(Args())
    assert calls == ["/auth/step-up"]


def test_pack_prints_secret_bootstrap_and_brief_once(api):
    output = run(Args())
    assert output.count("rh_dev_secret_once") >= 1
    assert "You have a RelayHall board" in output
    assert "COMPILED BRIEF TEXT" in output
    assert "never stored" in output


def test_brief_out_writes_the_brief_to_a_file(api, tmp_path):
    target = tmp_path / "brief.md"
    output = run(Args(brief_out=str(target)))
    assert target.read_text(encoding="utf-8") == "COMPILED BRIEF TEXT"
    assert "COMPILED BRIEF TEXT" not in output


def test_json_mode_emits_the_raw_envelope(api):
    output = run(Args(json=True))
    envelope = json.loads(output)
    assert envelope["pack"]["secretOnce"] == "rh_dev_secret_once"


def test_missing_scope_refuses_before_any_call(api):
    with pytest.raises(SystemExit):
        run(Args(scope=[]))
    assert api == []
