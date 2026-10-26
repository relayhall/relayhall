"""The connector's usage-quota collector (E462 slice S3; E456; E463).

- Payload parity: the snapshots are the ones today's reporters post (the Claude windows of the plugin's
  claude-report collector, the Codex windows of the PC collector), and they reach the board the same way:
  POST, exact read-back, 1.5 s spacing, a 429 retried.
- Reliable provider reads (E463), against a FAKE PROVIDER that is a real child process: it hangs (with a
  grandchild holding its stdout, the shape that held the earlier reporter's lock), fails, then succeeds. Each
  read has a hard deadline, the whole process tree is ended, a transient failure is retried with backoff, the
  lock is released on every exit path (and by the OS when the watchdog ends an overrun run), and a read that
  still fails is reported to the board BY NAME.
- Trust before reading: a refused binary is never run, its rows say `untrusted-binary`; a new version is
  reported once; the board's override narrows and a widening entry is refused and reported.
"""
import datetime
import hashlib
import json
import os
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

import relayhall_connector as connector
import relayhall_connector_collector as C
import relayhall_connector_trust as T
from relayhall_connector_proc import run_bounded
from connector_testkit import (CLAUDE_USAGE, CODEX_EMAIL, CODEX_LIMITS, HANDLE, PRINCIPAL_ID, TOKEN, FakeTrust,
                               StubBoard, accounts, claude_pin, codex_pin, make_runtime, output, registration, run_verb,
                               sign_in, use_collector, write_collector_config)

HERE = Path(__file__).resolve().parent
AT = "2026-10-24T17:00:00.000Z"
POSIX = sys.platform != "win32"


def install(rt, board, harness="claude-code"):
    return run_verb(rt, ["install", "--harness", harness, "--board", board.origin])


def epoch_iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")


# ── payload parity ────────────────────────────────────────────────────────────

def test_the_claude_snapshot_is_the_plugin_collectors_snapshot():
    reg = registration()
    snap = C.claude_snapshot(reg, CLAUDE_USAGE, AT)
    model = "model-" + hashlib.sha256("Sonnet 9".encode()).hexdigest()[:12]
    assert snap == {
        "schemaVersion": "rh.usage-quota/1", "sourceProduct": "claude-code", "provider": "claude-code",
        "providerAccountId": reg["providerAccountId"], "label": reg["label"], "observedAt": AT, "checkedAt": AT,
        "status": "reported", "windows": [
            {"id": "five_hour", "label": "5 hours", "unit": "percent", "used": 12.5, "limit": 100,
             "resetsAt": "2026-10-24T20:00:00.123Z"},
            {"id": "seven_day", "label": "Weekly", "unit": "percent", "used": 40, "limit": 100,
             "resetsAt": epoch_iso(1761500000)},
            {"id": model, "label": "Weekly · Sonnet 9", "unit": "percent", "used": 100, "limit": 100}]}
    # No windows is an honest not-reported reading, never zero.
    assert C.claude_snapshot(reg, {"rate_limits": {"five_hour": {"utilization": None}}}, AT)["status"] == "not-reported"
    assert C.claude_snapshot(reg, {}, AT)["windows"] == []


def test_the_codex_snapshot_is_the_pc_collectors_snapshot():
    reg = registration("codex")
    snap = C.codex_snapshot(reg, CODEX_LIMITS, AT)
    bucket = hashlib.sha256(b"codex").hexdigest()[:20]
    assert snap == {
        "provider": "openai", "providerAccountId": reg["providerAccountId"], "sourceProduct": "codex",
        "label": reg["label"], "schemaVersion": "rh.usage-quota/1", "observedAt": AT, "checkedAt": AT,
        "status": "reported", "windows": [
            {"id": f"quota-{bucket}-primary", "label": "codex 300 minutes", "unit": "percent", "used": 25,
             "limit": 100, "resetsAt": epoch_iso(1761500000)},
            {"id": f"quota-{bucket}-secondary", "label": "codex weekly", "unit": "percent", "used": 60, "limit": 100}]}
    with pytest.raises(C.Refusal) as caught:
        C.codex_snapshot(reg, {"rateLimitsByLimitId": {"codex": {"primary": {"usedPercent": 101,
                                                                            "windowDurationMins": 5}}}}, AT)
    assert caught.value.code == "QUOTA_PERCENT"
    with pytest.raises(C.Refusal) as caught:
        C.codex_snapshot(reg, {"rateLimitsByLimitId": {}}, AT)
    assert caught.value.code == "QUOTA_WINDOWS_UNAVAILABLE"


def test_a_failed_refresh_keeps_the_reading_and_names_the_cause():
    reg = registration()
    last = C.claude_snapshot(reg, CLAUDE_USAGE, AT)
    later = "2026-10-24T17:05:00.000Z"
    kept = C.failed_snapshot(reg, last, later, "PROVIDER_TIMEOUT")
    assert {k: v for k, v in kept.items() if k not in ("checkedAt", "errorCode")} == \
           {k: v for k, v in last.items() if k != "checkedAt"}
    assert kept["checkedAt"] == later and kept["errorCode"] == "timeout"
    fresh = C.failed_snapshot(reg, None, later, "BINARY_SIGNER_MISMATCH")
    assert fresh["status"] == "not-reported" and fresh["windows"] == [] and fresh["errorCode"] == "untrusted-binary"
    assert C.error_code_for("NOT_SIGNED_IN") == "auth-required"
    assert C.error_code_for("PROVIDER_EXITED") == "unavailable"


# ── a fake provider that is a real child process ─────────────────────────────

FAKE = textwrap.dedent('''\
    #!{python}
    import json, os, subprocess, sys, time
    here = os.path.abspath(__file__)
    plan = json.load(open(here + ".plan"))
    count = int(open(here + ".count").read()) if os.path.exists(here + ".count") else 0
    open(here + ".count", "w").write(str(count + 1))
    mode = plan[min(count, len(plan) - 1)]
    codex = sys.argv[1:2] == ["app-server"]
    if mode == "exit":
        sys.exit(3)
    if mode == "hang-with-grandchild":
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        open(here + ".grandchild", "w").write(str(child.pid))
        time.sleep(300)
    if mode == "hang":
        time.sleep(300)
    def send(value):
        sys.stdout.write(json.dumps(value) + "\\n"); sys.stdout.flush()
    for raw in sys.stdin:
        message = json.loads(raw)
        if codex:
            ident, method = message.get("id"), message.get("method")
            if ident is None:
                continue
            if method == "account/read":
                email = {email!r} if not (mode == "swap" and ident == 4) else "other@example.test"
                send({{"id": ident, "result": {{"account": {{"type": "chatgpt", "email": email}}}}}})
            elif method == "account/rateLimits/read":
                send({{"method": "noise"}})
                send({{"id": ident, "result": {limits!r}}})
            else:
                send({{"id": ident, "result": {{}}}})
            continue
        rid = message.get("request_id")
        if mode == "turn":
            send({{"type": "assistant", "message": {{}}}})
            continue
        if rid == "rh-init":
            send({{"type": "control_response", "response": {{"request_id": "rh-init", "subtype": "success"}}}})
        elif rid == "rh-usage" and mode == "usage-error":
            send({{"type": "control_response", "response": {{"request_id": "rh-usage", "subtype": "error"}}}})
        elif rid == "rh-usage":
            send({{"type": "control_response", "response": {{"request_id": "rh-usage", "subtype": "success",
                                                              "response": {usage!r}}}}})
''')


def fake_provider(folder, plan, name="claude.exe"):
    path = Path(folder) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(FAKE.format(python=sys.executable, email=CODEX_EMAIL, limits=CODEX_LIMITS, usage=CLAUDE_USAGE))
    path.chmod(0o755)
    Path(str(path) + ".plan").write_text(json.dumps(plan))
    return path


def runs(path):
    counter = Path(str(path) + ".count")
    return int(counter.read_text()) if counter.exists() else 0


def gone(pid):
    """Dead or a zombie (reaped by nobody yet): either way it holds nothing."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split(")")[-1].split()[0]
    except (FileNotFoundError, ProcessLookupError):
        return True
    return state == "Z"


posix_only = pytest.mark.skipif(not POSIX, reason="the fake provider is a script with a #! line")


@posix_only
def test_a_hung_provider_and_its_grandchild_are_ended_within_the_deadline(tmp_path):
    binary = fake_provider(tmp_path, ["hang-with-grandchild"])
    started = time.monotonic()
    with pytest.raises(C.ChildError) as caught:
        C.read_claude(str(binary), registration(), dict(os.environ), timeout=2, cwd=tmp_path)
    assert caught.value.code == "PROVIDER_TIMEOUT"
    assert time.monotonic() - started < 12
    grandchild = int(Path(str(binary) + ".grandchild").read_text())
    deadline = time.monotonic() + 5
    while not gone(grandchild) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert gone(grandchild), "the grandchild that held the provider's stdout survived"


@posix_only
@pytest.mark.parametrize("plan,code", [(["exit"], "PROVIDER_EXITED"), (["turn"], "PROVIDER_TURN_STARTED"),
                                       (["usage-error"], "PROVIDER_USAGE_REFUSED")])
def test_each_provider_failure_has_its_own_name(tmp_path, plan, code):
    binary = fake_provider(tmp_path, plan)
    with pytest.raises((C.ChildError, C.Refusal)) as caught:
        C.read_claude(str(binary), registration(), dict(os.environ), timeout=10, cwd=tmp_path)
    assert caught.value.code == code


@posix_only
def test_the_claude_protocol_reads_get_usage_without_a_turn(tmp_path):
    binary = fake_provider(tmp_path, ["ok"])
    assert C.read_claude(str(binary), registration(), dict(os.environ), timeout=10, cwd=tmp_path) == CLAUDE_USAGE


@posix_only
def test_the_codex_protocol_pins_the_account_before_and_after(tmp_path):
    binary = fake_provider(tmp_path, ["ok", "swap"], name="codex.exe")
    value = C.read_codex(str(binary), registration("codex"), dict(os.environ), timeout=10, cwd=tmp_path)
    assert value["data"] == CODEX_LIMITS
    with pytest.raises(C.Refusal) as caught:
        C.read_codex(str(binary), registration("codex"), dict(os.environ), timeout=10, cwd=tmp_path)
    assert caught.value.code == "ACCOUNT_CHANGED_DURING_READ"
    with pytest.raises(C.Refusal) as caught:
        C.read_codex(str(binary), registration("codex", pin=codex_pin("someone@example.test")), dict(os.environ),
                     timeout=10, cwd=tmp_path)
    assert caught.value.code == "ACCOUNT_CHANGED_BEFORE_READ"


def test_the_provider_environment_is_an_allowlist():
    environ = {"PATH": "/bin", "USERPROFILE": "/home/p", "RELAYHALL_TOKEN": TOKEN, "ANTHROPIC_API_KEY": "sk-x",
               "CLAUDE_CODE_OAUTH_TOKEN": "x", "OPENAI_API_KEY": "sk-y", "CODEX_HOME": "/elsewhere"}
    env = C.provider_env("claude-code", registration(config_dir="/accounts/b"), environ)
    assert env == {"PATH": "/bin", "USERPROFILE": "/home/p", "DISABLE_AUTOUPDATER": "1",
                   "CLAUDE_CONFIG_DIR": "/accounts/b"}
    env = C.provider_env("codex", registration("codex"), environ)
    assert env == {"PATH": "/bin", "USERPROFILE": "/home/p", "DISABLE_AUTOUPDATER": "1"}


# ── through the connector, against the stub board ────────────────────────────

def setup(tmp_path, board, harness="claude-code", regs=None, **kwargs):
    rt = make_runtime(tmp_path)
    assert install(rt, board, harness) == 0, output(rt)
    home = Path(rt.environ["USERPROFILE"])
    if harness == "claude-code":
        sign_in(home)
    if regs == "two":
        regs = accounts(rt, harness)
    regs = regs if regs is not None else [registration(harness)]
    write_collector_config(rt, HANDLE, harness, regs)
    trust = use_collector(rt, **kwargs)
    return rt, trust


def last_attempt(rt):
    return json.loads((connector.state_dir(rt, HANDLE) / "collector" / "last-attempt.json").read_text())


def events(board):
    return [e["outcome"]["error_type"] for e in board.events]


def test_collect_once_posts_reads_back_and_reports_a_new_version_once(tmp_path):
    with StubBoard() as board:
        rt, trust = setup(tmp_path, board)
        assert run_verb(rt, ["collect", "--once"]) == 0, output(rt)
        posts = board.quota_posts()
        assert len(posts) == 1 and posts[0]["windows"] and posts[0]["status"] == "reported"
        assert posts[0]["providerAccountId"] == registration()["providerAccountId"]
        record = last_attempt(rt)
        assert record["status"] == "ok" and record["registrations"][0]["outcome"] == "accepted"
        assert record["trust"]["status"] == "accepted" and record["trust"]["version"] == "2.1.246"
        assert events(board) == ["connector.trust.accepted"]
        assert board.events[0]["source"] == {"product": "claude-code", "adapter": "relayhall-connector",
                                             "adapter_version": C.COLLECTOR_VERSION, "mechanism": "push"}
        # The same build again: verified, not reported again (it is in the ledger already).
        assert run_verb(rt, ["collect", "--once"]) == 0
        assert events(board) == ["connector.trust.accepted"]
        assert trust.rechecks >= 4  # the very build, before every spawn and after every child


def test_quota_posts_are_spaced_and_a_429_is_retried(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, regs="two")
        board.fail[("POST", "/api/telemetry/quotas")] = [429, 429]
        assert run_verb(rt, ["collect", "--once"]) == 0, output(rt)
        record = last_attempt(rt)
        assert record["registrations"][0]["postRetries"] == 2
        assert {r["result"] for r in record["registrations"]} == {"ok"}


def test_a_board_refusal_is_recorded_by_its_name(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        board.fail[("POST", "/api/telemetry/quotas")] = [403]
        assert run_verb(rt, ["collect", "--once"]) == 1
        entry = last_attempt(rt)["registrations"][0]
        assert entry["failureCode"] == "HTTP_STATUS" and entry["httpStatus"] == 403
        assert entry["boardCode"] == "INJECTED_FAILURE"


def test_check_mode_reads_and_posts_nothing(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        assert run_verb(rt, ["collect", "--check"]) == 0, output(rt)
        assert [r for r in board.requests if r["method"] == "POST" and r["path"] != "/api/mcp"] == []
        assert last_attempt(rt)["status"] == "checked"


def test_a_registration_without_a_login_posts_an_honest_waiting_row(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, regs=[registration(config_dir=str(tmp_path / "accounts" / "b"))])
        assert run_verb(rt, ["collect", "--once"]) == 0, output(rt)
        post = board.quota_posts()[0]
        assert post["status"] == "not-reported" and post["errorCode"] == "auth-required" and post["windows"] == []


def test_another_account_in_the_folder_is_refused_and_named(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, regs=[registration(pin=claude_pin("99999999-2222-4333-8444-555555555555"))])
        assert run_verb(rt, ["collect", "--once"]) == 1
        entry = last_attempt(rt)["registrations"][0]
        assert entry["failureCode"] == "ACCOUNT_CHANGED_BEFORE_READ" and entry["reportedErrorCode"] == "unavailable"
        assert board.quota_posts()[0]["errorCode"] == "unavailable"
        assert events(board)[-1] == "connector.collector.refused.ACCOUNT_CHANGED_BEFORE_READ"


@posix_only
def test_a_transient_failure_is_retried_with_backoff_then_read(tmp_path):
    binary = fake_provider(tmp_path / "bin", ["exit", "hang", "ok"])
    slept = []
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, trust_checker=FakeTrust(binary=str(binary)),
                      readers={"claude-code": C.read_claude}, provider_seconds={"claude-code": 2})
        collector = rt.collector(HANDLE, connector.load_manifest(rt, HANDLE))
        collector.sleep = slept.append
        record = collector.run("once")
    entry = record["registrations"][0]
    assert entry["result"] == "ok" and entry["attempts"] == 3, record
    assert entry["retriedAfter"] == ["PROVIDER_EXITED", "PROVIDER_TIMEOUT"]
    assert slept[:2] == list(C.PROVIDER_BACKOFF_SECONDS)
    assert runs(binary) == 3


@posix_only
def test_a_read_that_keeps_failing_is_reported_by_name_and_keeps_the_last_reading(tmp_path):
    binary = fake_provider(tmp_path / "bin", ["ok", "exit"])
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, trust_checker=FakeTrust(binary=str(binary)),
                      readers={"claude-code": C.read_claude})
        assert run_verb(rt, ["collect", "--once"]) == 0, output(rt)
        good = board.quota_posts()[-1]
        assert run_verb(rt, ["collect", "--once"]) == 1
        entry = last_attempt(rt)["registrations"][0]
        assert entry["failureCode"] == "PROVIDER_EXITED" and entry["retriedAfter"] == ["PROVIDER_EXITED"] * 3
        failed = board.quota_posts()[-1]
        assert failed["errorCode"] == "unavailable" and failed["checkedAt"] > good["checkedAt"]
        assert {k: v for k, v in failed.items() if k not in ("checkedAt", "errorCode")} == \
               {k: v for k, v in good.items() if k != "checkedAt"}
        assert entry["outcome"] == "accepted"  # the board took it as the failed refresh of the same reading
        assert events(board)[-1] == "connector.collector.refused.PROVIDER_EXITED"
        assert "PROVIDER_READ" not in json.dumps(last_attempt(rt))


@posix_only
def test_a_turn_is_never_retried(tmp_path):
    binary = fake_provider(tmp_path / "bin", ["turn", "ok"])
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, trust_checker=FakeTrust(binary=str(binary)),
                      readers={"claude-code": C.read_claude})
        assert run_verb(rt, ["collect", "--once"]) == 1
    assert runs(binary) == 1 and last_attempt(rt)["registrations"][0]["failureCode"] == "PROVIDER_TURN_STARTED"


def test_a_refused_binary_is_never_run_and_its_rows_say_untrusted(tmp_path):
    called = []
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, regs="two",
                      trust_checker=FakeTrust(refuse="BINARY_SIGNER_MISMATCH"),
                      readers={"claude-code": lambda *a, **k: called.append(a)})
        assert run_verb(rt, ["collect", "--once"]) == 1
        assert called == []
        posts = board.quota_posts()
        assert len(posts) == 2 and {p["errorCode"] for p in posts} == {"untrusted-binary"}
        assert events(board) == ["connector.trust.refused.BINARY_SIGNER_MISMATCH"]
        record = last_attempt(rt)
        assert record["trust"] == {"status": "refused", "code": "BINARY_SIGNER_MISMATCH", "observed": {"version": "2.1.246"}}
        assert {r["failureCode"] for r in record["registrations"]} == {"BINARY_SIGNER_MISMATCH"}


def test_the_board_override_narrows_and_a_widening_entry_is_refused_and_reported(tmp_path):
    with StubBoard() as board:
        board.trust_policy = {"schemaVersion": "rh.connector-trust-policy/1", "ceilingSha256": T.CEILING_SHA256,
                              "source": "deployment", "rejected": [], "override": {
                                  "schemaVersion": T.OVERRIDE_SCHEMA, "products": {"claude-code": {"windows": {
                                      "minimumVersion": "2.1.300", "publishers": [{"id": "evil"}]}}}}}
        rt, trust = setup(tmp_path, board)
        run_verb(rt, ["collect", "--once"])
        rule = trust.policy["products"]["claude-code"]["windows"]
        assert rule["minimumVersion"] == "2.1.300" and [p["id"] for p in rule["publishers"]] == ["anthropic-digicert-ev"]
        policy = last_attempt(rt)["policy"]
        assert policy["overrideSource"] == "board" and policy["boardCeilingDiffers"] is False
        assert policy["overrideRejected"] == [{"path": "products.claude-code.windows.publishers",
                                               "code": "OVERRIDE_WIDENING_FIELD"}]
        assert "connector.trust.override_rejected.OVERRIDE_WIDENING_FIELD" in events(board)
        # The board unreachable next time: the last narrowing it served still applies (never the wider ceiling).
        board.fail[("GET", "/api/connectors/trust-policy")] = [503]
        run_verb(rt, ["collect", "--once"])
        assert trust.policy["products"]["claude-code"]["windows"]["minimumVersion"] == "2.1.300"
        assert last_attempt(rt)["policy"]["overrideSource"] == "cache"


def test_a_board_without_the_route_means_the_release_policy(tmp_path):
    with StubBoard() as board:
        rt, trust = setup(tmp_path, board)
        assert run_verb(rt, ["collect", "--once"]) == 0
        assert trust.policy["products"] == T.load_ceiling()["products"]
        assert last_attempt(rt)["policy"]["overrideSource"] == "none"


def test_the_codex_harness_posts_the_codex_rows(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, harness="codex")
        assert run_verb(rt, ["collect", "--once"]) == 0, output(rt)
        post = board.quota_posts()[0]
        assert post["provider"] == "openai" and post["sourceProduct"] == "codex" and len(post["windows"]) == 2


def test_a_harness_without_a_quota_source_says_unsupported(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, harness="vscode",
                      regs=[dict(registration(), provider="github-copilot", sourceProduct="vscode")])
        assert run_verb(rt, ["collect", "--once"]) == 0, output(rt)
        assert board.quota_posts()[0]["status"] == "unsupported"


def test_a_collector_that_is_not_configured_says_so(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert install(rt, board) == 0
        assert run_verb(rt, ["collect", "--once"]) == 1
        assert "COLLECTOR_NOT_CONFIGURED" in output(rt)


@pytest.mark.parametrize("config", [
    {"harness": "codex"}, {"registrations": []}, {"registrations": [dict(registration(), label="me@example.test")]},
    {"registrations": [dict(registration(), accountPin="x")]}, {"registrations": [registration(), registration()]},
    {"registrations": [dict(registration(), provider="openai")]}, {"extra": True}])
def test_a_malformed_configuration_refuses(tmp_path, config):
    rt = make_runtime(tmp_path)
    folder = connector.state_dir(rt, HANDLE)
    folder.mkdir(parents=True)
    value = dict({"schemaVersion": C.COLLECTOR_SCHEMA, "harness": "claude-code", "registrations": [registration()]},
                 **config)
    (folder / "collector.json").write_text(json.dumps(value))
    with pytest.raises(C.Refusal) as caught:
        C.load_config(folder, "claude-code")
    assert caught.value.code in ("COLLECTOR_CONFIG_SHAPE", "REGISTRATION_SHAPE", "REGISTRATION_DUPLICATE")


# ── the run lock ──────────────────────────────────────────────────────────────

def test_a_second_run_is_refused_while_one_holds_the_lock_and_the_owner_record_is_kept(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        assert run_verb(rt, ["collect", "--once"]) == 0
        before = last_attempt(rt)
        with C.exclusive(connector.state_dir(rt, HANDLE) / "collector" / "collector.lock"):
            assert run_verb(rt, ["collect", "--once"]) == C.EXIT_BUSY
            assert run_verb(rt, ["run", "--name", HANDLE]) == 0  # the scheduled run is not failed by a busy lock
        assert last_attempt(rt) == before


@posix_only
def test_the_lock_is_released_after_a_timeout_and_after_an_unexpected_error(tmp_path):
    binary = fake_provider(tmp_path / "bin", ["hang"])
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board, trust_checker=FakeTrust(binary=str(binary)),
                      readers={"claude-code": C.read_claude}, provider_seconds={"claude-code": 1}, attempts=1)
        assert run_verb(rt, ["collect", "--once"]) == 1
        assert last_attempt(rt)["registrations"][0]["failureCode"] == "PROVIDER_TIMEOUT"
        lock = connector.state_dir(rt, HANDLE) / "collector" / "collector.lock"
        with C.exclusive(lock):
            pass  # free again

        def explode(*args, **kwargs):
            raise RuntimeError("provider exploded")
        use_collector(rt, readers={"claude-code": explode})
        assert run_verb(rt, ["collect", "--once"]) == 1
        assert last_attempt(rt)["failureCode"] == "UNEXPECTED_RuntimeError"
        assert "provider exploded" not in json.dumps(last_attempt(rt)) and "provider exploded" not in output(rt)
        with C.exclusive(lock):
            pass


WATCHDOG = textwrap.dedent('''\
    import json, sys, time
    sys.path.insert(0, {cli!r})
    import relayhall_connector_collector as C, relayhall_connector_trust as T
    from connector_testkit import FakeTrust, PRINCIPAL_ID, TOKEN
    manifest = {{"board": {board!r}, "harness": "claude-code", "principal": {{"id": PRINCIPAL_ID}}}}
    collector = C.Collector("laptop", manifest, {folder!r}, lambda: TOKEN, {{"PATH": "/bin"}}, budget_seconds=5,
                            watchdog_grace=1, trust_checker=FakeTrust(), ceiling=T.load_ceiling(),
                            account_digest=lambda reg, env: time.sleep(60))
    collector.run("once")
    sys.exit(0)
''')


@posix_only
def test_an_overrun_cycle_is_ended_by_the_watchdog_and_the_os_releases_the_lock(tmp_path):
    """The deepest net (E463): even a hang the deadlines do not cover cannot hold the lock."""
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        folder = connector.state_dir(rt, HANDLE)
        script = tmp_path / "watchdog.py"
        script.write_text(WATCHDOG.format(cli=str(HERE), board=board.origin, folder=str(folder)))
        started = time.monotonic()
        done = subprocess.run([sys.executable, str(script)], capture_output=True, timeout=60)
        assert done.returncode == C.EXIT_WATCHDOG, done.stderr[-500:]
        assert time.monotonic() - started < 30
        assert last_attempt(rt)["failureCode"] == "CYCLE_WATCHDOG"
        with C.exclusive(folder / "collector" / "collector.lock"):
            pass


def test_an_unresolved_child_holds_new_reads_until_it_is_gone(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        held = connector.state_dir(rt, HANDLE) / "collector" / "cleanup-held.json"
        held.parent.mkdir(parents=True, exist_ok=True)
        held.write_text(json.dumps({"pid": os.getpid()}))
        assert run_verb(rt, ["collect", "--once"]) == 1
        assert last_attempt(rt)["failureCode"] == "OWNED_CHILD_CLEANUP_UNRESOLVED"
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        held.write_text(json.dumps({"pid": dead.pid}))
        assert run_verb(rt, ["collect", "--once"]) == 0, output(rt)
        assert not held.exists()


# ── the scheduled run and `check` ────────────────────────────────────────────

def test_the_scheduled_run_collects_once(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        assert run_verb(rt, ["run", "--name", HANDLE]) == 0
        state = json.loads((connector.state_dir(rt, HANDLE) / "run-state.json").read_text())
        assert state["result"].startswith("custody ok; collector ok: 1/1 accounts")
        assert len(board.quota_posts()) == 1
        task = rt.scheduler.tasks[connector.task_name(HANDLE)]
        assert "<TimeTrigger>" in task and "<Interval>PT5M</Interval>" in task


def test_check_runs_the_trust_check_and_a_dry_read(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        assert run_verb(rt, ["check"]) == 0, output(rt)
        text = output(rt)
        assert "ok    harness binary trust: claude-code 2.1.246 by verified publisher fake-publisher" in text
        assert "ok    quota dry read: 1/1 accounts read" in text
        assert board.quota_posts() == []
        (tmp_path / "second").mkdir()
        rt2, _ = setup(tmp_path / "second", board, trust_checker=FakeTrust(refuse="VERSION_BELOW_MINIMUM"))
        assert run_verb(rt2, ["check"]) == 1
        assert "FAIL  harness binary trust: refused: VERSION_BELOW_MINIMUM" in output(rt2)


def test_status_shows_the_last_cycle(tmp_path):
    with StubBoard() as board:
        rt, _ = setup(tmp_path, board)
        assert run_verb(rt, ["collect", "--once"]) == 0
        rt.stdout.seek(0)
        rt.stdout.truncate(0)
        assert run_verb(rt, ["status"]) == 0
        assert "collector  collector ok: 1/1 accounts; binary 2.1.246 trusted at " in rt.stdout.getvalue()


def test_every_recorded_code_is_in_the_closed_alphabet(tmp_path):
    source = (HERE / "relayhall_connector_collector.py").read_text()
    import re
    raised = set(re.findall(r'need\([^)]*?"([A-Z][A-Z_]{3,})"\)', source, re.S)) | set(
        re.findall(r'Refusal\("([A-Z_]{4,})"', source))
    assert raised and raised <= C.CODES, raised - C.CODES
    assert C.RETRYABLE <= C.CODES


TREE = textwrap.dedent('''\
    import subprocess, sys, time
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    open(sys.argv[1], "w").write(str(child.pid))
    time.sleep(300)
''')


def test_an_owned_child_tree_is_ended_on_this_operating_system(tmp_path):
    """The same E463 property on whichever OS runs the suite: on Windows the Job Object (and taskkill /T), on
    POSIX the process group. A grandchild that inherited the child's stdout is gone after the deadline."""
    script, marker = tmp_path / "tree.py", tmp_path / "grandchild.pid"
    script.write_text(TREE)
    started = time.monotonic()
    with pytest.raises(C.ChildError) as caught:
        run_bounded([sys.executable, str(script), str(marker)], env=dict(os.environ), timeout=3,
                      code_prefix="PROVIDER")
    assert caught.value.code == "PROVIDER_TIMEOUT" and time.monotonic() - started < 15
    grandchild = int(marker.read_text())
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and (gone(grandchild) is False if POSIX else C.process_alive(grandchild)):
        time.sleep(0.2)
    assert (gone(grandchild) if POSIX else not C.process_alive(grandchild)), "the grandchild survived its parent's end"
