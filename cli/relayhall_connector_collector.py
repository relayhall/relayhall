"""The connector's usage-quota collector (design v1.5 section 4; owner rulings
E456, E462 slice S3 and E463).

The Claude Code and Codex plan-quota reporters, moved into the connector:

- Same contract and payloads to the board as the reporters they replace:
  `POST /telemetry/quotas` with an `rh.usage-quota/1` snapshot, read back
  exactly with `GET /telemetry/quotas`, one POST every 1.5 s at most (a 429 is
  retried up to three times), per-account pins checked before and after each
  read (`ACCOUNT_CHANGED_*` discards a reading).
- Same credential path: the connector's ONE token, from the connector's OS
  custody. There is no second token and no file the collector reads it from.
- Before any provider read, the harness binary passes publisher trust
  (`relayhall_connector_trust`): by verified publisher and package identity,
  never by one exact version; a new version is accepted, recorded append-only
  and reported once (`connector.trust.accepted`); a mismatch refuses with a
  named code (`connector.trust.refused`) and the Usage Limits row says
  `untrusted-binary`, not stale. The board's override at
  GET /connectors/trust-policy can only narrow the release's policy.
- Provider reads are reliable (E463): each read is a child process the
  connector owns, with a hard deadline, its whole process tree ended on every
  path (`relayhall_connector_proc`), up to three attempts with backoff on a
  transient failure, within one cycle budget, and a watchdog that ends the whole
  run (so the OS releases the lock) if the budget is ever overrun. The run lock
  is an OS byte lock, released on every exit path. A read that still fails is
  reported to the board BY NAME: the quota row keeps its last reading with a
  later `checkedAt` and an `errorCode` (the plugin contract's attempt metadata),
  and a telemetry event carries the exact cause
  (`connector.collector.refused.<CODE>`).

The collector's local configuration (`collector.json` in the connector's
folder, see docs/connector-onboarding.md) names the accounts; it holds labels,
opaque provider account ids and sha256 pins, never an e-mail address or a
credential. What it records locally (`collector/last-attempt.json`) is codes,
counts and timestamps only.
"""
import contextlib
import datetime
import hashlib
import http.client
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import relayhall_connector_trust as trust
from relayhall_connector_mcp import TRANSPORT_ERRORS, board_opener
from relayhall_connector_proc import ChildError, OwnedChild, process_alive

COLLECTOR_FILE = "collector.json"
COLLECTOR_SCHEMA = "rh.connector-collector/1"
RUNTIME_DIR = "collector"
COLLECTOR_VERSION = "1.0.0"
EXIT_OK, EXIT_REFUSED, EXIT_WATCHDOG, EXIT_BUSY = 0, 1, 70, 75

CYCLE_SECONDS = 240
WATCHDOG_GRACE_SECONDS = 60
PROVIDER_ATTEMPTS = 3
PROVIDER_BACKOFF_SECONDS = (2.0, 5.0)
PROVIDER_SECONDS = {"claude-code": 40, "codex": 20}
RESERVE_SECONDS = 10
POST_SPACING_S = 1.5
RETRY_DEFAULT_S = 1.5
RETRY_MAX_S = 10.0
POST_RETRIES = 3

# What each harness collects (design 4.1). A harness with no known source reports `unsupported`.
SOURCES = {
    "claude-code": {"provider": "claude-code", "sourceProduct": "claude-code"},
    "codex": {"provider": "openai", "sourceProduct": "codex"},
}
UNSUPPORTED_SOURCES = {"vscode": "github-copilot", "antigravity": "antigravity"}

# A failed read is retried only when the cause can be transient. An account mismatch, a turn the provider
# started, a trust refusal or a child the connector could not end is never retried.
RETRYABLE = frozenset("""PROVIDER_TIMEOUT PROVIDER_EXITED PROVIDER_START_FAILED PROVIDER_PROTOCOL
PROVIDER_INIT_REFUSED PROVIDER_USAGE_REFUSED PROVIDER_RESPONSE PROVIDER_OUTPUT_LIMIT""".split())

# The closed alphabet of what a cycle records and reports. Nothing else (no exception text, no provider
# output, no e-mail, no token) is ever written or sent.
CODES = frozenset("""
COLLECTOR_NOT_CONFIGURED COLLECTOR_CONFIG_SHAPE REGISTRATION_SHAPE REGISTRATION_DUPLICATE ALREADY_RUNNING
CYCLE_TIMEOUT CYCLE_WATCHDOG CREDENTIAL_UNAVAILABLE CONNECTOR_NOT_INSTALLED_PRINCIPAL CONNECTOR_BINDING
TELEMETRY_SCOPE_MISSING READBACK_SCOPE_MISSING HARNESS_HAS_NO_QUOTA_SOURCE
NOT_SIGNED_IN ACCOUNT_PROFILE_UNREADABLE ACCOUNT_TYPE ACCOUNT_IDENTITY_UNAVAILABLE ACCOUNT_CHANGED_BEFORE_READ
ACCOUNT_CHANGED_DURING_READ ACCOUNT_CHANGED_AFTER_READ PROVIDER_TIMEOUT PROVIDER_EXITED PROVIDER_START_FAILED
PROVIDER_PROTOCOL PROVIDER_TURN_STARTED PROVIDER_INIT_REFUSED PROVIDER_USAGE_REFUSED PROVIDER_RESPONSE
PROVIDER_OUTPUT_LIMIT OWNED_CHILD_CLEANUP_UNRESOLVED QUOTA_BUCKETS QUOTA_BUCKET_ID QUOTA_BUCKET QUOTA_WINDOW
QUOTA_PERCENT QUOTA_DURATION QUOTA_RESET QUOTA_WINDOWS_UNAVAILABLE QUOTA_BODY_SIZE SNAPSHOT_SHAPE
HTTP_ROUTE HTTP_BODY_SIZE HTTP_RESPONSE HTTP_CONTENT_TYPE HTTP_RESPONSE_SIZE HTTP_JSON HTTP_STATUS HTTP_TRANSPORT
HTTP_MALFORMED REPORT_RESPONSE READBACK_TRUNCATED READBACK_MISSING READBACK_MISMATCH
""".split()) | trust.CODES

# The plugin contract's errorCode for each cause (docs/contracts/plugin-host-v1.md).
TRUST_ERROR = "untrusted-binary"


def error_code_for(code):
    if code in trust.CODES:
        return TRUST_ERROR
    if code == "PROVIDER_TIMEOUT":
        return "timeout"
    if code == "NOT_SIGNED_IN":
        return "auth-required"
    return "unavailable"


class Refusal(Exception):
    """A named collector refusal. args == (code,)."""

    def __init__(self, code, **facts):
        super().__init__(code)
        self.code = code
        self.facts = facts


def need(value, code):
    if not value:
        raise Refusal(code)


def code_of(error):
    code = getattr(error, "code", None)
    if isinstance(error, (Refusal, trust.TrustRefusal, ChildError)) and isinstance(code, str) and code in CODES:
        return code
    return "UNEXPECTED_" + type(error).__name__[:32]


def iso_now(clock=None):
    moment = clock() if clock else datetime.datetime.now(datetime.timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Budget:
    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.deadline = clock() + seconds

    def remaining(self):
        return self.deadline - self.clock()

    def check(self):
        need(self.remaining() > 0, "CYCLE_TIMEOUT")


# ── configuration ─────────────────────────────────────────────────────────────

REGISTRATION_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
OPAQUE = re.compile(r"[A-Za-z0-9_-]{1,128}")
LABEL = re.compile(r"[^\x00-\x1f\x7f@]{1,80}")
PIN = re.compile(r"[0-9a-f]{64}")
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})")


def _absolute(value):
    return isinstance(value, str) and (Path(value).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", value) is not None)


def load_config(folder, harness):
    path = Path(folder) / COLLECTOR_FILE
    if not path.is_file():
        raise Refusal("COLLECTOR_NOT_CONFIGURED")
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError):
        raise Refusal("COLLECTOR_CONFIG_SHAPE") from None
    need(isinstance(value, dict) and value.get("schemaVersion") == COLLECTOR_SCHEMA
         and set(value) <= {"schemaVersion", "harness", "registrations", "claudeBinary"}
         and value.get("harness") == harness, "COLLECTOR_CONFIG_SHAPE")
    need(value.get("claudeBinary") is None or (harness == "claude-code" and _absolute(value["claudeBinary"])),
         "COLLECTOR_CONFIG_SHAPE")
    regs = value.get("registrations")
    need(isinstance(regs, list) and 1 <= len(regs) <= 8, "COLLECTOR_CONFIG_SHAPE")
    source = SOURCES.get(harness)
    for reg in regs:
        need(isinstance(reg, dict) and set(reg) == {"registrationId", "provider", "sourceProduct", "providerAccountId",
                                                     "label", "discoveredAt", "configDir", "accountPin"},
             "REGISTRATION_SHAPE")
        need(isinstance(reg["registrationId"], str) and REGISTRATION_ID.fullmatch(reg["registrationId"])
             and isinstance(reg["providerAccountId"], str) and OPAQUE.fullmatch(reg["providerAccountId"])
             and isinstance(reg["label"], str) and LABEL.fullmatch(reg["label"])
             and isinstance(reg["discoveredAt"], str) and ISO.fullmatch(reg["discoveredAt"])
             and (reg["configDir"] is None or _absolute(reg["configDir"]))
             and isinstance(reg["accountPin"], str) and PIN.fullmatch(reg["accountPin"]), "REGISTRATION_SHAPE")
        if source:
            need(reg["provider"] == source["provider"] and reg["sourceProduct"] == source["sourceProduct"],
                 "REGISTRATION_SHAPE")
        else:
            need(isinstance(reg["provider"], str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", reg["provider"])
                 and isinstance(reg["sourceProduct"], str)
                 and re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", reg["sourceProduct"]), "REGISTRATION_SHAPE")
    for key in ("registrationId", "providerAccountId", "accountPin"):
        need(len({r[key] for r in regs}) == len(regs), "REGISTRATION_DUPLICATE")
    return value


# ── accounts ──────────────────────────────────────────────────────────────────

def claude_account_digest(reg, environ, sleep=time.sleep):
    """sha256 of the accountUuid the registration's Claude Code profile names, or None when not signed in.
    Reads the profile cache only, never a credential file; the value never leaves this function."""
    base = reg["configDir"] or environ.get("USERPROFILE") or environ.get("HOME") or ""
    path = Path(base) / ".claude.json"
    if not path.is_file():
        return None
    value = None
    for attempt in range(3):  # Claude Code rewrites this file while it runs; a torn read is retried
        try:
            value = json.loads(trust.checked_bytes(path, 8 * 1048576))
            break
        except (ValueError, trust.TrustRefusal):
            need(attempt < 2, "ACCOUNT_PROFILE_UNREADABLE")
            sleep(0.5)
    account = (value.get("oauthAccount") or {}).get("accountUuid") if isinstance(value, dict) else None
    if not isinstance(account, str) or not re.fullmatch(r"[0-9a-f-]{36}", account):
        return None
    return hashlib.sha256(account.encode("ascii")).hexdigest()


def codex_account_pin(account):
    """The pin of a Codex `account/read` answer: sha256 of `chatgpt:<lower-cased e-mail>`. Never the e-mail."""
    need(isinstance(account, dict) and account.get("type") == "chatgpt", "ACCOUNT_TYPE")
    email = account.get("email")
    need(isinstance(email, str) and 0 < len(email) <= 320, "ACCOUNT_IDENTITY_UNAVAILABLE")
    return hashlib.sha256(("chatgpt:" + email.strip().lower()).encode("utf-8")).hexdigest()


# ── provider reads (each one an owned child) ─────────────────────────────────

ENV_ALLOW = ("SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "USERPROFILE", "HOMEDRIVE",
             "HOMEPATH", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "TEMP", "TMP", "TMPDIR",
             "USERNAME", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "LANG")

CLAUDE_USAGE_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                     "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence",
                     "--disable-slash-commands", "--setting-sources", "user", "--settings", '{"disableAllHooks":true}']


def provider_env(harness, reg, environ):
    """Allowlist, not denylist: nothing else the scheduler or a shell holds reaches the provider."""
    env = {k: v for k, v in environ.items() if k.upper() in ENV_ALLOW}
    env["DISABLE_AUTOUPDATER"] = "1"  # a collector never updates the binary it reads through
    if reg["configDir"]:
        env["CLAUDE_CONFIG_DIR" if harness == "claude-code" else "CODEX_HOME"] = reg["configDir"]
    return env


def _json_line(raw):
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise Refusal("PROVIDER_PROTOCOL") from None


def read_claude(binary, reg, environ, timeout, cwd=None, spawn=OwnedChild, clock=time.monotonic):
    """The installed Claude Code answers its own `get_usage` control request; no prompt, so no turn runs."""
    deadline = clock() + timeout
    with spawn([binary, *CLAUDE_USAGE_ARGS], provider_env("claude-code", reg, environ), cwd=cwd) as child:
        child.send({"type": "control_request", "request_id": "rh-init", "request": {"subtype": "initialize"}})
        initialized = False
        while True:
            message = _json_line(child.next_line(deadline, clock))
            if message is None:
                continue
            # Anything but a control response (an assistant message, a result) means a turn ran: refuse it.
            need(isinstance(message, dict) and message.get("type") == "control_response", "PROVIDER_TURN_STARTED")
            response = message.get("response")
            need(isinstance(response, dict), "PROVIDER_PROTOCOL")
            if response.get("request_id") == "rh-init" and not initialized:
                need(response.get("subtype") == "success", "PROVIDER_INIT_REFUSED")
                initialized = True
                child.send({"type": "control_request", "request_id": "rh-usage",
                            "request": {"subtype": "get_usage", "skip_behaviors": True}})
            elif response.get("request_id") == "rh-usage" and initialized:
                need(response.get("subtype") == "success" and isinstance(response.get("response"), dict),
                     "PROVIDER_USAGE_REFUSED")
                return response["response"]
            else:
                raise Refusal("PROVIDER_PROTOCOL")


def read_codex(binary, reg, environ, timeout, cwd=None, spawn=OwnedChild, clock=time.monotonic):
    """One owned `codex app-server`: account before, quotas, account after (no auth-file read)."""
    deadline = clock() + timeout
    with spawn([binary, "app-server"], provider_env("codex", reg, environ), cwd=cwd) as child:
        def call(method, ident=None, params=None):
            message = {"method": method}
            if ident is not None:
                message["id"] = ident
            if params is not None:
                message["params"] = params
            child.send(message)
            if ident is None:
                return None
            while True:
                value = _json_line(child.next_line(deadline, clock))
                if value is None:
                    continue
                need(isinstance(value, dict), "PROVIDER_PROTOCOL")
                if value.get("id") == ident:
                    need("error" not in value and isinstance(value.get("result"), dict), "PROVIDER_RESPONSE")
                    return value["result"]

        call("initialize", 1, {"clientInfo": {"name": "relayhall_quota_reporter", "version": "1.0.0"},
                               "capabilities": {}})
        call("initialized", params={})
        before = codex_account_pin(call("account/read", 2, {"refreshToken": False}).get("account"))
        need(before == reg["accountPin"], "ACCOUNT_CHANGED_BEFORE_READ")
        quota = call("account/rateLimits/read", 3)
        observed = iso_now()
        after = codex_account_pin(call("account/read", 4, {"refreshToken": False}).get("account"))
        need(after == before, "ACCOUNT_CHANGED_DURING_READ")
        return {"data": quota, "observedAt": observed}


# ── snapshots (the payloads today's reporters post) ──────────────────────────

def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value \
        and value not in (float("inf"), float("-inf"))


def _iso_from_epoch(seconds):
    try:
        moment = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _iso_normal(value):
    """An RFC 3339 instant, normalized as JavaScript's toISOString() (milliseconds, Z), else None."""
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})", value or "")
    if not match:
        return None
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    try:
        tz = datetime.timezone.utc if zone == "Z" else datetime.timezone(
            datetime.timedelta(hours=int(zone[1:3]), minutes=int(zone[4:6])) * (1 if zone[0] == "+" else -1))
        moment = datetime.datetime(int(year), int(month), int(day), int(hour), int(minute), int(second),
                                   int(((fraction or "0") + "000")[:3]) * 1000, tz)
    except ValueError:
        return None
    return moment.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


CLAUDE_WINDOWS = [("five_hour", "5 hours"), ("seven_day", "Weekly"), ("seven_day_opus", "Weekly · Opus"),
                  ("seven_day_sonnet", "Weekly · Sonnet"), ("spend_limit", "Gateway spend limit")]


def _claude_window(ident, label, window):
    if not isinstance(window, dict):
        return None
    used = window.get("used_percentage")
    if used is None:
        used = window.get("utilization")
    if not _finite(used) or used < 0:
        return None
    reset = window.get("resets_at")
    resets = None
    if _finite(reset):
        resets = _iso_from_epoch(reset) if 0 < reset < 8640000000000 else None
    elif isinstance(reset, str):
        resets = _iso_normal(reset)
    row = {"id": ident, "label": label, "unit": "percent", "used": min(used, 100), "limit": 100}
    if resets:
        row["resetsAt"] = resets
    return row


def claude_windows(data):
    limits = data.get("rate_limits") if isinstance(data, dict) else None
    if not isinstance(limits, dict):
        return []
    result = [w for w in (_claude_window(i, label, limits.get(i)) for i, label in CLAUDE_WINDOWS) if w]
    for scoped in limits.get("model_scoped") if isinstance(limits.get("model_scoped"), list) else []:
        name = scoped.get("display_name") if isinstance(scoped, dict) else None
        name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()[:60] if isinstance(name, str) else ""
        if not name:
            continue
        window = _claude_window("model-" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:12],
                                "Weekly · " + name, scoped)
        if window and not any(x["id"] == window["id"] for x in result):
            result.append(window)
    need(len(result) <= 16, "QUOTA_BODY_SIZE")
    return result


def claude_snapshot(reg, data, at):
    windows = claude_windows(data)
    return {"schemaVersion": "rh.usage-quota/1", "sourceProduct": reg["sourceProduct"], "provider": reg["provider"],
            "providerAccountId": reg["providerAccountId"], "label": reg["label"], "observedAt": at, "checkedAt": at,
            "status": "reported" if windows else "not-reported", "windows": windows}


def codex_windows(data):
    need(isinstance(data, dict), "QUOTA_BUCKETS")
    buckets = data.get("rateLimitsByLimitId")
    if buckets is None:
        legacy = data.get("rateLimits")
        buckets = {legacy.get("limitId") or "codex": legacy} if isinstance(legacy, dict) else {}
    need(isinstance(buckets, dict), "QUOTA_BUCKETS")
    result = []
    for bucket, body in buckets.items():
        need(isinstance(bucket, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}", bucket), "QUOTA_BUCKET_ID")
        need(isinstance(body, dict), "QUOTA_BUCKET")
        for slot in ("primary", "secondary"):
            window = body.get(slot)
            if window is None:
                continue
            need(isinstance(window, dict), "QUOTA_WINDOW")
            used, duration = window.get("usedPercent"), window.get("windowDurationMins")
            need(_finite(used) and 0 <= used <= 100, "QUOTA_PERCENT")
            need(_finite(duration) and duration > 0, "QUOTA_DURATION")
            label = bucket[:45] + " " + ("weekly" if duration == 10080 else str(duration) + " minutes")
            row = {"id": "quota-" + hashlib.sha256(bucket.encode()).hexdigest()[:20] + "-" + slot, "label": label,
                   "unit": "percent", "used": used, "limit": 100}
            reset = window.get("resetsAt")
            if reset is not None:
                need(_finite(reset) and 0 < reset <= 253402300799, "QUOTA_RESET")
                stamp = _iso_from_epoch(reset)
                need(stamp is not None, "QUOTA_RESET")
                row["resetsAt"] = stamp
            result.append(row)
    need(0 < len(result) <= 16, "QUOTA_WINDOWS_UNAVAILABLE")
    return result


def codex_snapshot(reg, data, observed):
    value = {k: reg[k] for k in ("provider", "providerAccountId", "sourceProduct", "label")}
    value.update(schemaVersion="rh.usage-quota/1", observedAt=observed, checkedAt=observed, status="reported",
                 windows=codex_windows(data))
    need(len(json.dumps(value).encode()) <= 16384, "QUOTA_BODY_SIZE")
    return value


def waiting_snapshot(reg, at, status="not-reported", error_code="auth-required"):
    """A known account with no reading: an observation made now, status only, never a quota value."""
    value = {"schemaVersion": "rh.usage-quota/1", "sourceProduct": reg["sourceProduct"], "provider": reg["provider"],
             "providerAccountId": reg["providerAccountId"], "label": reg["label"], "observedAt": at,
             "checkedAt": at, "status": status, "windows": []}
    if error_code:
        value["errorCode"] = error_code
    return value


def failed_snapshot(reg, last, at, code):
    """The plugin contract's failed refresh: the last reading kept, a later checkedAt and the errorCode.
    With no earlier reading, an honest not-reported row observed now."""
    error = error_code_for(code)
    if isinstance(last, dict) and all(last.get(k) == reg[k] for k in ("provider", "providerAccountId",
                                                                       "sourceProduct")):
        return dict(last, checkedAt=at, errorCode=error)
    return waiting_snapshot(reg, at, error_code=error)


# ── the board ─────────────────────────────────────────────────────────────────

ROUTES = frozenset({("GET", "/principals/me"), ("GET", "/telemetry/quotas"), ("POST", "/telemetry/quotas"),
                    ("POST", "/telemetry/events"), ("GET", "/connectors/trust-policy")})
BOARD_CODE = re.compile(r"[A-Z][A-Z0-9_]{1,63}")


class BoardApi:
    """The five board calls the collector makes, with the connector's token. No other route, no redirect."""

    def __init__(self, board, credential, opener=None, budget=None):
        self.base = board.rstrip("/") + "/api"
        self._credential = credential
        self.opener = opener or board_opener(board)
        self.budget = budget

    def __call__(self, method, path, payload=None):
        need((method, path) in ROUTES and (payload is None) == (method == "GET"), "HTTP_ROUTE")
        body = None if payload is None else json.dumps(payload, ensure_ascii=True, separators=(",", ":"),
                                                       allow_nan=False).encode("utf-8")
        need(body is None or len(body) <= 65536, "HTTP_BODY_SIZE")
        if self.budget:
            self.budget.check()
        request = urllib.request.Request(self.base + path, data=body, method=method)
        request.add_header("Accept", "application/json")
        request.add_header("Authorization", "Bearer " + self._credential)
        if body is not None:
            request.add_header("Content-Type", "application/json")
        timeout = max(1.0, min(15.0, self.budget.remaining() if self.budget else 15.0))
        try:
            with self.opener.open(request, timeout=timeout) as response:
                need(response.status == 200, "HTTP_RESPONSE")
                need(response.headers.get_content_type() == "application/json", "HTTP_CONTENT_TYPE")
                data = response.read(4194305)
        except urllib.error.HTTPError as error:
            status, headers = error.code, error.headers
            try:
                raw = error.read(4096)
            except (OSError, http.client.HTTPException):
                raw = b""
            error.close()
            failure = Refusal("HTTP_STATUS")
            failure.httpStatus = status
            try:
                board_code = json.loads(raw).get("code")
            except (ValueError, AttributeError):
                board_code = None
            if isinstance(board_code, str) and BOARD_CODE.fullmatch(board_code):
                failure.boardCode = board_code  # the board's refusal, by name
            failure.retryAfter = retry_after_seconds((headers.get("Retry-After") or "").strip() if headers else "")
            raise failure from None
        except http.client.HTTPException:
            raise Refusal("HTTP_MALFORMED") from None
        except TRANSPORT_ERRORS:
            raise Refusal("HTTP_TRANSPORT") from None
        need(len(data) <= 4194304, "HTTP_RESPONSE_SIZE")
        try:
            value = json.loads(data)
        except ValueError:
            raise Refusal("HTTP_JSON") from None
        need(isinstance(value, dict), "HTTP_JSON")
        return value


def retry_after_seconds(value):
    if re.fullmatch(r"\d{1,4}(\.\d{1,3})?", value or ""):
        return min(max(float(value), RETRY_DEFAULT_S), RETRY_MAX_S)
    return RETRY_DEFAULT_S


class PostPacer:
    """Every POST starts at least POST_SPACING_S after the previous one (the board accepts one per connector
    per second); a 429, and only a 429, is retried with the same body at most POST_RETRIES times."""

    def __init__(self, clock=time.monotonic, sleep=time.sleep):
        self.clock, self.sleep, self.last = clock, sleep, None

    def wait(self, seconds, budget):
        if seconds > 0:
            need(budget is None or budget.remaining() > seconds + 5, "CYCLE_TIMEOUT")
            self.sleep(seconds)

    def post(self, send, budget=None):
        retries = 0
        while True:
            if self.last is not None:
                self.wait(self.last + POST_SPACING_S - self.clock(), budget)
            try:
                answer = send()
                self.last = self.clock()
                return answer, retries
            except Refusal as refusal:
                self.last = self.clock()
                if getattr(refusal, "httpStatus", None) != 429 or retries >= POST_RETRIES:
                    refusal.retries = retries
                    raise
                retries += 1
                self.wait(getattr(refusal, "retryAfter", RETRY_DEFAULT_S), budget)


# ── local state ───────────────────────────────────────────────────────────────

def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="") as handle:
        handle.write(json.dumps(value, indent=1, sort_keys=True, ensure_ascii=True) + "\n")
    os.replace(temporary, path)


def _read_json(path):
    try:
        value = json.loads(Path(path).read_bytes())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


@contextlib.contextmanager
def exclusive(path, platform=None):
    """An OS byte lock on `path`, held for the block and released on every exit path (and by the OS if the
    process dies). A second holder is refused at once: ALREADY_RUNNING."""
    platform = sys.platform if platform is None else platform
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    try:
        if platform == "win32":
            import msvcrt
            if handle.seek(0, 2) == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise Refusal("ALREADY_RUNNING") from None
            unlock = lambda: (handle.seek(0), msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1))  # noqa: E731
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise Refusal("ALREADY_RUNNING") from None
            unlock = lambda: fcntl.flock(handle.fileno(), fcntl.LOCK_UN)  # noqa: E731
        try:
            yield
        finally:
            try:
                unlock()
            except OSError:
                pass
    finally:
        handle.close()


# ── the cycle ─────────────────────────────────────────────────────────────────

def default_claude_binary(environ):
    appdata = environ.get("APPDATA") or ""
    return str(Path(appdata) / "npm" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe")


class Collector:
    """One connector's collector. Every machine-facing member is a seam a test replaces."""

    def __init__(self, name, manifest, folder, credential_loader, environ, platform=None, opener=None,
                 clock=time.monotonic, wall=None, sleep=time.sleep, budget_seconds=CYCLE_SECONDS,
                 watchdog_grace=WATCHDOG_GRACE_SECONDS, hard_exit=os._exit, trust_checker=None, readers=None,
                 account_digest=claude_account_digest, ceiling=None, attempts=PROVIDER_ATTEMPTS,
                 backoff=PROVIDER_BACKOFF_SECONDS, provider_seconds=None):
        self.name, self.manifest, self.folder = name, manifest, Path(folder)
        self.runtime = self.folder / RUNTIME_DIR
        self.harness = manifest.get("harness")
        self.credential_loader = credential_loader
        self.environ = dict(environ)
        self.platform = sys.platform if platform is None else platform
        self.opener = opener
        self.clock, self.wall, self.sleep = clock, wall, sleep
        self.budget_seconds, self.watchdog_grace, self.hard_exit = budget_seconds, watchdog_grace, hard_exit
        self.trust_checker = trust_checker
        self.readers = readers or {"claude-code": read_claude, "codex": read_codex}
        self.account_digest = account_digest
        self.ceiling = ceiling
        self.attempts, self.backoff = attempts, backoff
        self.provider_seconds = dict(PROVIDER_SECONDS, **(provider_seconds or {}))
        self.pacer = PostPacer(clock=clock, sleep=sleep)

    def now(self):
        return iso_now(self.wall)

    # The one entry point. mode: "once" (read and post) or "check" (read, post nothing).
    def run(self, mode):
        assert mode in ("once", "check")
        record = {"schemaVersion": 1, "attemptId": uuid.uuid4().hex, "mode": mode, "startedAt": self.now(),
                  "harness": self.harness, "status": "running", "registrations": [], "events": []}
        try:
            with exclusive(self.runtime / "collector.lock", self.platform):
                watchdog = threading.Timer(self.budget_seconds + self.watchdog_grace, self._watchdog, args=(record,))
                watchdog.daemon = True
                watchdog.start()
                try:
                    self._cycle(mode, record)
                except Exception as error:  # noqa: BLE001 - classified, never echoed
                    record.update(status="refused", failureCode=code_of(error))
                    for key in ("httpStatus", "boardCode"):
                        if getattr(error, key, None) is not None:
                            record[key] = getattr(error, key)
                    if isinstance(error, ChildError) and error.code == "OWNED_CHILD_CLEANUP_UNRESOLVED":
                        self._hold_cleanup(error, record)
                finally:
                    watchdog.cancel()
                    record["finishedAt"] = self.now()
                    _write_json(self.runtime / "last-attempt.json", record)
        except Refusal as refusal:  # the lock: a contender never overwrites the owner's record
            record.update(status="busy" if refusal.code == "ALREADY_RUNNING" else "refused",
                          failureCode=refusal.code, finishedAt=self.now())
        return record

    def exit_code(self, record):
        if record.get("status") == "busy":
            return EXIT_BUSY
        return EXIT_OK if record.get("status") in ("ok", "checked") else EXIT_REFUSED

    def _watchdog(self, record):
        """The cycle overran its budget by the grace: end the PROCESS, so the OS releases the lock."""
        try:
            snapshot = dict(record, status="refused", failureCode="CYCLE_WATCHDOG", finishedAt=self.now())
            _write_json(self.runtime / "last-attempt.json", snapshot)
        finally:
            self.hard_exit(EXIT_WATCHDOG)

    def _hold_cleanup(self, error, record):
        record["ownedChildCleanupUnresolvedPid"] = error.pid
        _write_json(self.runtime / "cleanup-held.json", {"pid": error.pid, "at": self.now(),
                                                         "attemptId": record["attemptId"]})

    def _cleanup_clear(self):
        held = _read_json(self.runtime / "cleanup-held.json")
        if held is None:
            return
        # A child the connector could not end once must not run beside a new read. When it is gone, the hold
        # clears itself; while it runs, every cycle refuses by name.
        need(not process_alive(held.get("pid"), self.platform), "OWNED_CHILD_CLEANUP_UNRESOLVED")
        (self.runtime / "cleanup-held.json").unlink()

    def _cycle(self, mode, record):
        budget = Budget(self.budget_seconds, self.clock)
        self._cleanup_clear()
        if self.harness in UNSUPPORTED_SOURCES:
            config = load_config(self.folder, self.harness)
            record["status"] = "checked" if mode == "check" else "ok"
            api = self._api(budget)
            for reg in config["registrations"]:
                entry = {"registrationId": reg["registrationId"], "phase": "unsupported"}
                record["registrations"].append(entry)
                if mode == "once":
                    entry["outcome"] = self._post(api, waiting_snapshot(reg, self.now(), "unsupported", None),
                                                  budget, entry)
                entry["result"] = "ok"
            return
        need(self.harness in SOURCES, "HARNESS_HAS_NO_QUOTA_SOURCE")
        config = load_config(self.folder, self.harness)
        api = self._api(budget)
        self._preflight(api)
        policy = self._policy(api, record, mode)
        binary = None
        try:
            binary = self._trust(policy, config, record, mode, api)
        except trust.TrustRefusal as refusal:
            record["trust"] = {"status": "refused", "code": refusal.code, "observed": refusal.observed or {}}
            self._event(api, mode, record, "connector.trust.refused", refusal.code, "blocked",
                        f"{trust.HARNESS_PRODUCT[self.harness]}:{refusal.code}:{self.now()[:13]}")
        for reg in config["registrations"]:
            entry = {"registrationId": reg["registrationId"]}
            record["registrations"].append(entry)
            self._one(api, mode, reg, binary, budget, entry, record, policy, config)
        refused = [e for e in record["registrations"] if e.get("result") != "ok"]
        record["status"] = ("checked" if mode == "check" else "ok") if not refused else "partial"

    def _api(self, budget):
        try:
            credential = self.credential_loader()
        except Exception:  # noqa: BLE001 - the custody error text is the connector's to print, not ours
            raise Refusal("CREDENTIAL_UNAVAILABLE") from None
        return BoardApi(self.manifest["board"], credential, self.opener, budget)

    def _preflight(self, api):
        me = api("GET", "/principals/me")
        principal = me.get("principal") if isinstance(me.get("principal"), dict) else {}
        need(principal.get("id") == (self.manifest.get("principal") or {}).get("id"),
             "CONNECTOR_NOT_INSTALLED_PRINCIPAL")
        need(principal.get("kind") == "service" and principal.get("status", "active") == "active", "CONNECTOR_BINDING")
        scopes = me.get("scopes") if isinstance(me.get("scopes"), list) else []
        need("telemetry:write" in scopes, "TELEMETRY_SCOPE_MISSING")
        need("services:read" in scopes, "READBACK_SCOPE_MISSING")

    def _policy(self, api, record, mode):
        ceiling = self.ceiling or trust.load_ceiling()
        cache = self.runtime / "trust-override.json"
        source, override, board_ceiling = "none", None, None
        try:
            answer = api("GET", "/connectors/trust-policy")
            override, board_ceiling, source = answer.get("override"), answer.get("ceilingSha256"), "board"
        except Refusal as refusal:
            if getattr(refusal, "httpStatus", None) == 404:
                source = "none"  # a board without the route: the release's policy alone
            else:
                cached = _read_json(cache)
                override, source = (cached or {}).get("override"), "cache" if cached else "none"
        accepted, rejected = trust.validate_override(ceiling, override)
        if source == "board":
            _write_json(cache, {"override": {"schemaVersion": trust.OVERRIDE_SCHEMA, "products": accepted},
                                "fetchedAt": self.now()})
        record["policy"] = {"ceilingSha256": ceiling["_sha256"], "overrideSource": source,
                            "boardCeilingDiffers": board_ceiling is not None and board_ceiling != ceiling["_sha256"],
                            "overrideAccepted": accepted, "overrideRejected": rejected}
        if rejected:
            digest = hashlib.sha256(trust.canonical(rejected)).hexdigest()[:16]
            self._event(api, mode, record, "connector.trust.override_rejected", rejected[0]["code"], "blocked",
                        f"{digest}:{self.now()[:10]}")
        return trust.effective_policy(ceiling, accepted)

    def _checker(self, policy):
        if self.trust_checker is not None:
            return self.trust_checker(policy)
        return trust.TrustChecker(policy, self.folder / trust.LEDGER_FILE, environ=self.environ,
                                  platform=self.platform)

    def _binary_path(self, config):
        if self.harness == "claude-code":
            return config.get("claudeBinary") or default_claude_binary(self.environ)
        return None

    def _trust(self, policy, config, record, mode, api):
        checker = self._checker(policy)
        product = trust.HARNESS_PRODUCT[self.harness]
        verified = checker.check(product, self._binary_path(config))
        verified["_checker"] = checker
        record["trust"] = dict(trust.trust_summary(verified), status="accepted")
        if verified.get("newlyRecorded"):
            # E456 (1): verified automatically, recorded, reported after the fact. No human acts per version.
            self._event(api, mode, record, "connector.trust.accepted", None, "ok",
                        verified["ledgerEntrySha256"][:32])
        return verified

    def _read(self, reg, binary, budget, config):
        """One registration's reading with bounded retry: (snapshot, attempts)."""
        attempts = []
        reader = self.readers[self.harness]
        per_attempt = self.provider_seconds[self.harness]
        cwd = self.runtime / "work"
        cwd.mkdir(parents=True, exist_ok=True)
        for index in range(self.attempts):
            need(budget.remaining() > min(per_attempt, 5) + RESERVE_SECONDS, "CYCLE_TIMEOUT")
            timeout = max(1.0, min(per_attempt, budget.remaining() - RESERVE_SECONDS))
            try:
                checker, product, path = binary["_checker"], trust.HARNESS_PRODUCT[self.harness], \
                    self._binary_path(config)
                checker.recheck(product, binary, path)  # the very build verified for this run, before the spawn
                try:
                    value = reader(binary["runBinary"], reg, self.environ, timeout, cwd=cwd)
                finally:
                    checker.recheck(product, binary, path)  # ... and after the child is gone
                return value, attempts
            except (Refusal, ChildError) as error:
                code = code_of(error)
                attempts.append(code)
                error.attempts = list(attempts)  # every failed attempt, by name, for the record
                if code not in RETRYABLE or index == self.attempts - 1:
                    raise
                wait = self.backoff[min(index, len(self.backoff) - 1)]
                if budget.remaining() < wait + min(per_attempt, 5) + RESERVE_SECONDS:
                    raise
                self.sleep(wait)
        raise Refusal("CYCLE_TIMEOUT")  # unreachable: the loop returns or raises

    def _one(self, api, mode, reg, binary, budget, entry, record, policy, config):
        last_path = self.runtime / "last-success" / (reg["registrationId"] + ".json")
        try:
            if binary is None:
                raise trust.TrustRefusal(record["trust"]["code"])
            snapshot = None
            if self.harness == "claude-code":
                before = self.account_digest(reg, self.environ)
                if before is None:
                    entry["phase"] = "not-signed-in"
                    snapshot = waiting_snapshot(reg, self.now())
                else:
                    need(before == reg["accountPin"], "ACCOUNT_CHANGED_BEFORE_READ")
            if snapshot is None:
                value, attempts = self._read(reg, binary, budget, config)
                if attempts:
                    entry["retriedAfter"] = attempts
                entry["attempts"] = len(attempts) + 1
                if self.harness == "claude-code":
                    need(self.account_digest(reg, self.environ) == reg["accountPin"], "ACCOUNT_CHANGED_AFTER_READ")
                    snapshot = claude_snapshot(reg, value, self.now())
                else:
                    snapshot = codex_snapshot(reg, value["data"], value["observedAt"])
                entry["phase"] = "read"
            entry.update(status=snapshot["status"], windows=len(snapshot["windows"]))
            if mode == "once":
                entry["outcome"] = self._post(api, snapshot, budget, entry)
                if snapshot["status"] == "reported":
                    _write_json(last_path, snapshot)
            entry["result"] = "ok"
        except ChildError as error:
            if error.code == "OWNED_CHILD_CLEANUP_UNRESOLVED":
                raise  # stops the cycle; the lock is still released
            self._refused(api, mode, reg, entry, record, error, last_path, budget)
        except (Refusal, trust.TrustRefusal) as error:
            self._refused(api, mode, reg, entry, record, error, last_path, budget)

    def _refused(self, api, mode, reg, entry, record, error, last_path, budget):
        code = code_of(error)
        entry.update(result="refused", failureCode=code)
        if getattr(error, "attempts", None):
            entry.update(attempts=len(error.attempts), retriedAfter=error.attempts)
        for key in ("httpStatus", "boardCode", "retries"):
            if getattr(error, key, None):
                entry[key] = getattr(error, key)
        if code.startswith(("HTTP_", "READBACK_", "REPORT_")) or code in ("CYCLE_TIMEOUT", "CREDENTIAL_UNAVAILABLE"):
            # The board could not be reached, refused this connector, or took the reading and read it back
            # differently: nothing more to send now. The local record names it.
            return
        # The cause, BY NAME (E463): the row keeps its last reading with this attempt's checkedAt and errorCode,
        # and an event names the exact code the row's errorCode summarizes.
        entry["reportedErrorCode"] = error_code_for(code)
        if mode != "once":
            return
        try:
            entry["outcome"] = self._post(api, failed_snapshot(reg, _read_json(last_path), self.now(), code),
                                          budget, entry)
        except Refusal as failure:
            entry["reportFailureCode"] = code_of(failure)
            for key in ("httpStatus", "boardCode"):
                if getattr(failure, key, None):
                    entry["report" + key[0].upper() + key[1:]] = getattr(failure, key)
        if code not in trust.CODES:  # a trust refusal was reported once, as connector.trust.refused
            self._event(api, mode, record, "connector.collector.refused", code, "error",
                        f"{reg['registrationId']}:{code}:{record['attemptId'][:12]}")

    def _post(self, api, snapshot, budget, entry):
        answer, retries = self.pacer.post(lambda: api("POST", "/telemetry/quotas", snapshot), budget)
        if retries:
            entry["postRetries"] = retries
        need(answer.get("schemaVersion") == "rh.usage-quota/1"
             and answer.get("outcome") in ("accepted", "duplicate", "older"), "REPORT_RESPONSE")
        rows = api("GET", "/telemetry/quotas")
        need(rows.get("truncated") is False and isinstance(rows.get("accounts"), list), "READBACK_TRUNCATED")
        connector = (self.manifest.get("principal") or {}).get("id")
        found = [r for r in rows["accounts"] if isinstance(r, dict) and r.get("connectorId") == connector
                 and r.get("provider") == snapshot["provider"]
                 and r.get("providerAccountId") == snapshot["providerAccountId"]]
        need(len(found) == 1, "READBACK_MISSING")
        if answer["outcome"] != "older":
            need(all(found[0].get(k) == v for k, v in snapshot.items()), "READBACK_MISMATCH")
        return answer["outcome"]

    def _event(self, api, mode, record, name, code, status, key):
        """A telemetry event, after the fact. Its failure never fails the cycle; it is recorded."""
        kind = name + ("." + code if code else "")
        event = {"name": name, "code": code}
        record["events"].append(event)
        if mode != "once":
            event["sent"] = False
            return
        envelope = {
            "schema_version": "rh.ai.telemetry/1.0",
            "event_id": (name + ":" + key)[:128],
            "occurred_at": self.now(),
            "source": {"product": SOURCES[self.harness]["sourceProduct"], "adapter": "relayhall-connector",
                       "adapter_version": COLLECTOR_VERSION, "mechanism": "push"},
            "kind": "health",
            "phase": "completed" if status == "ok" else "failed",
            # Tier 0 keeps outcome.error_type (a class name): the event's name and its code ride there.
            "outcome": {"status": status, "error_type": kind[:80]},
        }
        try:
            self.pacer.post(lambda: api("POST", "/telemetry/events", envelope))
            event["sent"] = True
        except Refusal as failure:
            event.update(sent=False, failureCode=code_of(failure))
            if getattr(failure, "boardCode", None):
                event["boardCode"] = failure.boardCode


def summary(record):
    """One line for `connector run` / `status`: counts and codes only."""
    regs = record.get("registrations") or []
    ok = sum(1 for r in regs if r.get("result") == "ok")
    text = f"collector {record.get('status')}: {ok}/{len(regs)} accounts"
    if record.get("failureCode"):
        text += f", {record['failureCode']}"
    codes = sorted({r["failureCode"] for r in regs if r.get("failureCode")})
    if codes:
        text += f" ({', '.join(codes)})"
    trust_state = record.get("trust") or {}
    if trust_state.get("status") == "refused":
        text += f"; binary refused: {trust_state.get('code')}"
    elif trust_state.get("version"):
        text += f"; binary {trust_state.get('version')} trusted"
    return text
