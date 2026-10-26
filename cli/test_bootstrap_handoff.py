"""The CLI half of the bootstrap handoff (card 94e8bb0b, items 1 and 2).

 - `credential issue` on a Connector prints the pack's bootstrap prompt and the
   secure configuration guidance AFTER the one-time secret, and an Account
   issuance (no pack) prints neither;
 - `agent mint` prints the same prompt inside its one-time pack;
 - `skill update/create --skill-md-file` sends the file's exact bytes as
   `skill_md`, which is how the reviewed registry Skill source in
   skills/relayhall-connector-bootstrap/SKILL.md becomes a draft Version.

Driven through the real argparse tree and dispatcher with api() faked.
"""
import importlib.machinery
import importlib.util
import io
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
REPO_SKILL = Path(__file__).parent.parent / "skills" / "relayhall-connector-bootstrap" / "SKILL.md"
CONNECTOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
SECRET = "rh_dev_ab12cd34ef56.SECRETVALUE0000000000"
PROMPT = ('Connect to the RelayHall MCP server "relayhall" at https://board/api/mcp with the credential '
          'from your secure store; never paste the credential into this chat.\n'
          'Call relayhall_brief_compile with {"session": true} to get your session brief.')
GUIDANCE = ['Register the MCP server as "relayhall" at https://board/api/mcp using the block for your client.']


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_bootstrap_handoff",
        importlib.machinery.SourceFileLoader("relayhall_cli_bootstrap_handoff", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


def run(monkeypatch, replies, *argv):
    calls = []

    def fake_api(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
        calls.append((method, path, data, headers))
        for (m, prefix), reply in replies.items():
            if m == method and path.startswith(prefix):
                return reply(data) if callable(reply) else reply
        raise AssertionError(f"unexpected call {method} {path}")

    monkeypatch.setattr(cli, "api", fake_api)
    out, err = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, "argv", ["relayhall", *argv])
    code = 0
    with redirect_stdout(out), redirect_stderr(err):
        try:
            cli.main()
        except SystemExit as exit_info:
            code = exit_info.code
    return code, out.getvalue(), err.getvalue(), calls


PRINCIPALS = {"principals": [{"id": CONNECTOR, "handle": "my-connector"}]}


def test_a_connector_issuance_prints_the_prompt_after_the_secret(monkeypatch):
    issued = {"success": True, "keyId": "k1", "scopes": ["tasks:read"], "secretOnce": SECRET,
              "onboarding": {"bootstrapPrompt": PROMPT, "configurationGuidance": GUIDANCE}}
    code, out, _, _ = run(monkeypatch, {("GET", "/principals"): PRINCIPALS,
                                        ("POST", f"/principals/{CONNECTOR}/credentials"): issued},
                          "credential", "issue", "my-connector", "--scopes", "tasks:read")
    assert code == 0
    assert out.count(SECRET) == 1
    secret_at = out.index(SECRET)
    prompt_at = out.index("BOOTSTRAP PROMPT")
    assert prompt_at > secret_at
    tail = out[prompt_at:]
    assert SECRET not in tail
    for line in PROMPT.split("\n"):
        assert line in tail
    assert "SECURE CONFIGURATION" in tail and f"- {GUIDANCE[0]}" in tail


def test_an_account_issuance_prints_no_prompt(monkeypatch):
    issued = {"success": True, "keyId": "k1", "scopes": ["tasks:read"], "secretOnce": SECRET}
    code, out, _, _ = run(monkeypatch, {("GET", "/principals"): PRINCIPALS,
                                        ("POST", f"/principals/{CONNECTOR}/credentials"): issued},
                          "credential", "issue", "my-connector", "--scopes", "tasks:read")
    assert code == 0
    assert SECRET in out
    assert "BOOTSTRAP PROMPT" not in out


def test_the_agent_mint_pack_prints_the_prompt(monkeypatch):
    task = "11111111-2222-4333-8444-555555555555"
    pack = {"success": True, "pack": {
        "principalId": CONNECTOR, "handle": "agent-1", "secretOnce": SECRET, "scopes": ["tasks:read"],
        "expiresAt": "2026-10-09T00:00:00Z",
        "onboarding": {"bootstrapLine": "You have a RelayHall board at https://board/api.",
                       "cliEnv": [f"export RELAYHALL_TOKEN={SECRET}"], "mcpConfig": {"generic": {}},
                       "bootstrapPrompt": PROMPT, "configurationGuidance": GUIDANCE}}}
    code, out, _, _ = run(monkeypatch, {("POST", "/auth/step-up"): {"stepUpToken": "rhsu_x"},
                                        ("POST", "/delegation/agent-mints"): pack},
                          "agent", "mint", "--task", task, "--scope", "tasks:read", "--password", "pw")
    assert code == 0
    tail = out[out.index("BOOTSTRAP PROMPT"):]
    assert "   Call relayhall_brief_compile" in tail
    assert SECRET not in tail


def _skill_listing(_data=None):
    return {"skills": [{"id": "7433a98f-dad0-4e65-9217-5717c75bfaf5", "name": "relayhall-connector-bootstrap",
                        "revision": "rev-1", "category": "workflow"}]}


def test_skill_update_sends_the_reviewed_source_byte_for_byte(monkeypatch):
    code, out, _, calls = run(monkeypatch, {
        ("GET", "/skills"): _skill_listing,
        ("PUT", "/skills/7433a98f"): {"skill": {"name": "relayhall-connector-bootstrap", "version": 2}},
    }, "skill", "update", "relayhall-connector-bootstrap", "--skill-md-file", str(REPO_SKILL))
    assert code == 0
    put = [c for c in calls if c[0] == "PUT"]
    assert len(put) == 1
    _method, path, data, headers = put[0]
    assert path == "/skills/7433a98f-dad0-4e65-9217-5717c75bfaf5"
    assert headers == {"If-Match": "rev-1"}
    assert data == {"skill_md": REPO_SKILL.read_bytes().decode("utf-8")}
    assert "Version: 2" in out


def test_skill_create_accepts_the_same_flag(monkeypatch):
    code, _, _, calls = run(monkeypatch, {("POST", "/skills"): {"skill": {"name": "x", "id": "i"}}},
                            "skill", "create", "--name", "relayhall-connector-bootstrap",
                            "--skill-md-file", str(REPO_SKILL))
    assert code == 0
    assert calls[0][2]["skill_md"] == REPO_SKILL.read_text(encoding="utf-8")
    assert "usage_instructions" not in calls[0][2]


def test_skill_md_file_refuses_a_second_body(monkeypatch, tmp_path):
    body = tmp_path / "body.md"
    body.write_text("text", encoding="utf-8")
    code, _, err, calls = run(monkeypatch, {("GET", "/skills"): _skill_listing},
                              "skill", "update", "relayhall-connector-bootstrap",
                              "--skill-md-file", str(REPO_SKILL), "--usage-file", str(body))
    assert code == 2
    assert "drop --usage/--usage-file" in err
    assert not [c for c in calls if c[0] == "PUT"]
