"""A minimal WebSocket client for the connector's wake socket (universal harness
connector design v1.5 section 6; owner ruling E462, slice S5).

The board's wake ring is `wss://<board>/api/events/ws?wake=2&cursor=<n>`, opened
with the connector's own bearer in the `Authorization` header (never in the
URL). The connector is standard-library Python only (design section 2), so this
module speaks just enough of RFC 6455 for that one socket:

  * the client handshake, with the bearer as a header, and the server's
    `Sec-WebSocket-Accept` checked; any answer but 101 is a refusal by its
    status, and a redirect is never followed (it would carry the bearer to a
    URL the person never named);
  * masked client text frames (`send_text`), serialised by a lock so two
    threads never interleave a frame;
  * server text frames, fragmented or not, up to a bounded size; ping is
    answered with pong; close is answered and ends the socket; a binary or a
    masked server frame closes the socket as a protocol error;
  * one reader thread that puts whole messages on a queue, so `recv(timeout)`
    never blocks past its deadline.

Plain `ws://` is accepted only for a board on this machine's loopback, exactly
as the rest of the connector accepts plain http (relayhall_connector_mcp).

Nothing here writes the bearer anywhere: it appears once, in the handshake
bytes sent on the socket. Error texts name a code, never a header.
"""
import base64
import hashlib
import os
import queue
import socket
import ssl
import struct
import threading
import urllib.parse

from relayhall_connector_mcp import LOOPBACK_HOSTS

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 4 * 1024 * 1024
MAX_HANDSHAKE = 16 * 1024
_CLOSED = object()


class WebSocketError(Exception):
    """A named WebSocket failure. `code` is an upper-case identifier; the text never carries a header value."""

    def __init__(self, code, status=None):
        super().__init__(code)
        self.code = code
        self.status = status


def socket_url(board, path):
    """The ws(s) URL for `path` under the board's origin, refusing plain ws off loopback."""
    parsed = urllib.parse.urlsplit(board)
    if parsed.scheme == "https":
        scheme = "wss"
    elif parsed.scheme == "http" and (parsed.hostname or "") in LOOPBACK_HOSTS:
        scheme = "ws"
    else:
        raise WebSocketError("WS_BOARD_NOT_HTTPS")
    return f"{scheme}://{parsed.netloc}{path}"


class WebSocket:
    """One client connection. Use `connect`, then `recv`/`send_text`, then `close`."""

    def __init__(self, sock):
        self._sock = sock
        self._send_lock = threading.Lock()
        self._messages = queue.Queue()
        self.closed = False
        self.close_code = None
        self.close_reason = ""
        self._pending = b""
        self._reader =threading.Thread(target=self._read_loop, daemon=True)

    # ── the handshake ─────────────────────────────────────────────────────
    @classmethod
    def connect(cls, url, headers=None, timeout=30.0, ssl_context=None, connector=None):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("ws", "wss") or not parsed.hostname:
            raise WebSocketError("WS_URL")
        if parsed.scheme == "ws" and parsed.hostname not in LOOPBACK_HOSTS:
            raise WebSocketError("WS_BOARD_NOT_HTTPS")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        try:
            raw = (connector or socket.create_connection)((parsed.hostname, port), timeout)
        except (OSError, ValueError):
            raise WebSocketError("WS_UNREACHABLE") from None
        try:
            if parsed.scheme == "wss":
                context = ssl_context or ssl.create_default_context()
                raw = context.wrap_socket(raw, server_hostname=parsed.hostname)
            raw.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            lines = [f"GET {target} HTTP/1.1", f"Host: {parsed.netloc}", "Upgrade: websocket",
                     "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
            for name, value in (headers or {}).items():
                if "\r" in name or "\n" in name or "\r" in value or "\n" in value:
                    raise WebSocketError("WS_HEADER")
                lines.append(f"{name}: {value}")
            raw.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            response = b""
            while b"\r\n\r\n" not in response:
                chunk = raw.recv(4096)
                if not chunk:
                    raise WebSocketError("WS_HANDSHAKE_CLOSED")
                response += chunk
                if len(response) > MAX_HANDSHAKE:
                    raise WebSocketError("WS_HANDSHAKE_SIZE")
            head, _, rest = response.partition(b"\r\n\r\n")
            status_line, *header_lines = head.decode("latin-1").split("\r\n")
            parts = status_line.split(" ", 2)
            status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
            if status != 101:
                raise WebSocketError("WS_HANDSHAKE_REFUSED", status)
            answered = {}
            for line in header_lines:
                name, _, value = line.partition(":")
                answered[name.strip().lower()] = value.strip()
            expected = base64.b64encode(hashlib.sha1((key + GUID).encode("ascii")).digest()).decode("ascii")
            if answered.get("sec-websocket-accept") != expected or answered.get("upgrade", "").lower() != "websocket":
                raise WebSocketError("WS_HANDSHAKE_INVALID", status)
            raw.settimeout(None)
        except WebSocketError:
            _quiet_close(raw)
            raise
        except (OSError, ValueError, ssl.SSLError):
            _quiet_close(raw)
            raise WebSocketError("WS_HANDSHAKE_FAILED") from None
        connection = cls(raw)
        connection._pending = rest
        connection._reader.start()
        return connection

    # ── frames ────────────────────────────────────────────────────────────
    def _read_exact(self, count):
        data = b""
        if self._pending:
            data, self._pending = self._pending[:count], self._pending[count:]
        while len(data) < count:
            chunk = self._sock.recv(min(65536, count - len(data)))
            if not chunk:
                raise ConnectionError("closed")
            data += chunk
        return data

    def _read_frame(self):
        first, second = self._read_exact(2)
        fin, opcode = bool(first & 0x80), first & 0x0F
        if first & 0x70:
            raise WebSocketError("WS_PROTOCOL")
        if second & 0x80:
            raise WebSocketError("WS_MASKED_SERVER_FRAME")
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        if length > MAX_MESSAGE:
            raise WebSocketError("WS_MESSAGE_SIZE")
        return fin, opcode, self._read_exact(length) if length else b""

    def _read_loop(self):
        parts, total = [], 0
        try:
            while True:
                fin, opcode, payload = self._read_frame()
                if opcode == 0x8:
                    code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                    self.close_code = code
                    self.close_reason = payload[2:125].decode("utf-8", errors="replace")
                    self._send_frame(0x8, payload[:2])
                    break
                if opcode == 0x9:
                    self._send_frame(0xA, payload[:125])
                    continue
                if opcode == 0xA:
                    continue
                if opcode == 0x2 or opcode not in (0x0, 0x1) or (opcode == 0x0 and not parts) \
                        or (opcode == 0x1 and parts):
                    raise WebSocketError("WS_PROTOCOL")
                parts.append(payload)
                total += len(payload)
                if total > MAX_MESSAGE:
                    raise WebSocketError("WS_MESSAGE_SIZE")
                if fin:
                    try:
                        self._messages.put(b"".join(parts).decode("utf-8"))
                    except UnicodeDecodeError:
                        raise WebSocketError("WS_PROTOCOL") from None
                    parts, total = [], 0
        except WebSocketError as error:
            self.close_code = self.close_code or 1002
            self.close_reason = error.code
            try:
                self._send_frame(0x8, struct.pack("!H", 1002))
            except (OSError, WebSocketError):
                pass
        except (OSError, ValueError, ConnectionError, ssl.SSLError):
            self.close_code = self.close_code or 1006
        finally:
            self.closed = True
            _quiet_close(self._sock)
            self._messages.put(_CLOSED)

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        with self._send_lock:
            self._sock.sendall(header + mask + masked)

    # ── the API ───────────────────────────────────────────────────────────
    def send_text(self, text):
        """Send one text message. Raises WS_CLOSED once the socket is gone."""
        if self.closed:
            raise WebSocketError("WS_CLOSED")
        data = text.encode("utf-8")
        if len(data) > MAX_MESSAGE:
            raise WebSocketError("WS_MESSAGE_SIZE")
        try:
            self._send_frame(0x1, data)
        except (OSError, ssl.SSLError):
            self.closed = True
            raise WebSocketError("WS_CLOSED") from None

    def recv(self, timeout):
        """The next text message, None on timeout; raises WS_CLOSED when the socket has ended."""
        try:
            item = self._messages.get(timeout=max(0.0, timeout))
        except queue.Empty:
            return None
        if item is _CLOSED:
            self._messages.put(_CLOSED)  # every later recv sees the end too
            raise WebSocketError("WS_CLOSED")
        return item

    def close(self, code=1000):
        if not self.closed:
            try:
                self._send_frame(0x8, struct.pack("!H", code))
            except (OSError, ssl.SSLError, WebSocketError):
                pass
        self.closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        _quiet_close(self._sock)


def _quiet_close(sock):
    try:
        sock.close()
    except OSError:
        pass
