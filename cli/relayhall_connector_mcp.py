"""`relayhall connector mcp --name <connector>`: the stdio MCP proxy (universal
harness connector design v1.5 section 3.3; owner ruling E462, slice S2).

The harness launches this as an ordinary stdio MCP server. It reads the
connector's token from custody once, at start, and then forwards every JSON-RPC
message the harness writes on stdin to the board's Streamable HTTP endpoint,
`<board>/api/mcp`, as a POST carrying `Authorization: Bearer <token>`. Each
reply is written back to stdout as one line. It adds and drops nothing in the
messages themselves.

What it adds on the wire, and only on the wire:
  * the `Authorization` header (the token's ONLY appearance anywhere);
  * `Accept: application/json, text/event-stream`, which the transport requires;
  * after `initialize`, the negotiated `MCP-Protocol-Version` header, and an
    `Mcp-Session-Id` if the board ever returns one (today's board is stateless
    and returns none). An stdio client has no headers of its own to send, so
    the proxy carries what the HTTP transport asks a client to carry.

What it never does:
  * write the token to disk, stdout or stderr. Diagnostics on stderr are fixed
    sentences; anything taken from a failure passes through `scrub` first;
  * follow an HTTP redirect. A redirect would carry the bearer to a host the
    person never named, so a 3xx is answered as an error instead;
  * leave a request unanswered: if the board cannot be reached, answers with
    something that is not JSON-RPC, or its answer is cut off or malformed on
    the wire, a request that has an id gets a JSON-RPC error reply so the
    harness does not wait forever. Notifications get none;
  * hand a board on this machine's loopback to an HTTP proxy from the
    environment: plain http is accepted only for loopback, and a proxy would
    carry the bearer off the machine in clear text.

Requests are forwarded concurrently (one thread each), because a harness may
have a long `tools/call` in flight while it asks for something else. stdout
writes are serialised so replies never interleave.
"""
import http.client
import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

PROXY_ERROR = -32000
PARSE_ERROR = -32700
REQUEST_TIMEOUT_SECONDS = 600
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
# What a board exchange can raise short of an HTTP status: no route, a refused
# or reset connection, a timeout. A reply cut off or malformed on the wire
# raises http.client.HTTPException (IncompleteRead, BadStatusLine, ...), which
# is neither, so every caller names it as well.
TRANSPORT_ERRORS = (urllib.error.URLError, OSError, ValueError)


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """A 3xx is never followed: the bearer must not travel to another URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def is_loopback(url):
    return (urllib.parse.urlsplit(url or "").hostname or "") in LOOPBACK_HOSTS


def board_opener(url=None):
    """The urllib opener the connector uses for the board at `url`: no redirects,
    and for a board on this machine's loopback no proxy from the environment."""
    handlers = [_RefuseRedirects()]
    if is_loopback(url):
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


def scrub(text, token):
    """`text` with the token (and its secret half) cut out, whatever produced it."""
    text = str(text)
    if token:
        text = text.replace(token, "[redacted]")
        secret = token.split(".", 1)[-1]
        if len(secret) >= 8:
            text = text.replace(secret, "[redacted]")
    return text


def _error_reply(message_id, text):
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": PROXY_ERROR, "message": text}}


def _ids_of(message):
    """The ids a request (or a batch) expects answers for; notifications have none."""
    items = message if isinstance(message, list) else [message]
    return [item["id"] for item in items
            if isinstance(item, dict) and "method" in item and item.get("id") is not None]


def _is_jsonrpc(value):
    items = value if isinstance(value, list) else [value]
    return bool(items) and all(isinstance(item, dict) and item.get("jsonrpc") == "2.0" for item in items)


def _sse_messages(body):
    """JSON-RPC messages out of a `text/event-stream` body (one per event)."""
    messages, data = [], []
    for raw in body.splitlines() + [""]:
        line = raw.rstrip("\r")
        if line == "":
            if data:
                try:
                    messages.append(json.loads("\n".join(data)))
                except ValueError:
                    pass
                data = []
        elif line.startswith("data:"):
            data.append(line[5:][1:] if line[5:].startswith(" ") else line[5:])
    return messages


class McpProxy:
    def __init__(self, token, mcp_url, stdout=None, stderr=None, opener=None,
                 timeout=REQUEST_TIMEOUT_SECONDS):
        self._token = token
        self.mcp_url = mcp_url
        self.stdout = sys.stdout.buffer if stdout is None else stdout
        self.stderr = sys.stderr if stderr is None else stderr
        self.opener = board_opener(mcp_url) if opener is None else opener
        self.timeout = timeout
        self.protocol_version = None
        self.session_id = None
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._threads = []

    # ── output ────────────────────────────────────────────────────────────
    def _emit(self, message):
        line = (json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        with self._write_lock:
            self.stdout.write(line)
            self.stdout.flush()

    def _note(self, text):
        print(f"relayhall connector mcp: {scrub(text, self._token)}", file=self.stderr, flush=True)

    # ── one exchange ──────────────────────────────────────────────────────
    def _headers(self):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self._token}",
        }
        with self._state_lock:
            if self.protocol_version:
                headers["MCP-Protocol-Version"] = self.protocol_version
            if self.session_id:
                headers["Mcp-Session-Id"] = self.session_id
        return headers

    def _remember(self, message, replies, response_headers):
        session = response_headers.get("Mcp-Session-Id") if response_headers else None
        with self._state_lock:
            if session:
                self.session_id = session
            if isinstance(message, dict) and message.get("method") == "initialize":
                for reply in replies:
                    result = reply.get("result") if isinstance(reply, dict) else None
                    version = result.get("protocolVersion") if isinstance(result, dict) else None
                    if isinstance(version, str) and version:
                        self.protocol_version = version

    def forward(self, raw, message):
        """POST one stdin message; write whatever JSON-RPC comes back."""
        ids = _ids_of(message)
        request = urllib.request.Request(self.mcp_url, data=raw, method="POST")
        for key, value in self._headers().items():
            request.add_header(key, value)
        status, content_type, body, response_headers = None, "", b"", None
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                status = response.status
                content_type = response.headers.get("Content-Type", "")
                response_headers = response.headers
                body = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            content_type = error.headers.get("Content-Type", "") if error.headers else ""
            response_headers = error.headers
            try:
                body = error.read()
            except OSError:
                body = b""
        except http.client.HTTPException as error:
            # The answer was cut off or malformed on the wire. Its text can quote
            # what was read, so only the class name is noted.
            self._note(f"the board's answer could not be read ({type(error).__name__})")
            for message_id in ids:
                self._emit(_error_reply(message_id, "The RelayHall board's answer was cut off or malformed."))
            return
        except TRANSPORT_ERRORS as error:
            reason = getattr(error, "reason", error)
            self._note(f"could not reach the board: {reason}")
            for message_id in ids:
                self._emit(_error_reply(message_id, "The RelayHall board could not be reached."))
            return

        text = body.decode("utf-8", errors="replace")
        replies = []
        if "text/event-stream" in content_type:
            replies = _sse_messages(text)
        elif text.strip():
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = None
            if parsed is not None and _is_jsonrpc(parsed):
                replies = parsed if isinstance(parsed, list) else [parsed]
            elif parsed is not None and isinstance(parsed, dict):
                detail = parsed.get("message") or parsed.get("error") or ""
                self._note(f"the board answered HTTP {status}: {str(detail)[:200]}")
        self._remember(message, replies, response_headers)

        if replies:
            for reply in replies:
                self._emit(reply)
            return
        if status is not None and 200 <= status < 300 and not ids:
            return  # a notification, accepted (202) with no body
        if status is not None and 300 <= status < 400:
            self._note(f"the board answered with a redirect (HTTP {status}); redirects are never followed")
        for message_id in ids:
            self._emit(_error_reply(message_id, f"The RelayHall board answered HTTP {status} without a JSON-RPC reply."))

    # ── the loop ──────────────────────────────────────────────────────────
    def handle_line(self, raw):
        stripped = raw.strip()
        if not stripped:
            return
        try:
            message = json.loads(stripped.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._emit({"jsonrpc": "2.0", "id": None,
                        "error": {"code": PARSE_ERROR, "message": "Parse error: a line on stdin was not JSON."}})
            return
        worker = threading.Thread(target=self.forward, args=(stripped, message), daemon=True)
        self._threads.append(worker)
        worker.start()

    def serve(self, stdin=None, drain_seconds=30):
        stdin = sys.stdin.buffer if stdin is None else stdin
        for raw in iter(stdin.readline, b""):
            self.handle_line(raw)
            self._threads = [thread for thread in self._threads if thread.is_alive()]
        for thread in self._threads:
            thread.join(timeout=drain_seconds)
        return 0


def mcp_url_for(board):
    return board.rstrip("/") + "/api/mcp"
