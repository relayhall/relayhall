"""`relayhall connector install | check | status | uninstall | mcp | run`
(universal harness connector design v1.5 sections 2, 3 and 8; owner ruling
E462, slice S2).

The RelayHall connector is the one local component a person installs once per
harness per machine. It runs on that person's machine and only ever dials OUT
to the board over HTTPS: no inbound port, no SSH. This module is its skeleton:

  install    takes the connector's ONE token once, at a hidden prompt (or one
             line on stdin with --token-stdin), never from argv or the
             environment; stores it in OS custody (Windows: DPAPI CurrentUser,
             see relayhall_connector_custody); writes the harness's MCP entry
             so the harness starts the local stdio proxy instead of holding the
             token; installs the connection skill where the harness has one;
             registers a per-user scheduled task (no administrator rights) that
             runs the connector at sign-in, restarted on failure.
  check      custody, board reachability (HTTPS), whoami, the harness scope
             set, and an MCP round trip through the real proxy process.
  status     names, ids and states only, from local state. No network.
  uninstall  removes exactly what install recorded it created, and nothing
             else: the custody entry, the task, the MCP entry (a server entry
             install replaced is put back from install's backup), the
             connection skill block, and the connector's own state folder.
  mcp        the stdio MCP proxy a harness launches (relayhall_connector_mcp).
             With `--run <folder>` (slice S5) it is a harness RUN's proxy: it
             reads that run's Agent credential from the run folder's custody
             entry, never the connector's token.
  collect    the usage-quota collector (relayhall_connector_collector, slice
             S3): `--once` reads every configured account and posts, `--check`
             reads and posts nothing. The harness binary passes publisher
             trust (relayhall_connector_trust) before any read.
  run        what the scheduled task runs, at sign-in and every five minutes:
             it confirms custody and, when the collector is configured, runs
             one collector cycle. With an enabled `ring.json` (slice S5) it is
             the long-running daemon instead: the wake receiver, catch-up,
             local policy, harness runs and notifications
             (relayhall_connector_ring), with a collector cycle every five
             minutes in its own process.

Everything machine-specific lives in the connector's local state folder,
`%LOCALAPPDATA%\\RelayHall\\connector\\<name>\\connector.json`, which install
writes and which never holds the token.

macOS and Linux custody is a later release: there, install refuses before it
asks for anything (exit 3).
"""
import datetime
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

import relayhall_connector_collector as collector_module
import relayhall_connector_custody as custody_module
import relayhall_connector_ring as ring_module
from relayhall_connector_custody import CustodyError, UnsupportedPlatform, validate_name, validate_token
from relayhall_connector_mcp import (
    LOOPBACK_HOSTS, TRANSPORT_ERRORS, McpProxy, board_opener, mcp_url_for, scrub,
)

EXIT_FAILED = 1
EXIT_UNSUPPORTED = 3
MANIFEST = "connector.json"
BACKUPS = "backups"
DEFAULT_ALIAS = "relayhall"
ALIAS_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
TASK_PREFIX = "RelayHall Connector "

# The harness scope set (design section 3.1, plus owner rulings E475 (1) and
# E480): the Agent working set, the three the connector's other jobs need,
# knowledge-contents:read, personalities:read and blueprints:use, and
# projects:write and phases:write so a Blueprint can be instantiated. The
# dashboard's HARNESS_CONNECTOR_SCOPES is the one definition;
# cli/test_connector_install.py reads it back out of
# frontend/src/types/connections.ts so the two cannot drift apart.
AGENT_WORKING_SCOPES = [
    "tasks:read", "tasks:write", "reports:read", "reports:write",
    "projects:read", "phases:read", "skills:read", "skills:use",
]
HARNESS_SCOPES = AGENT_WORKING_SCOPES + [
    "telemetry:write", "services:read", "principals:read",
    "knowledge-contents:read", "personalities:read", "blueprints:use",
    "projects:write", "phases:write",
]

HARNESSES = {
    "claude-code": {"label": "Claude Code", "config": "claude-json", "skill": "claude-code"},
    "codex": {"label": "Codex", "config": "codex-toml", "skill": "codex"},
    "vscode": {"label": "VS Code", "config": "vscode-json", "skill": None},
    # Owner ruling E475 (2): Antigravity's own MCP config file and its global
    # skills folder (see config_path and relayhall_connection_skill).
    "antigravity": {"label": "Antigravity", "config": "antigravity-json", "skill": "antigravity"},
}

# Antigravity's MCP config is plain JSON, so the installer's managed "block" is
# one server entry it recognises by this marker in the entry's `env` map (the
# documented environment of a stdio server): `env.RELAYHALL_CONNECTOR` holds the
# connector's NAME, never a secret. An entry without it, even one that starts the
# same proxy, is the person's and is kept for uninstall to put back.
ANTIGRAVITY_MARKER = "RELAYHALL_CONNECTOR"
BACKUP_INFIX = ".relayhall-backup-"


class ConnectorError(Exception):
    """A refusal or failure. Its text never carries the token."""


# ── the runtime: everything that touches the machine, injectable ──────────

class Runtime:
    """What the verbs touch. Tests replace members; nothing else selects them."""

    def __init__(self, environ=None, platform=None, stdin=None, stdout=None, stderr=None):
        self.environ = dict(os.environ if environ is None else environ)
        self.platform = sys.platform if platform is None else platform
        self.stdin = sys.stdin if stdin is None else stdin
        self.stdout = sys.stdout if stdout is None else stdout
        self.stderr = sys.stderr if stderr is None else stderr
        # None: each board call builds board_opener(board) (no redirects; no
        # environment proxy for a loopback board). A test may set one.
        self.opener = None
        self.script = Path(__file__).resolve().parent / "relayhall"
        self.python = sys.executable
        self._custody = None
        self.state_root = None

    def opener_for(self, url):
        return self.opener if self.opener is not None else board_opener(url)

    def getpass(self, prompt):
        import getpass
        return getpass.getpass(prompt)

    def stdin_binary(self):
        return getattr(self.stdin, "buffer", self.stdin)

    def stdout_binary(self):
        return getattr(self.stdout, "buffer", self.stdout)

    def custody(self):
        if self._custody is None:
            self._custody = custody_module.custody_for_platform(self.platform, self.environ)
        return self._custody

    def root(self):
        if self.state_root is not None:
            return Path(self.state_root)
        return custody_module.default_root(self.environ)

    def child_env(self):
        """The environment a child process gets: this one, minus any board token."""
        env = dict(self.environ)
        env.pop("RELAYHALL_TOKEN", None)
        return env

    def run(self, argv):
        """Run a helper (schtasks). The argv and env never carry the token."""
        return subprocess.run(argv, capture_output=True, text=True, errors="replace",
                              timeout=60, env=self.child_env())

    def spawn_mcp(self, name):
        """The real proxy, as the harness starts it: (stdin, stdout, close)."""
        process = subprocess.Popen(
            [self.python, str(self.script), "connector", "mcp", "--name", name],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=self.child_env())

        def close():
            try:
                process.stdin.close()
            except OSError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        return process.stdin, process.stdout, close

    def now(self):
        return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)

    def windows_user(self):
        """DOMAIN\\user of the signed-in account, for the task's trigger and principal."""
        try:
            import ctypes
            size = ctypes.c_ulong(0)
            secur32 = ctypes.WinDLL("secur32")
            secur32.GetUserNameExW(2, None, ctypes.byref(size))  # NameSamCompatible
            buffer = ctypes.create_unicode_buffer(size.value or 256)
            if secur32.GetUserNameExW(2, buffer, ctypes.byref(size)):
                return buffer.value
        except (AttributeError, OSError, ValueError):
            pass
        domain, user = self.environ.get("USERDOMAIN"), self.environ.get("USERNAME")
        if not user:
            raise ConnectorError("could not tell which Windows user is signed in (USERNAME is not set).")
        return f"{domain}\\{user}" if domain else user

    def pythonw(self):
        candidate = Path(self.python).with_name("pythonw.exe")
        return str(candidate) if candidate.is_file() else self.python

    def console_python(self):
        """The interpreter a harness starts the per-run proxy with: python.exe, even when the daemon runs under
        pythonw.exe (the proxy speaks on stdin and stdout)."""
        current = Path(self.python)
        if current.name.lower() == "pythonw.exe" and current.with_name("python.exe").is_file():
            return str(current.with_name("python.exe"))
        return self.python

    hard_exit = staticmethod(os._exit)

    def ws_connect(self, url, headers, timeout):
        return ring_module.WebSocket.connect(url, headers, timeout)

    def ring(self, name, manifest, policy):
        """The wake ring for one installed connector (slice S5). Tests replace it."""
        folder = state_dir(self, name)
        cycle = (ring_module.collector_subprocess(self, name)
                 if (folder / collector_module.COLLECTOR_FILE).is_file() else None)
        return ring_module.Ring(
            name, manifest, folder, policy, lambda: self.custody().load(name), environ=self.child_env(),
            python=self.console_python(), script=self.script, opener=self.opener_for(manifest["board"]),
            trust_gate=ring_module.default_trust_gate(self, name, manifest, policy), collector_cycle=cycle)

    def collector(self, name, manifest):
        """The usage-quota collector for one installed connector (slice S3). Tests replace it."""
        # The collector's lock, child processes and trust reads follow the REAL operating system, never the
        # platform a test runtime claims.
        return collector_module.Collector(
            name, manifest, state_dir(self, name), lambda: self.custody().load(name), self.child_env(),
            opener=self.opener_for(manifest["board"]))


# ── small helpers ─────────────────────────────────────────────────────────

def say(rt, text=""):
    print(text, file=rt.stdout)


def validate_board(board):
    """The board's ORIGIN: https, or http on this machine's loopback only."""
    parsed = urllib.parse.urlsplit((board or "").strip())
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ConnectorError("--board must be the board's address, e.g. https://board.example. Nothing was changed.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConnectorError("--board must not carry user information, a query or a fragment. Nothing was changed.")
    if parsed.path not in ("", "/"):
        raise ConnectorError("--board is the board's origin only, e.g. https://board.example (no /api, no path). "
                             "Nothing was changed.")
    if parsed.scheme == "http" and parsed.hostname not in LOOPBACK_HOSTS:
        raise ConnectorError("the connector talks to a board over HTTPS only; plain http is accepted for a board on "
                             "this machine (localhost) and nowhere else. Nothing was changed.")
    return f"{parsed.scheme}://{parsed.netloc.lower()}"


def validate_alias(alias):
    if not ALIAS_SHAPE.fullmatch(alias or ""):
        raise ConnectorError(f"--alias must be 1-64 letters, digits, '-' or '_', got {alias!r}. Nothing was changed.")
    return alias


def board_json(rt, board, method, path, token=None, timeout=30):
    """(status, parsed body) for one board call. Unreachable is a ConnectorError."""
    request = urllib.request.Request(board + "/api" + path, method=method)
    request.add_header("Accept", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with rt.opener_for(board).open(request, timeout=timeout) as response:
            status, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            body = error.read()
        except OSError:
            body = b""
    except http.client.HTTPException as error:
        raise ConnectorError(f"the board at {board} sent an answer that was cut off or malformed "
                             f"({type(error).__name__}).") from None
    except TRANSPORT_ERRORS as error:
        reason = scrub(getattr(error, "reason", error), token)
        raise ConnectorError(f"could not reach the board at {board} ({reason}).") from None
    try:
        parsed = json.loads(body.decode("utf-8")) if body else None
    except (UnicodeDecodeError, ValueError):
        parsed = None
    return status, parsed


def _refusal(parsed):
    if isinstance(parsed, dict):
        return str(parsed.get("message") or parsed.get("error") or "")[:200]
    return ""


def whoami(rt, board, token):
    status, parsed = board_json(rt, board, "GET", "/principals/me", token)
    if status in (401, 403):
        raise ConnectorError(
            f"the board refused this token on its REST routes (HTTP {status}: {scrub(_refusal(parsed), token)}). "
            "A harness connector's token is pinned to the `any` transport; one pinned to `mcp` must be widened "
            "on the Credentials page first.")
    if status != 200 or not isinstance(parsed, dict) or not isinstance(parsed.get("principal"), dict):
        raise ConnectorError(f"the board did not say who this token is (GET /principals/me answered HTTP {status}).")
    principal = parsed["principal"]
    scopes = parsed.get("scopes") if isinstance(parsed.get("scopes"), list) else []
    return principal, scopes


def missing_harness_scopes(scopes):
    return [scope for scope in HARNESS_SCOPES if scope not in scopes]


def mcp_probe(rt, board, token):
    """One `initialize` straight to the MCP endpoint: does the pin admit MCP?"""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "relayhall-connector-install", "version": "1"}}}).encode()
    request = urllib.request.Request(mcp_url_for(board), data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json, text/event-stream")
    request.add_header("Authorization", f"Bearer {token}")
    try:
        with rt.opener_for(board).open(request, timeout=30) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    except http.client.HTTPException as error:
        raise ConnectorError(f"the board's MCP endpoint sent an answer that was cut off or malformed "
                             f"({type(error).__name__}).") from None
    except TRANSPORT_ERRORS as error:
        raise ConnectorError(f"could not reach the board's MCP endpoint ({scrub(getattr(error, 'reason', error), token)}).") from None
    if status != 200:
        raise ConnectorError(
            f"the board refused this token on the MCP endpoint (HTTP {status}). A harness connector's token is "
            "pinned to the `any` transport; one pinned to `api` cannot serve the harness.")


def read_token(args, rt):
    if getattr(args, "token_stdin", False):
        line = rt.stdin.readline()
    else:
        line = rt.getpass("Paste the connector token (input is hidden): ")
    try:
        return validate_token(line)
    except CustodyError as error:
        raise ConnectorError(str(error)) from None


def _iso(moment):
    return moment.isoformat().replace("+00:00", "Z")


def _stamp(moment):
    return moment.strftime("%Y%m%dT%H%M%SZ")


def _write_text(path, text):
    path = Path(path)
    if path.is_symlink():
        raise ConnectorError(f"{path} is a symbolic link; refusing to write through it.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.replace(temporary, path)


def _read_text(path):
    path = Path(path)
    return path.read_text(encoding="utf-8") if path.is_file() else None


# ── the local state ───────────────────────────────────────────────────────

def state_dir(rt, name):
    return rt.root() / validate_name(name)


def load_manifest(rt, name):
    text = _read_text(state_dir(rt, name) / MANIFEST)
    if text is None:
        return None
    try:
        manifest = json.loads(text)
    except ValueError:
        raise ConnectorError(f"the connector's local record {state_dir(rt, name) / MANIFEST} is damaged.") from None
    return manifest if isinstance(manifest, dict) else None


def save_manifest(rt, manifest):
    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if custody_module.TOKEN_SHAPE.search(text):  # belt and braces: the record never holds a token
        raise ConnectorError("refusing to write a local record that looks like it holds a credential.")
    _write_text(state_dir(rt, manifest["name"]) / MANIFEST, text)


def installed_names(rt):
    try:
        root = rt.root()
    except CustodyError:
        return []
    if not root.is_dir():
        return []
    return sorted(child.name for child in root.iterdir()
                  if child.is_dir() and (child / MANIFEST).is_file() and custody_module.NAME_SHAPE.fullmatch(child.name))


def resolve_name(rt, name):
    if name:
        return validate_name(name)
    names = installed_names(rt)
    if len(names) == 1:
        return names[0]
    if not names:
        raise ConnectorError("no connector is installed for this user.")
    raise ConnectorError(f"more than one connector is installed ({', '.join(names)}); name one with --name.")


# ── the harness MCP entry ─────────────────────────────────────────────────

def proxy_args(rt, name):
    return [str(rt.script), "connector", "mcp", "--name", name]


def managed_by(entry):
    """The connector name an MCP entry was written for, or None if not ours."""
    if not isinstance(entry, dict):
        return None
    args = entry.get("args")
    if not isinstance(args, list):
        return None
    for index in range(len(args) - 3):
        if args[index:index + 3] == ["connector", "mcp", "--name"]:
            candidate = args[index + 3]
            return candidate if isinstance(candidate, str) else None
    return None


def entry_owner(harness, entry):
    """The connector an entry belongs to, or None. Antigravity: the marker field alone."""
    if HARNESSES[harness]["config"] != "antigravity-json":
        return managed_by(entry)
    env = entry.get("env") if isinstance(entry, dict) else None
    owner = env.get(ANTIGRAVITY_MARKER) if isinstance(env, dict) else None
    return owner if isinstance(owner, str) and owner else None


def _home(rt):
    return Path(rt.environ.get("USERPROFILE") or rt.environ.get("HOME") or os.path.expanduser("~"))


def config_path(rt, harness):
    kind = HARNESSES[harness]["config"]
    if kind == "claude-json":
        base = rt.environ.get("CLAUDE_CONFIG_DIR")
        return Path(base) / ".claude.json" if base else _home(rt) / ".claude.json"
    if kind == "codex-toml":
        return Path(rt.environ.get("CODEX_HOME") or _home(rt) / ".codex") / "config.toml"
    if kind == "vscode-json":
        appdata = rt.environ.get("APPDATA")
        if not appdata:
            raise ConnectorError("APPDATA is not set, so VS Code's user folder cannot be found.")
        return Path(appdata) / "Code" / "User" / "mcp.json"
    if kind == "antigravity-json":
        # The path owner ruling E475 (2) names, and the one a working Antigravity
        # install reads: `mcpServers` of ~/.gemini/config/mcp_config.json.
        return _home(rt) / ".gemini" / "config" / "mcp_config.json"
    return None


def json_entry(rt, harness, name):
    if HARNESSES[harness]["config"] == "antigravity-json":
        # The shape a working Antigravity stdio entry has (`command`, `args`),
        # plus the marker in its `env`. No `type` key: Antigravity's file has none.
        return {"command": rt.python, "args": proxy_args(rt, name), "env": {ANTIGRAVITY_MARKER: name}}
    entry = {"type": "stdio", "command": rt.python, "args": proxy_args(rt, name)}
    if harness == "claude-code":
        entry["env"] = {}
    return entry


# ── credentials in an entry install would replace (design section 8; S2 review B1) ──
#
# Install keeps what it replaces so that uninstall can put it back. A kept copy
# of a credential would be that credential on disk outside custody, so install
# never replaces an entry that carries one: it refuses and names the file, the
# entry and the field (never the value). "Carries" is read strictly: a value in
# the board's credential shape, an HTTP auth scheme with a value, a well-known
# secret prefix, any literal under a key or flag that names a secret, and any
# long opaque string. A REFERENCE (an environment variable's name, `${VAR}`,
# `${env:VAR}`, `${input:id}`, `%VAR%`) is not a credential.

SECRET_KEY = re.compile(r"authorization|token|secret|passw(or)?d|api[-_]?key|access[-_]?key|private[-_]?key|"
                        r"cookie|credential", re.I)
REFERENCE_KEY = re.compile(r"env_vars?$|env_http_headers$", re.I)  # Codex: these name variables, never values
REFERENCE_VALUE = re.compile(r"\s*(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)\s*")
SCHEME_VALUE = re.compile(r"\b(Bearer|Basic|Token)\s+(?!\$\{|\$[A-Za-z_]|%[A-Za-z_])[A-Za-z0-9._~+/=-]{8,}", re.I)
KNOWN_SECRET = re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
                          r"glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|"
                          r"AIza[0-9A-Za-z_-]{30,})")
OPAQUE_VALUE = re.compile(r"(?=[A-Za-z0-9_+=.-]*[0-9])(?=[A-Za-z0-9_+=.-]*[A-Za-z])[A-Za-z0-9_+=.-]{32,}")
SECRET_FLAG = re.compile(r"--?[A-Za-z0-9_-]*(token|secret|passw(or)?d|api[-_]?key|auth)[A-Za-z0-9_-]*", re.I)
TOML_ASSIGNMENT = re.compile(r'(?:^|[{,])\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*"([^"]*)"')


def _secret_shaped(value):
    return bool(custody_module.TOKEN_SHAPE.search(value) or SCHEME_VALUE.search(value)
                or KNOWN_SECRET.search(value) or OPAQUE_VALUE.fullmatch(value.strip()))


def _literal(value):
    """A value, not a reference: `Bearer ${TOKEN}` names a variable; `Bearer abc…` is a credential."""
    bare = re.sub(r"^\s*(Bearer|Basic|Token)\s+", "", value, flags=re.I)
    return len(bare.strip()) >= 8 and not REFERENCE_VALUE.fullmatch(bare)


def credential_fields(value, path=""):
    """The dotted names of the fields of `value` that carry a credential (names only, never values)."""
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if REFERENCE_KEY.search(str(key)):
                continue
            if isinstance(child, str) and SECRET_KEY.search(str(key)) and _literal(child):
                found.append(child_path)
            else:
                found.extend(credential_fields(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = f"{path}[{index}]"
            previous = value[index - 1] if index else None
            if (isinstance(child, str) and isinstance(previous, str) and SECRET_FLAG.fullmatch(previous)
                    and _literal(child)):
                found.append(child_path)
            elif (isinstance(child, str) and "=" in child and SECRET_FLAG.fullmatch(child.split("=", 1)[0])
                    and _literal(child.split("=", 1)[1])):
                found.append(child_path)
            else:
                found.extend(credential_fields(child, child_path))
    elif isinstance(value, str) and _secret_shaped(value):
        found.append(path or "(value)")
    return found


def credential_fields_toml(text):
    """credential_fields for a TOML fragment: parsed where Python reads TOML, read line by line otherwise."""
    try:
        parsed = _toml_load(text)
    except ValueError:
        parsed = None
    if parsed is not None:
        return credential_fields(parsed)
    found = []
    for number, line in enumerate(text.split("\n"), start=1):
        if line.lstrip().startswith("#"):
            continue
        hit = _secret_shaped(line)
        for key, value in TOML_ASSIGNMENT.findall(line):
            if not REFERENCE_KEY.search(key) and SECRET_KEY.search(key) and _literal(value):
                hit = True
        if hit:
            found.append(f"line {number}")
    return found


def prose_carries_credential(text):
    """For a file of prose (SKILL.md): a value in a credential shape, never a word such as `token`."""
    return bool(custody_module.TOKEN_SHAPE.search(text) or SCHEME_VALUE.search(text) or KNOWN_SECRET.search(text))


def holds_token(text, token):
    """Does `text` hold `token`, or its secret half?"""
    if not text or not token:
        return False
    secret = token.split(".", 1)[-1]
    return token in text or (len(secret) >= 8 and secret in text)


def printable_fields(fields, token):
    """The field names a message may PRINT: never a name that is itself shaped like a secret or holds the token.

    For display only. Whether an entry or a file carries a credential is decided
    on the UNFILTERED list: a credential whose dotted path happens to look opaque
    (`mcpServers.context7.env.CONTEXT7_API_KEY` is 32+ characters with a digit)
    is unprintable, never absent (E475 round-1 review B1)."""
    return [field for field in fields if not _secret_shaped(field) and not holds_token(field, token)]


def refuse_credential_entry(path, alias, fields, same_token, token):
    # The caller decided on the full list; this only chooses what may be printed.
    fields = printable_fields(fields, token)
    named = f" (in {', '.join(fields[:3])})" if fields else ""
    parts = [f"the MCP server {alias!r} in {path} carries a credential{named}, so the installer will not replace "
             "it: keeping that entry for uninstall would copy the credential to disk outside the connector's "
             "custody."]
    if same_token:
        parts.append("It is the SAME credential you are installing now, so do NOT revoke it: the connector will "
                     f"keep it in custody. Remove the {alias!r} entry from {path} by hand and re-run install, or "
                     "install under another name with --alias <name>.")
    else:
        parts.append(f"It is not the credential you are installing. Remove the {alias!r} entry from {path} by hand "
                     "and re-run install, or install under another name with --alias <name>.")
    parts.append("Nothing was changed.")
    raise ConnectorError(scrub(" ".join(parts), token))


class ConfigPlan:
    """What install will do to one harness configuration file, decided before anything is written.

    `kept` is what uninstall needs to put a replaced entry back: that entry
    alone, never the whole file, so no other credential the file may hold is
    ever copied (and a replaced entry never carries one: plan_* refuses it)."""

    def __init__(self, harness, path, kind, before, after, replaced, kept=None, created_container=False,
                 file_backup=False, file_backup_refusal=None):
        self.harness, self.path, self.kind = harness, path, kind
        self.before, self.after = before, after
        self.replaced = replaced
        self.kept = kept
        self.created_container = created_container
        # Antigravity (E475 (2)): keep a copy of the whole file beside it before
        # changing it, unless the file holds another credential (S2 review B1:
        # a copy of it would be that credential on disk outside custody). Then
        # `file_backup_refusal` names the fields, never a value.
        self.file_backup = file_backup
        self.file_backup_refusal = file_backup_refusal

    @property
    def unchanged(self):
        return self.after is None


def _json_container(harness):
    return "mcpServers" if harness in ("claude-code", "antigravity") else "servers"


BOM = "﻿"


class _DuplicateKey(ValueError):
    pass


def _strict_pairs(pairs):
    """object_pairs_hook: a key given twice makes the file's meaning ambiguous, so it is refused."""
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise _DuplicateKey(key)
        seen[key] = value
    return seen


def _dump_json(data, bom=False):
    return (BOM if bom else "") + json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def plan_json(rt, harness, alias, name, token):
    path = config_path(rt, harness)
    container = _json_container(harness)
    antigravity = HARNESSES[harness]["config"] == "antigravity-json"
    if antigravity and path.is_symlink():
        raise ConnectorError(f"{path} is a symbolic link; the installer will not write through it. Nothing was changed.")
    before = _read_text(path)
    entry = json_entry(rt, harness, name)
    manual = json.dumps({container: {alias: entry}}, indent=2)
    bom = bool(antigravity and before and before.startswith(BOM))
    source = before[1:] if bom else before
    if source is None or not source.strip():
        data = {}
    else:
        try:
            data = json.loads(source, object_pairs_hook=_strict_pairs if antigravity else None)
        except _DuplicateKey as duplicate:
            raise ConnectorError(
                f"{path} names the same key twice ({str(duplicate)[:64]!r}), so what it means is ambiguous and the "
                f"installer will not rewrite it. Repair it, or add this entry by hand:\n{manual}\n"
                "Nothing was changed.") from None
        except ValueError:
            raise ConnectorError(
                f"{path} is not plain JSON (comments or trailing commas?), so the installer will not rewrite it. "
                f"Add this entry by hand and re-run install:\n{manual}\nNothing was changed.") from None
    if not isinstance(data, dict) or not isinstance(data.get(container, {}), dict) or (
            antigravity and alias in data.get(container, {}) and not isinstance(data[container][alias], dict)):
        raise ConnectorError(f"{path} does not have the shape the installer expects; add this entry by hand:\n"
                             f"{manual}\nNothing was changed.")
    servers = dict(data.get(container) or {})
    current = servers.get(alias)
    owner = entry_owner(harness, current)
    if current is not None and owner is not None and owner != name:
        raise ConnectorError(f"the MCP server {alias!r} in {path} belongs to connector {owner!r}. Uninstall that "
                             "one first, or choose another --alias. Nothing was changed.")
    if current == entry:
        return ConfigPlan(harness, path, "json", before, None, False)
    replaced = current is not None and owner is None
    kept = None
    if replaced:
        fields = credential_fields(current)
        same = holds_token(json.dumps(current), token)
        if fields or same:
            refuse_credential_entry(path, alias, fields, same, token)
        kept = json.dumps({container: {alias: current}}, indent=2, ensure_ascii=False) + "\n"
    file_backup, refusal = False, None
    if antigravity and before is not None:
        others = dict(data)
        if owner == name:  # what the installer itself wrote is no reason to withhold the copy (review B3)
            mine = {k: v for k, v in current.items() if k != 'env' and v != entry.get(k)}
            env = current.get('env') if isinstance(current.get('env'), dict) else {}
            extra = {k: v for k, v in env.items() if (entry.get('env') or {}).get(k) != v}
            if extra:
                mine['env'] = extra
            others[container] = {**{k: v for k, v in servers.items() if k != alias}, alias: mine}
        # Decide on every credential field found; filter only what the message prints (review B1).
        found = credential_fields(others)
        if found or holds_token(before, token):
            named = printable_fields(found, token)
            refusal = (", ".join(named[:3]) or
                       ("a field whose name is not printed because it looks like a secret" if found
                        else "the token you are installing"))
        else:
            file_backup = True
    created_container = container not in data
    servers[alias] = entry
    data = dict(data)
    data[container] = servers
    after = _dump_json(data, bom)
    return ConfigPlan(harness, path, "json", before, after, replaced, kept, created_container,
                      file_backup, refusal)


def toml_begin(name):
    return f"# >>> relayhall connector {name} (managed by `relayhall connector install`; edit outside this block)"


def toml_end(name):
    return f"# <<< relayhall connector {name}"


TOML_BEGIN = re.compile(r"^# >>> relayhall connector ([a-z0-9][a-z0-9-]{0,62}) ")
TOML_HEADER = re.compile(r"^\s*\[")


def _toml_string(value):
    # A JSON string is a valid TOML basic string (same escapes); keep non-ASCII as is.
    return json.dumps(value, ensure_ascii=False)


def toml_block(rt, alias, name):
    args = ", ".join(_toml_string(arg) for arg in proxy_args(rt, name))
    return [toml_begin(name), f"[mcp_servers.{alias}]", f"command = {_toml_string(rt.python)}",
            f"args = [{args}]", toml_end(name)]


def _alias_header(alias):
    quoted = re.escape(alias)
    return re.compile(r'^\s*\[\s*mcp_servers\s*\.\s*(?:' + quoted + r'|"' + quoted + r'"|\'' + quoted + r'\')\s*\]\s*(?:#.*)?$')


def _alias_subheader(alias):
    quoted = re.escape(alias)
    return re.compile(r'^\s*\[\s*mcp_servers\s*\.\s*(?:' + quoted + r'|"' + quoted + r'"|\'' + quoted + r'\')\s*\.')


def managed_blocks(lines):
    """{name: (begin, end)} of every managed block, by line index (inclusive)."""
    blocks, index = {}, 0
    while index < len(lines):
        match = TOML_BEGIN.match(lines[index])
        if match:
            name = match.group(1)
            end = next((j for j in range(index + 1, len(lines)) if lines[j].rstrip() == toml_end(name)), None)
            if end is None:
                raise ConnectorError(f"the managed block for connector {name!r} has lost its end marker; "
                                     "repair it by hand.")
            blocks[name] = (index, end)
            index = end + 1
        else:
            index += 1
    return blocks


def unmanaged_section(lines, alias, blocks):
    """(start, end) of a hand-written [mcp_servers.<alias>] table outside every block, or None."""
    inside = set()
    for begin, end in blocks.values():
        inside.update(range(begin, end + 1))
    header, sub = _alias_header(alias), _alias_subheader(alias)
    starts = [i for i, line in enumerate(lines) if i not in inside and header.match(line)]
    if len(starts) > 1:
        raise ConnectorError(f"[mcp_servers.{alias}] appears more than once; repair the file by hand.")
    if not starts:
        return None
    start = starts[0]
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if j in inside or (TOML_HEADER.match(lines[j]) and not sub.match(lines[j])):
            end = j
            break
    while end - 1 > start and (not lines[end - 1].strip() or lines[end - 1].lstrip().startswith("#")):
        end -= 1  # leave trailing blank lines and comments with what follows
    return start, end - 1


def _toml_load(text):
    try:
        import tomllib
    except ModuleNotFoundError:  # Python 3.10: no reader in the standard library
        return None
    return tomllib.loads(text)


def _block_alias(lines, begin, end):
    for line in lines[begin:end + 1]:
        match = re.match(r'^\s*\[\s*mcp_servers\s*\.\s*"?\'?([A-Za-z0-9_-]+)"?\'?\s*\]', line)
        if match:
            return match.group(1)
    return None


def plan_toml(rt, harness, alias, name, token):
    path = config_path(rt, harness)
    before = _read_text(path)
    text = before or ""
    lines = text.split("\n")
    block = toml_block(rt, alias, name)
    manual = "\n".join(block[1:-1])
    try:
        parsed = _toml_load(text) if text.strip() else {}
    except ValueError as error:
        raise ConnectorError(f"{path} is not valid TOML ({error}); the installer will not rewrite it. "
                             f"Add this entry by hand and re-run install:\n{manual}\nNothing was changed.") from None
    blocks = managed_blocks(lines)
    for other, (begin, end) in blocks.items():
        if other != name and _block_alias(lines, begin, end) == alias:
            raise ConnectorError(f"the MCP server {alias!r} in {path} belongs to connector {other!r}. Uninstall "
                                 "that one first, or choose another --alias. Nothing was changed.")
    section = unmanaged_section(lines, alias, blocks)
    ours = blocks.get(name)
    if ours is not None and section is not None:
        raise ConnectorError(f"{path} has both a managed and a hand-written [mcp_servers.{alias}]; remove one by hand.")
    if (parsed is not None and section is None and ours is None
            and isinstance(parsed.get("mcp_servers"), dict) and alias in parsed["mcp_servers"]):
        raise ConnectorError(f"{path} defines the MCP server {alias!r} in a form the installer does not edit "
                             f"(an inline table or dotted keys). Remove it, or add this entry by hand:\n{manual}\n"
                             "Nothing was changed.")
    replaced, kept = False, None
    if ours is not None:
        new_lines = lines[:ours[0]] + block + lines[ours[1] + 1:]
    elif section is not None:
        replaced = True
        kept = "\n".join(lines[section[0]:section[1] + 1]) + "\n"
        fields = credential_fields_toml(kept)
        same = holds_token(kept, token)
        if fields or same:
            refuse_credential_entry(path, alias, fields, same, token)
        new_lines = lines[:section[0]] + block + lines[section[1] + 1:]
    else:
        body = text
        if body and not body.endswith("\n"):
            body += "\n"
        prefix = body + ("\n" if body.strip() else "")
        new_lines = (prefix + "\n".join(block) + "\n").split("\n")
    after = "\n".join(new_lines)
    if not after.endswith("\n"):
        after += "\n"
    if after == before:
        return ConfigPlan(harness, path, "toml", before, None, False)
    check = _toml_load(after)
    if check is not None:
        written = (check.get("mcp_servers") or {}).get(alias)
        if written != {"command": rt.python, "args": proxy_args(rt, name)}:
            raise ConnectorError(f"the edited {path} would not read back as the intended entry; nothing was changed.")
    return ConfigPlan(harness, path, "toml", before, after, replaced, kept)


def plan_config(rt, harness, alias, name, token):
    kind = HARNESSES[harness]["config"]
    if kind in ("claude-json", "vscode-json", "antigravity-json"):
        return plan_json(rt, harness, alias, name, token)
    if kind == "codex-toml":
        return plan_toml(rt, harness, alias, name, token)
    return None


def manual_entry(rt, harness, alias, name):
    entry = {"type": "stdio", "command": rt.python, "args": proxy_args(rt, name)}
    return json.dumps({alias: entry}, indent=2)


def _write_private_copy(path, data):
    """A new file holding `data`, created 0600 (on Windows the mode is what the platform allows), never
    overwriting one already there: a second backup in the same second gets the next free suffix."""
    path = Path(path)
    for attempt in range(100):
        candidate = path if attempt == 0 else path.with_name(f"{path.name}-{attempt}")
        try:
            descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        except FileExistsError:
            continue
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        try:
            os.chmod(candidate, 0o600)  # the umask cannot widen it; a no-op beyond read-only on Windows
        except OSError:
            pass
        return candidate
    raise ConnectorError(f"could not choose a free name for a backup beside {path}; nothing was changed.")


def apply_config(rt, plan, manifest, moment, backup=True):
    """Keep the entry being replaced, then write. Returns the config record kept in the manifest.

    The backup is the replaced entry alone (plan.kept), never the whole file:
    a harness file can hold other credentials (another server's header, a
    client's own API key), and a copy of the file would put them on disk
    outside custody. Nothing is kept when nothing is replaced.

    A re-install (the entry is already this connector's) keeps the FIRST
    install's record and backup, because that backup is what uninstall must
    restore; it makes no second one of the connector's own entry."""
    record = {"path": str(plan.path), "kind": plan.kind, "created": plan.before is None,
              "replaced": plan.replaced, "createdContainer": plan.created_container, "backup": None}
    if HARNESSES[plan.harness]["config"] == "antigravity-json":
        record["fileBackup"] = None
        if plan.file_backup:
            # The exact bytes about to be replaced, beside the file, BEFORE it is written.
            with open(plan.path, "rb") as handle:
                original = handle.read()
            copy = _write_private_copy(plan.path.with_name(f"{plan.path.name}{BACKUP_INFIX}{_stamp(moment)}"),
                                       original)
            record["fileBackup"] = str(copy)
    if plan.kept is not None and backup:
        backup = state_dir(rt, manifest["name"]) / BACKUPS / f"{plan.path.name}.{_stamp(moment)}.entry.bak"
        _write_text(backup, plan.kept)
        record["backup"] = str(backup)
    _write_text(plan.path, plan.after)
    return record


def remove_config(rt, manifest, record, notes):
    """Undo the MCP entry: remove our entry; put back one install replaced."""
    path = Path(record["path"])
    name = manifest["name"]
    alias = manifest["alias"]
    current = _read_text(path)
    if current is None:
        notes.append(f"MCP entry: {path} is gone already; nothing to remove.")
        return True
    backup_text = _read_text(record["backup"]) if record.get("backup") else None
    if record.get("replaced") and backup_text is None:
        notes.append(f"MCP entry: the backup of the entry install replaced is missing; the entry is removed, "
                     "not restored.")
    if record["kind"] == "json":
        harness = manifest["harness"]
        container = _json_container(harness)
        if record.get("fileBackup"):
            notes.append(f"MCP entry: the copy of {path} install kept before changing it stays at "
                         f"{record['fileBackup']}; delete it when you no longer need it.")
        bom = current.startswith(BOM)
        try:
            data = json.loads(current[1:] if bom else current)
        except ValueError:
            notes.append(f"MCP entry: {path} is no longer plain JSON; remove the {alias!r} entry by hand.")
            return False
        servers = data.get(container) if isinstance(data, dict) else None
        if not isinstance(servers, dict) or entry_owner(harness, servers.get(alias)) != name:
            notes.append(f"MCP entry: {path} no longer holds this connector's {alias!r} entry; left as it is.")
            return True
        servers = dict(servers)
        previous = None
        if record.get("replaced") and backup_text is not None:
            try:
                previous = (json.loads(backup_text).get(container) or {}).get(alias)
            except (ValueError, AttributeError):
                previous = None
        if previous is not None:
            servers[alias] = previous
        else:
            servers.pop(alias, None)
        data = dict(data)
        if not servers and record.get("createdContainer"):
            data.pop(container, None)
        else:
            data[container] = servers
        if record.get("created") and not data:
            path.unlink()
            notes.append(f"MCP entry: removed {path}, which install had created.")
            return True
        _write_text(path, _dump_json(data, bom))
        notes.append(f"MCP entry: {'restored the earlier' if previous is not None else 'removed the'} {alias!r} "
                     f"entry in {path}.")
        return True
    lines = current.split("\n")
    try:
        blocks = managed_blocks(lines)
    except ConnectorError as error:
        notes.append(f"MCP entry: {error}")
        return False
    ours = blocks.get(name)
    if ours is None:
        notes.append(f"MCP entry: {path} no longer holds this connector's block; left as it is.")
        return True
    replacement = []
    if record.get("replaced") and backup_text is not None:
        old = backup_text.split("\n")
        try:
            section = unmanaged_section(old, alias, managed_blocks(old))
        except ConnectorError:
            section = None
        if section is not None:
            replacement = old[section[0]:section[1] + 1]
    begin, end = ours
    new_lines = lines[:begin] + replacement + lines[end + 1:]
    if not replacement and begin > 0 and not new_lines[begin - 1].strip():
        del new_lines[begin - 1]  # the blank line install put before the block
    after = "\n".join(new_lines)
    if record.get("created") and not after.strip():
        path.unlink()
        notes.append(f"MCP entry: removed {path}, which install had created.")
        return True
    _write_text(path, after if after.endswith("\n") else after + "\n")
    notes.append(f"MCP entry: {'restored the earlier' if replacement else 'removed the'} {alias!r} entry in {path}.")
    return True


def config_state(rt, manifest):
    record = manifest.get("config")
    if not record:
        return "not written"
    path = Path(record["path"])
    text = _read_text(path)
    if text is None:
        return f"missing ({path} is gone)"
    if record["kind"] == "json":
        try:
            data = json.loads(text[1:] if text.startswith(BOM) else text)
            entry = (data.get(_json_container(manifest["harness"])) or {}).get(manifest["alias"])
        except (ValueError, AttributeError):
            return f"unreadable ({path} is not plain JSON)"
        owned = entry_owner(manifest["harness"], entry) == manifest["name"]
        return f"present in {path}" if owned else f"missing from {path}"
    try:
        present = manifest["name"] in managed_blocks(text.split("\n"))
    except ConnectorError:
        present = False
    return f"present in {path}" if present else f"missing from {path}"


# ── the connection skill (design section 3.3: install also runs it) ───────

def install_skill(rt, manifest, token, moment):
    import relayhall_connection_skill as skill

    harness = HARNESSES[manifest["harness"]]["skill"]
    if not harness:
        return None, None

    def api(method, path, data=None, timeout=30, exit_on_error=False, headers=None):
        status, parsed = board_json(rt, manifest["board"], method, path, token)
        if status != 200 or not isinstance(parsed, dict):
            return {"success": False, "status": status}
        return parsed

    try:
        identity = skill.resolve_registry_skill(api)
        credential_ref = f"the RelayHall connector's OS custody (`relayhall connector status --name {manifest['name']}`)"
        block = skill.render_block(manifest["alias"], mcp_url_for(manifest["board"]), credential_ref, identity)
        skill._refuse_secret("the rendered skill", block, [token])
        _label, variable, default_dir = skill.HARNESSES[harness]
        # The same location `connection-skill install` uses, but with the home
        # folder taken from this runtime rather than from the process.
        skills = Path((rt.environ.get(variable) if variable else None) or _home(rt) / default_dir) / "skills"
        target = skills / skill.LOCAL_SKILL / "SKILL.md"
        if target.is_symlink():
            raise skill.InstallError(f"{target} is a symbolic link")
        existing = _read_text(target)
        if existing is not None and not manifest.get("skill") and (
                prose_carries_credential(existing) or holds_token(existing, token)):
            # Its backup would be a copy of that credential outside custody (S2 review B1).
            same = holds_token(existing, token)
            return None, (f"connection skill not installed: {target} already carries a credential, so the "
                          "installer will not copy or rewrite it. "
                          + ("It is the SAME credential you are installing now: do NOT revoke it; remove it from "
                             "that file and re-run install." if same else
                             "Remove it from that file and re-run install."))
        content = skill.merge(existing, block)
    except (skill.InstallError, ConnectorError) as error:
        return None, f"connection skill not installed: {scrub(error, token)}"
    record = {"path": str(target), "created": existing is None, "backup": None}
    if existing == content:
        return record, None
    if existing is not None and not manifest.get("skill"):
        backup = state_dir(rt, manifest["name"]) / BACKUPS / f"SKILL.md.{_stamp(moment)}.bak"
        _write_text(backup, existing)
        record["backup"] = str(backup)
    _write_text(target, content)
    return record, None


def remove_skill(rt, record, notes):
    import relayhall_connection_skill as skill

    path = Path(record["path"])
    current = _read_text(path)
    if current is None:
        notes.append("connection skill: already gone.")
        return True
    if record.get("created"):
        path.unlink()
        try:
            path.parent.rmdir()
        except OSError:
            pass
        notes.append(f"connection skill: removed {path}, which install had created.")
        return True
    backup = _read_text(record["backup"]) if record.get("backup") else None
    if backup is None:
        notes.append(f"connection skill: {path} was there before install and was not changed; left as it is.")
        return True

    def block_of(text):
        lines = text.split("\n")
        begins = [i for i, line in enumerate(lines) if line.rstrip("\r").startswith(skill.BEGIN_PREFIX)]
        ends = [i for i, line in enumerate(lines) if line.rstrip("\r") == skill.END]
        if len(begins) == 1 and len(ends) == 1 and begins[0] < ends[0]:
            return lines, begins[0], ends[0]
        return lines, None, None

    lines, begin, end = block_of(current)
    old_lines, old_begin, old_end = block_of(backup)
    if begin is None:
        notes.append(f"connection skill: {path} no longer holds the managed block; left as it is.")
        return True
    replacement = old_lines[old_begin:old_end + 1] if old_begin is not None else []
    _write_text(path, "\n".join(lines[:begin] + replacement + lines[end + 1:]))
    notes.append(f"connection skill: restored the block {path} held before install.")
    return True


# ── the scheduled task (design section 3.4) ───────────────────────────────

def task_name(name):
    return TASK_PREFIX + validate_name(name)


def task_arguments(rt, name):
    return subprocess.list2cmdline([str(rt.script), "connector", "run", "--name", name])


# Slice S3: the task also repeats, so the collector reports every five minutes (the board calls a reading
# stale after fifteen). Each run is one bounded cycle (E463).
# Slice S5: with the ring enabled, `connector run` is the long-running daemon, and a harness run lives inside
# it for up to four hours, so Task Scheduler no longer stops the task (PT0S: no limit; it would end every run
# in flight). The one-cycle run keeps its fifteen-minute outer net in-process instead (ONESHOT_LIMIT_SECONDS),
# under the collector's own deadline and watchdog. IgnoreNew still keeps one instance; RestartOnFailure and the
# five-minute trigger start the daemon again after a crash.
TASK_REPEAT_INTERVAL = "PT5M"
TASK_EXECUTION_LIMIT = "PT0S"
ONESHOT_LIMIT_SECONDS = 15 * 60
EXIT_ONESHOT_WATCHDOG = 70
TASK_START_BOUNDARY = "2026-01-01T00:00:00"


def render_task_xml(name, user_id, command, arguments):
    """A per-user task at logon and every five minutes: least privilege, interactive token, restarted on failure."""
    values = {key: xml_escape(value) for key, value in
              {"name": name, "user": user_id, "command": command, "arguments": arguments}.items()}
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RelayHall connector {values['name']}: written by `relayhall connector install`, removed by `relayhall connector uninstall`.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{values['user']}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>{TASK_START_BOUNDARY}</StartBoundary>
      <Repetition>
        <Interval>{TASK_REPEAT_INTERVAL}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{values['user']}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>{TASK_EXECUTION_LIMIT}</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{values['command']}</Command>
      <Arguments>{values['arguments']}</Arguments>
    </Exec>
  </Actions>
</Task>
"""


def task_create_argv(task, xml_path):
    return ["schtasks", "/Create", "/TN", task, "/XML", str(xml_path), "/F"]


def task_delete_argv(task):
    return ["schtasks", "/Delete", "/TN", task, "/F"]


def task_query_xml_argv(task):
    return ["schtasks", "/Query", "/TN", task, "/XML"]


def task_query_state_argv(task):
    return ["schtasks", "/Query", "/TN", task, "/FO", "CSV", "/NH", "/V"]


def register_task(rt, name):
    task = task_name(name)
    xml = render_task_xml(name, rt.windows_user(), rt.pythonw(), task_arguments(rt, name))
    xml_path = state_dir(rt, name) / "task.xml"
    xml_path.parent.mkdir(parents=True, exist_ok=True)
    with open(xml_path, "w", encoding="utf-16") as handle:
        handle.write(xml)
    try:
        result = rt.run(task_create_argv(task, xml_path))
    finally:
        try:
            xml_path.unlink()
        except FileNotFoundError:
            pass
    if result.returncode != 0:
        raise ConnectorError(f"Task Scheduler refused the per-user task {task!r}: "
                             f"{(result.stderr or result.stdout or '').strip()[:300]}")
    return {"name": task}


def task_is_ours(rt, record, name):
    result = rt.run(task_query_xml_argv(record["name"]))
    if result.returncode != 0:
        return None  # not registered
    return f"connector run --name {name}" in (result.stdout or "")


def task_state(rt, record):
    result = rt.run(task_query_state_argv(record["name"]))
    if result.returncode != 0:
        return "not registered"
    import csv
    rows = list(csv.reader((result.stdout or "").strip().splitlines()))
    row = rows[0] if rows else []
    status = row[3] if len(row) > 3 else "unknown"
    last = row[6] if len(row) > 6 else "unknown"
    return f"{status}, last result {last}"


def remove_task(rt, record, name, notes):
    ours = task_is_ours(rt, record, name)
    if ours is None:
        notes.append(f"task: {record['name']!r} is not registered; nothing to remove.")
        return True
    if not ours:
        notes.append(f"task: {record['name']!r} no longer runs this connector; left as it is.")
        return False
    result = rt.run(task_delete_argv(record["name"]))
    if result.returncode != 0:
        notes.append(f"task: Task Scheduler refused to delete {record['name']!r}: "
                     f"{(result.stderr or result.stdout or '').strip()[:300]}")
        return False
    notes.append(f"task: removed {record['name']!r}.")
    return True


# ── removal of everything a manifest records ──────────────────────────────

def remove_recorded(rt, manifest, notes):
    ok = True
    name = manifest["name"]
    if manifest.get("task"):
        ok = remove_task(rt, manifest["task"], name, notes) and ok
    if manifest.get("config"):
        ok = remove_config(rt, manifest, manifest["config"], notes) and ok
    if manifest.get("skill"):
        ok = remove_skill(rt, manifest["skill"], notes) and ok
    if manifest.get("custody"):
        try:
            removed = rt.custody().delete(name)
            notes.append("custody: removed the stored token." if removed else "custody: no stored token was left.")
        except CustodyError as error:
            notes.append(f"custody: {error}")
            ok = False
    if ok:
        folder = state_dir(rt, name)
        backups = folder / BACKUPS
        recorded = {p for p in ((manifest.get("config") or {}).get("backup"),
                                (manifest.get("skill") or {}).get("backup")) if p}
        for path in recorded:
            try:
                Path(path).unlink()
            except FileNotFoundError:
                pass
        # The collector's own runtime state (its last attempt, last readings, override cache, lock). The
        # person's collector.json and the append-only trust ledger stay: install did not write them.
        shutil.rmtree(folder / collector_module.RUNTIME_DIR, ignore_errors=True)
        for leftover in (folder / MANIFEST, folder / "run-state.json"):
            try:
                leftover.unlink()
            except FileNotFoundError:
                pass
        for directory in (backups, folder):
            try:
                directory.rmdir()
            except OSError:
                pass
        if folder.exists():
            notes.append(f"state: {folder} still holds files install did not write; left in place.")
        else:
            notes.append(f"state: removed {folder}.")
    else:
        notes.append("state: kept the local record, because something above was not removed; fix it and re-run "
                     "uninstall.")
    return ok


# ── verbs ─────────────────────────────────────────────────────────────────

def cmd_install(args, rt):
    harness = (args.harness or "").strip().lower()
    if harness not in HARNESSES:
        raise ConnectorError(f"--harness must be one of {', '.join(HARNESSES)}, got {args.harness!r}. "
                             "Nothing was changed.")
    board = validate_board(args.board)
    alias = validate_alias(args.alias)
    if args.name:
        validate_name(args.name)
    custody = rt.custody()  # refuses on a platform without custody, before anything is asked
    if rt.environ.get("RELAYHALL_TOKEN"):
        say(rt, "Note: RELAYHALL_TOKEN is set in this shell. The connector never reads it.")
    token = read_token(args, rt)

    status, _parsed = board_json(rt, board, "GET", "/health")
    if status is None or status >= 500:
        raise ConnectorError(f"the board at {board} is not healthy (GET /api/health answered HTTP {status}). "
                             "Nothing was changed.")
    principal, scopes = whoami(rt, board, token)
    if principal.get("kind") != "service":
        raise ConnectorError(f"this token belongs to a {principal.get('kind')!r} principal, not a connector. Make the "
                             "connection with Connect your agent and use the token it shows. Nothing was changed.")
    name = args.name or str(principal.get("handle") or "")
    try:
        name = validate_name(name)
    except CustodyError:
        raise ConnectorError(f"the connector's board handle {name!r} is not a usable local name; give one with "
                             "--name. Nothing was changed.") from None
    mcp_probe(rt, board, token)

    previous = load_manifest(rt, name)
    if previous and (previous.get("board") != board or previous.get("harness") != harness):
        raise ConnectorError(f"connector {name!r} is already installed for {previous.get('harness')} on "
                             f"{previous.get('board')}; uninstall it first. Nothing was changed.")
    if previous and previous.get("alias", DEFAULT_ALIAS) != alias:
        # One connector, one entry: a second alias would be an entry uninstall does not know about.
        raise ConnectorError(f"connector {name!r} is already installed as the MCP server "
                             f"{previous.get('alias', DEFAULT_ALIAS)!r}; uninstall it first to change --alias. "
                             "Nothing was changed.")
    plan = plan_config(rt, harness, alias, name, token)

    moment = rt.now()
    manifest = dict(previous or {})
    manifest.update({"version": 1, "name": name, "harness": harness, "board": board, "alias": alias,
                     "principal": {"id": principal.get("id"), "handle": principal.get("handle")},
                     "installedAt": manifest.get("installedAt") or _iso(moment), "updatedAt": _iso(moment)})
    save_manifest(rt, manifest)
    try:
        custody.store(name, token)
        manifest["custody"] = {"kind": custody.kind}
        save_manifest(rt, manifest)
        if plan is not None and not plan.unchanged:
            first = (previous or {}).get("config")
            record = apply_config(rt, plan, manifest, moment, backup=not first)
            if first and record.get("fileBackup"):
                # A re-install that changes the file keeps the first record (uninstall restores from it) and
                # names the newest copy of the whole file, so no copy install made goes unrecorded.
                first = dict(first, fileBackup=record["fileBackup"])
            manifest["config"] = first or record
            save_manifest(rt, manifest)
        elif plan is not None and not manifest.get("config"):
            manifest["config"] = {"path": str(plan.path), "kind": plan.kind, "created": False, "replaced": False,
                                  "createdContainer": False, "backup": None}
            save_manifest(rt, manifest)
        skill_record, skill_note = install_skill(rt, manifest, token, moment)
        if skill_record and not manifest.get("skill"):
            manifest["skill"] = skill_record
            save_manifest(rt, manifest)
        manifest["task"] = register_task(rt, name)
        save_manifest(rt, manifest)
    except Exception as error:  # roll back what this run recorded, then report without the token
        notes = []
        if not previous:
            remove_recorded(rt, manifest, notes)
        reason = scrub(error, token)
        raise ConnectorError(f"install did not finish ({reason}). " +
                             ("Everything it had written was removed: " + " ".join(notes) if notes
                              else "The earlier installation is unchanged except where noted.")) from None

    label = HARNESSES[harness]["label"]
    say(rt, f"Installed RelayHall connector {name!r} for {label} on {board}.")
    say(rt, f"  principal  {principal.get('id')} ({principal.get('handle')})")
    say(rt, f"  custody    {custody.describe(name)}")
    if plan is None:
        say(rt, f"  mcp entry  not written: the installer does not edit {label}'s configuration yet. Add this "
                "stdio server by hand (it holds no token):")
        say(rt, manual_entry(rt, harness, alias, name))
    else:
        say(rt, f"  mcp entry  {'unchanged' if plan.unchanged else 'written'}: {plan.path} ({alias!r} starts "
                "the local proxy; no token in the file)")
        if plan.replaced:
            say(rt, f"             it replaced an earlier {alias!r} entry (it held no credential), kept in the "
                    "connector's folder; uninstall puts it back.")
        if not plan.unchanged and (manifest.get("config") or {}).get("fileBackup"):
            say(rt, f"  backup     {manifest['config']['fileBackup']}: the file as it was before this install "
                    "(owner-only where the platform allows; uninstall keeps it)")
        elif not plan.unchanged and plan.file_backup_refusal:
            say(rt, f"  backup     no backup of {plan.path}: it holds a credential "
                    f"({scrub(plan.file_backup_refusal, token)}), and a copy would put that credential on disk a "
                    f"second time. Only the {alias!r} entry was changed; uninstall removes it again.")
        if not plan.unchanged and holds_token(plan.before, token):
            say(rt, f"WARNING: {plan.path} still holds the token you just installed, outside the {alias!r} entry. "
                    "It is the SAME credential the connector now keeps, so do NOT revoke it; remove it from that "
                    "file so the token lives only in custody.")
    if manifest.get("skill"):
        say(rt, f"  skill      {manifest['skill']['path']}")
    elif skill_note:
        say(rt, f"  skill      {skill_note}")
    say(rt, f"  task       {manifest['task']['name']!r} runs the connector at sign-in (per user, no administrator)")
    missing = missing_harness_scopes(scopes)
    if missing:
        say(rt, f"WARNING: this token lacks {', '.join(missing)} of the harness set; `relayhall connector check` "
                "will fail until it is widened on the Credentials page.")
    if rt.environ.get("RELAYHALL_TOKEN"):
        say(rt, "RELAYHALL_TOKEN is set in this shell, and the connector does not need it. Once `connector check` "
                "passes, remove it from your persistent user environment as well (for example, in PowerShell: "
                "[Environment]::SetEnvironmentVariable('RELAYHALL_TOKEN', $null, 'User')), so the token is held "
                "only in custody.")
    say(rt, f"Restart {label} so it starts the proxy, then run `relayhall connector check --name {name}`.")
    return 0


def mcp_round_trip(rt, name, expected_id):
    """initialize + tools/call relayhall_principal_whoami through the real proxy process."""
    import queue

    writer, reader, close = rt.spawn_mcp(name)
    replies = queue.Queue()

    def read():
        try:
            for raw in iter(reader.readline, b""):
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    replies.put(message)
        except (OSError, ValueError):
            pass

    def wait_for(message_id, seconds):
        deadline = datetime.datetime.now().timestamp() + seconds
        while True:
            remaining = deadline - datetime.datetime.now().timestamp()
            if remaining <= 0:
                return None
            try:
                message = replies.get(timeout=remaining)
            except queue.Empty:
                return None
            if message.get("id") == message_id:
                return message

    def send(message):
        writer.write((json.dumps(message) + "\n").encode())
        writer.flush()

    threading.Thread(target=read, daemon=True).start()
    reply = None
    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "relayhall-connector-check", "version": "1"}}})
        initialized = wait_for(1, 30)
        if initialized is None or "error" in initialized:
            detail = (initialized or {}).get("error", {}).get("message") if initialized else "no reply to initialize"
            return False, str(detail)[:200]
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
              "params": {"name": "relayhall_principal_whoami", "arguments": {}}})
        reply = wait_for(2, 60)
    except OSError as error:
        return False, f"the proxy could not be started or reached ({type(error).__name__})"
    finally:
        close()
    if not reply:
        return False, "no reply from the proxy"
    if "error" in reply:
        return False, str((reply.get("error") or {}).get("message"))[:200]
    text = json.dumps(reply.get("result"))
    if expected_id and expected_id not in text:
        return False, "the proxy answered as a different principal"
    return True, "relayhall_principal_whoami answered through the proxy"


def cmd_check(args, rt):
    name = resolve_name(rt, args.name)
    manifest = load_manifest(rt, name)
    if not manifest:
        raise ConnectorError(f"connector {name!r} is not installed.")
    results = []

    def record(label, ok, detail):
        results.append(ok)
        say(rt, f"  {'ok  ' if ok else 'FAIL'}  {label}: {detail}")

    say(rt, f"Checking RelayHall connector {name!r} ({manifest['harness']}, {manifest['board']})")
    token = None
    try:
        token = rt.custody().load(name)
        record("custody", True, rt.custody().label)
    except CustodyError as error:
        record("custody", False, str(error))
    board = manifest["board"]
    try:
        status, _parsed = board_json(rt, board, "GET", "/health")
        record("board", status is not None and status < 500,
               f"reachable over {urllib.parse.urlsplit(board).scheme.upper()} (GET /api/health: HTTP {status})")
    except ConnectorError as error:
        record("board", False, str(error))
    if token:
        try:
            principal, scopes = whoami(rt, board, token)
            same = principal.get("id") == (manifest.get("principal") or {}).get("id")
            record("whoami", same, f"{principal.get('id')} ({principal.get('handle')})"
                   + ("" if same else "; NOT the principal install recorded"))
            missing = missing_harness_scopes(scopes)
            record("scopes", not missing, "the harness set" if not missing else
                   f"missing {', '.join(missing)}; widen the credential on the Credentials page")
        except ConnectorError as error:
            record("whoami", False, scrub(error, token))
        ok, detail = mcp_round_trip(rt, name, (manifest.get("principal") or {}).get("id"))
        record("mcp proxy", ok, scrub(detail, token))
    say(rt, f"  info  mcp entry: {config_state(rt, manifest)}")
    if manifest.get("task"):
        say(rt, f"  info  task: {manifest['task']['name']!r}: {task_state(rt, manifest['task'])}")
    if token:
        check_collector(rt, name, manifest, record)
        check_ring(rt, name, manifest, record, token)
    say(rt, "  info  not checked in this version: service descriptor")
    passed = all(results)
    say(rt, "All checks passed." if passed else "Some checks failed.")
    return 0 if passed else EXIT_FAILED


def wake_status(rt, board, token, seconds=10.0):
    """Design 3.4 step 4: open the wake socket, read the board's wake.status frame, close. Sends nothing."""
    url = ring_module.socket_url(board, "/api/events/ws?wake=2")
    try:
        sock = rt.ws_connect(url, {"Authorization": f"Bearer {token}"}, 30.0)
    except ring_module.WebSocketError as error:
        return False, f"the wake socket was refused ({error.code}{', HTTP ' + str(error.status) if error.status else ''})"
    try:
        deadline = datetime.datetime.now().timestamp() + seconds
        while True:
            remaining = deadline - datetime.datetime.now().timestamp()
            if remaining <= 0:
                return False, "no wake.status frame arrived"
            text = sock.recv(remaining)
            if text is None:
                continue
            try:
                frame = json.loads(text)
            except ValueError:
                continue
            if isinstance(frame, dict) and frame.get("type") == "wake.status":
                if frame.get("enabled") is True:
                    return True, "wake=2 enabled (one published connector)"
                reason = frame.get("reason")
                return False, f"wake disabled: {reason if isinstance(reason, str) else 'no reason given'}"
    except ring_module.WebSocketError as error:
        return False, f"the wake socket closed ({error.code}, close code {sock.close_code})"
    finally:
        sock.close()


def check_ring(rt, name, manifest, record, token):
    """The ring (slice S5): its policy file, the task's limit, and the wake status frame."""
    try:
        policy = ring_module.load_policy(state_dir(rt, name))
    except ring_module.RingError as error:
        record("ring policy", False, f"{ring_module.RING_FILE} is not valid ({error.board_code}); the daemon runs "
                                     "nothing until it is")
        return
    if policy is None:
        say(rt, f"  info  ring: not configured ({ring_module.RING_FILE} in {state_dir(rt, name)}); "
                "see docs/connector-onboarding.md")
    else:
        runs = policy["kinds"]
        record("ring policy", True, f"{'enabled' if policy['enabled'] else 'disabled'}; implement {runs['implement']}, "
                                    f"verify {runs['verify']}, stuck {runs['stuck']}; at most "
                                    f"{policy['maxConcurrentRuns']} run(s), {len(policy['workdirs'])} working folder(s)")
        if policy["enabled"] and manifest.get("task"):
            result = rt.run(task_query_xml_argv(manifest["task"]["name"]))
            text = result.stdout or ""
            limited = result.returncode == 0 and f"<ExecutionTimeLimit>{TASK_EXECUTION_LIMIT}</ExecutionTimeLimit>" \
                not in text
            record("ring task", not limited, "the task lets the daemon run" if not limited else
                   "the registered task still stops the connector after 15 minutes; re-run `relayhall connector "
                   "install` once to register it again")
    ok, detail = wake_status(rt, manifest["board"], token)
    record("wake", ok, detail)


def check_collector(rt, name, manifest, record):
    """Design 3.4 steps 5 and 6: a trust check of the harness binary and a quota dry read (posts nothing)."""
    if not (state_dir(rt, name) / collector_module.COLLECTOR_FILE).is_file():
        say(rt, "  info  usage quotas: the collector is not configured "
                f"({collector_module.COLLECTOR_FILE} in {state_dir(rt, name)}); see docs/connector-onboarding.md")
        return
    result = rt.collector(name, manifest).run("check")
    state = result.get("trust") or {}
    if state.get("status") == "accepted":
        record("harness binary trust", True, f"{state.get('product')} {state.get('version')} by verified publisher "
                                             f"{state.get('publisher')}")
    elif state.get("status") == "refused":
        record("harness binary trust", False, f"refused: {state.get('code')}")
    regs = result.get("registrations") or []
    failed = sorted({r.get("failureCode") for r in regs if r.get("result") != "ok"})
    if result.get("failureCode"):
        failed = [result["failureCode"]] + failed
    record("quota dry read", not failed and result.get("status") == "checked",
           f"{sum(1 for r in regs if r.get('result') == 'ok')}/{len(regs)} accounts read"
           + (f"; {', '.join(str(code) for code in failed)}" if failed else ""))


def cmd_collect(args, rt):
    name = resolve_name(rt, args.name)
    manifest = load_manifest(rt, name)
    if not manifest:
        raise ConnectorError(f"connector {name!r} is not installed.")
    collector = rt.collector(name, manifest)
    result = collector.run("check" if args.check else "once")
    say(rt, f"relayhall connector collect {name}: {collector_module.summary(result)}")
    for entry in result.get("registrations") or []:
        detail = entry.get("failureCode") or entry.get("outcome") or entry.get("phase") or ""
        say(rt, f"  {entry.get('registrationId')}: {entry.get('result')} {detail}".rstrip())
    return collector.exit_code(result)


def cmd_status(args, rt):
    names = [validate_name(args.name)] if args.name else installed_names(rt)
    if not names:
        say(rt, "No RelayHall connector is installed for this user.")
        return 0
    for name in names:
        manifest = load_manifest(rt, name)
        if not manifest:
            say(rt, f"connector  {name}: not installed")
            continue
        principal = manifest.get("principal") or {}
        try:
            custody = rt.custody()
            held = ("present" if custody.exists(name) else "missing") + f" ({custody.label})"
        except CustodyError as error:
            held = f"unavailable ({error})"
        say(rt, f"connector  {name}")
        say(rt, f"  harness    {manifest.get('harness')}")
        say(rt, f"  board      {manifest.get('board')}")
        say(rt, f"  principal  {principal.get('id')} ({principal.get('handle')})")
        say(rt, f"  custody    {held}")
        say(rt, f"  mcp entry  {manifest.get('alias')}: {config_state(rt, manifest)}")
        say(rt, f"  skill      {(manifest.get('skill') or {}).get('path') or 'not installed'}")
        if manifest.get("task"):
            say(rt, f"  task       {manifest['task']['name']!r}: {task_state(rt, manifest['task'])}")
        else:
            say(rt, "  task       not registered")
        folder = state_dir(rt, name)
        if (folder / collector_module.COLLECTOR_FILE).is_file():
            last = collector_module._read_json(folder / collector_module.RUNTIME_DIR / "last-attempt.json")
            say(rt, f"  collector  {collector_module.summary(last) + ' at ' + str(last.get('finishedAt')) if last else 'configured, not run yet'}")
        else:
            say(rt, "  collector  not configured")
        say(rt, f"  ring       {ring_status(folder)}")
    return 0


def ring_status(folder):
    """One line from local state: policy, pending and active runs, the last run's outcome. No network."""
    try:
        policy = ring_module.load_policy(folder)
    except ring_module.RingError as error:
        return f"policy invalid ({error.board_code})"
    if policy is None:
        return "not configured"
    state = ring_module.RingState(folder)
    last = state.runs[-1] if state.runs else None
    text = (f"{'enabled' if policy['enabled'] else 'disabled'}; {len(state.active)} run(s) active, "
            f"{len(state.pending)} pending, {len(state.revocations)} revocation(s) to retry")
    if last:
        text += f"; last run {str(last.get('runId'))[:8]} {last.get('code') or 'exited cleanly'}"
    return text


def cmd_uninstall(args, rt):
    name = resolve_name(rt, args.name)
    manifest = load_manifest(rt, name)
    if not manifest:
        raise ConnectorError(f"connector {name!r} is not installed; nothing was changed.")
    rt.custody()  # refuses on a platform without custody
    notes = []
    ok = remove_recorded(rt, manifest, notes)
    for note in notes:
        say(rt, f"  {note}")
    say(rt, f"Uninstalled RelayHall connector {name!r}." if ok else
        f"Connector {name!r} was only partly uninstalled; see above.")
    return 0 if ok else EXIT_FAILED


def cmd_mcp_run(args, rt):
    """A harness run's proxy (slice S5): the run folder's Agent credential, never the connector's token."""
    try:
        record = ring_module.check_run_folder(args.run)
        board = validate_board(record["board"])
        agent_secret = ring_module.load_run_credential(args.run, record["runId"])
    except ring_module.RingError as error:
        raise ConnectorError(f"the run folder cannot serve a proxy ({error.code}).") from None
    proxy = McpProxy(agent_secret, mcp_url_for(board), stdout=rt.stdout_binary(), stderr=rt.stderr,
                     opener=rt.opener_for(board))
    return proxy.serve(rt.stdin_binary())


def cmd_mcp(args, rt):
    if getattr(args, "run", None):
        return cmd_mcp_run(args, rt)
    if not args.name:
        raise ConnectorError("--name is required (or --run, for a harness run's proxy).")
    name = validate_name(args.name)
    manifest = load_manifest(rt, name)
    if not manifest:
        raise ConnectorError(f"connector {name!r} is not installed.")
    token = rt.custody().load(name)
    proxy = McpProxy(token, mcp_url_for(manifest["board"]), stdout=rt.stdout_binary(), stderr=rt.stderr,
                     opener=rt.opener_for(manifest["board"]))
    return proxy.serve(rt.stdin_binary())


def _run_state(rt, name, moment, result):
    _write_text(state_dir(rt, name) / "run-state.json",
                json.dumps({"lastRunAt": _iso(moment), "result": result}, indent=2) + "\n")
    print(f"relayhall connector run {name}: {result}", file=rt.stderr)


def cmd_run(args, rt):
    name = validate_name(args.name)
    manifest = load_manifest(rt, name)
    if not manifest:
        raise ConnectorError(f"connector {name!r} is not installed.")
    moment = rt.now()
    note = ""
    try:
        policy = ring_module.load_policy(state_dir(rt, name))
    except ring_module.RingError as error:
        policy, note = None, f"; ring policy invalid ({error.board_code}), ring not started"
    if policy is not None and policy["enabled"]:
        return run_ring(rt, name, manifest, policy, moment)
    # One bounded cycle. The fifteen-minute outer net the task's execution limit used to give (E463) is kept
    # in-process: past it, the process ends, and the OS releases its locks and ends its owned children.
    watchdog = threading.Timer(ONESHOT_LIMIT_SECONDS, rt.hard_exit, args=(EXIT_ONESHOT_WATCHDOG,))
    watchdog.daemon = True
    watchdog.start()
    try:
        try:
            rt.custody().load(name)
            result, code = "custody ok", 0
        except CustodyError as error:
            result, code = f"custody failed: {error}", EXIT_FAILED
        if code == 0:
            if (state_dir(rt, name) / collector_module.COLLECTOR_FILE).is_file():
                collector = rt.collector(name, manifest)
                outcome = collector.run("once")
                result += "; " + collector_module.summary(outcome)
                # Another cycle already running (a person's `collect --once`) is not this run's failure.
                code = 0 if outcome.get("status") == "busy" else collector.exit_code(outcome)
            else:
                result += "; collector not configured"
        _run_state(rt, name, moment, result + note)
        return code
    finally:
        watchdog.cancel()


def run_ring(rt, name, manifest, policy, moment):
    """The daemon (slice S5): one instance per connector, until it is stopped or fails."""
    try:
        rt.custody().load(name)
    except CustodyError as error:
        _run_state(rt, name, moment, f"custody failed: {error}")
        return EXIT_FAILED
    try:
        with collector_module.exclusive(state_dir(rt, name) / ring_module.STATE_DIR / "ring.lock"):
            _run_state(rt, name, moment, "ring started")
            ring = rt.ring(name, manifest, policy)
            try:
                code = ring.serve()
                _run_state(rt, name, rt.now(), "ring stopped")
                return code
            except ring_module.RingError as error:
                ring.stop()
                _run_state(rt, name, rt.now(), f"ring stopped: {error.code}")
                return EXIT_FAILED
    except collector_module.Refusal as refusal:
        if refusal.code == "ALREADY_RUNNING":
            _run_state(rt, name, moment, "ring already running")
            return collector_module.EXIT_BUSY
        raise


VERBS = {"install": cmd_install, "check": cmd_check, "status": cmd_status,
         "uninstall": cmd_uninstall, "mcp": cmd_mcp, "run": cmd_run, "collect": cmd_collect}


def register(sub):
    parser = sub.add_parser(
        "connector",
        help="Install and run the local RelayHall connector for one harness (token in OS custody)",
    )
    verbs = parser.add_subparsers(dest="connector_command", required=True)
    install = verbs.add_parser("install", help="Store the token in OS custody, write the harness MCP entry, "
                                               "register the per-user task")
    install.add_argument("--harness", required=True, help=", ".join(HARNESSES))
    install.add_argument("--board", required=True, help="The board's origin, e.g. https://board.example")
    install.add_argument("--name", help="Local connector name (default: the connector's board handle)")
    install.add_argument("--alias", default=DEFAULT_ALIAS, help=f"MCP server name in the harness (default {DEFAULT_ALIAS})")
    install.add_argument("--token-stdin", action="store_true",
                         help="Read the token as one line on stdin instead of the hidden prompt")
    for verb, text in (("check", "Verify custody, the board, whoami and the MCP proxy"),
                       ("status", "Show names, ids and states (local only)"),
                       ("uninstall", "Remove exactly what install created")):
        child = verbs.add_parser(verb, help=text)
        child.add_argument("--name", help="Connector name (default: the only one installed)")
    mcp = verbs.add_parser("mcp", help="The stdio MCP proxy a harness starts (not for interactive use)")
    target = mcp.add_mutually_exclusive_group(required=True)
    target.add_argument("--name")
    target.add_argument("--run", help="A harness run's folder: serve that run's Agent credential (the daemon writes it)")
    run_parser = verbs.add_parser("run", help="What the per-user task runs")
    run_parser.add_argument("--name", required=True)
    collect = verbs.add_parser("collect", help="Read the harness's usage quotas (publisher-trusted binary only)")
    collect.add_argument("--name", help="Connector name (default: the only one installed)")
    mode = collect.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="One cycle: read every configured account and post")
    mode.add_argument("--check", action="store_true", help="Trust check and a dry read: post nothing")


def run(args, global_token=None, rt=None):
    rt = Runtime() if rt is None else rt
    verb = args.connector_command
    if global_token:
        print("relayhall connector: refusing --token. The connector reads its token only at install's hidden "
              "prompt and then from OS custody; a token typed on a command line is in your shell history, so treat "
              "it as exposed.", file=rt.stderr)
        return EXIT_FAILED
    try:
        # install validates its arguments first, then refuses the same way. A run's proxy (`mcp --run`) reads
        # only its run folder, never the connector's custody.
        if verb != "install" and not (verb == "mcp" and getattr(args, "run", None)):
            rt.custody()  # macOS and Linux: the Windows-only sentence, before any local state is read
        return VERBS[verb](args, rt)
    except UnsupportedPlatform as error:
        print(f"relayhall connector {verb}: {error}", file=rt.stderr)
        return EXIT_UNSUPPORTED
    except (ConnectorError, CustodyError) as error:
        print(f"relayhall connector {verb}: {error}", file=rt.stderr)
        return EXIT_FAILED
    except KeyboardInterrupt:
        print(f"relayhall connector {verb}: interrupted.", file=rt.stderr)
        return EXIT_FAILED
    except Exception as error:  # never a traceback: it could quote a value
        print(f"relayhall connector {verb}: unexpected {type(error).__name__}.", file=rt.stderr)
        return EXIT_FAILED
