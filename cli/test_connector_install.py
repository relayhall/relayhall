"""`relayhall connector install | check | status | uninstall` (E462 slice S2;
design v1.5 sections 3.1-3.4).

Every test drives the verbs through the real argparse tree of the connector
module against a real HTTP stub board, with in-memory custody, a recording Task
Scheduler and a temporary home folder (connector_testkit). What these pin:

 - the platform gate: macOS and Linux refuse before anything is asked or
   written (exit 3); a global --token is refused; a malformed token is refused
   without being quoted;
 - the token's principal must be a connector (kind `service`), its pin must
   admit REST (whoami) and MCP (initialize), and the board must answer;
 - per harness: Claude Code's user `.claude.json` (`mcpServers`), Codex's
   `config.toml` (a marker block), VS Code's user `mcp.json` (`servers`) and
   Antigravity's `~/.gemini/config/mcp_config.json` (`mcpServers`, one entry
   marked by `env.RELAYHALL_CONNECTOR`, the file backed up beside itself first;
   owner ruling E475 (2)) each get an entry that starts the local proxy and
   holds no token;
 - a pre-existing entry under the alias is backed up, replaced, and PUT BACK by
   uninstall; one that carried a credential is warned about by name of the risk;
 - whether an entry or a file carries a credential is decided on every field
   found, never on the field names a message may print (a long dotted path is
   unprintable, never absent), in every harness file;
 - uninstall leaves an entry the person rewrote without the installer's marker;
 - a file the installer cannot rewrite safely (JSONC, invalid TOML, an inline
   table) is refused before custody is touched;
 - re-install is idempotent: no rewrite, no second backup;
 - install rolls back everything it wrote when a later step fails;
 - the per-user task is registered under the connector's name and removed by
   uninstall; status and check print names, ids and states only;
 - uninstall removes exactly what install recorded, and nothing else;
 - the harness scope set equals the dashboard's HARNESS_CONNECTOR_SCOPES, and
   the ratified sixteen written out (E462 section 3.1 plus E475 (1) and E480).
"""
import json
import os
import re
import stat
from pathlib import Path

import pytest

import relayhall_connector as connector
from connector_testkit import (
    HANDLE, PRINCIPAL_ID, TOKEN, RecordingScheduler, StubBoard, all_files, make_runtime, output, run_verb,
)

REPO = Path(__file__).resolve().parents[1]


def install(rt, board, harness, *extra):
    return run_verb(rt, ["install", "--harness", harness, "--board", board.origin, *extra])


def home(rt):
    return Path(rt.environ["USERPROFILE"])


def claude_json(rt):
    return home(rt) / ".claude.json"


def codex_toml(rt):
    return home(rt) / ".codex" / "config.toml"


def vscode_json(rt):
    return Path(rt.environ["APPDATA"]) / "Code" / "User" / "mcp.json"


def proxy_args(name=HANDLE):
    return ["connector", "mcp", "--name", name]


# ── gates before anything is written ──────────────────────────────────────

@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_macos_and_linux_refuse_before_asking_for_anything(tmp_path, platform):
    with StubBoard() as board:
        rt = make_runtime(tmp_path, platform=platform)
        assert install(rt, board, "claude-code") == connector.EXIT_UNSUPPORTED
        assert rt.prompts == [] and board.requests == []
    assert "Windows only" in rt.stderr.getvalue()
    assert all_files(home(rt)) == []


@pytest.mark.parametrize("platform", ["linux", "darwin"])
@pytest.mark.parametrize("verb", [["mcp", "--name", HANDLE], ["run", "--name", HANDLE], ["check"], ["status"],
                                  ["uninstall"]], ids=lambda v: v[0])
def test_every_other_verb_says_windows_only_on_macos_and_linux(tmp_path, platform, verb):
    rt = make_runtime(tmp_path, platform=platform)
    del rt.environ["LOCALAPPDATA"]  # as on a real macOS or Linux machine
    rt.state_root = None
    assert run_verb(rt, verb) == connector.EXIT_UNSUPPORTED
    err = rt.stderr.getvalue()
    assert "Windows only" in err and "LOCALAPPDATA" not in err
    assert all_files(home(rt)) == []


def test_a_global_token_flag_is_refused(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert run_verb(rt, ["install", "--harness", "codex", "--board", board.origin], global_token=TOKEN) == 1
        assert board.requests == [] and rt.prompts == []
    assert "refusing --token" in rt.stderr.getvalue()
    assert TOKEN not in output(rt)


def test_the_token_is_read_at_the_hidden_prompt_only(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        rt.environ["RELAYHALL_TOKEN"] = "rh_live_zz99zz99zz99.EnvironmentTokenNeverRead000"
        assert install(rt, board, "vscode") == 0
    assert rt.prompts == ["Paste the connector token (input is hidden): "]
    assert "never reads it" in rt.stdout.getvalue()
    assert "remove it from your persistent user environment" in rt.stdout.getvalue()
    assert "EnvironmentTokenNeverRead" not in output(rt)
    assert rt.custody().load(HANDLE) == TOKEN
    # Children never inherit a board token from this shell.
    assert all("RELAYHALL_TOKEN" not in call["env"] for call in rt.scheduler.calls)


def test_token_stdin_reads_one_line_and_skips_the_prompt(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path, stdin_text=TOKEN + "\n")
        assert install(rt, board, "vscode", "--token-stdin") == 0
    assert rt.prompts == []
    assert rt.custody().load(HANDLE) == TOKEN


def test_a_malformed_token_is_refused_without_being_quoted(tmp_path):
    typed = "rh_live_ab12cd34ef56.tooshort"
    with StubBoard() as board:
        rt = make_runtime(tmp_path, token_reader=lambda: typed)
        assert install(rt, board, "claude-code") == 1
        assert board.requests == []
    assert typed not in output(rt) and "tooshort" not in output(rt)
    assert all_files(home(rt)) == []


@pytest.mark.parametrize("bad", ["ftp://board.example", "http://board.example", "https://board.example/api",
                                 "https://user:pw@board.example", "https://board.example/?q=1", "board.example"])
def test_board_must_be_an_https_origin(tmp_path, bad):
    rt = make_runtime(tmp_path)
    assert run_verb(rt, ["install", "--harness", "codex", "--board", bad]) == 1
    assert rt.prompts == []


def test_board_accepts_https_and_loopback_http():
    assert connector.validate_board("https://Board.Example/") == "https://board.example"
    assert connector.validate_board("http://localhost:8082") == "http://localhost:8082"
    assert connector.validate_board("http://127.0.0.1:3001") == "http://127.0.0.1:3001"


def test_an_unknown_harness_is_refused(tmp_path):
    rt = make_runtime(tmp_path)
    assert run_verb(rt, ["install", "--harness", "emacs", "--board", "https://board.example"]) == 1
    assert "claude-code, codex, vscode, antigravity" in rt.stderr.getvalue()


@pytest.mark.parametrize("board_kwargs, expected", [
    ({"kind": "human"}, "not a connector"),
    ({"rest_status": 403}, "pinned to the `any` transport"),
    ({"mcp_status": 403}, "refused this token on the MCP endpoint"),
    ({"token": "rh_live_ab12cd34ef56.SomeOtherSecret0000000000000"}, "refused this token on its REST routes"),
])
def test_the_token_must_be_a_connector_token_that_works_on_rest_and_mcp(tmp_path, board_kwargs, expected):
    with StubBoard(**board_kwargs) as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "claude-code") == 1
    assert expected in rt.stderr.getvalue()
    assert not rt.custody().exists(HANDLE)
    assert all_files(home(rt)) == []
    assert rt.scheduler.calls == []
    assert TOKEN not in output(rt)


def test_an_unreachable_board_is_a_refusal(tmp_path):
    rt = make_runtime(tmp_path)
    assert run_verb(rt, ["install", "--harness", "codex", "--board", "http://127.0.0.1:9"]) == 1
    assert "could not reach the board" in rt.stderr.getvalue()
    assert all_files(home(rt)) == []


# ── Claude Code ───────────────────────────────────────────────────────────

def test_claude_code_install_check_status_uninstall(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        claude_json(rt).write_text(json.dumps({"numStartups": 7, "projects": {"x": {}}}, indent=2) + "\n")
        original = claude_json(rt).read_text()
        assert install(rt, board, "claude-code") == 0, output(rt)
        data = json.loads(claude_json(rt).read_text())
        entry = data["mcpServers"]["relayhall"]
        assert entry["type"] == "stdio" and entry["env"] == {}
        assert entry["command"] == rt.python and entry["args"][1:] == proxy_args()
        assert data["numStartups"] == 7 and data["projects"] == {"x": {}}
        assert TOKEN not in claude_json(rt).read_text()

        manifest = connector.load_manifest(rt, HANDLE)
        assert manifest["principal"] == {"id": PRINCIPAL_ID, "handle": HANDLE}
        assert manifest["board"] == board.origin and manifest["harness"] == "claude-code"
        # Nothing was replaced, so nothing is kept: no copy of the person's file in the connector's folder.
        assert manifest["config"]["backup"] is None and manifest["config"]["replaced"] is False
        assert not (Path(rt.state_root) / HANDLE / "backups").exists()
        skill = Path(manifest["skill"]["path"])
        assert skill == home(rt) / ".claude" / "skills" / "relayhall-connection" / "SKILL.md"
        assert "OS custody" in skill.read_text() and TOKEN not in skill.read_text()
        assert manifest["task"] == {"name": f"RelayHall Connector {HANDLE}"}
        assert f"connector run --name {HANDLE}" in rt.scheduler.tasks[f"RelayHall Connector {HANDLE}"]

        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["check"]) == 0, output(rt)
        report = rt.stdout.getvalue()
        for label in ("custody", "board", "whoami", "scopes", "mcp proxy"):
            assert re.search(rf"ok\s+{label}:", report), (label, report)
        assert "All checks passed." in report

        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["status"]) == 0
        status = rt.stdout.getvalue()
        assert HANDLE in status and PRINCIPAL_ID in status and "present" in status and "Ready" in status

        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
        assert json.loads(claude_json(rt).read_text()) == json.loads(original)
        assert not skill.exists() and not skill.parent.exists()
        assert rt.scheduler.tasks == {}
        assert not rt.custody().exists(HANDLE)
        assert not (Path(rt.state_root) / HANDLE).exists()
    assert TOKEN not in output(rt)


OTHER_TOKEN = "rh_live_0ld0ld0ld0ld.OldSecretInTheConfigFile00000"


def onboarding_entry(board, token):
    """The manual Claude Code block the onboarding pack generates (headers.Authorization = Bearer <secret>)."""
    return {"type": "http", "url": board.origin + "/api/mcp", "headers": {"Authorization": f"Bearer {token}"}}


@pytest.mark.parametrize("same", [True, False], ids=["same-token", "other-token"])
def test_claude_code_entry_that_carries_a_credential_is_refused_by_name_and_left_alone(tmp_path, same):
    """S2 review B1: replacing it would keep the credential in a backup outside custody, so install refuses,
    names the file, the entry and the field (never the value), and says plainly whether it is the same token."""
    with StubBoard() as board:
        held = TOKEN if same else OTHER_TOKEN
        rt = make_runtime(tmp_path)
        claude_json(rt).write_text(json.dumps({"mcpServers": {"relayhall": onboarding_entry(board, held),
                                                              "other": {"command": "x"}}}))
        original = claude_json(rt).read_bytes()
        assert install(rt, board, "claude-code") == 1
        err = rt.stderr.getvalue()
        assert str(claude_json(rt)) in err and "'relayhall'" in err and "headers.Authorization" in err
        assert "carries a credential" in err and "--alias" in err and "Nothing was changed." in err
        if same:
            assert "SAME credential you are installing" in err and "do NOT revoke it" in err
        else:
            assert "not the credential you are installing" in err and "SAME" not in err
        assert held not in output(rt) and held.split(".")[1] not in output(rt)
        assert claude_json(rt).read_bytes() == original
        assert not rt.custody().exists(HANDLE) and rt.scheduler.calls == []
        assert not (Path(rt.state_root) / HANDLE).exists()
        assert not (home(rt) / ".claude" / "skills").exists()
        # The way round it the message names: install beside it under another alias.
        assert install(rt, board, "claude-code", "--alias", "board2") == 0, output(rt)
        servers = json.loads(claude_json(rt).read_text())["mcpServers"]
        assert servers["relayhall"] == onboarding_entry(board, held)
        assert servers["board2"]["args"][1:] == proxy_args()
        assert connector.load_manifest(rt, HANDLE)["config"]["backup"] is None
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert json.loads(claude_json(rt).read_text()) == json.loads(original)
    assert held not in output(rt)


def test_a_replaced_entry_is_kept_alone_never_the_whole_file(tmp_path):
    """The backup is the replaced entry, not a copy of a file that may hold other credentials."""
    previous = {"type": "http", "url": "https://board.example/api/mcp",
                "headers": {"Authorization": "Bearer ${RELAYHALL_TOKEN}"}}
    neighbour = {"type": "http", "url": "https://git.example/mcp",
                 "headers": {"Authorization": "Bearer ghp_NeighbourSecretNeverCopied000000000"}}
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        claude_json(rt).write_text(json.dumps({"primaryApiKey": "sk-ant-api03-ClientKeyNeverCopied0000000000",
                                               "mcpServers": {"relayhall": previous, "git": neighbour}}))
        assert install(rt, board, "claude-code") == 0, output(rt)
        assert "replaced an earlier 'relayhall' entry (it held no credential)" in rt.stdout.getvalue()
        backup = Path(connector.load_manifest(rt, HANDLE)["config"]["backup"])
        assert json.loads(backup.read_text()) == {"mcpServers": {"relayhall": previous}}
        for path in all_files(Path(rt.state_root)):
            data = path.read_text(encoding="utf-8", errors="replace")
            assert "NeighbourSecret" not in data and "ClientKeyNeverCopied" not in data, path
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    servers = json.loads(claude_json(rt).read_text())["mcpServers"]
    assert servers == {"relayhall": previous, "git": neighbour}


def test_the_same_token_elsewhere_in_the_file_is_warned_about_and_never_copied(tmp_path):
    """A project-scoped entry holding the token stays the person's; install says so and copies it nowhere."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        claude_json(rt).write_text(json.dumps({"projects": {"C:/work": {"mcpServers": {
            "relayhall": onboarding_entry(board, TOKEN)}}}}))
        assert install(rt, board, "claude-code") == 0, output(rt)
        out = rt.stdout.getvalue()
        assert "still holds the token you just installed" in out and "do NOT revoke it" in out
        assert claude_json(rt).read_text().count(TOKEN) == 1
        assert [p for p in all_files(home(rt)) if TOKEN.encode() in p.read_bytes()] == [claude_json(rt)]
        assert TOKEN not in output(rt)


# A synthetic plain-text credential value, joined at run time so no secret-shaped literal sits in the
# committed text (the publication secret scan would otherwise flag each occurrence).
PLAIN_SECRET = "abcdefgh" + "12345678"


@pytest.mark.parametrize("entry, field", [
    ({"command": "npx", "args": ["server"], "env": {"RELAYHALL_TOKEN": TOKEN}}, "env.RELAYHALL_TOKEN"),
    ({"type": "http", "url": "https://x/mcp", "headers": {"X-API-Key": PLAIN_SECRET}}, "headers.X-API-Key"),
    ({"command": "srv", "args": ["--api-key", PLAIN_SECRET]}, "args[1]"),
    ({"command": "srv", "args": ["--token=" + PLAIN_SECRET]}, "args[0]"),
    ({"command": "srv", "args": ["9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]}, "args[0]"),
    ({"type": "http", "url": "https://x/mcp", "headers": {"Authorization": "Basic dXNlcjpwYXNzd29yZA=="}},
     "headers.Authorization"),
])
def test_credential_fields_reads_strictly_and_names_only_the_field(entry, field):
    assert connector.credential_fields(entry) == [field]


@pytest.mark.parametrize("entry", [
    {"type": "http", "url": "https://board.example/api/mcp", "headers": {"Authorization": "Bearer ${RELAYHALL_TOKEN}"}},
    {"type": "http", "url": "https://x/mcp", "headers": {"Authorization": "Bearer ${env:RELAYHALL_TOKEN}"}},
    {"type": "http", "url": "https://x/mcp", "headers": {"Authorization": "${input:relayhall-token}"}},
    {"command": "npx", "args": ["-y", "@scope/server-git"], "env": {"GIT_TOKEN": "%GIT_TOKEN%"}},
    {"url": "https://x/mcp", "bearer_token_env_var": "RELAYHALL_TOKEN", "env_vars": ["RELAYHALL_TOKEN"],
     "env_http_headers": {"Authorization": "RELAYHALL_AUTH_HEADER"}},
    {"command": "C:\\Python312\\python.exe", "args": ["C:\\tools\\relayhall", "connector", "mcp"], "env": {}},
])
def test_references_are_not_credentials(entry):
    assert connector.credential_fields(entry) == []


def test_claude_config_dir_is_honoured(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        rt.environ["CLAUDE_CONFIG_DIR"] = str(tmp_path / "claude-config")
        assert install(rt, board, "claude-code") == 0
    assert (tmp_path / "claude-config" / ".claude.json").is_file()
    assert (tmp_path / "claude-config" / "skills" / "relayhall-connection" / "SKILL.md").is_file()
    assert not claude_json(rt).exists()


def test_reinstall_is_idempotent_and_takes_no_second_backup(tmp_path):
    previous = {"command": "old-relayhall-adapter"}
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        claude_json(rt).write_text(json.dumps({"mcpServers": {"relayhall": previous}}) + "\n")
        assert install(rt, board, "claude-code") == 0
        first = connector.load_manifest(rt, HANDLE)
        written = claude_json(rt).stat().st_mtime_ns
        backups = sorted((Path(rt.state_root) / HANDLE / "backups").iterdir())
        assert len(backups) == 1
        assert install(rt, board, "claude-code") == 0
        assert claude_json(rt).stat().st_mtime_ns == written
        assert sorted((Path(rt.state_root) / HANDLE / "backups").iterdir()) == backups
        assert connector.load_manifest(rt, HANDLE)["config"] == first["config"]
        assert "unchanged" in rt.stdout.getvalue()
        assert run_verb(rt, ["uninstall"]) == 0
    assert json.loads(claude_json(rt).read_text()) == {"mcpServers": {"relayhall": previous}}


@pytest.mark.parametrize("harness", ["claude-code", "codex", "vscode"])
def test_reinstall_with_another_alias_is_refused_uninstall_first(tmp_path, harness):
    """S2 review B2: a second alias would be an entry uninstall does not know about."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, harness) == 0, output(rt)
        path = connector.config_path(rt, harness)
        before = path.read_bytes()
        manifest = connector.load_manifest(rt, HANDLE)
        assert install(rt, board, harness, "--alias", "board2") == 1
        err = rt.stderr.getvalue()
        assert "already installed as the MCP server 'relayhall'" in err and "uninstall it first" in err
        assert path.read_bytes() == before and connector.load_manifest(rt, HANDLE) == manifest
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert not path.exists()  # install created it; nothing install wrote is left behind
    assert not (Path(rt.state_root) / HANDLE).exists()


def test_an_alias_owned_by_another_connector_is_refused(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "claude-code") == 0
        before = claude_json(rt).read_text()
        assert install(rt, board, "claude-code", "--name", "second-one") == 1
        assert "belongs to connector" in rt.stderr.getvalue()
        assert claude_json(rt).read_text() == before
        assert not rt.custody().exists("second-one")


def test_a_failed_task_registration_rolls_everything_back(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path, scheduler=RecordingScheduler(fail_create=True))
        claude_json(rt).write_text(json.dumps({"keep": True}))
        original = claude_json(rt).read_text()
        assert install(rt, board, "claude-code") == 1
    assert "Access is denied" in rt.stderr.getvalue()
    assert json.loads(claude_json(rt).read_text()) == json.loads(original)
    assert not rt.custody().exists(HANDLE)
    assert not (Path(rt.state_root) / HANDLE).exists()
    assert not (home(rt) / ".claude" / "skills" / "relayhall-connection").exists()
    assert TOKEN not in output(rt)


# ── Codex ─────────────────────────────────────────────────────────────────

CODEX_BEFORE = """model = "gpt-6"

[mcp_servers.relayhall]
url = "https://board.example/api/mcp"
bearer_token_env_var = "RELAYHALL_TOKEN"

[mcp_servers.relayhall.env]
X = "1"

# notes about the next table
[profiles.fast]
model = "mini"
"""


def test_codex_hand_written_table_is_replaced_by_a_block_and_put_back(tmp_path):
    tomllib = pytest.importorskip("tomllib")
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        codex_toml(rt).parent.mkdir(parents=True)
        codex_toml(rt).write_text(CODEX_BEFORE)
        assert install(rt, board, "codex") == 0, output(rt)
        text = codex_toml(rt).read_text()
        parsed = tomllib.loads(text)
        assert parsed["mcp_servers"]["relayhall"] == {"command": rt.python,
                                                     "args": [str(rt.script)] + proxy_args()}
        assert parsed["model"] == "gpt-6" and parsed["profiles"]["fast"] == {"model": "mini"}
        assert "# notes about the next table" in text
        assert text.count("# >>> relayhall connector") == 1 and TOKEN not in text
        # It named an environment variable, not a credential: no false alarm.
        assert "WARNING" not in rt.stdout.getvalue()
        assert "replaced an earlier 'relayhall' entry" in rt.stdout.getvalue()
        skill = home(rt) / ".codex" / "skills" / "relayhall-connection" / "SKILL.md"
        assert skill.is_file()
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert codex_toml(rt).read_text() == CODEX_BEFORE
    assert not skill.exists()


@pytest.mark.parametrize("table, same", [
    ('[mcp_servers.relayhall]\ncommand = "npx"\n\n[mcp_servers.relayhall.env]\nRELAYHALL_TOKEN = "@TOK@"\n', True),
    ('[mcp_servers.relayhall]\nurl = "https://board.example/api/mcp"\n'
     'http_headers = { Authorization = "Bearer @TOK@" }\n', True),
    ('[mcp_servers.relayhall]\nurl = "https://board.example/api/mcp"\n'
     'http_headers = { Authorization = "Bearer @OTHER@" }\n', False),
], ids=["env-same", "header-same", "header-other"])
def test_codex_table_that_carries_a_credential_is_refused(tmp_path, table, same):
    text = 'model = "gpt-6"\n\n' + table.replace("@OTHER@", OTHER_TOKEN).replace("@TOK@", TOKEN)
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        codex_toml(rt).parent.mkdir(parents=True)
        codex_toml(rt).write_text(text)
        assert install(rt, board, "codex") == 1
    err = rt.stderr.getvalue()
    assert str(codex_toml(rt)) in err and "'relayhall'" in err and "carries a credential" in err
    assert ("SAME credential you are installing" in err) is same
    assert TOKEN not in output(rt) and OTHER_TOKEN not in output(rt)
    assert codex_toml(rt).read_text() == text
    assert not rt.custody().exists(HANDLE) and not (Path(rt.state_root) / HANDLE).exists()


def test_codex_header_from_an_environment_variable_is_not_a_credential(tmp_path):
    tomllib = pytest.importorskip("tomllib")
    text = ('[mcp_servers.relayhall]\nurl = "https://board.example/api/mcp"\n'
            'env_http_headers = { Authorization = "RELAYHALL_AUTH_HEADER" }\n')
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        codex_toml(rt).parent.mkdir(parents=True)
        codex_toml(rt).write_text(text)
        assert install(rt, board, "codex") == 0, output(rt)
        assert tomllib.loads(codex_toml(rt).read_text())["mcp_servers"]["relayhall"]["args"][1:] == proxy_args()
        backup = Path(connector.load_manifest(rt, HANDLE)["config"]["backup"])
        assert backup.read_text() == text  # the replaced table alone
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert codex_toml(rt).read_text() == text


def test_a_skill_file_that_carries_a_credential_is_neither_copied_nor_rewritten(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        skill = home(rt) / ".claude" / "skills" / "relayhall-connection" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        original = f"---\nname: relayhall-connection\n---\nAuthorization: Bearer {TOKEN}\n"
        skill.write_text(original)
        assert install(rt, board, "claude-code") == 0, output(rt)
        out = rt.stdout.getvalue()
        assert "connection skill not installed" in out and "SAME credential" in out and TOKEN not in out
        assert skill.read_text() == original and "skill" not in connector.load_manifest(rt, HANDLE)
        assert [p for p in all_files(Path(rt.state_root)) if TOKEN.encode() in p.read_bytes()] == []
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert skill.read_text() == original


def test_codex_new_file_is_created_and_removed(tmp_path):
    tomllib = pytest.importorskip("tomllib")
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "codex") == 0
        assert tomllib.loads(codex_toml(rt).read_text())["mcp_servers"]["relayhall"]["args"][1:] == proxy_args()
        assert run_verb(rt, ["uninstall"]) == 0
    assert not codex_toml(rt).exists()


def test_codex_append_keeps_existing_text_and_uninstall_returns_it(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        codex_toml(rt).parent.mkdir(parents=True)
        codex_toml(rt).write_text('model = "gpt-6"\n')
        assert install(rt, board, "codex") == 0
        assert codex_toml(rt).read_text().startswith('model = "gpt-6"\n\n# >>> relayhall connector')
        assert run_verb(rt, ["uninstall"]) == 0
    assert codex_toml(rt).read_text() == 'model = "gpt-6"\n'


@pytest.mark.parametrize("text, expected", [
    ('mcp_servers.relayhall = { url = "x" }\n', "a form the installer does not edit"),
    ('[mcp_servers]\nrelayhall = { url = "x" }\n', "a form the installer does not edit"),
    ("this is = = not toml\n", "is not valid TOML"),
])
def test_codex_files_the_installer_cannot_edit_safely_are_refused_first(tmp_path, text, expected):
    pytest.importorskip("tomllib")
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        codex_toml(rt).parent.mkdir(parents=True)
        codex_toml(rt).write_text(text)
        assert install(rt, board, "codex") == 1
    assert expected in rt.stderr.getvalue()
    assert codex_toml(rt).read_text() == text
    assert not rt.custody().exists(HANDLE) and rt.scheduler.calls == []


def test_codex_home_is_honoured(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        rt.environ["CODEX_HOME"] = str(tmp_path / "codex-home")
        assert install(rt, board, "codex") == 0
    assert (tmp_path / "codex-home" / "config.toml").is_file()


# ── VS Code and Antigravity ───────────────────────────────────────────────

def test_vscode_user_mcp_json(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        vscode_json(rt).parent.mkdir(parents=True)
        vscode_json(rt).write_text(json.dumps({"servers": {"git": {"command": "git-mcp"}}, "inputs": []}))
        assert install(rt, board, "vscode") == 0
        data = json.loads(vscode_json(rt).read_text())
        assert data["servers"]["relayhall"] == {"type": "stdio", "command": rt.python,
                                                "args": [str(rt.script)] + proxy_args()}
        assert data["servers"]["git"] == {"command": "git-mcp"} and data["inputs"] == []
        assert "skill" not in connector.load_manifest(rt, HANDLE)
        assert run_verb(rt, ["uninstall"]) == 0
    assert json.loads(vscode_json(rt).read_text()) == {"servers": {"git": {"command": "git-mcp"}}, "inputs": []}


def test_vscode_jsonc_is_refused_before_custody_and_prints_the_entry(tmp_path):
    jsonc = '{\n  // my servers\n  "servers": {}\n}\n'
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        vscode_json(rt).parent.mkdir(parents=True)
        vscode_json(rt).write_text(jsonc)
        assert install(rt, board, "vscode") == 1
    err = rt.stderr.getvalue()
    assert "not plain JSON" in err and '"relayhall"' in err and "connector" in err
    assert vscode_json(rt).read_text() == jsonc
    assert not rt.custody().exists(HANDLE) and rt.scheduler.calls == []


# ── Antigravity (owner ruling E475 (2)) ───────────────────────────────────
#
# Antigravity reads ~/.gemini/config/mcp_config.json: plain JSON, servers under
# `mcpServers`, each stdio server `{command, args}` (the shape recorded from a
# working Antigravity install: those two keys and nothing else). JSON carries no
# comments, so the managed "block" is ONE server entry the installer recognises
# by its marker field, `env.RELAYHALL_CONNECTOR = <connector name>`, which sits
# in the documented `env` map of a stdio server and names no secret.

def antigravity_json(rt):
    return home(rt) / ".gemini" / "config" / "mcp_config.json"


def antigravity_skill(rt):
    return home(rt) / ".gemini" / "antigravity" / "skills" / "relayhall-connection" / "SKILL.md"


def antigravity_backups(rt):
    folder = antigravity_json(rt).parent
    return sorted(p for p in folder.iterdir() if p.name.startswith("mcp_config.json.relayhall-backup-"))


def owned_entry(rt, name=HANDLE):
    return {"command": rt.python, "args": [str(rt.script)] + proxy_args(name),
            "env": {"RELAYHALL_CONNECTOR": name}}


ANTIGRAVITY_BEFORE = {
    "mcpServers": {
        "git": {"command": "uvx", "args": ["mcp-server-git", "--repository", "C:/work/repo"]},
        "browser": {"command": "npx", "args": ["-y", "@example/browser-mcp"], "env": {"BROWSER_PROFILE": "work"}},
    },
    "zzOtherTopLevelKey": {"keep": [1, 2.5, True, None, "ünïcödé"]},
}


def test_antigravity_fresh_install_writes_one_owned_entry_and_the_skill(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "antigravity") == 0, output(rt)
        data = json.loads(antigravity_json(rt).read_text(encoding="utf-8"))
        assert data == {"mcpServers": {"relayhall": owned_entry(rt)}}
        assert TOKEN not in antigravity_json(rt).read_text(encoding="utf-8")
        # Nothing was there before, so there is nothing to back up.
        assert antigravity_backups(rt) == []
        manifest = connector.load_manifest(rt, HANDLE)
        assert manifest["config"]["created"] is True and manifest["config"]["fileBackup"] is None
        skill = antigravity_skill(rt)
        assert Path(manifest["skill"]["path"]) == skill
        assert "OS custody" in skill.read_text(encoding="utf-8") and TOKEN not in skill.read_text(encoding="utf-8")
        out = rt.stdout.getvalue()
        assert f"written: {antigravity_json(rt)}" in out and "not written" not in out

        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["check"]) == 0, output(rt)
        assert f"mcp entry: present in {antigravity_json(rt)}" in rt.stdout.getvalue()

        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert not antigravity_json(rt).exists()  # install created it; uninstall takes it away again
    assert not skill.exists()
    assert TOKEN not in output(rt)


def test_antigravity_existing_file_is_backed_up_beside_it_and_every_other_key_is_kept(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        antigravity_json(rt).parent.mkdir(parents=True)
        original = json.dumps(ANTIGRAVITY_BEFORE, indent=4, ensure_ascii=False).encode("utf-8")
        antigravity_json(rt).write_bytes(original)
        assert install(rt, board, "antigravity") == 0, output(rt)

        data = json.loads(antigravity_json(rt).read_text(encoding="utf-8"))
        assert data["mcpServers"]["relayhall"] == owned_entry(rt)
        # Every other server and key is kept, in its order, with its exact value.
        without_ours = dict(data, mcpServers={k: v for k, v in data["mcpServers"].items() if k != "relayhall"})
        assert without_ours == ANTIGRAVITY_BEFORE
        assert list(data) == list(ANTIGRAVITY_BEFORE)
        assert list(data["mcpServers"]) == ["git", "browser", "relayhall"]

        # The backup: one timestamped copy BESIDE the file, the exact bytes it replaced, private.
        backups = antigravity_backups(rt)
        assert len(backups) == 1 and re.fullmatch(r"mcp_config\.json\.relayhall-backup-\d{8}T\d{6}Z", backups[0].name)
        assert backups[0].read_bytes() == original
        if os.name == "posix":
            assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600
        manifest = connector.load_manifest(rt, HANDLE)
        assert manifest["config"]["fileBackup"] == str(backups[0])
        assert str(backups[0]) in rt.stdout.getvalue()

        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
        # Uninstall removes ONLY the owned entry: the meaning of the file is what it was.
        assert json.loads(antigravity_json(rt).read_text(encoding="utf-8")) == ANTIGRAVITY_BEFORE
        # The backup is the person's restore point; uninstall keeps it and says where it is.
        assert antigravity_backups(rt) == backups
        assert str(backups[0]) in rt.stdout.getvalue()


def test_antigravity_second_run_changes_nothing_and_makes_no_second_backup(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        antigravity_json(rt).parent.mkdir(parents=True)
        antigravity_json(rt).write_text(json.dumps(ANTIGRAVITY_BEFORE), encoding="utf-8")
        assert install(rt, board, "antigravity") == 0, output(rt)
        first = connector.load_manifest(rt, HANDLE)
        written = antigravity_json(rt).read_bytes()
        stamp = antigravity_json(rt).stat().st_mtime_ns
        backups = antigravity_backups(rt)
        assert len(backups) == 1
        rt.now = lambda: connector.datetime.datetime(2031, 1, 2, 3, 4, 5, tzinfo=connector.datetime.timezone.utc)
        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert install(rt, board, "antigravity") == 0, output(rt)
        assert antigravity_json(rt).read_bytes() == written
        assert antigravity_json(rt).stat().st_mtime_ns == stamp
        assert antigravity_backups(rt) == backups
        assert connector.load_manifest(rt, HANDLE)["config"] == first["config"]
        assert "mcp entry  unchanged" in rt.stdout.getvalue()


@pytest.mark.parametrize("text, reason", [
    ('{\n  // my servers\n  "mcpServers": {}\n}\n', "not plain JSON"),
    ('{"mcpServers": {"git": {"command": "uvx"},}}\n', "not plain JSON"),
    ('{"mcpServers": {"git": {"command": "a"}, "git": {"command": "b"}}}\n', "the same key twice"),
    ('["mcpServers"]\n', "does not have the shape"),
    ('{"mcpServers": ["git"]}\n', "does not have the shape"),
    ('{"mcpServers": {"relayhall": "not an object"}}\n', "does not have the shape"),
], ids=["comments", "trailing-comma", "duplicate-key", "top-level-list", "servers-list", "entry-not-object"])
def test_antigravity_malformed_file_is_refused_without_writing(tmp_path, text, reason):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        antigravity_json(rt).parent.mkdir(parents=True)
        antigravity_json(rt).write_text(text, encoding="utf-8")
        before = antigravity_json(rt).read_bytes()
        assert install(rt, board, "antigravity") == 1
    err = rt.stderr.getvalue()
    assert reason in err and "Nothing was changed." in err
    assert antigravity_json(rt).read_bytes() == before
    assert antigravity_backups(rt) == []
    assert not rt.custody().exists(HANDLE) and rt.scheduler.calls == []
    assert not (Path(rt.state_root) / HANDLE).exists()
    assert not antigravity_skill(rt).exists()


def test_antigravity_hand_written_proxy_entry_is_replaced_and_put_back(tmp_path):
    """The entry a person added by hand (the proxy, no marker) is not the installer's: it is kept and restored."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        hand = {"command": rt.python, "args": [str(rt.script)] + proxy_args()}
        antigravity_json(rt).parent.mkdir(parents=True)
        antigravity_json(rt).write_text(json.dumps({"mcpServers": {"relayhall": hand}}, indent=2), encoding="utf-8")
        assert install(rt, board, "antigravity") == 0, output(rt)
        assert json.loads(antigravity_json(rt).read_text())["mcpServers"]["relayhall"] == owned_entry(rt)
        assert "replaced an earlier 'relayhall' entry" in rt.stdout.getvalue()
        manifest = connector.load_manifest(rt, HANDLE)
        assert manifest["config"]["replaced"] is True
        assert json.loads(Path(manifest["config"]["backup"]).read_text()) == {"mcpServers": {"relayhall": hand}}
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert json.loads(antigravity_json(rt).read_text()) == {"mcpServers": {"relayhall": hand}}


def test_antigravity_upgrade_from_an_install_that_wrote_no_config(tmp_path):
    """A connector installed before E475 (custody and task only, entry added by hand) re-runs install: the hand
    entry is kept and replaced, the file is backed up beside itself, and the skill is written."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "antigravity") == 0, output(rt)
        manifest = connector.load_manifest(rt, HANDLE)
        Path(manifest["skill"]["path"]).unlink()
        hand = {"command": rt.python, "args": [str(rt.script)] + proxy_args()}
        antigravity_json(rt).write_text(json.dumps({"mcpServers": {"relayhall": hand}}, indent=2), encoding="utf-8")
        older = {key: value for key, value in manifest.items() if key not in ("config", "skill")}
        connector.save_manifest(rt, older)  # what the S2 installer recorded for Antigravity
        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert install(rt, board, "antigravity") == 0, output(rt)
        upgraded = connector.load_manifest(rt, HANDLE)
        assert json.loads(antigravity_json(rt).read_text())["mcpServers"]["relayhall"] == owned_entry(rt)
        assert upgraded["config"]["replaced"] is True and upgraded["config"]["fileBackup"]
        assert len(antigravity_backups(rt)) == 1 and antigravity_skill(rt).is_file()
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert json.loads(antigravity_json(rt).read_text()) == {"mcpServers": {"relayhall": hand}}
    assert not antigravity_skill(rt).exists()


def test_antigravity_entry_owned_by_another_connector_is_refused(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        antigravity_json(rt).parent.mkdir(parents=True)
        antigravity_json(rt).write_text(json.dumps({"mcpServers": {"relayhall": owned_entry(rt, "other-one")}}))
        before = antigravity_json(rt).read_bytes()
        assert install(rt, board, "antigravity") == 1
    assert "belongs to connector 'other-one'" in rt.stderr.getvalue()
    assert antigravity_json(rt).read_bytes() == before and antigravity_backups(rt) == []


def test_antigravity_entry_that_carries_a_credential_is_refused_by_name(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        antigravity_json(rt).parent.mkdir(parents=True)
        antigravity_json(rt).write_text(json.dumps({"mcpServers": {"relayhall": {
            "serverUrl": board.origin + "/api/mcp", "headers": {"Authorization": f"Bearer {TOKEN}"}}}}))
        before = antigravity_json(rt).read_bytes()
        assert install(rt, board, "antigravity") == 1
    err = rt.stderr.getvalue()
    assert "carries a credential" in err and "headers.Authorization" in err and "SAME credential" in err
    assert TOKEN not in output(rt)
    assert antigravity_json(rt).read_bytes() == before and antigravity_backups(rt) == []


def test_antigravity_file_holding_another_servers_credential_is_never_copied(tmp_path):
    """S2 review B1 stands: a backup would be that credential on disk outside custody, so install makes none,
    says so, and still writes its own entry; uninstall still restores the file's meaning."""
    neighbour = {"command": "npx", "args": ["-y", "@example/git-mcp"],
                 "env": {"GIT_TOKEN": "ghp_" + "NeighbourSecretNeverCopied0000000000"}}
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        antigravity_json(rt).parent.mkdir(parents=True)
        antigravity_json(rt).write_text(json.dumps({"mcpServers": {"git": neighbour}}), encoding="utf-8")
        assert install(rt, board, "antigravity") == 0, output(rt)
        assert antigravity_backups(rt) == []
        out = rt.stdout.getvalue()
        assert "no backup" in out and "mcpServers.git.env.GIT_TOKEN" in out and "NeighbourSecret" not in out
        assert connector.load_manifest(rt, HANDLE)["config"]["fileBackup"] is None
        for path in all_files(home(rt)):
            if path != antigravity_json(rt):
                assert b"NeighbourSecret" not in path.read_bytes(), path
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert json.loads(antigravity_json(rt).read_text()) == {"mcpServers": {"git": neighbour}}


# ── a credential whose field path LOOKS opaque (E475 round-1 review B1) ───────
#
# A field name that is itself shaped like a secret is never PRINTED; it must
# never be dropped from what install DECIDES on. A dotted path of 32+ characters
# from [A-Za-z0-9_+=.-] with a digit is opaque-shaped although it names nothing
# secret: `mcpServers.context7.env.CONTEXT7_API_KEY` is 41 characters. Each case
# runs in every harness file the installer writes. The value is joined at run
# time so no secret-shaped literal sits in the committed text.

LONG_PATH_SECRET = "opaque" + "NeighbourSecretNeverCopied" + "1234"


def write_harness_file(rt, harness, servers, top=None):
    """`servers` ({name: {command, args, env}}) in the harness's own file format; returns the path."""
    path = connector.config_path(rt, harness)
    path.parent.mkdir(parents=True, exist_ok=True)
    if harness == "codex":
        lines = ['model = "gpt-6"', ""]
        for name, entry in servers.items():
            lines += [f"[mcp_servers.{name}]", f"command = {json.dumps(entry['command'])}",
                      f"args = {json.dumps(entry.get('args', []))}"]
            if entry.get("env"):
                lines += ["", f"[mcp_servers.{name}.env]"] + [f"{k} = {json.dumps(v)}" for k, v in entry["env"].items()]
            lines.append("")
        path.write_text("\n".join(lines), encoding="utf-8")
    else:
        data = dict(top or {})
        data["servers" if harness == "vscode" else "mcpServers"] = servers
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def copies_of(rt, secret, besides):
    return [p for p in all_files(home(rt)) if p != besides and secret.encode() in p.read_bytes()]


def neighbour_with(key):
    return {"command": "npx", "args": ["-y", "@example/mcp"], "env": {key: LONG_PATH_SECRET}}


ALL_HARNESSES = ["claude-code", "codex", "vscode", "antigravity"]


@pytest.mark.parametrize("harness", ALL_HARNESSES)
@pytest.mark.parametrize("server, key", [
    ("context7", "CONTEXT7_API_KEY"),             # 40+ characters with a digit: opaque-shaped
    ("server2", "GITHUB_PERSONAL_ACCESS_TOKEN"),  # ditto
    ("git", "GIT_TOKEN"),                         # CONTROL: a short path, printable
], ids=["long-path", "digit-path", "short-path"])
def test_a_neighbours_credential_is_never_copied_whatever_its_path_looks_like(tmp_path, harness, server, key):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        path = write_harness_file(rt, harness, {server: neighbour_with(key)})
        original = path.read_bytes()
        assert install(rt, board, harness) == 0, output(rt)
        assert copies_of(rt, LONG_PATH_SECRET, besides=path) == []
        assert LONG_PATH_SECRET not in output(rt)
        if harness == "antigravity":
            assert antigravity_backups(rt) == []
            assert connector.load_manifest(rt, HANDLE)["config"]["fileBackup"] is None
            out = rt.stdout.getvalue()
            assert f"no backup of {path}: it holds a credential" in out
            field = f"mcpServers.{server}.env.{key}"
            # The decision never depends on it, but a printable name is printed and an opaque one is not.
            assert (field in out) is (len(field) < 32)
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    if harness == "codex":
        assert path.read_bytes() == original
    else:
        assert json.loads(path.read_text()) == json.loads(original)


OWN_ENTRY_SECRET = "rv2" + "OwnEntryEditedCredential" + "55555"


def test_a_credential_added_inside_the_owned_entry_is_never_copied_on_reinstall(tmp_path):
    """Review B3: the person adds a credential INSIDE this connector's own entry (marker kept) and re-installs.
    Only what the installer itself wrote is set aside before the decision, so the added field withholds the
    whole-file copy, and no backup ever holds it."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        path = write_harness_file(rt, "antigravity", {"git": {"command": "uvx", "args": []}})
        assert install(rt, board, "antigravity") == 0, output(rt)
        data = json.loads(path.read_text(encoding="utf-8"))
        data["mcpServers"]["relayhall"]["env"]["EXTRA_API_KEY"] = OWN_ENTRY_SECRET  # the marker stays
        path.write_text(json.dumps(data), encoding="utf-8")
        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert install(rt, board, "antigravity") == 0, output(rt)
        assert copies_of(rt, OWN_ENTRY_SECRET, besides=path) == []
        assert [b for b in antigravity_backups(rt) if OWN_ENTRY_SECRET.encode() in b.read_bytes()] == []
        assert OWN_ENTRY_SECRET not in output(rt)


def test_reinstall_of_an_own_entry_with_a_long_digit_bearing_name_still_backs_up(tmp_path):
    """The carve-out's legitimate purpose: the installer's own fields (here a long, digit-bearing connector name in
    the marker) are no credential, so a re-install over a changed own entry still makes its whole-file backup."""
    name = "connector-pc-laptop-antigravity-2026102512345"
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        path = write_harness_file(rt, "antigravity", {"git": {"command": "uvx", "args": []}})
        assert install(rt, board, "antigravity", "--name", name) == 0, output(rt)
        before = antigravity_backups(rt)
        data = json.loads(path.read_text(encoding="utf-8"))
        data["mcpServers"]["relayhall"]["timeout"] = 60  # a harmless key the person added; installer fields unchanged
        path.write_text(json.dumps(data), encoding="utf-8")
        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert install(rt, board, "antigravity", "--name", name) == 0, output(rt)
        assert len(antigravity_backups(rt)) == len(before) + 1, output(rt)


def test_antigravity_another_top_level_key_with_a_long_path_is_never_copied(tmp_path):
    """Not only `mcpServers`: any other key of the file that holds a credential withholds the whole-file copy."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        top = {"modelProviders2031": {"openaiCompatible": {"apiKey": LONG_PATH_SECRET}}}
        path = write_harness_file(rt, "antigravity", {"git": {"command": "uvx", "args": []}}, top=top)
        assert install(rt, board, "antigravity") == 0, output(rt)
        assert antigravity_backups(rt) == [] and copies_of(rt, LONG_PATH_SECRET, besides=path) == []
        assert "no backup" in rt.stdout.getvalue() and LONG_PATH_SECRET not in output(rt)


@pytest.mark.parametrize("harness", ALL_HARNESSES)
def test_an_entry_whose_credential_path_looks_opaque_is_still_refused(tmp_path, harness):
    """The replaced-entry decision, in every config writer: an opaque-shaped path is unprintable, never absent.
    JSON entries are read from the entry (`env.GITHUB_PERSONAL_ACCESS_TOKEN_V2`, 35 characters); Codex reads the
    table (`mcp_servers.relayhall.env.GITHUB_PERSONAL_ACCESS_TOKEN_V2`)."""
    key = "GITHUB_PERSONAL_ACCESS_TOKEN_V2"
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        path = write_harness_file(rt, harness, {"relayhall": neighbour_with(key)})
        original = path.read_bytes()
        assert install(rt, board, harness) == 1, output(rt)
    err = rt.stderr.getvalue()
    assert "carries a credential" in err and "Nothing was changed." in err
    assert key not in err and LONG_PATH_SECRET not in output(rt)
    assert path.read_bytes() == original and copies_of(rt, LONG_PATH_SECRET, besides=path) == []
    assert not rt.custody().exists(HANDLE) and not (Path(rt.state_root) / HANDLE).exists()


# ── uninstall removes only the entry this connector owns (review B2) ─────────

@pytest.mark.parametrize("harness", ["claude-code", "vscode", "antigravity"])
@pytest.mark.parametrize("existing", [False, True], ids=["install-created-the-file", "file-was-there"])
def test_uninstall_leaves_an_entry_the_person_rewrote_without_the_marker(tmp_path, harness, existing):
    """The person replaced the installer's entry with their own under the same alias. It is theirs now:
    uninstall leaves it exactly as written (and keeps the file install had created)."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        path = connector.config_path(rt, harness)
        if existing:
            write_harness_file(rt, harness, {"git": {"command": "uvx", "args": ["a"]}})
        assert install(rt, board, harness) == 0, output(rt)
        container = "servers" if harness == "vscode" else "mcpServers"
        data = json.loads(path.read_text(encoding="utf-8"))
        data[container]["relayhall"] = {"command": "my-own-relayhall", "args": ["--mine"]}
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        mine = path.read_bytes()
        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    assert path.read_bytes() == mine
    assert f"{path} no longer holds this connector's 'relayhall' entry; left as it is." in rt.stdout.getvalue()


# ── a symbolic link is refused at plan time, before custody (review nice-to-have) ──

def test_antigravity_config_that_is_a_symbolic_link_is_refused_before_anything_is_written(tmp_path):
    """Refused when the plan is made: nothing reaches custody, no copy of the link's target is made, and the
    message is the plan-time one, not a rolled-back install."""
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        target = tmp_path / "elsewhere" / "mcp_config.json"
        target.parent.mkdir()
        target.write_text(json.dumps({"mcpServers": {"git": {"command": "uvx", "args": []}}}), encoding="utf-8")
        antigravity_json(rt).parent.mkdir(parents=True)
        try:
            os.symlink(target, antigravity_json(rt))
        except (OSError, NotImplementedError):
            pytest.skip("this platform does not let the test make a symbolic link")
        before = target.read_bytes()
        assert install(rt, board, "antigravity") == 1
    err = rt.stderr.getvalue()
    assert "is a symbolic link; the installer will not write through it. Nothing was changed." in err
    assert "install did not finish" not in err
    assert antigravity_json(rt).is_symlink() and target.read_bytes() == before
    assert antigravity_backups(rt) == [] and list(target.parent.iterdir()) == [target]
    assert not rt.custody().exists(HANDLE) and rt.scheduler.calls == []
    assert not (Path(rt.state_root) / HANDLE).exists()


def test_antigravity_byte_order_mark_is_kept(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        antigravity_json(rt).parent.mkdir(parents=True)
        antigravity_json(rt).write_bytes(b"\xef\xbb\xbf" + json.dumps(ANTIGRAVITY_BEFORE).encode("utf-8"))
        assert install(rt, board, "antigravity") == 0, output(rt)
        raw = antigravity_json(rt).read_bytes()
        assert raw.startswith(b"\xef\xbb\xbf")
        assert json.loads(raw[3:].decode("utf-8"))["mcpServers"]["relayhall"] == owned_entry(rt)
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
    raw = antigravity_json(rt).read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf") and json.loads(raw[3:].decode("utf-8")) == ANTIGRAVITY_BEFORE


def test_antigravity_status_names_the_file(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "antigravity") == 0, output(rt)
        rt.stdout.truncate(0), rt.stdout.seek(0)
        assert run_verb(rt, ["status"]) == 0
    assert f"relayhall: present in {antigravity_json(rt)}" in rt.stdout.getvalue()
    assert str(antigravity_skill(rt)) in rt.stdout.getvalue()


# ── check, status, uninstall ──────────────────────────────────────────────

def test_check_names_the_missing_harness_scopes(tmp_path):
    scopes = [s for s in connector.HARNESS_SCOPES if s not in ("telemetry:write", "principals:read")]
    with StubBoard(scopes=scopes) as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "vscode") == 0
        assert "lacks telemetry:write, principals:read" in rt.stdout.getvalue()
        assert run_verb(rt, ["check"]) == 1
    assert re.search(r"FAIL\s+scopes: missing telemetry:write, principals:read", rt.stdout.getvalue())


def test_check_fails_when_custody_is_gone(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "vscode") == 0
        rt.custody().delete(HANDLE)
        assert run_verb(rt, ["check"]) == 1
    assert re.search(r"FAIL\s+custody", rt.stdout.getvalue())


def test_check_fails_when_the_board_now_refuses_the_token(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "vscode") == 0
        board.token = "rh_live_ab12cd34ef56.RevokedAndReplaced000000000000"
        assert run_verb(rt, ["check"]) == 1
    report = rt.stdout.getvalue()
    assert re.search(r"FAIL\s+whoami", report) and re.search(r"FAIL\s+mcp proxy", report)
    assert TOKEN not in output(rt)


def test_status_with_nothing_installed(tmp_path):
    rt = make_runtime(tmp_path)
    assert run_verb(rt, ["status"]) == 0
    assert "No RelayHall connector is installed" in rt.stdout.getvalue()


def test_uninstall_leaves_a_task_someone_repointed(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "vscode") == 0
        task = f"RelayHall Connector {HANDLE}"
        rt.scheduler.tasks[task] = "<Task><Arguments>something else</Arguments></Task>"
        assert run_verb(rt, ["uninstall"]) == 1
    assert task in rt.scheduler.tasks
    assert (Path(rt.state_root) / HANDLE / "connector.json").is_file()  # record kept for a re-run


def test_uninstall_never_touches_files_install_did_not_write(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "claude-code") == 0
        stray = Path(rt.state_root) / HANDLE / "person-notes.txt"
        stray.write_text("mine")
        neighbour = Path(rt.state_root) / "other-connector" / "keep.txt"
        neighbour.parent.mkdir(parents=True)
        neighbour.write_text("keep")
        assert run_verb(rt, ["uninstall"]) == 0
    assert stray.read_text() == "mine" and neighbour.read_text() == "keep"
    assert "still holds files install did not write" in rt.stdout.getvalue()


def test_run_records_that_it_ran_and_exits(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board, "vscode") == 0
        assert run_verb(rt, ["run", "--name", HANDLE]) == 0
        state = json.loads((Path(rt.state_root) / HANDLE / "run-state.json").read_text())
        assert state["result"] == "custody ok; collector not configured"
        rt.custody().delete(HANDLE)
        assert run_verb(rt, ["run", "--name", HANDLE]) == 1


def test_the_harness_set_is_the_dashboard_set():
    """Derived from the dashboard source, not restated: the two lists cannot drift."""
    source = (REPO / "frontend" / "src" / "types" / "connections.ts").read_text(encoding="utf-8")
    working = re.search(r"export const AGENT_WORKING_SCOPES: string\[\] = \[(.*?)\];", source, re.S).group(1)
    harness = re.search(r"export const HARNESS_CONNECTOR_SCOPES: string\[\] = \[(.*?)\];", source, re.S).group(1)
    assert "...AGENT_WORKING_SCOPES" in harness
    # Family names may carry a hyphen (`knowledge-contents:read`): a pattern without one would silently drop it.
    expected = re.findall(r"'([a-z-]+:[a-z]+)'", working) + re.findall(r"'([a-z-]+:[a-z]+)'", harness)
    assert len(expected) == len(re.findall(r"'[^']*'", working)) + len(re.findall(r"'[^']*'", harness))
    assert connector.HARNESS_SCOPES == expected
    assert not any(s == "root" or s.endswith(":admin") or s == "services:write" for s in connector.HARNESS_SCOPES)


def test_the_harness_set_is_the_ratified_set_written_out():
    """E462 section 3.1 plus owner rulings E475 (1) and E480, as literals: an edit to the constant alone fails here."""
    assert connector.HARNESS_SCOPES == [
        "tasks:read", "tasks:write", "reports:read", "reports:write",
        "projects:read", "phases:read", "skills:read", "skills:use",
        "telemetry:write", "services:read", "principals:read",
        "knowledge-contents:read", "personalities:read", "blueprints:use",
        "projects:write", "phases:write",
    ]
    assert len(connector.HARNESS_SCOPES) == len(set(connector.HARNESS_SCOPES)) == 16
    assert "blueprints:read" not in connector.HARNESS_SCOPES
    assert "root" not in connector.HARNESS_SCOPES and "services:write" not in connector.HARNESS_SCOPES
    assert [s for s in connector.HARNESS_SCOPES if s.endswith(":admin")] == []
