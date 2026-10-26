"""The connector's token never reaches argv, an environment, output, a log or a
file (E462 slice S2; design v1.5 sections 3.2, 3.3 and 8).

Two censuses, each with a negative control:

1. STATIC. Every output, logging and process-launch call site in the three
   connector modules (print, say, _note, *.write, logging.*, subprocess.*,
   os.system/spawn*/exec*, Popen) is found from the AST, and none of their
   arguments may mention a token-bearing name (token, _token, self._token,
   secret, plaintext), except as the redaction key of `scrub(text, token)`.
   An environment handed to a child (`env=`) must come from `child_env()`.
   The rule is checked against planted violations, so a checker that matches
   nothing cannot pass.

2. RUNTIME. A whole life cycle (install, check, status, run, the MCP proxy,
   uninstall) runs against the stub board with every machine-facing seam
   recorded: each schtasks argv and env, each proxy spawn's env, stdout and
   stderr, every file left anywhere under the temporary home at each stage,
   and every request the board received. The token appears in exactly one
   place: the Authorization header of a request to the board.
"""
import ast
import io
import json
import subprocess
from pathlib import Path

import pytest

import relayhall_connector as connector
from connector_testkit import (HANDLE, TOKEN, StubBoard, accounts, all_files, make_runtime, output, registration, run_verb,
                               sign_in, use_collector, write_collector_config)

CLI = Path(__file__).resolve().parent
MODULES = ["relayhall_connector.py", "relayhall_connector_mcp.py", "relayhall_connector_custody.py",
           # Slice S3: the collector, its trust check and its owned child processes.
           "relayhall_connector_collector.py", "relayhall_connector_trust.py", "relayhall_connector_proc.py",
           # Slice S5: the ring (wake receiver, policy, runs) and its WebSocket client.
           "relayhall_connector_ring.py", "relayhall_connector_ws.py"]
TOKEN_NAMES = {"token", "_token", "secret", "plaintext", "line", "credential", "_credential",
               # Slice S5: a run's Agent credential, the connector's token where the ring scrubs with it, and the
               # bearer a ring Board holds.
               "agent_secret", "connector_secret", "_bearer", "bearer"}
# Printers, the check report's `record`, and the exception classes whose text
# `run()` prints.
SINK_NAMES = {"print", "say", "_note", "record", "ConnectorError", "CustodyError", "UnsupportedPlatform",
              # Slice S3: the collector's refusals and every local record it writes.
              "Refusal", "TrustRefusal", "ChildError", "_write_json", "need",
              # Slice S5: the ring's refusals, its event record and its local state writer.
              "RingError", "WebSocketError", "_record", "write_state", "_outcome", "_finish_decision"}
SINK_ATTRS = {"write", "writelines", "debug", "info", "warning", "error", "exception", "critical", "log",
              "system", "popen", "run", "Popen", "call", "check_call", "check_output", "spawnv", "spawnve",
              "execv", "execve"}
# Writes whose argument is DATA by design, not a diagnostic: the proxy's JSON-RPC
# line (built by _emit from a reply), the DPAPI blob, and files built from a
# record the census below proves token-free at runtime.
EXEMPT_WRITE_ARGS = {"line", "blob", "text", "content", "xml"}


def _mentions(node, names):
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id in names:
            return True
        if isinstance(child, ast.Attribute) and child.attr in names:
            return True
        # Slice S5: a record keyed by a token-bearing name (`pack["agent_secret"]`) is the token too.
        if isinstance(child, ast.Subscript) and isinstance(child.slice, ast.Constant) and child.slice.value in names:
            return True
    return False


def _strip_scrub_keys(node):
    """A copy of `node` with the redaction key of every scrub(x, token) removed."""
    node = ast.parse(ast.unparse(node), mode="eval").body
    for child in ast.walk(node):
        if isinstance(child, ast.Call) and getattr(child.func, "id", None) == "scrub" and len(child.args) == 2:
            child.args = child.args[:1]
    return node


def violations(source, filename="<source>"):
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
        if name not in SINK_NAMES and name not in SINK_ATTRS:
            continue
        arguments = list(node.args) + [k.value for k in node.keywords if k.arg != "env"]
        if name in ("write", "writelines") and all(isinstance(a, ast.Name) and a.id in EXEMPT_WRITE_ARGS
                                                    for a in node.args):
            continue
        for argument in arguments:
            if _mentions(_strip_scrub_keys(argument), TOKEN_NAMES):
                found.append(f"{filename}:{node.lineno}: {ast.unparse(node)[:120]}")
                break
        for keyword in node.keywords:
            if keyword.arg == "env" and not (isinstance(keyword.value, ast.Call)
                                             and getattr(keyword.value.func, "attr", None) == "child_env"):
                found.append(f"{filename}:{node.lineno}: env= not from child_env()")
    return found


def sink_count(source):
    count = 0
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            count += name in SINK_NAMES or name in SINK_ATTRS
    return count


@pytest.mark.parametrize("module", MODULES)
def test_no_output_or_launch_site_mentions_the_token(module):
    source = (CLI / module).read_text(encoding="utf-8")
    assert sink_count(source) > 0, "the census found no call sites at all"
    assert violations(source, module) == []


@pytest.mark.parametrize("planted", [
    "print(token)",
    "print(f'got {token}')",
    "say(rt, 'x ' + token)",
    "self._note(self._token)",
    "sys.stderr.write(token)",
    "subprocess.run(['schtasks', token])",
    "subprocess.Popen(argv, env={'RELAYHALL_TOKEN': token})",
    "logging.info('%s', secret)",
    "os.system('x ' + token)",
    "say(rt, scrub(token, other))",
    "record('whoami', False, token)",
    "raise ConnectorError(f'bad {token}')",
    "handle.write(self._credential)",
    "raise Refusal(credential)",
    "_write_json(path, {'auth': self._credential})",
])
def test_the_census_catches_planted_leaks(planted):
    assert violations(planted) != []


@pytest.mark.parametrize("clean", [
    "say(rt, scrub(error, token))",
    "self._note(f'could not reach: {reason}')",
    "subprocess.run(argv, env=self.child_env())",
    "handle.write(blob)",
])
def test_the_census_passes_redacted_and_data_writes(clean):
    assert violations(clean) == []


def _assert_nowhere(rt, root, label, person_owned=None):
    """No file anywhere holds the token or its secret half, backups included. `person_owned` maps a file the
    PERSON put the token in before install to the number of copies it held: that file may keep exactly
    those copies (the connector never removes what is not its own) and never gains one."""
    person_owned = person_owned or {}
    for path in all_files(root):
        data = path.read_bytes()
        if path in person_owned:
            assert data.count(TOKEN.encode()) <= person_owned[path], f"{label}: install copied the token into {path}"
            continue
        assert TOKEN.encode() not in data, f"{label}: token in {path}"
        assert TOKEN.split(".")[1].encode() not in data, f"{label}: secret half in {path}"
    assert TOKEN not in output(rt), f"{label}: token on stdout/stderr"
    for call in rt.scheduler.calls:
        assert all(TOKEN not in part for part in call["argv"]), f"{label}: token in schtasks argv"
        assert TOKEN not in json.dumps(call["env"]), f"{label}: token in schtasks env"
    for spawn in rt.spawned:
        assert TOKEN not in json.dumps(spawn), f"{label}: token in the proxy's argv/env"


@pytest.mark.parametrize("harness", ["claude-code", "codex", "vscode", "antigravity"])
def test_the_whole_life_cycle_leaks_the_token_nowhere(tmp_path, harness):
    root = tmp_path
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        rt.environ["RELAYHALL_TOKEN"] = "rh_live_zz99zz99zz99.ShellTokenTheConnectorIgnores00"
        assert run_verb(rt, ["install", "--harness", harness, "--board", board.origin]) == 0, output(rt)
        _assert_nowhere(rt, root, "install")
        assert run_verb(rt, ["check"]) == 0, output(rt)
        assert run_verb(rt, ["status"]) == 0
        name = connector.installed_names(rt)[0]
        assert run_verb(rt, ["run", "--name", name]) == 0
        _assert_nowhere(rt, root, "check/status/run")
        mcp_out = io.BytesIO()
        saved = rt.stdout, rt.stdin
        rt.stdout = io.TextIOWrapper(mcp_out, encoding="utf-8", write_through=True)
        rt.stdin = io.TextIOWrapper(io.BytesIO(
            b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
            b'{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'), encoding="utf-8")
        assert run_verb(rt, ["mcp", "--name", name]) == 0
        assert TOKEN.encode() not in mcp_out.getvalue()
        rt.stdout, rt.stdin = saved
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
        _assert_nowhere(rt, root, "uninstall")
    assert board.requests, "the board was never called"
    for request in board.requests:
        assert TOKEN not in request["path"] and TOKEN.encode() not in request["body"]
        for key, value in request["headers"].items():
            if TOKEN in value:
                assert key.lower() == "authorization" and value == f"Bearer {TOKEN}"
    authorised = [r for r in board.requests if r["headers"].get("Authorization") == f"Bearer {TOKEN}"]
    assert authorised and all(r["path"] != "/api/health" for r in authorised)


OTHER_TOKEN = "rh_live_0ld0ld0ld0ld.OldSecretInTheConfigFile00000"


def _onboarding_block(board, token):
    return {"type": "http", "url": board.origin + "/api/mcp", "headers": {"Authorization": f"Bearer {token}"}}


@pytest.mark.parametrize("case", ["same-token-entry", "other-token-entry", "same-token-elsewhere"])
def test_a_harness_file_that_already_holds_a_credential_leaks_it_nowhere(tmp_path, case):
    """S2 review B1, as a census: the person's harness file already carries a credential (the onboarding pack's
    manual Claude Code block, or a project-scoped copy). At every stage of the life cycle the connector's token,
    and the other credential, are in no file but the person's own, which never gains a copy: not in a backup,
    not in the record, not in the skill, not on any output."""
    root = tmp_path
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        harness_file = Path(rt.environ["USERPROFILE"]) / ".claude.json"
        if case == "same-token-elsewhere":
            # A credential-free entry install replaces (so a backup IS taken) beside a project-scoped
            # copy of the token the person keeps: the backup must hold the entry alone.
            data = {"projects": {"C:/work": {"mcpServers": {"relayhall": _onboarding_block(board, TOKEN)}}},
                    "mcpServers": {"relayhall": {"command": "old-relayhall-adapter"}}}
        else:
            held = TOKEN if case == "same-token-entry" else OTHER_TOKEN
            data = {"mcpServers": {"relayhall": _onboarding_block(board, held)}}
        harness_file.write_text(json.dumps(data))
        original = harness_file.read_bytes()
        owned = {harness_file: original.count(TOKEN.encode())}

        def nowhere(label):
            _assert_nowhere(rt, root, label, owned)
            for path in all_files(root):
                if path != harness_file:
                    assert OTHER_TOKEN.encode() not in path.read_bytes(), f"{label}: other credential in {path}"
            assert OTHER_TOKEN not in output(rt)

        argv = ["install", "--harness", "claude-code", "--board", board.origin]
        if case != "same-token-elsewhere":
            assert run_verb(rt, argv) == 1  # refused by name of the file and entry
            assert harness_file.read_bytes() == original
            nowhere("refused install")
            argv += ["--alias", "board2"]
        assert run_verb(rt, argv) == 0, output(rt)
        nowhere("install")
        assert run_verb(rt, ["check"]) == 0, output(rt)
        assert run_verb(rt, ["status"]) == 0
        assert run_verb(rt, ["run", "--name", connector.installed_names(rt)[0]]) == 0
        nowhere("check/status/run")
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
        nowhere("uninstall")
    assert json.loads(harness_file.read_text()) == json.loads(original)


def test_the_real_runtime_strips_a_shell_token_from_children(monkeypatch):
    seen = []

    class Recorder:
        def __init__(self, argv, **kwargs):
            seen.append((argv, kwargs.get("env")))
            self.stdin = io.BytesIO()
            self.stdout = io.BytesIO()

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(subprocess, "Popen", Recorder)
    monkeypatch.setattr(subprocess, "run", lambda argv, **kwargs: seen.append((argv, kwargs.get("env"))))
    rt = connector.Runtime(environ={"RELAYHALL_TOKEN": TOKEN, "PATH": "/bin"})
    rt.spawn_mcp("laptop")[2]()
    rt.run(["schtasks", "/Query", "/TN", "x"])
    assert len(seen) == 2
    for argv, env in seen:
        assert TOKEN not in json.dumps(argv)
        assert env == {"PATH": "/bin"}
    assert seen[0][0][-4:] == ["connector", "mcp", "--name", "laptop"]


@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_the_collector_leaks_the_token_nowhere(tmp_path, harness):
    """Slice S3, the runtime census over the collector: collect --check, collect --once (a reading, a 429, a
    refused read reported by name), the scheduled run and status. The token travels in exactly one place, the
    Authorization header of a request to the board, and the provider child never sees it: its environment is
    an allowlist built from child_env(), recorded here at every spawn."""
    import relayhall_connector_collector as collector_module
    from connector_testkit import CLAUDE_USAGE, CODEX_LIMITS
    spawned = []

    def reader(binary, reg, environ, timeout, cwd=None):
        spawned.append({"argv": [binary], "env": collector_module.provider_env(harness, reg, environ)})
        if reg["registrationId"] == "pc-b":
            raise collector_module.Refusal("PROVIDER_USAGE_REFUSED")
        if harness == "codex":
            return {"data": CODEX_LIMITS, "observedAt": "2026-10-24T17:00:00.000Z"}
        return CLAUDE_USAGE

    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        rt.environ["RELAYHALL_TOKEN"] = "rh_live_zz99zz99zz99.ShellTokenTheConnectorIgnores00"
        assert run_verb(rt, ["install", "--harness", harness, "--board", board.origin]) == 0, output(rt)
        sign_in(rt.environ["USERPROFILE"])
        write_collector_config(rt, HANDLE, harness, accounts(rt, harness))
        use_collector(rt, readers={harness: reader}, attempts=1)
        board.fail[("POST", "/api/telemetry/quotas")] = [429]
        assert run_verb(rt, ["collect", "--check"]) == 1
        assert run_verb(rt, ["collect", "--once"]) == 1
        assert run_verb(rt, ["run", "--name", HANDLE]) == 1
        assert run_verb(rt, ["status"]) == 0
        _assert_nowhere(rt, tmp_path, "collector")
        assert run_verb(rt, ["uninstall"]) == 0, output(rt)
        _assert_nowhere(rt, tmp_path, "collector uninstall")
    assert spawned and board.quota_posts() and board.events
    for spawn in spawned:
        blob = json.dumps(spawn)
        assert TOKEN not in blob and "ShellTokenTheConnectorIgnores" not in blob and "RELAYHALL_TOKEN" not in blob
    for request in board.requests:
        assert TOKEN not in request["path"] and TOKEN.encode() not in request["body"]
        for key, value in request["headers"].items():
            if TOKEN in value:
                assert key.lower() == "authorization" and value == f"Bearer {TOKEN}"


# ── slice S5: the ring and the per-run Agent credential ────────────────────────

@pytest.mark.parametrize("planted", [
    "print(agent_secret)",
    "self._record(what='x', value=agent_secret)",
    "_write_json(path, {'pack': pack['agent_secret']})",
    "subprocess.run([binary, '--token', agent_secret])",
    "sys.stderr.write(connector_secret)",
    "raise RingError(self._bearer)",
])
def test_the_census_catches_planted_ring_leaks(planted):
    assert violations(planted) != []


@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_the_ring_leaks_neither_credential_anywhere(tmp_path, harness):
    """The ring's runtime census: an implement wake, a run, its Report, the revoke, a catch-up pass and status.
    The connector token travels only as the Authorization header of the connector's own requests (and the wake
    socket's handshake); the run's Agent credential only as the Authorization header of the Agent's requests
    and inside the run folder's custody entry while the run lives. Neither is in the harness's argv or
    environment, a socket frame, a notification, a local record, the run's Report, any output, or any file left
    behind."""
    import relayhall_connector_ring as ring_module
    from connector_testkit import (AGENT_TOKEN, CLAUDE_STREAM, CODEX_STREAM, FakeSocket, RecordingNotifier,
                                   RecordingSpawn, RingRoutes, TASK_ID, WAKE_ID, assigned_task, install_for_ring,
                                   make_ring, wait_for, write_ring_policy)
    with StubBoard() as board:
        routes = RingRoutes(board)
        rt = install_for_ring(tmp_path, board, harness=harness)
        rt.environ["RELAYHALL_TOKEN"] = "rh_live_zz99zz99zz99.ShellTokenTheConnectorIgnores00"
        # A credential-shaped value under any other name must not reach a run either (harness_env).
        rt.environ["SAVED_BOARD_KEY"] = "rh_live_" + "zz88zz88zz88" + "." + "SavedKeyTheRunMustNotSee" + "000"
        workdir = tmp_path / "work"
        workdir.mkdir()
        write_ring_policy(rt, HANDLE, workdir)
        routes.add_task(assigned_task())
        # The harness's own output quotes both credentials: the Report must carry neither.
        leaky = [dict(line) for line in (CLAUDE_STREAM if harness == "claude-code" else CODEX_STREAM)]
        leaky.append({"type": "result", "subtype": "success", "is_error": False,
                      "result": f"echo {AGENT_TOKEN} and {TOKEN}"})
        spawn = RecordingSpawn(leaky, on_start=lambda: routes.tasks[TASK_ID].update(status="in-progress"))
        notifier = RecordingNotifier()
        sock = FakeSocket()
        ring = make_ring(rt, sock=sock, spawn=spawn, notifier=notifier, run_root=str(tmp_path))
        ring.start()
        ring.on_message(sock, json.dumps({"type": "wake.status", "enabled": True}))
        ring.on_message(sock, json.dumps({"type": "wake", "wakeId": WAKE_ID, "taskId": TASK_ID, "kind": "implement",
                                          "cursor": "3", "attempt": 1}))
        assert wait_for(ring.idle), ring.events
        ring.reconcile()
        assert wait_for(ring.idle), ring.events
        assert run_verb(rt, ["status"]) == 0
        ring.stop()
        _assert_nowhere(rt, tmp_path, "ring")
        for path in all_files(tmp_path):
            assert AGENT_TOKEN.encode() not in path.read_bytes(), f"agent credential left in {path}"
    call = spawn.calls[0]
    assert call["files"]["agent.cred"]  # it existed while the run lived, in the run folder only
    assert ring_module.RUN_CREDENTIAL not in [p.name for p in all_files(tmp_path)]
    for blob in (json.dumps(call["argv"]), json.dumps(call["env"]), json.dumps(sock.sent), json.dumps(notifier.sent),
                 json.dumps(ring.events), output(rt)):
        assert AGENT_TOKEN not in blob and TOKEN not in blob and "ShellTokenTheConnectorIgnores" not in blob
        assert "SavedKeyTheRunMustNotSee" not in blob
    assert "RELAYHALL_TOKEN" not in call["env"]
    assert all(AGENT_TOKEN not in json.dumps(r["body"]) and TOKEN not in json.dumps(r["body"])
               for r in routes.reports + routes.stream)
    assert routes.reports and "[redacted]" in routes.reports[0]["body"]["content"]
    for request in board.requests:
        assert TOKEN not in request["path"] and AGENT_TOKEN not in request["path"]
        assert TOKEN.encode() not in request["body"] and AGENT_TOKEN.encode() not in request["body"]
        for key, value in request["headers"].items():
            if TOKEN in value or AGENT_TOKEN in value:
                assert key.lower() == "authorization" and value in (f"Bearer {TOKEN}", f"Bearer {AGENT_TOKEN}")
    agent_calls = [c for c in routes.calls if c["who"] == "agent"]
    assert agent_calls and {c["path"] for c in agent_calls} <= {f"/api/tasks/{TASK_ID}/claim",
                                                                f"/api/tasks/{TASK_ID}/reports",
                                                                f"/api/tasks/{TASK_ID}/stream"}
