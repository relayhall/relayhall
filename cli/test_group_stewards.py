"""LENSES-c c1-A (card 46cfbd1d) - `relayhall group steward list|add|remove`.

These measure what the CLI SENDS (method, path, body), what it REFUSES before
sending (anything but an exact UUID), and what it PRINTS: the live/inert flag
with its reason, and a server refusal verbatim with its code and the stable
exit code. Appointing and removing are root login-session acts with no step-up,
so the CLI never asks for a password and never sends a stepUpToken.
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI_PATH = os.path.join(HERE, "relayhall")

GROUP = "0b7a5ff6-3c1d-4c21-9a4f-1f1f1f1f1f1f"
ACCOUNT = "7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f"
APPOINTER = "11111111-2222-4333-8444-555555555555"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_group_stewards", importlib.machinery.SourceFileLoader("relayhall_cli_group_stewards", CLI_PATH))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Recorder:
    """What the CLI asked the board to do, answered with one (status, body)."""

    def __init__(self, status, body):
        self.calls = []
        self.status = status
        self.body = body

    def __call__(self, method, path, data=None, headers=None):
        self.calls.append((method, path, data))
        return self.status, json.dumps(self.body)


class Args:
    def __init__(self, **values):
        self.json = False
        for key, value in values.items():
            setattr(self, key, value)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(cli, "resource_api", lambda *a, **k: pytest.fail("the test forgot to install a recorder"))
    monkeypatch.setattr(cli, "api", lambda *a, **k: pytest.fail("the steward verbs use resource_api only"))


def run(fn, args):
    with pytest.raises(SystemExit) as exited:
        fn(args)
    return exited.value.code


def steward_row(**overrides):
    row = {
        "accountPrincipalId": ACCOUNT, "handle": "ada", "kind": "human", "status": "active",
        "role": "owner", "appointedByPrincipalId": APPOINTER, "appointedAt": "2026-10-14T09:00:00.000Z",
        "live": True, "inertReason": None,
    }
    row.update(overrides)
    return row


# ── list ──

def test_list_reads_the_stewards_route_and_prints_role_holder_and_flag(monkeypatch, capsys):
    recorder = Recorder(200, {"success": True, "stewards": [
        steward_row(),
        steward_row(accountPrincipalId=APPOINTER, handle="bo", role="manager", live=False, inertReason="not_a_member"),
    ]})
    monkeypatch.setattr(cli, "resource_api", recorder)
    assert run(cli.cmd_group_steward_list, Args(group_id=GROUP)) == 0
    assert recorder.calls == [("GET", f"/groups/{GROUP}/stewards", None)]
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[0].startswith("owner") and ACCOUNT in lines[0] and "ada" in lines[0] and lines[0].endswith("live")
    assert "inert (not_a_member)" in out
    assert "not a member of the Group" in out
    assert "an inert role confers nothing" in out


@pytest.mark.parametrize("reason,words", [
    ("principal_inactive", "not active"),
    ("elevated_role", "elevated role"),
    ("not_a_member", "not a member"),
])
def test_every_inert_reason_is_explained(monkeypatch, capsys, reason, words):
    monkeypatch.setattr(cli, "resource_api", Recorder(200, {"stewards": [steward_row(live=False, inertReason=reason)]}))
    assert run(cli.cmd_group_steward_list, Args(group_id=GROUP)) == 0
    out = capsys.readouterr().out
    assert f"inert ({reason})" in out and words in out


def test_an_empty_group_says_so(monkeypatch, capsys):
    monkeypatch.setattr(cli, "resource_api", Recorder(200, {"success": True, "stewards": []}))
    assert run(cli.cmd_group_steward_list, Args(group_id=GROUP)) == 0
    assert "No Group roles" in capsys.readouterr().out


def test_an_uppercase_uuid_is_sent_lowercase(monkeypatch):
    recorder = Recorder(200, {"stewards": []})
    monkeypatch.setattr(cli, "resource_api", recorder)
    run(cli.cmd_group_steward_list, Args(group_id=GROUP.upper()))
    assert recorder.calls[0][1] == f"/groups/{GROUP}/stewards"


# ── exact-UUID targets: refused before anything is sent ──

@pytest.mark.parametrize("fn,values", [
    ("cmd_group_steward_list", {"group_id": "engineering"}),
    ("cmd_group_steward_list", {"group_id": GROUP[:8]}),
    ("cmd_group_steward_add", {"group_id": "engineering", "account_id": ACCOUNT, "role": "owner"}),
    ("cmd_group_steward_add", {"group_id": GROUP, "account_id": "ada", "role": "owner"}),
    ("cmd_group_steward_remove", {"group_id": GROUP, "account_id": ACCOUNT[:8]}),
    ("cmd_group_steward_remove", {"group_id": GROUP + "x", "account_id": ACCOUNT}),
    ("cmd_group_steward_list", {"group_id": GROUP + "\n"}),
])
def test_a_name_handle_or_prefix_is_a_usage_error_and_nothing_is_sent(monkeypatch, capsys, fn, values):
    recorder = Recorder(200, {})
    monkeypatch.setattr(cli, "resource_api", recorder)
    monkeypatch.setattr(cli, "confirm_prompt", lambda message: True)
    assert run(getattr(cli, fn), Args(**values)) == 2
    assert recorder.calls == []
    assert "exact UUID" in capsys.readouterr().err


# ── add ──

def test_add_sends_exactly_the_two_fields_and_no_step_up(monkeypatch, capsys):
    recorder = Recorder(201, {"success": True, "steward": steward_row(role="manager")})
    monkeypatch.setattr(cli, "resource_api", recorder)
    assert run(cli.cmd_group_steward_add, Args(group_id=GROUP, account_id=ACCOUNT, role="manager")) == 0
    assert recorder.calls == [("POST", f"/groups/{GROUP}/stewards", {"accountPrincipalId": ACCOUNT, "role": "manager"})]
    out = capsys.readouterr().out
    assert "Appointed manager" in out and "live" in out


def test_add_of_an_outsider_says_the_row_is_inert(monkeypatch, capsys):
    monkeypatch.setattr(cli, "resource_api", Recorder(201, {"steward": steward_row(live=False, inertReason="not_a_member")}))
    assert run(cli.cmd_group_steward_add, Args(group_id=GROUP, account_id=ACCOUNT, role="owner")) == 0
    out = capsys.readouterr().out
    assert "inert (not_a_member)" in out and "recorded but inert" in out


def test_add_refuses_a_role_other_than_owner_or_manager_before_sending(monkeypatch):
    recorder = Recorder(201, {})
    monkeypatch.setattr(cli, "resource_api", recorder)
    assert run(cli.cmd_group_steward_add, Args(group_id=GROUP, account_id=ACCOUNT, role="admin")) == 2
    assert recorder.calls == []


@pytest.mark.parametrize("status,code,exit_code", [
    (403, "REQUIRES_LOGIN_SESSION", 3),
    (403, "FORBIDDEN", 3),
    (404, "GROUP_NOT_FOUND", 4),
    (409, "ALREADY_A_STEWARD", 5),
    (422, "STEWARD_INELIGIBLE", 6),
    (422, "STEWARD_NOT_FOUND", 6),
])
def test_add_prints_the_refusal_verbatim_with_its_code(monkeypatch, capsys, status, code, exit_code):
    message = f"server words for {code}: kept exactly"
    monkeypatch.setattr(cli, "resource_api", Recorder(status, {"success": False, "code": code, "message": message}))
    assert run(cli.cmd_group_steward_add, Args(group_id=GROUP, account_id=ACCOUNT, role="owner")) == exit_code
    err = capsys.readouterr().err
    assert message in err and f"[{code}]" in err


def test_add_json_passes_the_envelope_through(monkeypatch, capsys):
    body = {"success": False, "code": "REQUIRES_LOGIN_SESSION", "message": "m"}
    monkeypatch.setattr(cli, "resource_api", Recorder(403, body))
    assert run(cli.cmd_group_steward_add, Args(group_id=GROUP, account_id=ACCOUNT, role="owner", json=True)) == 3
    assert json.loads(capsys.readouterr().out) == body


# ── remove ──

def test_remove_confirms_then_deletes_the_row_with_no_body(monkeypatch, capsys):
    recorder = Recorder(200, {"success": True, "removed": {"accountPrincipalId": ACCOUNT, "role": "owner"}})
    monkeypatch.setattr(cli, "resource_api", recorder)
    prompts = []
    monkeypatch.setattr(cli, "confirm_prompt", lambda message: prompts.append(message) or True)
    assert run(cli.cmd_group_steward_remove, Args(group_id=GROUP, account_id=ACCOUNT)) == 0
    assert recorder.calls == [("DELETE", f"/groups/{GROUP}/stewards/{ACCOUNT}", None)]
    assert len(prompts) == 1 and ACCOUNT in prompts[0] and GROUP in prompts[0]
    assert "Removed the owner role" in capsys.readouterr().out


def test_remove_declined_sends_nothing(monkeypatch, capsys):
    recorder = Recorder(200, {})
    monkeypatch.setattr(cli, "resource_api", recorder)
    monkeypatch.setattr(cli, "confirm_prompt", lambda message: False)
    assert run(cli.cmd_group_steward_remove, Args(group_id=GROUP, account_id=ACCOUNT)) == 1
    assert recorder.calls == []
    assert "Nothing was sent" in capsys.readouterr().err


@pytest.mark.parametrize("status,code,exit_code", [
    (404, "STEWARD_NOT_FOUND", 4),
    (403, "REQUIRES_LOGIN_SESSION", 3),
])
def test_remove_prints_the_refusal_verbatim(monkeypatch, capsys, status, code, exit_code):
    monkeypatch.setattr(cli, "resource_api", Recorder(status, {"code": code, "message": f"words {code}"}))
    monkeypatch.setattr(cli, "confirm_prompt", lambda message: True)
    assert run(cli.cmd_group_steward_remove, Args(group_id=GROUP, account_id=ACCOUNT)) == exit_code
    err = capsys.readouterr().err
    assert f"words {code}" in err and f"[{code}]" in err


# ── the parser: exactly three verbs, no gate or owner verb ──

def test_the_parser_offers_list_add_remove_and_nothing_else():
    result = subprocess.run([sys.executable, CLI_PATH, "group", "steward", "--help"],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0
    assert "{list,add,remove}" in result.stdout
    source = open(CLI_PATH, encoding="utf-8").read()
    for verb in ("appoint-manager", "remove-manager", "transfer", "gate"):
        assert f'group_steward_sub.add_parser("{verb}"' not in source


def test_the_verbs_never_mint_a_step_up():
    source = open(CLI_PATH, encoding="utf-8").read()
    start = source.index("def cmd_group_steward_list(")
    end = source.index("def cmd_grant_list(")
    block = source[start:end]
    assert "/auth/step-up" not in block and "stepUpToken" not in block and "getpass" not in block


def test_a_non_uuid_on_the_command_line_exits_2_without_a_request():
    env = dict(os.environ, RELAYHALL_API_URL="http://127.0.0.1:9", RELAYHALL_TOKEN="unused")
    result = subprocess.run([sys.executable, CLI_PATH, "group", "steward", "list", "engineering"],
                            capture_output=True, text=True, timeout=30, env=env)
    assert result.returncode == 2
    assert "exact UUID" in result.stderr
