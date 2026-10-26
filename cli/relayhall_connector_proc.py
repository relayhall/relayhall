"""Child processes the connector owns (owner ruling E462 slice S3; E463).

Every provider read and every trust read runs as a child process the connector
OWNS, under three rules:

- a hard deadline on the whole exchange;
- on a timeout, on any failure and on success alike, the child's whole process
  TREE is ended: on Windows the child is put in a Job Object that kills every
  process in it when the connector closes it (plus `taskkill /T /F` as a second
  net), on macOS and Linux the child leads a new session and the session's
  process group is killed;
- nothing ever waits for a pipe's end-of-file without a deadline. Reading runs
  on daemon threads into a bounded queue.

The third rule is the E463 repair. `subprocess.run(timeout=...)` on Windows
calls `communicate()` again after killing the child, with NO timeout, and that
waits for every holder of the child's stdout pipe to exit. A grandchild that
inherited the pipe (the Claude Code process a Node collector started) therefore
held the earlier reporter, and the reporter held its run lock, for as long as
the grandchild lived.
"""
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time

_EOF = object()
_OVERFLOW = object()


class ChildError(Exception):
    """A named failure of an owned child. `args[0]` is the code; never child output."""

    def __init__(self, code, pid=None, exit_code=None):
        super().__init__(code)
        self.code = code
        self.pid = pid
        self.exit_code = exit_code


# ── Windows: a Job Object that kills the tree when it is closed ──────────────

class _WindowsJob:
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BasicLimit(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        self._ctypes = ctypes
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        self._kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self._kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self._kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self._kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self._kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self._kernel32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("CreateJobObjectW failed")
        info = ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = self.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self._kernel32.SetInformationJobObject(self.handle, self.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                                                      ctypes.byref(info), ctypes.sizeof(info)):
            self.close()
            raise OSError("SetInformationJobObject failed")

    def assign(self, process):
        return bool(self._kernel32.AssignProcessToJobObject(self.handle, int(process._handle)))

    def close(self):
        if self.handle:
            self._kernel32.TerminateJobObject(self.handle, 1)
            self._kernel32.CloseHandle(self.handle)
            self.handle = None


def _taskkill():
    root = os.environ.get("SystemRoot") or os.environ.get("SYSTEMROOT") or r"C:\Windows"
    return os.path.join(root, "System32", "taskkill.exe")


class OwnedChild:
    """One owned child with line-oriented stdout. Use as a context manager: exit always ends the tree."""

    def __init__(self, argv, env, cwd=None, max_output=1 << 20, max_line=1 << 20, code_prefix="PROVIDER",
                 popen=None, platform=None, stderr_sink=None):
        """`stderr_sink`, when given, receives every stderr line (each cut to `max_line`) on its own thread; the pipe
        is always drained, so a chatty child never blocks on it. Without a sink, stderr goes nowhere."""
        self.code_prefix = code_prefix
        self.platform = sys.platform if platform is None else platform
        self.max_output = max_output
        self.max_line = max_line
        self.queue = queue.Queue()
        self.job = None
        self.closed = False
        self.stderr_reader = None
        kwargs = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE,
                  "stderr": subprocess.DEVNULL if stderr_sink is None else subprocess.PIPE, "env": env}
        if cwd:
            kwargs["cwd"] = str(cwd)
        if self.platform == "win32":
            kwargs["creationflags"] = (getattr(subprocess, "CREATE_NO_WINDOW", 0)
                                       | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        else:
            kwargs["start_new_session"] = True
        try:
            self.process = (popen or subprocess.Popen)(list(argv), **kwargs)
        except (OSError, ValueError):
            raise ChildError(f"{code_prefix}_START_FAILED") from None
        if self.platform == "win32" and popen is None:
            try:
                self.job = _WindowsJob()
                if not self.job.assign(self.process):
                    self.job.close()
                    self.job = None
            except (OSError, AttributeError, ValueError):
                self.job = None
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        if stderr_sink is not None:
            self.stderr_reader = threading.Thread(target=self._drain_stderr, args=(stderr_sink,), daemon=True)
            self.stderr_reader.start()

    def _drain_stderr(self, sink):
        try:
            while True:
                line = self.process.stderr.readline(self.max_line + 1)
                if not line:
                    return
                try:
                    sink(line[:self.max_line])
                except Exception:  # noqa: BLE001 - a sink's failure never stops the drain
                    pass
        except (OSError, ValueError, AttributeError):
            return

    @property
    def pid(self):
        return getattr(self.process, "pid", None)

    def _read(self):
        total = 0
        try:
            while True:
                line = self.process.stdout.readline(self.max_line + 1)
                if not line:
                    self.queue.put(_EOF)
                    return
                total += len(line)
                if total > self.max_output or len(line) > self.max_line:
                    self.queue.put(_OVERFLOW)
                    return
                self.queue.put(line)
        except (OSError, ValueError):
            self.queue.put(_EOF)

    def send(self, message):
        try:
            self.process.stdin.write((json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8"))
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise ChildError(f"{self.code_prefix}_EXITED", self.pid, self.process.poll()) from None

    def next_line(self, deadline, clock=time.monotonic):
        remaining = deadline - clock()
        if remaining <= 0:
            raise ChildError(f"{self.code_prefix}_TIMEOUT", self.pid)
        try:
            item = self.queue.get(timeout=remaining)
        except queue.Empty:
            raise ChildError(f"{self.code_prefix}_TIMEOUT", self.pid) from None
        if item is _EOF:
            try:
                code = self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                code = None
            raise ChildError(f"{self.code_prefix}_EXITED", self.pid, code)
        if item is _OVERFLOW:
            raise ChildError(f"{self.code_prefix}_OUTPUT_LIMIT", self.pid)
        return item

    def read_all(self, deadline, clock=time.monotonic):
        """Every byte the child writes until it exits, bounded by size and by the deadline."""
        chunks = []
        while True:
            try:
                chunks.append(self.next_line(deadline, clock))
            except ChildError as error:
                if error.code == f"{self.code_prefix}_EXITED":
                    return b"".join(chunks), error.exit_code
                raise

    def close(self, grace=5.0):
        """End the whole tree, reap the child, close our pipe ends. Idempotent.

        Raises OWNED_CHILD_CLEANUP_UNRESOLVED (with the pid) only if the child
        itself is still alive after every step; the caller records it and still
        releases its lock."""
        if self.closed:
            return
        self.closed = True
        for stream in (self.process.stdin,):
            try:
                if stream:
                    stream.close()
            except (OSError, ValueError):
                pass
        kill_tree(self.process, self.job, self.platform)
        if self.job is not None:
            self.job.close()
        try:
            self.process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            try:
                self.process.kill()
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                raise ChildError("OWNED_CHILD_CLEANUP_UNRESOLVED", self.pid) from None
        finally:
            try:
                if self.process.stdout:
                    self.process.stdout.close()
            except (OSError, ValueError):
                pass
            if self.stderr_reader is not None:
                # The tree is gone, so the pipe reaches its end: everything the child wrote is with the sink.
                self.stderr_reader.join(timeout=2)
                try:
                    if self.process.stderr:
                        self.process.stderr.close()
                except (OSError, ValueError):
                    pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def kill_tree(process, job=None, platform=None):
    """End `process` and everything it started. Never raises."""
    platform = sys.platform if platform is None else platform
    pid = getattr(process, "pid", None)
    if platform == "win32":
        if job is not None:
            try:
                job.close()
            except OSError:
                pass
        if pid:
            try:
                subprocess.run([_taskkill(), "/PID", str(pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except (OSError, subprocess.SubprocessError):
                pass
    elif pid:
        # The child leads its own session, so its process group id IS its pid, and the group outlives the
        # child: a grandchild still holding a pipe is reached even after the child itself was reaped.
        try:
            os.killpg(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError, PermissionError):
            pass
    try:
        if process.poll() is None:
            process.kill()
    except OSError:
        pass


def run_bounded(argv, env, timeout, code_prefix, max_output=262144, cwd=None, popen=None, platform=None,
                clock=time.monotonic):
    """Run a non-interactive child to completion within `timeout` seconds: (exit code, stdout bytes).

    A timeout raises `<code_prefix>_TIMEOUT` after the whole tree is ended."""
    deadline = clock() + timeout
    with OwnedChild(argv, env, cwd=cwd, max_output=max_output, max_line=max_output, code_prefix=code_prefix,
                    popen=popen, platform=platform) as child:
        try:
            child.process.stdin.close()
        except (OSError, ValueError):
            pass
        data, code = child.read_all(deadline, clock)
        if code is None:
            remaining = max(0.1, deadline - clock())
            try:
                code = child.process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                raise ChildError(f"{code_prefix}_TIMEOUT", child.pid) from None
        return code, data


def process_alive(pid, platform=None):
    """Is `pid` still running? A failure to tell reads as alive (fail closed)."""
    platform = sys.platform if platform is None else platform
    if not isinstance(pid, int) or pid <= 0:
        return False
    if platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel32.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED
            if not handle:
                return ctypes.get_last_error() == 5  # access denied: something runs under that pid
            try:
                return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: still running
            finally:
                kernel32.CloseHandle(handle)
        except (OSError, AttributeError):
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True
