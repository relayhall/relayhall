"""Card 549cc51f - `relayhall shared-writers list|add|remove`.

These measure what the CLI SENDS (method, path, body, the retry key), what it
REFUSES before sending (anything but an exact UUID, a reason outside 20-2000
characters, and any change attempted with an `rh_` credential), the step-up it
mints first and binds to the act and the Account (exactly as `agent mint`
does), and what it PRINTS: the list, and a server refusal verbatim with its code,
a hint and the stable exit code.
"""
import importlib.machinery
import importlib.util
import json
import os

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI_PATH = os.path.join(HERE, "relayhall")

SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ACCOUNT = "7c0e4a3e-1f2b-4c3d-8e9f-0a1b2c3d4e5f"
REASON = "Writes the organisation runbooks for everyone."


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_shared_writers", importlib.machinery.SourceFileLoader("relayhall_cli_shared_writers", CLI_PATH))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Board:
    """What the CLI asked the board to do; answers by path."""

    def __init__(self, answers):
        self.calls = []
        self.answers = answers

    def __call__(self, method, path, data=None, headers=None):
        self.calls.append((method, path, data, headers or {}))
        for prefix, (status, body) in self.answers.items():
            if path.startswith(prefix):
                return status, json.dumps(body)
        raise AssertionError(f"unexpected path {path}")


class Args:
    def __init__(self, **values):
        self.json = False
        self.source = None
        self.expires_at = None
        self.password = "hunter2"
        for key, value in values.items():
            setattr(self, key, value)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(cli, "resource_api", lambda *a, **k: pytest.fail("the test forgot to install a recorder"))
    monkeypatch.setattr(cli, "api", lambda *a, **k: pytest.fail("the shared-writer verbs use resource_api only"))
    monkeypatch.setattr(cli, "get_token", lambda: "eyJ.session.jwt")


def run(fn, args):
    with pytest.raises(SystemExit) as exit_info:
        fn(args)
    return exit_info.value.code


LIST = {"success": True, "source": {"id": SOURCE, "slug": "brain", "name": "Brain"}, "scope": "organisation",
        "writers": [{"accountId": ACCOUNT, "label": "Grace Hopper"}], "youCanWrite": True}


def test_list_reads_the_list_and_prints_it(monkeypatch, capsys):
    board = Board({"/knowledge-shared-writers": (200, LIST)})
    monkeypatch.setattr(cli, "resource_api", board)
    assert run(cli.cmd_shared_writers_list, Args()) == 0
    assert board.calls[0][:2] == ("GET", "/knowledge-shared-writers")
    out = capsys.readouterr().out
    assert "Shared area of Brain (brain), scope organisation" in out
    assert "You can write it: yes" in out
    assert ACCOUNT in out and "Grace Hopper" in out


def test_list_names_the_source_exactly(monkeypatch):
    board = Board({"/knowledge-shared-writers": (200, LIST)})
    monkeypatch.setattr(cli, "resource_api", board)
    assert run(cli.cmd_shared_writers_list, Args(source=SOURCE.upper())) == 0
    assert board.calls[0][1] == f"/knowledge-shared-writers?source={SOURCE}"
    with pytest.raises(SystemExit) as refused:
        cli.cmd_shared_writers_list(Args(source="brain"))
    assert refused.value.code == 2
    assert len(board.calls) == 1


def test_add_mints_the_step_up_first_then_sends_one_keyed_change(monkeypatch, capsys):
    board = Board({
        "/auth/step-up": (200, {"success": True, "stepUpToken": "rhsu_cli"}),
        "/knowledge-shared-writers": (200, {"success": True, "action": "add", "before": [], "after": [ACCOUNT]}),
    })
    monkeypatch.setattr(cli, "resource_api", board)
    assert run(cli.cmd_shared_writers_add, Args(account_id=ACCOUNT, reason=REASON, source=SOURCE,
                                                expires_at="2027-01-01T00:00:00Z")) == 0
    assert board.calls[0][:2] == ("POST", "/auth/step-up")
    assert board.calls[0][2] == {"password": "hunter2", "action": "knowledge.shared-writer.add", "targetId": ACCOUNT}
    method, path, body, headers = board.calls[1]
    assert (method, path) == ("POST", "/knowledge-shared-writers")
    assert body == {"accountId": ACCOUNT, "reason": REASON, "source": SOURCE,
                    "expiresAt": "2027-01-01T00:00:00Z", "stepUpToken": "rhsu_cli"}
    assert len(headers["Idempotency-Key"]) >= 16
    assert "Added" in capsys.readouterr().out


def test_remove_binds_the_remove_act(monkeypatch):
    board = Board({
        "/auth/step-up": (200, {"success": True, "stepUpToken": "rhsu_rm"}),
        "/knowledge-shared-writers/remove": (200, {"success": True, "action": "remove", "before": [ACCOUNT], "after": []}),
    })
    monkeypatch.setattr(cli, "resource_api", board)
    assert run(cli.cmd_shared_writers_remove, Args(account_id=ACCOUNT, reason=REASON)) == 0
    assert board.calls[0][2]["action"] == "knowledge.shared-writer.remove"
    assert board.calls[1][:2] == ("POST", "/knowledge-shared-writers/remove")
    assert "expiresAt" not in board.calls[1][2]


def test_an_rh_credential_is_refused_before_anything_is_sent(monkeypatch, capsys):
    board = Board({})
    monkeypatch.setattr(cli, "resource_api", board)
    monkeypatch.setattr(cli, "get_token", lambda: "rh_dev_abcdef.secret")
    assert run(cli.cmd_shared_writers_add, Args(account_id=ACCOUNT, reason=REASON)) == 3
    assert board.calls == []
    err = capsys.readouterr().err
    assert "login-session act" in err and "relayhall login" in err


def test_a_short_reason_and_a_non_uuid_account_are_refused_locally(monkeypatch):
    board = Board({})
    monkeypatch.setattr(cli, "resource_api", board)
    assert run(cli.cmd_shared_writers_add, Args(account_id=ACCOUNT, reason="too short")) == 2
    assert run(cli.cmd_shared_writers_add, Args(account_id="grace", reason=REASON)) == 2
    assert board.calls == []


def test_a_refused_step_up_sends_no_change(monkeypatch, capsys):
    board = Board({"/auth/step-up": (401, {"error": "Unauthorized", "message": "Invalid password"})})
    monkeypatch.setattr(cli, "resource_api", board)
    assert run(cli.cmd_shared_writers_add, Args(account_id=ACCOUNT, reason=REASON)) == 3
    assert [call[1] for call in board.calls] == ["/auth/step-up"]
    assert "Invalid password" in capsys.readouterr().err


def test_a_server_refusal_prints_its_code_and_a_hint(monkeypatch, capsys):
    board = Board({
        "/auth/step-up": (200, {"success": True, "stepUpToken": "rhsu_cli"}),
        "/knowledge-shared-writers": (422, {"success": False, "code": "SHARED_WRITER_NOT_AN_ACCOUNT",
                                            "message": "A shared-area writer is an Account"}),
    })
    monkeypatch.setattr(cli, "resource_api", board)
    assert run(cli.cmd_shared_writers_add, Args(account_id=ACCOUNT, reason=REASON)) == 6
    err = capsys.readouterr().err
    assert "[SHARED_WRITER_NOT_AN_ACCOUNT]" in err
    assert "never a connection, an agent, a Group or a service identity" in err


def test_the_parser_wires_the_three_verbs():
    source = open(CLI_PATH, encoding="utf-8").read()
    assert 'sub.add_parser(\n        "shared-writers"' in source
    for verb in ("list", "add", "remove"):
        assert f"cmd_shared_writers_{verb}(args)" in source
