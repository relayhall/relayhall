"""The connector's ring (owner ruling E462, slice S5; universal harness connector
design v1.5 sections 6.1-6.7): the wake receiver, catch-up, the local policy,
the Agent per run, the harness runners and notifications.

Every test drives the real Ring over the stub board (real HTTP on 127.0.0.1)
with the machine-facing seams doubled: the wake socket (FakeSocket, or the real
WebSocket client against WakeEndpoint), the harness spawn (RecordingSpawn
answering the recorded stream format), publisher trust, notifications. The
end-to-end tests at the bottom start a REAL stand-in harness process that
starts the REAL per-run proxy (`relayhall connector mcp --run`).
"""
import http.server
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.parse as urllib_parse
from pathlib import Path

import pytest

import relayhall_connector as connector
import relayhall_connector_custody as custody_module
import relayhall_connector_ring as ring_module
from connector_testkit import (AGENT_TOKEN, APPROVAL_ID, CLAUDE_STREAM, CODEX_STREAM, HANDLE, OTHER_SERVICE,
                               PRINCIPAL_ID, PROJECT_ID, SERVICE_ID, TASK_ID, TASK_TITLE, TOKEN, WAKE_ID, FakeRunTrust,
                               FakeSocket, RecordingNotifier, RecordingSpawn, RingRoutes, StubBoard, WakeEndpoint,
                               all_files, assigned_task, codex_stderr, install_for_ring, make_ring, output, run_verb,
                               wait_for, write_ring_policy)
from relayhall_connector_ws import WebSocket, WebSocketError, socket_url

OTHER_TASK = "7a5c0000-0000-4000-8000-0000000000b2"


@pytest.fixture
def board():
    with StubBoard() as stub:
        yield stub


@pytest.fixture
def setup(tmp_path, board):
    routes = RingRoutes(board)
    rt = install_for_ring(tmp_path, board)
    workdir = tmp_path / "work"
    workdir.mkdir()
    write_ring_policy(rt, HANDLE, workdir)
    return {"rt": rt, "routes": routes, "workdir": workdir, "board": board, "tmp": tmp_path}


def wake(kind="implement", task_id=TASK_ID, wake_id=WAKE_ID):
    return {"type": "wake", "wakeId": wake_id, "taskId": task_id, "kind": kind, "cursor": "7", "attempt": 1}


def started_ring(s, **kwargs):
    sock = kwargs.pop("sock", None) or FakeSocket()
    ring = make_ring(s["rt"], sock=sock, run_root=str(s["tmp"]), **kwargs)
    ring.start()
    ring.socket = sock
    ring.on_message(sock, json.dumps({"type": "wake.status", "enabled": True}))
    return ring, sock


def settle(ring):
    assert wait_for(ring.idle), ring.events
    return ring


def outcomes(sock):
    return [(f["outcome"], f["reason"]) for f in sock.of("wake.outcome")]


def in_progress(routes, task_id=TASK_ID):
    return lambda: routes.tasks[task_id].update(status="in-progress")


# ── the local policy ───────────────────────────────────────────────────────────

def test_policy_defaults_and_bounds():
    policy = ring_module.validate_policy({"schemaVersion": "rh.connector-ring/1", "enabled": True})
    assert policy["kinds"] == {"implement": "run", "verify": "run", "stuck": "notify"}
    assert (policy["maxConcurrentRuns"], policy["runTimeoutMinutes"], policy["workdirs"], policy["hold"]) == (1, 60, [], False)
    assert policy["claude"]["permissionMode"] == "acceptEdits"
    assert policy["codex"]["sandbox"] == "workspace-write"


@pytest.mark.parametrize("change, where", [
    ({"unknown": 1}, "unknown-field"),
    ({"schemaVersion": "rh.connector-ring/2"}, "schemaVersion"),
    ({"enabled": "yes"}, "enabled"),
    ({"kinds": {"stuck": "run"}}, "kinds.stuck"),
    ({"kinds": {"review": "run"}}, "kinds"),
    ({"maxConcurrentRuns": 0}, "maxConcurrentRuns"),
    ({"maxConcurrentRuns": 5}, "maxConcurrentRuns"),
    ({"runTimeoutMinutes": 241}, "runTimeoutMinutes"),
    ({"workdirs": [{"path": "relative/dir"}]}, "workdirs[0].path"),
    ({"workdirs": [{"path": "/abs", "projects": ["not-a-uuid"]}]}, "workdirs[0].projects"),
    ({"serviceId": "x"}, "serviceId"),
    ({"claude": {"permissionMode": "bypassPermissions"}}, "claude.permissionMode"),
    ({"codex": {"sandbox": "danger-full-access"}}, "codex.sandbox"),
])
def test_policy_refuses_what_it_does_not_know(change, where):
    raw = dict({"schemaVersion": "rh.connector-ring/1", "enabled": True}, **change)
    with pytest.raises(ring_module.RingError) as caught:
        ring_module.validate_policy(raw)
    assert (caught.value.code, caught.value.board_code) == ("RING_POLICY_INVALID", where)


def test_no_policy_file_means_no_ring(tmp_path):
    assert ring_module.load_policy(tmp_path) is None


def test_run_scopes_never_ask_for_more_than_the_connector_holds():
    held = ["tasks:read", "tasks:write", "reports:read", "telemetry:write"]
    assert ring_module.run_scopes("implement", held) == ["tasks:read", "tasks:write", "reports:read", "telemetry:write"]
    assert ring_module.run_scopes("verify", connector.HARNESS_SCOPES) == ring_module.VERIFY_SCOPES


def test_run_scopes_refuse_an_admin_scope(monkeypatch):
    monkeypatch.setattr(ring_module, "IMPLEMENT_SCOPES", ring_module.IMPLEMENT_SCOPES + ["tasks:admin"])
    with pytest.raises(ring_module.RingError) as caught:
        ring_module.run_scopes("implement", ["tasks:admin"])
    assert caught.value.code == "AGENT_SCOPE_REFUSED"


def live_n14_source():
    return (Path(__file__).resolve().parents[1] / "backend" / "src" / "__tests__"
            / "connectorRunClaimLive.test.ts").read_text(encoding="utf-8")


def test_implement_scopes_match_the_live_n14_drill():
    block = live_n14_source().split("const IMPLEMENT_SCOPES = [", 1)[1].split("];", 1)[0]
    assert [part.strip().strip("'") for part in block.replace("\n", "").split(",") if part.strip()] \
        == ring_module.IMPLEMENT_SCOPES


def test_the_implement_mint_body_is_the_live_n14_drills_daemon_body():
    """The live suite proves the claim/finish path with the daemon's EXACT body: no `via`, no `warrantId`."""
    source, literal = live_n14_source(), "const DAEMON_IMPLEMENT_MINT = (taskId: string) => ({"
    assert literal in source
    block = source.split(literal, 1)[1].split("});", 1)[0]
    pairs = dict(re.findall(r"(\w+): ([^,\n]+)", block))
    body = ring_module.mint_body("implement", TASK_ID, ring_module.IMPLEMENT_SCOPES)
    assert sorted(pairs) == sorted(body) == ["label", "requestedScopes", "role", "targetTaskId"]
    assert (pairs["targetTaskId"], pairs["requestedScopes"]) == ("taskId", "IMPLEMENT_SCOPES")
    assert (pairs["role"].strip("'"), pairs["label"].strip("'")) == (body["role"], body["label"])
    assert body["targetTaskId"] == TASK_ID and body["requestedScopes"] == ring_module.IMPLEMENT_SCOPES
    assert ring_module.mint_body("verify", TASK_ID, ring_module.VERIFY_SCOPES)["via"] == "warrant"


# ── the WebSocket client against a real endpoint ───────────────────────────────

def test_websocket_client_speaks_rfc6455_with_the_bearer_in_a_header(board):
    endpoint = WakeEndpoint(board)
    url = socket_url(board.origin, "/api/events/ws?cursor=0&wake=2")
    sock = WebSocket.connect(url, {"Authorization": f"Bearer {TOKEN}"}, 10)
    endpoint.send({"type": "wake.status", "enabled": True})
    assert json.loads(sock.recv(10)) == {"type": "wake.status", "enabled": True}
    sock.send_text(json.dumps({"type": "wake.ack", "wakeId": WAKE_ID}))
    assert wait_for(lambda: endpoint.received)
    assert endpoint.received == [{"type": "wake.ack", "wakeId": WAKE_ID}]
    endpoint.end()
    with pytest.raises(WebSocketError):
        while True:
            sock.recv(10)
    shake = endpoint.handshakes[0]
    assert shake["path"] == "/api/events/ws?cursor=0&wake=2" and TOKEN not in shake["path"]
    assert shake["headers"]["Authorization"] == f"Bearer {TOKEN}"


def test_websocket_refusal_is_named_by_status(board):
    endpoint = WakeEndpoint(board)
    endpoint.refuse_status = 401
    with pytest.raises(WebSocketError) as caught:
        WebSocket.connect(socket_url(board.origin, "/api/events/ws?wake=2"), {"Authorization": "Bearer x"}, 10)
    assert (caught.value.code, caught.value.status) == ("WS_HANDSHAKE_REFUSED", 401)


def test_plain_ws_is_refused_off_loopback():
    with pytest.raises(WebSocketError) as caught:
        socket_url("http://board.example", "/api/events/ws")
    assert caught.value.code == "WS_BOARD_NOT_HTTPS"
    assert socket_url("https://board.example", "/api/events/ws?wake=2") == "wss://board.example/api/events/ws?wake=2"


# ── receiving ──────────────────────────────────────────────────────────────────

def test_a_wake_is_acknowledged_before_anything_is_decided(setup):
    gate = threading.Event()
    s = setup
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, gate=gate, on_start=in_progress(s["routes"])))
    ring.on_message(sock, json.dumps(wake()))
    assert sock.sent[0] == {"type": "wake.ack", "wakeId": WAKE_ID}
    gate.set()
    settle(ring)


def test_no_frame_is_sent_before_wake_status_enabled(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    sock = FakeSocket()
    ring = make_ring(s["rt"], sock=sock, run_root=str(s["tmp"]))
    ring.start()
    ring.on_message(sock, json.dumps(wake()))
    ring.on_message(sock, json.dumps({"type": "wake.status", "enabled": False, "reason": "NOT_A_PUBLISHED_CONNECTOR"}))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert sock.sent == [] and s["routes"].mints == []


def test_a_malformed_wake_is_not_a_wake(setup):
    ring, sock = started_ring(setup)
    for frame in (dict(wake(), extra=1), dict(wake(), kind="review"), dict(wake(), taskId="../x"),
                  dict(wake(), attempt=True)):
        ring.on_message(sock, json.dumps(frame))
    settle(ring)
    assert sock.sent == [] and setup["routes"].mints == []


def test_the_cursor_only_moves_forward(setup):
    ring, sock = started_ring(setup)
    ring.on_message(sock, json.dumps({"type": "events", "events": [], "nextCursor": "40"}))
    ring.on_message(sock, json.dumps({"type": "events", "events": [], "nextCursor": "12"}))
    assert ring.state.cursor == "40"
    assert ring_module.RingState(ring.folder).cursor == "40"


# ── an implement run ───────────────────────────────────────────────────────────

def test_an_implement_wake_runs_claude_under_a_minted_agent(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(routes))
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("started", None), ("finished", None)]
    mint = routes.mints[0]
    assert (mint["who"], mint["role"], mint["targetTaskId"]) == ("connector", "implementer", TASK_ID)
    assert mint["requestedScopes"] == ring_module.IMPLEMENT_SCOPES
    # N14: the Agent claims with an empty body (the WRITE door), never the connector, never the epoch door.
    assert routes.claims == [{"who": "agent", "body": {}}]
    call = spawn.calls[0]
    argv = call["argv"]
    assert argv[:3] == ["/opt/fake/harness", "-p", argv[2]] and TASK_ID in argv[2] and TASK_TITLE not in argv[2]
    assert "--strict-mcp-config" in argv and argv[argv.index("--output-format") + 1] == "stream-json"
    config = json.loads(call["files"]["mcp.json"])
    assert list(config["mcpServers"]) == ["relayhall"]
    entry = config["mcpServers"]["relayhall"]
    assert entry["args"][-4:-1] == ["connector", "mcp", "--run"] and Path(entry["args"][-1]) == call["folder"]
    assert Path(call["cwd"]) == s["workdir"]
    # The run's evidence under the Agent, then the Agent revoked by the connector, then the folder gone.
    assert [r["who"] for r in routes.reports] == ["agent"]
    assert routes.revoked == [{"who": "connector", "credentialId": "a9e7c300-0000-4000-8000-0000000c0001"}]
    assert not call["folder"].exists()
    assert ring.state.active == {}


def test_a_codex_run_uses_exec_json_and_ignores_the_user_config(tmp_path, board):
    routes = RingRoutes(board)
    rt = install_for_ring(tmp_path, board, harness="codex")
    workdir = tmp_path / "work"
    workdir.mkdir()
    write_ring_policy(rt, HANDLE, workdir)
    routes.add_task(assigned_task())
    spawn = RecordingSpawn(CODEX_STREAM, on_start=in_progress(routes))
    sock = FakeSocket()
    ring = make_ring(rt, sock=sock, spawn=spawn, run_root=str(tmp_path))
    ring.start()
    ring.on_message(sock, json.dumps({"type": "wake.status", "enabled": True}))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert len(spawn.calls) == 1, ring.events
    argv = spawn.calls[0]["argv"]
    assert argv[1:5] == ["exec", "--json", "--ignore-user-config", "--skip-git-repo-check"]
    assert argv[argv.index("-C") + 1] == str(workdir)
    entry = argv[argv.index("-c") + 1]
    assert entry.startswith("mcp_servers.relayhall={command=") and '"--run"' in entry
    assert outcomes(sock) == [("started", None), ("finished", None)]
    assert spawn.calls[0]["files"].keys() == {"run.json", "agent.cred"}


def test_a_codex_build_that_cannot_isolate_is_refused_before_any_mint(tmp_path, board):
    routes = RingRoutes(board)
    rt = install_for_ring(tmp_path, board, harness="codex")
    workdir = tmp_path / "work"
    workdir.mkdir()
    write_ring_policy(rt, HANDLE, workdir)
    routes.add_task(assigned_task())
    sock = FakeSocket()
    notifier = RecordingNotifier()
    ring = make_ring(rt, sock=sock, isolation=False, notifier=notifier, run_root=str(tmp_path))
    ring.start()
    ring.on_message(sock, json.dumps({"type": "wake.status", "enabled": True}))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "HARNESS_CONFIG_NOT_ISOLATED")]
    assert routes.mints == [] and notifier.sent[0]["reason"] == "HARNESS_CONFIG_NOT_ISOLATED"


def test_codex_isolation_probe_reads_the_documented_flag(tmp_path):
    def runner(present):
        return lambda argv, env, timeout, prefix: (0, b"  --ignore-user-config\n" if present else b"  --json\n")
    assert ring_module.codex_isolates("codex", {}, runner=runner(True)) is True
    assert ring_module.codex_isolates("codex", {}, runner=runner(False)) is False


def test_an_untrusted_binary_never_runs(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring, sock = started_ring(s, spawn=spawn, trust_gate=FakeRunTrust("/x", refuse="SIGNER_MISMATCH"))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "UNTRUSTED_BINARY")]
    assert s["routes"].mints == [] and spawn.calls == []


def test_a_binary_that_changes_during_the_run_is_named(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(s["routes"])),
                              trust_gate=FakeRunTrust("/x", change_after_run=True))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("started", None), ("finished", "RUN_BINARY_CHANGED")]


def test_a_task_outside_every_working_folder_is_refused_and_the_person_told(setup):
    s = setup
    s["routes"].phases[assigned_task()["phaseId"]] = "9a0ec700-0000-4000-8000-0000000000ff"
    s["routes"].add_task(assigned_task())
    notifier = RecordingNotifier()
    ring, sock = started_ring(s, notifier=notifier)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "WORKDIR_NOT_CONFIGURED")]
    assert s["routes"].mints == [] and notifier.sent == [{"taskId": TASK_ID, "kind": "implement",
                                                          "reason": "WORKDIR_NOT_CONFIGURED"}]


def test_a_local_hold_starts_nothing_and_keeps_the_task_pending(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], hold=True)
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "USAGE_HOLD")]
    assert s["routes"].mints == [] and ring.state.pending == {TASK_ID: "implement"}


def test_at_most_n_runs_and_the_rest_wait_for_the_next_reconcile(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    routes.add_task(assigned_task(OTHER_TASK))
    gate = threading.Event()
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, gate=gate))
    ring.on_message(sock, json.dumps(wake()))
    assert wait_for(lambda: ("started", None) in outcomes(sock))
    ring.on_message(sock, json.dumps(wake(task_id=OTHER_TASK, wake_id="3a4e0000-0000-4000-8000-0000000000b2")))
    assert wait_for(lambda: ("refused", "AT_CAPACITY") in outcomes(sock))
    assert ring.state.pending == {OTHER_TASK: "implement"}
    gate.set()
    settle(ring)
    ring.reconcile()
    settle(ring)
    assert len(routes.mints) == 2 and ring.state.pending == {}


def test_a_second_wake_for_a_task_being_run_is_answered_already_running(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    gate = threading.Event()
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, gate=gate))
    ring.on_message(sock, json.dumps(wake()))
    assert wait_for(lambda: ("started", None) in outcomes(sock))
    ring.on_message(sock, json.dumps(wake(wake_id="3a4e0000-0000-4000-8000-0000000000c3")))
    assert wait_for(lambda: ("refused", "ALREADY_RUNNING") in outcomes(sock))
    gate.set()
    settle(ring)
    assert len(s["routes"].mints) == 1


def test_a_mint_that_needs_approval_notifies_once_and_runs_when_approved(setup):
    s = setup
    routes = s["routes"]
    routes.mint_mode = "approval"
    routes.add_task(assigned_task())
    notifier = RecordingNotifier()
    ring, sock = started_ring(s, notifier=notifier, spawn=RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(routes)))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("notified", "AGENT_MINT_PENDING_APPROVAL")]
    assert ring.state.approvals == {TASK_ID: APPROVAL_ID} and ring.state.pending == {TASK_ID: "implement"}
    ring.reconcile()
    settle(ring)
    assert len([m for m in routes.mints if not m.get("collect")]) == 1  # never filed twice
    assert len(notifier.sent) == 1
    routes.approval_status = "approved"
    ring.reconcile()
    settle(ring)
    assert routes.mints[-1].get("collect") is True
    assert routes.claims == [{"who": "agent", "body": {}}] and ring.state.pending == {}


def test_a_refused_mint_is_refused_by_name(setup):
    s = setup
    s["routes"].mint_mode = "refuse"
    s["routes"].add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "AGENT_MINT_REFUSED")] and spawn.calls == []


def test_a_pack_that_is_not_bound_to_the_task_is_revoked_and_never_used(setup):
    s = setup
    s["routes"].pack_overrides = {"boundTaskId": OTHER_TASK}
    s["routes"].add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "AGENT_MINT_REFUSED")] and spawn.calls == []
    assert s["routes"].claims == [] and [r["who"] for r in s["routes"].revoked] == ["connector"]


def test_a_pack_wider_than_the_request_is_revoked_and_never_used(setup):
    s = setup
    s["routes"].pack_overrides = {"scopes": ring_module.IMPLEMENT_SCOPES + ["principals:write"]}
    s["routes"].add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "AGENT_MINT_REFUSED")] and spawn.calls == []
    assert s["routes"].claims == [] and [r["who"] for r in s["routes"].revoked] == ["connector"]


def test_a_pack_with_an_admin_scope_is_revoked_and_never_used(setup):
    s = setup
    s["routes"].pack_overrides = {"scopes": ["tasks:read", "tasks:admin"]}
    s["routes"].add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "AGENT_MINT_REFUSED")] and spawn.calls == []


def test_a_pack_holding_an_admin_scope_is_refused_even_when_it_was_asked_for(setup):
    """The :admin refusal stands on its own, beside the requested-scopes check (run_scopes never asks for one)."""
    s = setup
    ring, _sock = started_ring(s)
    pack = {"principalId": "a9e7c300-0000-4000-8000-00000000a6e9", "credentialId": "a9e7c300-0000-4000-8000-0000000c0aaa",
            "secretOnce": AGENT_TOKEN, "boundTaskId": TASK_ID, "scopes": ["tasks:read", "tasks:admin"]}
    taken = ring._pack_of({"pack": pack}, ring_module.Candidate("implement", TASK_ID), ring._board(),
                          ["tasks:read", "tasks:admin"])
    assert taken is None and [r["credentialId"] for r in s["routes"].revoked] == [pack["credentialId"]]


def test_a_refused_agent_claim_revokes_the_agent_and_starts_nothing(setup):
    s = setup
    s["routes"].claim_status = 403
    s["routes"].add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "AGENT_CLAIM_REFUSED")] and spawn.calls == []
    assert [c["who"] for c in s["routes"].claims] == ["agent"]  # the fallback (the connector claims) is never taken
    assert len(s["routes"].revoked) == 1


@pytest.mark.parametrize("spawn, code", [
    (RecordingSpawn(CLAUDE_STREAM, exit_code=3), "RUN_EXIT_NONZERO"),
    (RecordingSpawn(CLAUDE_STREAM, hang=True), "RUN_TIMEOUT"),
])
def test_exit_codes_map_to_named_outcomes(setup, spawn, code):
    s = setup
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("started", None), ("finished", code)]
    assert len(s["routes"].revoked) == 1


def test_a_harness_that_cannot_start_is_refused_and_cleaned_up(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    spawn = RecordingSpawn(CLAUDE_STREAM, fail=True)
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("started", None), ("finished", "RUN_START_FAILED")]
    assert len(s["routes"].revoked) == 1 and not spawn.calls[0]["folder"].exists()


def test_a_custody_failure_while_reporting_still_finishes_and_revokes(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    readable = {"now": True}

    def run_started():
        routes.tasks[TASK_ID].update(status="in-progress")
        readable["now"] = False  # the person's custody stops answering mid-run (a locked session, a removed blob)
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, on_start=run_started))
    loader = ring.token_loader

    def custody():
        if not readable["now"]:
            raise custody_module.CustodyError("custody unavailable")
        return loader()
    ring.token_loader = custody
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("started", None), ("finished", None)]
    assert [r["who"] for r in routes.reports] == ["agent"] and len(routes.revoked) == 1


def test_any_failure_while_reporting_still_finishes_and_revokes(setup, monkeypatch):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())

    def broken(text, token):
        raise RuntimeError("the report writer broke")
    monkeypatch.setattr(ring_module, "scrub", broken)
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(routes)))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("started", None), ("finished", "RUN_REPORT_FAILED")]
    assert routes.reports == [] and len(routes.revoked) == 1 and ring.state.active == {}


class ExplodingTrust(FakeRunTrust):
    def __call__(self, product):
        raise RuntimeError("not a TrustRefusal")


def test_an_unexpected_failure_before_a_run_still_answers_the_wake(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s, trust_gate=ExplodingTrust("/x"))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "RING_INTERNAL")] and s["routes"].mints == []


def test_a_finished_task_gets_a_stream_note_not_a_report(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    ring, sock = started_ring(s, spawn=RecordingSpawn(
        CLAUDE_STREAM, on_start=lambda: routes.tasks[TASK_ID].update(status="review")))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert [r["who"] for r in routes.reports] == ["agent"]  # tried, frozen (409)
    assert [n["who"] for n in routes.stream] == ["agent"]


def test_a_failed_revocation_is_retried_on_reconcile(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    s["board"].fail[("POST", "/api/credentials/a9e7c300-0000-4000-8000-0000000c0001/revoke")] = [503]
    original = routes.__call__

    def flaky(method, path, headers, body):
        queued = s["board"].fail.get((method, path))
        if queued:
            return queued.pop(0), {"code": "INJECTED_FAILURE"}
        return original(method, path, headers, body)
    s["board"].routes = flaky
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(routes)))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert ring.state.revocations == ["a9e7c300-0000-4000-8000-0000000c0001"]
    ring.reconcile()
    assert ring.state.revocations == [] and len(routes.revoked) == 1


def test_a_runs_agent_is_revoked_even_while_the_ring_stops(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    gate = threading.Event()
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, gate=gate, on_start=in_progress(routes)))
    ring.on_message(sock, json.dumps(wake()))
    assert wait_for(lambda: ("started", None) in outcomes(sock))
    ring.stopping.set()  # the daemon is told to stop while a run is still working
    gate.set()
    assert wait_for(lambda: not ring.running)
    assert len(routes.revoked) == 1 and ring.state.revocations == []


def test_a_crashed_run_is_cleaned_up_on_the_next_start(setup):
    s = setup
    folder = s["tmp"] / "rh-run-leftover"
    folder.mkdir()
    (folder / "agent.cred").write_text(AGENT_TOKEN)
    state = ring_module.RingState(connector.state_dir(s["rt"], HANDLE))
    state.update(lambda st: st.active.__setitem__("11111111-0000-4000-8000-000000000001", {
        "folder": str(folder), "credentialId": "a9e7c300-0000-4000-8000-0000000c0099", "taskId": TASK_ID}))
    ring, _ = started_ring(s)
    assert not folder.exists() and ring.state.active == {}
    assert ring.state.revocations == ["a9e7c300-0000-4000-8000-0000000c0099"]
    ring.reconcile()
    assert ring.state.revocations == []


# ── a run's MCP isolation, read back from the harness ─────────────────────────

def codex_ring(tmp_path, board, stderr=None, notifier=None, exit_code=0):
    routes = RingRoutes(board)
    rt = install_for_ring(tmp_path, board, harness="codex")
    workdir = tmp_path / "work"
    workdir.mkdir()
    write_ring_policy(rt, HANDLE, workdir)
    routes.add_task(assigned_task())
    spawn = RecordingSpawn(CODEX_STREAM, on_start=in_progress(routes), stderr=stderr, exit_code=exit_code)
    sock = FakeSocket()
    ring = make_ring(rt, sock=sock, spawn=spawn, notifier=notifier, run_root=str(tmp_path))
    ring.start()
    ring.on_message(sock, json.dumps({"type": "wake.status", "enabled": True}))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    return ring, sock, routes, spawn


def test_a_codex_run_records_the_mcp_servers_it_started(tmp_path, board):
    ring, sock, routes, spawn = codex_ring(tmp_path, board)
    assert outcomes(sock) == [("started", None), ("finished", None)]
    assert ring.state.runs[-1]["mcpServers"] == ["relayhall"]
    assert "MCP servers the harness started: relayhall\n" in routes.reports[0]["body"]["content"]
    assert spawn.calls[0]["env"]["RUST_LOG"] == ring_module.CODEX_LOG_FILTER


def test_a_codex_run_that_started_another_mcp_server_is_unisolated(tmp_path, board):
    notifier = RecordingNotifier()
    ring, sock, routes, _spawn = codex_ring(tmp_path, board, stderr=codex_stderr(("usermarker", "projmarker", "relayhall")),
                                            notifier=notifier)
    assert outcomes(sock) == [("started", None), ("finished", "RUN_UNISOLATED")]
    assert ring.state.runs[-1]["mcpServers"] == ["projmarker", "relayhall", "usermarker"]
    content = routes.reports[0]["body"]["content"]
    assert "projmarker, relayhall, usermarker" in content and "refuses this run's output" in content
    assert "Finished the Task." not in content and "Last output" not in content  # nothing it returned is passed on
    assert notifier.sent == [{"taskId": TASK_ID, "kind": "implement", "reason": "RUN_UNISOLATED"}]
    assert len(routes.revoked) == 1


def test_a_run_that_names_no_mcp_servers_is_unverified(tmp_path, board):
    ring, sock, routes, _spawn = codex_ring(tmp_path, board, stderr=[b"Reading additional input from stdin...\n"])
    assert outcomes(sock) == [("started", None), ("finished", "RUN_MCP_UNVERIFIED")]
    content = routes.reports[0]["body"]["content"]
    assert "not reported" in content and "did not say which MCP servers" in content
    assert "Finished the Task." not in content and "Last output" not in content


def assert_withheld_but_named(sock, routes, code, notifier):
    """The run's failure is still the outcome, yet nothing it printed reaches the board: the isolation verdict alone
    decides what is evidence, and the person is told the verdict (the failure's code is not one that tells them)."""
    assert outcomes(sock) == [("started", None), ("finished", code)]
    assert notifier.sent == [{"taskId": TASK_ID, "kind": "implement", "reason": "RUN_MCP_UNVERIFIED"}]
    content = routes.reports[0]["body"]["content"]
    assert f"outcome {code}" in content and "MCP servers the harness started: not reported" in content
    assert "refuses this run's output" in content and "did not say which MCP servers" in content
    assert "Finished the Task." not in content and "Harness result" not in content and "Last output" not in content
    assert len(routes.revoked) == 1


def test_a_failed_codex_run_that_names_no_mcp_servers_still_withholds_its_output(tmp_path, board):
    notifier = RecordingNotifier()
    _ring, sock, routes, _spawn = codex_ring(tmp_path, board, stderr=[b"Reading additional input from stdin...\n"],
                                             exit_code=3, notifier=notifier)
    assert_withheld_but_named(sock, routes, "RUN_EXIT_NONZERO", notifier)


@pytest.mark.parametrize("failure, code", [({"exit_code": 3}, "RUN_EXIT_NONZERO"), ({"hang": True}, "RUN_TIMEOUT")],
                         ids=["exit-3", "timeout"])
def test_a_failed_claude_run_that_names_no_mcp_servers_still_withholds_its_output(setup, failure, code):
    s = setup
    s["routes"].add_task(assigned_task())
    no_init = CLAUDE_STREAM[1:]  # the stream without its system/init event: no record of the servers it started
    notifier = RecordingNotifier()
    ring, sock = started_ring(s, spawn=RecordingSpawn(no_init, on_start=in_progress(s["routes"]), **failure),
                              notifier=notifier)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert ring.state.runs[-1]["mcpServers"] is None
    assert_withheld_but_named(sock, s["routes"], code, notifier)


def claude_stream_with(*inits):
    lines = [dict(CLAUDE_STREAM[0], mcp_servers=[{"name": n, "status": "connected"} for n in servers])
             for servers in inits]
    return lines + CLAUDE_STREAM[1:]


@pytest.mark.parametrize("inits", [(("relayhall", "notes"),), (("relayhall", "notes"), ("relayhall",))],
                         ids=["one-init", "a-later-init"])
def test_a_claude_run_that_started_another_mcp_server_is_unisolated(setup, inits):
    s = setup
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s, spawn=RecordingSpawn(claude_stream_with(*inits), on_start=in_progress(s["routes"])))
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("started", None), ("finished", "RUN_UNISOLATED")]
    assert ring.state.runs[-1]["mcpServers"] == ["notes", "relayhall"]


def test_the_codex_session_line_is_read_and_nothing_else_is():
    summary = {}
    for line in codex_stderr(("relayhall",)) + [b'INFO x: mcp_servers="other"\n',
                                                b"\x1b[2m" + codex_stderr(("relayhall", "late"))[1] + b"\x1b[0m"]:
        ring_module.summarise_stderr("codex", line, summary)
    assert summary == {"mcpServers": ["late", "relayhall"]}
    ring_module.summarise_stderr("claude-code", codex_stderr(("x",))[1], summary)
    assert summary == {"mcpServers": ["late", "relayhall"]}
    assert ring_module.isolation_verdict({}) == "RUN_MCP_UNVERIFIED"
    assert ring_module.isolation_verdict({"mcpServers": ["relayhall"]}) is None


def test_the_owned_child_hands_stderr_to_the_sink_and_never_blocks_on_it():
    import relayhall_connector_proc as proc
    seen = []
    script = ("import sys\nfor _ in range(2048):\n    sys.stderr.write('x' * 1023 + '\\n')\nsys.stderr.flush()\n"
              "print('{\"done\": true}', flush=True)\n")
    env = {k: v for k, v in os.environ.items() if k != "RELAYHALL_TOKEN"}
    child = proc.OwnedChild([sys.executable, "-c", script], env, stderr_sink=seen.append, code_prefix="RUN")
    lines = []
    try:
        while True:
            lines.append(child.next_line(time.monotonic() + 30))
    except proc.ChildError as error:
        ended = error.code
    finally:
        child.close()
    assert (ended, lines) == ("RUN_EXITED", [b'{"done": true}\n'])
    assert len(seen) == 2048 and seen[0] == b"x" * 1023 + b"\n"


# The real Codex (owner ruling E462 S5 leftovers): which MCP servers a run starts, measured by marker servers that
# record their own start, and read back by the ring from Codex's own output. Runs only where a codex-cli binary is
# named (RH_TEST_CODEX_BINARY), against a loopback stand-in for the model API, under a temporary HOME/CODEX_HOME.
MARKER_MCP = (
    "import json, os, sys\n"
    "name, folder = sys.argv[1], sys.argv[2]\n"
    "open(os.path.join(folder, 'started-' + name), 'w').write(name)\n"
    "for line in sys.stdin:\n"
    "    message = json.loads(line)\n"
    "    if 'id' not in message:\n"
    "        continue\n"
    "    method = message.get('method')\n"
    "    if method == 'initialize':\n"
    "        result = {'protocolVersion': message['params'].get('protocolVersion', '2025-06-18'),\n"
    "                  'capabilities': {'tools': {}}, 'serverInfo': {'name': name, 'version': '1'}}\n"
    "    else:\n"
    "        result = {'tools': []} if method == 'tools/list' else {}\n"
    "    sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}) + '\\n')\n"
    "    sys.stdout.flush()\n")


class ResponsesStandIn(http.server.BaseHTTPRequestHandler):
    """POST /v1/responses: one short assistant message, as server-sent events. Nothing leaves the loopback."""

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        events = [{"type": "response.created", "response": {"id": "resp_1"}},
                  {"type": "response.output_item.done", "item": {
                      "type": "message", "role": "assistant", "id": "msg_1",
                      "content": [{"type": "output_text", "text": "stand-in answer"}]}},
                  {"type": "response.completed", "response": {"id": "resp_1", "usage": {
                      "input_tokens": 1, "input_tokens_details": None, "output_tokens": 1,
                      "output_tokens_details": None, "total_tokens": 2}}}]
        data = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.mark.skipif(not os.environ.get("RH_TEST_CODEX_BINARY") or shutil.which("git") is None,
                    reason="needs a real codex-cli (RH_TEST_CODEX_BINARY) and git")
@pytest.mark.parametrize("ignore_user_config", [True, False], ids=["the-rings-argv", "control-without-the-flag"])
def test_a_real_codex_starts_only_the_run_entry_and_the_ring_reads_it_back(tmp_path, ignore_user_config):
    binary = os.environ["RH_TEST_CODEX_BINARY"]
    home, codex_home, work, marks = (tmp_path / name for name in ("home", "codex-home", "work", "marks"))
    for folder in (home, codex_home, work / ".codex", marks):
        folder.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(work)], check=True)

    def marker(name):
        return f"command = {json.dumps(sys.executable)}\nargs = {json.dumps(['-c', MARKER_MCP, name, str(marks)])}\n"
    # The person's own Codex configuration (an entry of theirs, and this workdir trusted) and a PROJECT-level one in
    # the working folder: neither may reach a run.
    (codex_home / "config.toml").write_text(f"[mcp_servers.usermarker]\n{marker('usermarker')}\n"
                                            f"[projects.{json.dumps(str(work))}]\ntrust_level = \"trusted\"\n")
    (work / ".codex" / "config.toml").write_text(f"[mcp_servers.projmarker]\n{marker('projmarker')}")
    policy = ring_module.validate_policy({"schemaVersion": ring_module.RING_SCHEMA, "enabled": True,
                                          "codex": {"sandbox": "read-only"}})
    argv, files = ring_module.harness_invocation("codex", binary, tmp_path, work, policy, TASK_ID, "implement",
                                                 [sys.executable, "-c", MARKER_MCP, "relayhall", str(marks)])
    assert files == {} and "--ignore-user-config" in argv
    if not ignore_user_config:
        argv.remove("--ignore-user-config")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ResponsesStandIn)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}/v1"
        provider = ["-c", 'model_provider="stand"', "-c",
                    'model_providers.stand={name="stand",base_url="' + base + '",wire_api="responses"}',
                    "-c", 'model="stand-model"']
        argv = argv[:-1] + provider + argv[-1:]
        env = ring_module.harness_env({"PATH": os.environ.get("PATH", ""), "HOME": str(home),
                                       "CODEX_HOME": str(codex_home)}, "codex")
        result = ring_module.supervise(argv, env, str(work), 120, "codex")
    finally:
        server.shutdown()
    started = sorted(path.name[len("started-"):] for path in marks.iterdir())
    expected = ["relayhall"] if ignore_user_config else ["projmarker", "relayhall", "usermarker"]
    assert started == expected, (result.code, result.tail[-2000:])
    assert result.summary.get("mcpServers") == expected  # the ring's read-back agrees with what really started
    assert ring_module.isolation_verdict(result.summary) == (None if ignore_user_config else "RUN_UNISOLATED")
    assert (result.code, result.exit_code) == (None, 0)


# ── catch-up (design 6.3; N20: GET /events replay) ─────────────────────────────

def history(routes, count):
    """`count` task.ready rows for Tasks this board does not hold here (somebody else's history)."""
    for n in range(count):
        routes.ready(f"{n:08x}-0000-4000-8000-0000000000ee")


def test_a_first_start_begins_at_the_feed_head_and_replays_nothing(setup):
    s = setup
    routes = s["routes"]
    history(routes, 4000)
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]))
    ring.start()
    ring.reconcile()
    settle(ring)
    assert ring.state.cursor == "4000" and ring_module.RingState(ring.folder).cursor == "4000"
    reads = [c for c in routes.calls if c["path"] == "/api/events"]
    assert 1 <= len(reads) <= 30, len(reads)  # about 2 x log2(4000) one-row reads, never the 4000 rows
    assert not [c for c in routes.calls if c["path"].startswith("/api/tasks/")]  # no Task re-read for history
    routes.ready(OTHER_TASK)  # what becomes ready from now on is found by the next pass
    ring.reconcile()
    settle(ring)
    assert ring.state.cursor == "4001"
    assert [c["path"] for c in routes.calls if c["path"].startswith("/api/tasks/")] == [f"/api/tasks/{OTHER_TASK}"]


def test_a_first_start_opens_the_wake_socket_at_the_feed_head(setup):
    s = setup
    history(s["routes"], 30)
    attempts = []

    def connect(url, headers, timeout):
        attempts.append(url)
        dropped = FakeSocket()
        dropped.end()
        return dropped
    ring = make_ring(s["rt"], run_root=str(s["tmp"]), ws_connect=connect)
    ring.serve(stop_at=time.monotonic() + 2)
    assert attempts and all("cursor=30&wake=2" in url for url in attempts), attempts


def test_a_first_start_still_finds_work_already_waiting(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    routes.ready(TASK_ID)  # it became ready before the connector's first start
    history(routes, 300)
    spawn = RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(routes))
    ring = make_ring(s["rt"], sock=None, spawn=spawn, run_root=str(s["tmp"]))
    ring.start()
    ring.reconcile()
    settle(ring)
    assert ring.state.cursor == "301" and len(spawn.calls) == 1
    assert [e["outcome"]["error_type"] for e in s["board"].events] == ["connector.trigger.started",
                                                                       "connector.trigger.finished"]


class FakeClock:
    """A clock the ring's rate gate sleeps on: a sleep moves it forward at once."""

    def __init__(self):
        self.value, self.lock = 1000.0, threading.Lock()

    def __call__(self):
        with self.lock:
            return self.value

    def sleep(self, seconds):
        with self.lock:
            self.value += max(float(seconds or 0), 0.001)


def test_a_large_backlog_is_paced_and_bounded_per_pass(setup):
    s = setup
    routes = s["routes"]
    history(routes, 4000)
    ring_module.RingState(connector.state_dir(s["rt"], HANDLE)).start_at("0")  # a saved cursor far behind the head
    clock = FakeClock()
    routes.clock = clock
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]), clock=clock, sleep=clock.sleep,
                     rate_per_minute=ring_module.RATE_PER_MINUTE, rate_burst=ring_module.RATE_BURST)
    ring.start()
    per_pass = []
    for _ in range(4):
        before = len(routes.calls)
        ring.reconcile()
        settle(ring)
        per_pass.append(len([c for c in routes.calls[before:] if c["path"].startswith("/api/tasks/")]))
    assert per_pass == [ring_module.PULL_PER_PASS] * 4  # each pass takes its share; the rest waits its turn
    assert ring.state.cursor == str(4 * ring_module.PULL_PER_PASS)  # and resumes where the last pass stopped
    stamps = sorted(c["at"] for c in routes.calls)
    busiest = max(sum(1 for t in stamps if start <= t < start + 60) for start in stamps)
    assert busiest <= ring_module.RATE_BURST + ring_module.RATE_PER_MINUTE < 300, busiest


def foreign_waiting(routes, count):
    """`count` armed Tasks waiting for ANOTHER connector's service, readable here."""
    for n in range(count):
        routes.add_task(assigned_task(f"{n:08x}-0000-4000-8000-0000000000fa", service=OTHER_SERVICE))


def test_waiting_work_never_starves_the_replay(setup):
    s = setup
    routes = s["routes"]
    foreign_waiting(routes, 60)
    history(routes, 5)
    ring_module.RingState(connector.state_dir(s["rt"], HANDLE)).start_at("0")
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]))
    ring.start()
    ring.reconcile()
    settle(ring)
    assert ring.state.cursor == "5"  # the five replayed events were taken in the same pass
    reads = [c["path"] for c in routes.calls if c["path"].startswith("/api/tasks/")]
    assert len([p for p in reads if p.endswith("0000000000fa")]) == ring_module.PULL_PER_PASS // 2


def test_another_connectors_waiting_work_is_read_once(setup):
    s = setup
    routes = s["routes"]
    foreign_waiting(routes, 60)
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]))
    ring.start()
    counts = []
    for _ in range(2):
        before = len(routes.calls)
        ring.reconcile()
        settle(ring)
        counts.append(len([c for c in routes.calls[before:] if c["path"].startswith("/api/tasks/")]))
    assert counts == [ring_module.PULL_PER_PASS // 2, 0] and ring.foreign_services == {OTHER_SERVICE}
    assert routes.mints == [] and s["board"].events == []


def waiting_offsets(routes, before):
    """The offsets the waiting-work list reads asked for since call `before`."""
    return [int(dict(urllib_parse.parse_qsl(c["query"])).get("offset", "0")) for c in routes.calls[before:]
            if c["method"] == "GET" and c["path"] == "/api/tasks"]


def test_an_armed_task_behind_many_newer_rows_is_reached_within_the_stated_passes(setup):
    """The waiting-work read is one sweep carried across passes: 350 newer unarmed todo rows (the list is newest
    first) stand before one older armed Task; a pass reads three pages of 100, so the second pass reaches it. At
    the end of the list the sweep starts again at the top."""
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())  # the oldest row: armed, waiting for this connector
    newer = 350
    for n in range(newer):
        routes.add_task(assigned_task(f"{n:08x}-0000-4000-8000-0000000000ab", auto_start=False))
    spawn = RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(routes))
    ring = make_ring(s["rt"], sock=None, spawn=spawn, run_root=str(s["tmp"]))
    ring.start()
    per_pass = ring_module.ASSIGNED_PAGES_PER_PASS * ring_module.ASSIGNED_PAGE
    stated = newer // per_pass + 1  # the pass of its sweep that reads list position `newer`
    assert stated == 2
    offsets = []
    for _ in range(stated):
        before = len(routes.calls)
        ring.reconcile()
        settle(ring)
        offsets.append(waiting_offsets(routes, before))
    assert offsets == [[0, 100, 200], [300]]  # never more than three pages a pass
    assert [r["taskId"] for r in ring.state.runs] == [TASK_ID] and len(spawn.calls) == 1
    routes.add_task(assigned_task(OTHER_TASK))  # newest now, at the top: the next sweep starts there
    before = len(routes.calls)
    ring.reconcile()
    settle(ring)
    assert waiting_offsets(routes, before) == [0, 100, 200]
    assert [r["taskId"] for r in ring.state.runs] == [TASK_ID, OTHER_TASK]


def test_a_failed_page_is_read_again_by_the_next_pass(setup):
    """The page that failed is where the next pass goes on, not the top of the list: 250 unarmed rows, the page at
    offset 100 answers 503 once."""
    s = setup
    routes = s["routes"]
    for n in range(250):
        routes.add_task(assigned_task(f"{n:08x}-0000-4000-8000-0000000000ac", auto_start=False))
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]))
    ring.start()
    routes.list_fail_offsets = {100}
    before = len(routes.calls)
    ring.reconcile()
    settle(ring)
    assert waiting_offsets(routes, before)[:2] == [0, 100] and ring.waiting_offset == 100
    routes.list_fail_offsets = set()
    before = len(routes.calls)
    ring.reconcile()
    settle(ring)
    assert waiting_offsets(routes, before) == [100, 200]  # not [0, 100, 200]
    assert ring.waiting_offset == 0  # the short page ended the sweep


def test_a_pass_out_of_share_resumes_at_the_row_it_did_not_take(setup):
    """Thirty armed Tasks of thirty other services (each point read teaches one): a pass takes its share of 25, the
    next goes on at row 25 of the same page, the one after starts again at the top and finds nothing new."""
    s = setup
    routes = s["routes"]
    for n in range(30):
        routes.add_task(assigned_task(f"{n:08x}-0000-4000-8000-0000000000fb",
                                      service=f"5e41ce00-0000-4000-8000-0000000{n:05x}"))
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]))
    ring.start()
    counts, offsets = [], []
    for _ in range(3):
        before = len(routes.calls)
        ring.reconcile()
        settle(ring)
        counts.append(len([c for c in routes.calls[before:] if c["path"].startswith("/api/tasks/")]))
        offsets.append(waiting_offsets(routes, before))
    assert counts == [ring_module.PULL_PER_PASS // 2, 5, 0] and offsets == [[0], [25], [0]]
    assert len(ring.foreign_services) == 30 and routes.mints == []


def test_a_wake_is_decided_before_pulled_work(setup):
    ring = make_ring(setup["rt"], sock=None, run_root=str(setup["tmp"]))
    for n in range(3):
        ring.submit(ring_module.Candidate("implement", f"{n:08x}-0000-4000-8000-0000000000ee", source="replay"))
    ring.submit(ring_module.Candidate("implement", TASK_ID, WAKE_ID, FakeSocket()))
    with ring.lock:
        first = ring._take_next()
    assert first.wake_id == WAKE_ID and len(ring.queue) == 3

def test_catch_up_finds_ready_work_without_a_socket_and_reports_by_telemetry(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task())
    routes.ready(TASK_ID)
    spawn = RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(routes))
    ring = make_ring(s["rt"], sock=None, spawn=spawn, run_root=str(s["tmp"]))
    ring.start()
    ring.reconcile()
    settle(ring)
    assert len(spawn.calls) == 1 and ring.state.cursor == "1"
    kinds = [e["outcome"]["error_type"] for e in s["board"].events]
    assert kinds == ["connector.trigger.started", "connector.trigger.finished"]
    assert any(c["path"] == "/api/events" for c in routes.calls)


def test_catch_up_ignores_ready_work_assigned_elsewhere(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task(service=OTHER_SERVICE))
    routes.ready(TASK_ID)
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]))
    ring.start()
    ring.reconcile()
    settle(ring)
    assert routes.mints == [] and s["board"].events == []


def test_catch_up_reads_verify_and_stuck_items(setup):
    s = setup
    routes = s["routes"]
    routes.add_task(assigned_task(status="stuck"))
    routes.actions = [{"key": f"stuck:{TASK_ID}", "kind": "stuck", "seen": False, "reasons": ["status"],
                       "since": "2026-10-24T20:00:00.000Z", "object": {"type": "task", "id": TASK_ID, "title": TASK_TITLE},
                       "project": None, "href": f"/tasks/{TASK_ID}", "detail": {}}]
    notifier = RecordingNotifier()
    ring = make_ring(s["rt"], sock=None, notifier=notifier, run_root=str(s["tmp"]))
    ring.start()
    ring.reconcile()
    settle(ring)
    ring.reconcile()
    settle(ring)
    assert notifier.sent == [{"taskId": TASK_ID, "kind": "stuck", "reason": None}]  # once per occurrence
    assert routes.mints == []


# ── verify (design 6.8: the service Verifier) and stuck ────────────────────────

def verify_task(**kwargs):
    defaults = dict(status="review", service=OTHER_SERVICE, owner="0aaa0000-0000-4000-8000-00000000000a",
                    verifier=PRINCIPAL_ID, mode="service")
    defaults.update(kwargs)
    return assigned_task(**defaults)


def test_a_verify_wake_runs_a_verifier_agent_under_a_warrant_and_claims_nothing(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], serviceId=SERVICE_ID)
    s["routes"].add_task(verify_task())
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring, sock = started_ring(s, spawn=spawn)
    ring.on_message(sock, json.dumps(wake("verify")))
    settle(ring)
    mint = s["routes"].mints[0]
    assert (mint["role"], mint["via"], mint["requestedScopes"]) == ("verifier", "warrant", ring_module.VERIFY_SCOPES)
    assert s["routes"].claims == []
    assert "Verify the Task against its success criteria" in spawn.calls[0]["argv"][2]
    assert outcomes(sock) == [("started", None), ("finished", None)]


@pytest.mark.parametrize("task, policy, code", [
    (verify_task(service=SERVICE_ID), {"serviceId": SERVICE_ID}, "OWN_SUBTREE_IMPLEMENTED"),
    (verify_task(owner=PRINCIPAL_ID), {"serviceId": SERVICE_ID}, "OWN_SUBTREE_IMPLEMENTED"),
    (verify_task(), {}, "OWN_SERVICE_UNKNOWN"),
    (verify_task(verifier="0bbb0000-0000-4000-8000-00000000000b"), {"serviceId": SERVICE_ID}, "NOT_THE_VERIFIER"),
    (verify_task(mode="human"), {"serviceId": SERVICE_ID}, "NOT_SERVICE_VERIFICATION"),
    (verify_task(status="in-progress"), {"serviceId": SERVICE_ID}, "TASK_NOT_IN_REVIEW"),
])
def test_the_local_guard_never_verifies_own_work(setup, task, policy, code):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], **policy)
    s["routes"].add_task(task)
    ring, sock = started_ring(s)
    ring.on_message(sock, json.dumps(wake("verify")))
    settle(ring)
    assert outcomes(sock) == [("refused", code)] and s["routes"].mints == []


def test_an_agent_this_connector_minted_is_its_own_subtree(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], serviceId=SERVICE_ID)
    agent = "a9e7c300-0000-4000-8000-00000000a6e9"
    ring_module.RingState(connector.state_dir(s["rt"], HANDLE)).update(lambda st: st.agents.append(agent))
    s["routes"].add_task(verify_task(owner=agent))
    ring, sock = started_ring(s)
    ring.on_message(sock, json.dumps(wake("verify")))
    settle(ring)
    assert outcomes(sock) == [("refused", "OWN_SUBTREE_IMPLEMENTED")]


def test_a_verify_without_a_warrant_notifies_and_never_files_an_approval(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], serviceId=SERVICE_ID)
    s["routes"].mint_mode = "approval"
    s["routes"].add_task(verify_task())
    notifier = RecordingNotifier()
    ring, sock = started_ring(s, notifier=notifier)
    ring.on_message(sock, json.dumps(wake("verify")))
    settle(ring)
    assert outcomes(sock) == [("refused", "NO_WARRANT")] and notifier.sent[0]["reason"] == "NO_WARRANT"
    assert ring.state.approvals == {}


def test_stuck_only_ever_notifies(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], kinds={"stuck": "notify"})
    s["routes"].add_task(assigned_task(status="stuck"))
    notifier = RecordingNotifier()
    ring, sock = started_ring(s, notifier=notifier)
    ring.on_message(sock, json.dumps(wake("stuck")))
    settle(ring)
    assert outcomes(sock) == [("notified", None)] and s["routes"].mints == []
    assert notifier.sent == [{"taskId": TASK_ID, "kind": "stuck", "reason": None}]


def test_a_kind_the_policy_ignores_is_refused_by_name(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], kinds={"implement": "ignore"})
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "KIND_IGNORED")] and s["routes"].mints == []


def test_an_implement_wake_for_a_task_no_longer_ready_is_refused(setup):
    s = setup
    s["routes"].add_task(assigned_task(owner="0aaa0000-0000-4000-8000-00000000000a"))
    ring, sock = started_ring(s)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "TASK_NOT_READY")] and s["routes"].mints == []


def test_a_configured_service_id_that_disagrees_with_the_board_stops_runs(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], serviceId=OTHER_SERVICE)
    s["routes"].add_task(assigned_task())
    ring, sock = started_ring(s)
    ring.on_message(sock, json.dumps(wake()))
    settle(ring)
    assert outcomes(sock) == [("refused", "RING_SERVICE_MISMATCH")] and s["routes"].mints == []


def test_an_outcome_after_the_socket_closed_goes_by_telemetry(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    gate = threading.Event()
    ring, sock = started_ring(s, spawn=RecordingSpawn(CLAUDE_STREAM, gate=gate, on_start=in_progress(s["routes"])))
    ring.on_message(sock, json.dumps(wake()))
    assert wait_for(lambda: ("started", None) in outcomes(sock))
    sock.closed = True
    gate.set()
    settle(ring)
    assert [e["outcome"]["error_type"] for e in s["board"].events] == ["connector.trigger.finished"]


def test_work_re_read_every_pass_is_reported_once(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], hold=True)
    s["routes"].add_task(assigned_task())
    s["routes"].ready(TASK_ID)
    ring = make_ring(s["rt"], sock=None, run_root=str(s["tmp"]))
    ring.start()
    for _ in range(3):
        ring.reconcile()
        settle(ring)
    kinds = [e["outcome"]["error_type"] for e in s["board"].events]
    assert kinds == ["connector.trigger.refused.USAGE_HOLD"]  # the replay once; the pending re-reads add nothing


def test_a_verify_occurrence_is_run_once_from_the_pull(setup):
    s = setup
    write_ring_policy(s["rt"], HANDLE, s["workdir"], serviceId=SERVICE_ID)
    s["routes"].add_task(verify_task())
    s["routes"].actions = [{"key": f"verify:{TASK_ID}", "kind": "verify", "seen": False, "reasons": ["verifier"],
                            "since": "2026-10-24T20:00:00.000Z", "object": {"type": "task", "id": TASK_ID, "title": None},
                            "project": None, "href": f"/tasks/{TASK_ID}", "detail": {}}]
    notifier = RecordingNotifier()
    spawn = RecordingSpawn(CLAUDE_STREAM)
    ring = make_ring(s["rt"], sock=None, spawn=spawn, notifier=notifier, run_root=str(s["tmp"]))
    ring.start()
    for _ in range(3):
        ring.reconcile()
        settle(ring)
    assert len(spawn.calls) == 1 and len(s["routes"].mints) == 1  # the item stayed open: told once, never looped
    assert notifier.sent == [{"taskId": TASK_ID, "kind": "verify", "reason": "VERIFY_ALREADY_ATTEMPTED"}]


def test_the_daemon_loop_receives_reconnects_with_back_off_and_stops(setup):
    s = setup
    s["routes"].add_task(assigned_task())
    first = FakeSocket([{"type": "wake.status", "enabled": True}, wake()])
    attempts = []

    def connect(url, headers, timeout):
        attempts.append(url)
        if len(attempts) == 1:
            return first
        dropped = FakeSocket()  # a socket the board drops at once (a refusal, a proxy that drops upgrades)
        dropped.end()
        return dropped
    ring = make_ring(s["rt"], spawn=RecordingSpawn(CLAUDE_STREAM, on_start=in_progress(s["routes"])),
                     run_root=str(s["tmp"]), ws_connect=connect)
    import time as _time
    done = threading.Thread(target=ring.serve, kwargs={"stop_at": _time.monotonic() + 8}, daemon=True)
    done.start()
    assert wait_for(lambda: ("finished", None) in outcomes(first), 20), ring.events
    first.end()
    done.join(20)
    assert not done.is_alive()
    assert first.sent[0] == {"type": "wake.ack", "wakeId": WAKE_ID}
    assert 2 <= len(attempts) <= 6  # back-off: a closed socket never turns into a tight reconnect loop
    assert "wake=2" in attempts[0] and TOKEN not in attempts[0]


def test_the_collector_cycle_never_blocks_the_receiver(setup):
    release = threading.Event()
    ring = make_ring(setup["rt"], sock=None, run_root=str(setup["tmp"]), collector_cycle=lambda: release.wait(20))
    ring.start()
    import time as _time
    began = _time.monotonic()
    ring.reconcile()
    ring.reconcile()
    assert _time.monotonic() - began < 5
    release.set()
    ring.collector_thread.join(5)


def test_the_default_trust_gate_is_the_collectors_publisher_trust(setup):
    from connector_testkit import FakeTrust, use_collector
    rt = setup["rt"]
    fake = use_collector(rt, trust_checker=FakeTrust(binary="/opt/trusted/claude"))
    policy = ring_module.load_policy(connector.state_dir(rt, HANDLE))
    gate = ring_module.default_trust_gate(rt, HANDLE, connector.load_manifest(rt, HANDLE), policy)
    verified = gate("claude-code")
    assert verified["runBinary"] == "/opt/trusted/claude" and fake.checks == 1
    assert gate.recheck("claude-code", verified) == verified and fake.rechecks == 1


# ── notifications ──────────────────────────────────────────────────────────────

def test_the_toast_names_the_short_id_the_kind_and_the_link_and_never_free_text():
    xml = ring_module.toast_xml("https://board.example", TASK_ID, "verify", "NO_WARRANT")
    assert "Task 7a5c0000 (NO_WARRANT)" in xml and f"https://board.example/tasks/{TASK_ID}" in xml
    assert "verification is waiting" in xml and TASK_TITLE not in xml


def test_the_windows_notifier_passes_only_the_toast(tmp_path):
    seen = []
    notifier = ring_module.Notifier("https://board.example", platform="win32",
                                    runner=lambda xml: seen.append(xml) or (0, b""))
    assert notifier.notify(TASK_ID, "stuck") is True and "a Task is stuck" in seen[0]
    assert ring_module.Notifier("https://board.example", platform="linux").notify(TASK_ID, "stuck") is False


# ── supervision of a real process tree ─────────────────────────────────────────

@pytest.mark.skipif(sys.platform == "win32", reason="the POSIX session kill; Windows uses the Job Object")
def test_a_timeout_ends_the_whole_process_tree(tmp_path):
    marker = tmp_path / "grandchild.pid"
    script = ("import subprocess,sys,time;"
              f"p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)']);"
              f"open({str(marker)!r},'w').write(str(p.pid));print('{{}}',flush=True);time.sleep(300)")
    result = ring_module.supervise([sys.executable, "-c", script], {"PATH": os.environ.get("PATH", "")},
                                   str(tmp_path), 2, "claude-code")
    assert result.code == "RUN_TIMEOUT"
    pid = int(marker.read_text())

    def gone():
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        try:
            return open(f"/proc/{pid}/stat").read().split()[2] == "Z"
        except (FileNotFoundError, ProcessLookupError):
            return True  # reaped between the kill probe and the read: gone
    assert wait_for(gone, 10)


# ── the per-run proxy and its folder ───────────────────────────────────────────

@pytest.mark.skipif(sys.platform == "win32", reason="POSIX folder modes")
def test_the_per_run_proxy_refuses_a_folder_others_can_read(tmp_path):
    folder = tmp_path / "rh-run-open"
    folder.mkdir()
    folder.chmod(0o755)
    (folder / "run.json").write_text(json.dumps({"schemaVersion": "rh.connector-run/1",
                                                  "runId": "11111111-0000-4000-8000-000000000001",
                                                  "board": "http://127.0.0.1:1"}))
    with pytest.raises(ring_module.RingError) as caught:
        ring_module.check_run_folder(folder)
    assert caught.value.code == "RUN_FOLDER_NOT_PRIVATE"


def test_the_run_credential_file_is_owner_only_and_removed(tmp_path):
    folder = tmp_path / "rh-run-x"
    folder.mkdir()
    ring_module.store_run_credential(folder, "11111111-0000-4000-8000-000000000001", AGENT_TOKEN, platform="linux")
    if sys.platform != "win32":
        assert stat.S_IMODE((folder / "agent.cred").stat().st_mode) == 0o600
    assert ring_module.load_run_credential(folder, "11111111-0000-4000-8000-000000000001", platform="linux") == AGENT_TOKEN
    assert ring_module.remove_run_folder(folder) and not folder.exists()


# ── the verbs ──────────────────────────────────────────────────────────────────

def test_connector_run_with_an_enabled_ring_serves_the_ring(setup):
    s = setup
    rt = s["rt"]
    served = []

    class StubRing:
        def serve(self):
            served.append(True)
            return 0

        def stop(self):
            pass
    rt.ring = lambda name, manifest, policy: StubRing()
    assert run_verb(rt, ["run", "--name", HANDLE]) == 0
    assert served == [True] and "ring stopped" in output(rt)


def test_the_harness_environment_carries_no_credential():
    saved = "rh_live_" + "zz88zz88zz88" + "." + "SavedKeyTheRunMustNotSee" + "000"
    env = ring_module.harness_env({"RELAYHALL_TOKEN": TOKEN, "SAVED_BOARD_KEY": saved, "PATH": "/bin"}, "claude-code")
    assert env == {"PATH": "/bin", "DISABLE_AUTOUPDATER": "1"}
    assert ring_module.harness_env({"PATH": "/bin", "OTHER": f"Bearer {saved}", "RUST_LOG": "trace"}, "codex") \
        == {"PATH": "/bin", "RUST_LOG": ring_module.CODEX_LOG_FILTER, "NO_COLOR": "1"}


def test_the_board_client_calls_only_its_routes():
    client = ring_module.Board("http://127.0.0.1:9", "x")
    for method, path in (("DELETE", f"/tasks/{TASK_ID}"), ("PATCH", f"/tasks/{TASK_ID}"), ("GET", "/grants"),
                         ("POST", "/warrants"), ("GET", f"/tasks/{TASK_ID}/../../credentials")):
        with pytest.raises(ring_module.RingError) as caught:
            client.call(method, path)
        assert caught.value.code == "BOARD_ROUTE"


def test_a_second_daemon_for_the_same_connector_stands_down(setup):
    import relayhall_connector_collector as collector_module
    rt = setup["rt"]
    rt.ring = lambda *a: pytest.fail("a second daemon must not start a ring")
    lock = connector.state_dir(rt, HANDLE) / ring_module.STATE_DIR / "ring.lock"
    with collector_module.exclusive(lock):
        assert run_verb(rt, ["run", "--name", HANDLE]) == collector_module.EXIT_BUSY
    assert "ring already running" in output(rt)


def test_connector_run_without_a_ring_is_one_bounded_cycle(tmp_path, board):
    rt = install_for_ring(tmp_path, board)
    rt.ring = lambda *a: pytest.fail("no ring without ring.json")
    assert run_verb(rt, ["run", "--name", HANDLE]) == 0
    assert "collector not configured" in output(rt) and rt.hard_exits == []


def test_a_one_cycle_run_still_ends_itself_after_fifteen_minutes(tmp_path, board, monkeypatch):
    rt = install_for_ring(tmp_path, board)
    (connector.state_dir(rt, HANDLE) / "collector.json").write_text("{}")
    release = threading.Event()

    class HungCollector:
        def run(self, mode):
            release.wait(20)
            return {"status": "ok"}

        def exit_code(self, record):
            return 0
    rt.collector = lambda name, manifest: HungCollector()
    monkeypatch.setattr(connector, "ONESHOT_LIMIT_SECONDS", 0.2)
    rt.hard_exit = lambda code: (rt.hard_exits.append(code), release.set())
    assert run_verb(rt, ["run", "--name", HANDLE]) == 0
    assert rt.hard_exits == [connector.EXIT_ONESHOT_WATCHDOG]


def test_check_reports_the_ring_policy_the_task_limit_and_wake(setup):
    rt = setup["rt"]
    assert run_verb(rt, ["check", "--name", HANDLE]) == 0, output(rt)
    text = output(rt)
    assert "ok    ring policy: enabled" in text and "ok    wake: wake=2 enabled" in text
    assert "ok    ring task" in text
    assert rt.ws_calls[0]["url"].endswith("/api/events/ws?wake=2") and TOKEN not in rt.ws_calls[0]["url"]


def test_check_fails_on_an_invalid_ring_policy(setup):
    rt = setup["rt"]
    (connector.state_dir(rt, HANDLE) / "ring.json").write_text(json.dumps({"schemaVersion": "nope"}))
    assert run_verb(rt, ["check", "--name", HANDLE]) == connector.EXIT_FAILED
    assert "FAIL  ring policy" in output(rt)


def test_the_task_no_longer_stops_the_daemon_after_fifteen_minutes(tmp_path, board):
    rt = install_for_ring(tmp_path, board)
    xml = next(iter(rt.scheduler.tasks.values()))
    assert "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>" in xml


def test_status_shows_the_ring(setup):
    rt = setup["rt"]
    assert run_verb(rt, ["status", "--name", HANDLE]) == 0
    assert "ring       enabled; 0 run(s) active, 0 pending" in output(rt)


# ── end to end: a real stand-in harness starts the real per-run proxy ──────────

def wrapper(tmp_path):
    """An executable that runs the stand-in harness (what publisher trust would hand the ring as runBinary)."""
    script = tmp_path / "bin" / "harness"
    script.parent.mkdir()
    fake = Path(__file__).resolve().parent / "connector_fake_harness.py"
    script.write_text(f"#!/bin/sh\nexec {sys.executable} {fake} \"$@\"\n")
    script.chmod(0o700)
    return script


@pytest.mark.skipif(sys.platform == "win32", reason="a POSIX wrapper script stands in for the trusted binary")
@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_end_to_end_the_run_reaches_the_board_only_as_its_agent(tmp_path, board, harness):
    routes = RingRoutes(board)
    rt = install_for_ring(tmp_path, board, harness=harness)
    workdir = tmp_path / "work"
    workdir.mkdir()
    reports = tmp_path / "reports"
    reports.mkdir()
    write_ring_policy(rt, HANDLE, workdir)
    rt.environ["FAKE_HARNESS_REPORT"] = str(reports)
    rt.environ["RELAYHALL_TOKEN"] = TOKEN  # a token in the person's shell must never reach a run
    routes.add_task(assigned_task())
    rt.python = sys.executable
    sock = FakeSocket()
    import relayhall_connector_proc as proc
    ring = make_ring(rt, sock=sock, spawn=proc.OwnedChild, trust_gate=FakeRunTrust(str(wrapper(tmp_path))),
                     run_root=str(tmp_path / "runs"))
    (tmp_path / "runs").mkdir()
    ring.start()
    ring.on_message(sock, json.dumps({"type": "wake.status", "enabled": True}))
    before = len(board.mcp_requests())
    ring.on_message(sock, json.dumps(wake()))
    assert wait_for(ring.idle, 60), ring.events
    assert outcomes(sock) == [("started", None), ("finished", None)], ring.events
    report = json.loads(next(reports.iterdir()).read_text())
    assert report["servers"] == ["relayhall"]
    proxy = report["proxy"]
    assert proxy["initialized"] and proxy["proxyExit"] == 0, proxy
    whoami = json.loads(proxy["whoami"]["result"]["content"][0]["text"])
    assert whoami["principal"]["id"] == "a9e7c300-0000-4000-8000-000000000001"  # the run's Agent, not the connector
    run_requests = board.mcp_requests()[before:]
    assert run_requests and {r["headers"]["Authorization"] for r in run_requests} == {f"Bearer {AGENT_TOKEN}"}
    # Census: neither credential is in the harness's argv or environment, and no file holds either afterwards.
    assert AGENT_TOKEN not in json.dumps(report["argv"]) and TOKEN not in json.dumps(report["argv"])
    assert AGENT_TOKEN not in json.dumps(report["env"]) and TOKEN not in json.dumps(report["env"])
    assert "RELAYHALL_TOKEN" not in report["env"]
    assert list((tmp_path / "runs").iterdir()) == []
    for path in all_files(tmp_path):
        data = path.read_bytes()
        assert AGENT_TOKEN.encode() not in data and TOKEN.encode() not in data, path
    assert AGENT_TOKEN not in json.dumps(ring.events) and TOKEN not in json.dumps(ring.events)
    assert [r["who"] for r in routes.revoked] == ["connector"]
    assert ring.state.runs[-1]["mcpServers"] == ["relayhall"]  # read back from the harness's own output
