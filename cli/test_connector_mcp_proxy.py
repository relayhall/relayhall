"""The connector's stdio MCP proxy against a stub board (E462 slice S2; design
v1.5 section 3.3).

Pins, each across a real socket to a real HTTP server:
 - initialize, tools/list and tools/call round-trip, and every reply goes back
   to stdout as one line with the request's id;
 - the bearer travels ONLY in the Authorization header: never in the path,
   the query or a body, and never on stdout or stderr;
 - after initialize the negotiated MCP-Protocol-Version header is carried;
 - a notification is forwarded and gets no reply (202);
 - an SSE-framed answer is unwrapped into its JSON-RPC messages;
 - an unreachable board, a 401 and a redirect each give the waiting request a
   JSON-RPC error instead of silence, and a redirect is never followed (the
   bearer never reaches the second host);
 - a line that is not JSON gets a parse error, not a crash;
 - the same exchange through real OS pipes in a separate process, and through
   the CLI verb `relayhall connector mcp --name` with custody and the local
   record behind it.
"""
import io
import json
import os
import subprocess
import sys
import threading
import textwrap
from pathlib import Path

import pytest

import relayhall_connector as connector
from connector_testkit import TOKEN, StubBoard, make_runtime, run_verb
from relayhall_connector_mcp import McpProxy, mcp_url_for

INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}
LIST = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
CALL = {"jsonrpc": "2.0", "id": "c-3", "method": "tools/call",
        "params": {"name": "relayhall_principal_whoami", "arguments": {}}}


def lines(*messages):
    return b"".join(json.dumps(m).encode() + b"\n" for m in messages)


def drive(url, *messages, token=TOKEN, sequential=True):
    """Run the proxy over the given stdin messages; return (replies, stderr)."""
    out, err = io.BytesIO(), io.StringIO()
    proxy = McpProxy(token, url, stdout=out, stderr=err, timeout=10)
    if sequential:
        # One at a time, as a client that waits for initialize does.
        for message in messages:
            proxy.handle_line(json.dumps(message).encode())
            for thread in proxy._threads:
                thread.join(timeout=10)
    else:
        proxy.serve(io.BytesIO(lines(*messages)))
    raw = out.getvalue().decode("utf-8")
    replies = [json.loads(line) for line in raw.splitlines() if line.strip()]
    return replies, err.getvalue(), raw


def header(request, name):
    """A request header by name, case-insensitively (urllib capitalises names)."""
    return next((v for k, v in request["headers"].items() if k.lower() == name.lower()), None)


def assert_bearer_only_in_header(board):
    for request in board.requests:
        assert TOKEN not in request["path"]
        assert TOKEN.encode() not in request["body"]
        for key, value in request["headers"].items():
            if key.lower() != "authorization":
                assert TOKEN not in value, key


def test_round_trip_initialize_list_call():
    with StubBoard() as board:
        replies, err, raw = drive(mcp_url_for(board.origin), INIT, INITIALIZED, LIST, CALL)
    by_id = {r["id"]: r for r in replies}
    assert set(by_id) == {1, 2, "c-3"}
    assert by_id[1]["result"]["protocolVersion"] == "2025-06-18"
    assert by_id[2]["result"]["tools"][0]["name"] == "relayhall_principal_whoami"
    assert "relayhall_principal_whoami" in by_id["c-3"]["result"]["content"][0]["text"]
    # Four POSTs, the bodies forwarded byte for byte.
    posts = board.mcp_requests()
    assert [json.loads(p["body"]) for p in posts] == [INIT, INITIALIZED, LIST, CALL]
    for post in posts:
        assert header(post, "Authorization") == f"Bearer {TOKEN}"
        assert "text/event-stream" in header(post, "Accept")
    assert header(posts[0], "MCP-Protocol-Version") is None
    assert all(header(p, "MCP-Protocol-Version") == "2025-06-18" for p in posts[1:])
    assert_bearer_only_in_header(board)
    assert TOKEN not in raw and TOKEN not in err
    assert raw.count("\n") == 3  # one line per reply; the notification got none


def test_concurrent_requests_all_answered_on_separate_lines():
    with StubBoard() as board:
        many = [dict(LIST, id=n) for n in range(10, 20)]
        replies, _err, raw = drive(mcp_url_for(board.origin), INIT, *many, sequential=False)
    assert sorted(r["id"] for r in replies) == [1] + list(range(10, 20))
    assert all(line.startswith("{") and line.endswith("}") for line in raw.splitlines())


def test_sse_answer_is_unwrapped():
    with StubBoard(sse=True) as board:
        replies, _err, _raw = drive(mcp_url_for(board.origin), INIT, LIST)
    assert [r["id"] for r in replies] == [1, 2]


def test_wrong_token_gives_an_error_reply_and_never_echoes():
    with StubBoard(token="rh_live_ab12cd34ef56.SomeOtherSecret0000000000000") as board:
        replies, err, raw = drive(mcp_url_for(board.origin), INIT)
    assert replies[0]["id"] == 1 and replies[0]["error"]["code"] == -32000
    assert "401" in replies[0]["error"]["message"]
    assert TOKEN not in raw and TOKEN not in err


def test_unreachable_board_answers_the_waiting_request():
    replies, err, raw = drive("http://127.0.0.1:9/api/mcp", INIT, INITIALIZED)
    assert len(replies) == 1 and replies[0]["id"] == 1
    assert "could not be reached" in replies[0]["error"]["message"]
    assert TOKEN not in raw and TOKEN not in err


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_a_redirect_is_never_followed_and_the_bearer_never_reaches_the_second_host(status):
    # urllib's default handler WOULD follow 301/302/303 for a POST (as a GET,
    # with the Authorization header); the proxy's opener must refuse every one.
    with StubBoard() as elsewhere:
        with StubBoard(redirect_to=mcp_url_for(elsewhere.origin), redirect_status=status) as board:
            replies, err, _raw = drive(mcp_url_for(board.origin), INIT)
        assert elsewhere.requests == []
    assert replies[0]["id"] == 1 and str(status) in replies[0]["error"]["message"]
    assert "redirect" in err


class _BrokenBoard:
    """A real socket server that answers every request with a broken HTTP reply."""

    def __init__(self, reply):
        import socket
        self.reply = reply
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                conn.settimeout(5)
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                head, _, rest = data.partition(b"\r\n\r\n")
                length = next((int(line.split(b":", 1)[1]) for line in head.split(b"\r\n")
                               if line.lower().startswith(b"content-length:")), 0)
                while len(rest) < length:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    rest += chunk
                conn.sendall(self.reply)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}/api/mcp"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.sock.close()


@pytest.mark.parametrize("reply", [
    # IncompleteRead: the body stops short of its Content-Length.
    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 400\r\nConnection: close\r\n\r\n"
    b'{"jsonrpc":"2.0","id":1,"res',
    # BadStatusLine: not an HTTP reply at all.
    b"SSH-2.0-not-a-web-server\r\n\r\n",
], ids=["incomplete-read", "bad-status-line"])
def test_a_reply_cut_off_or_malformed_on_the_wire_answers_the_waiting_request(reply):
    """S2 review: http.client's own exceptions are neither URLError nor OSError; before the repair the request
    went unanswered and a thread traceback reached stderr."""
    uncaught = []
    saved = threading.excepthook
    threading.excepthook = lambda args: uncaught.append(type(args.exc_value).__name__)
    try:
        with _BrokenBoard(reply) as broken:
            replies, err, raw = drive(broken.url, INIT)
    finally:
        threading.excepthook = saved
    assert uncaught == []
    assert replies == [{"jsonrpc": "2.0", "id": 1,
                        "error": {"code": -32000, "message": "The RelayHall board's answer was cut off or malformed."}}]
    assert "Traceback" not in err and "could not be read" in err
    assert TOKEN not in raw and TOKEN not in err


@pytest.fixture
def environment_proxy(monkeypatch):
    """An HTTP proxy named by the environment, as a corporate machine may have."""
    with StubBoard() as proxy:
        for key in ("no_proxy", "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "https_proxy", "all_proxy", "ALL_PROXY"):
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv("http_proxy", proxy.origin)
        yield proxy


def test_a_loopback_board_is_never_reached_through_an_environment_proxy(environment_proxy):
    """Plain http is accepted for loopback only; a proxy would carry the bearer off the machine in clear text."""
    with StubBoard() as board:
        replies, _err, _raw = drive(mcp_url_for(board.origin), INIT)
    assert replies[0]["id"] == 1 and "result" in replies[0]
    assert len(board.mcp_requests()) == 1
    assert environment_proxy.requests == []


def test_the_connector_rest_calls_bypass_an_environment_proxy_for_loopback(environment_proxy, tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert run_verb(rt, ["install", "--harness", "vscode", "--board", board.origin]) == 0
    assert environment_proxy.requests == []


def test_an_https_board_keeps_the_environment_proxy(environment_proxy):
    """Only loopback opts out: a board elsewhere is reached the way the machine reaches the internet."""
    import urllib.request
    from relayhall_connector_mcp import board_opener

    def proxies(url):
        return [h.proxies for h in board_opener(url).handlers if isinstance(h, urllib.request.ProxyHandler)]
    assert proxies("http://127.0.0.1:3001/api/mcp") == [] and proxies("http://localhost:8082/api/mcp") == []
    assert proxies("https://board.example/api/mcp") == [{"http": environment_proxy.origin}]


def test_a_line_that_is_not_json_gets_a_parse_error():
    out = io.BytesIO()
    proxy = McpProxy(TOKEN, "http://127.0.0.1:9/api/mcp", stdout=out, stderr=io.StringIO())
    proxy.handle_line(b"{not json")
    reply = json.loads(out.getvalue())
    assert reply == {"jsonrpc": "2.0", "id": None,
                     "error": {"code": -32700, "message": "Parse error: a line on stdin was not JSON."}}


def test_scrub_removes_the_token_and_its_secret_half():
    from relayhall_connector_mcp import scrub
    secret = TOKEN.split(".", 1)[1]
    assert scrub(f"x {TOKEN} y {secret} z", TOKEN) == "x [redacted] y [redacted] z"


PROGRAM = textwrap.dedent("""
    import sys
    sys.path.insert(0, sys.argv[1])
    from relayhall_connector_mcp import McpProxy
    token = sys.stdin.buffer.readline().decode().strip()
    sys.exit(McpProxy(token, sys.argv[2], timeout=10).serve())
""")


def test_real_process_over_real_pipes():
    """The proxy as its own process: the bearer enters on a pipe, never argv or env."""
    with StubBoard() as board:
        argv = [sys.executable, "-c", PROGRAM, str(Path(__file__).parent), mcp_url_for(board.origin)]
        env = {k: v for k, v in os.environ.items() if k != "RELAYHALL_TOKEN"}
        stdin = TOKEN.encode() + b"\n" + lines(INIT)
        first = subprocess.run(argv, input=stdin, capture_output=True, timeout=60, env=env)
        stdin = TOKEN.encode() + b"\n" + lines(INIT, INITIALIZED, CALL)
        result = subprocess.run(argv, input=stdin, capture_output=True, timeout=60, env=env)
    assert first.returncode == 0 and result.returncode == 0, result.stderr
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    assert {r["id"] for r in replies} == {1, "c-3"}
    assert TOKEN.encode() not in result.stdout + result.stderr
    assert all(TOKEN not in part for part in argv) and TOKEN not in json.dumps(env)
    assert_bearer_only_in_header(board)


def test_the_cli_verb_reads_custody_and_serves_stdio(tmp_path):
    with StubBoard() as board:
        rt = make_runtime(tmp_path)
        assert run_verb(rt, ["install", "--harness", "vscode", "--board", board.origin]) == 0
        name = connector.installed_names(rt)[0]
        out = io.BytesIO()
        rt.stdout = io.TextIOWrapper(out, encoding="utf-8", write_through=True)
        rt.stdin = io.TextIOWrapper(io.BytesIO(lines(INIT, INITIALIZED, LIST)), encoding="utf-8")
        before = len(board.mcp_requests())
        assert run_verb(rt, ["mcp", "--name", name]) == 0
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        assert sorted(r["id"] for r in replies) == [1, 2]
        assert len(board.mcp_requests()) - before == 3
        assert TOKEN.encode() not in out.getvalue()
        assert_bearer_only_in_header(board)


def test_the_cli_verb_refuses_an_uninstalled_name(tmp_path):
    rt = make_runtime(tmp_path)
    assert run_verb(rt, ["mcp", "--name", "nobody"]) == 1
    assert "not installed" in rt.stderr.getvalue()
