"""Where a RelayHall connector keeps its one token (universal harness connector
design v1.5 section 3.2; owner ruling E462, slice S2).

The token a harness connector holds enters ONCE, at `relayhall connector
install`, and from then on lives only in the operating system's per-user
keystore and in the memory of the process that is using it. It is never written
to a file a harness reads, never put on a command line or in an environment,
and never printed or logged.

WINDOWS (this version). The token is encrypted with DPAPI in the CurrentUser
scope: `CryptProtectData` from crypt32.dll, called through ctypes, with
`CRYPTPROTECT_UI_FORBIDDEN` and WITHOUT `CRYPTPROTECT_LOCAL_MACHINE`, so only
the same Windows user on the same machine can decrypt it. The optional entropy
binds the blob to the connector's name, so a blob copied under another
connector's name does not decrypt. The encrypted blob is written to

    %LOCALAPPDATA%\\RelayHall\\connector\\<name>\\token.dpapi

which is the store the design names. DPAPI CurrentUser is NOT a boundary
against another process of the same user: such a process can ask DPAPI to
decrypt the blob just as the connector does (design section 8, gap 7).

macOS (login Keychain) and Linux (Secret Service) come in a later release. On
those platforms `custody_for_platform` refuses with a sentence that says so,
and the installer stops before it asks for the token.

`MemoryCustodyForTests` is the in-memory backend the CLI suite uses. Nothing
selects it except a test passing it in by hand: there is no flag, environment
variable or configuration key that turns it on.
"""
import os
import re
import sys
from pathlib import Path

# The credential grammar the board mints, `rh_<env>_<keyId>.<secret>`, with the
# environment segment left open so a new prefix still validates. The same shape
# `relayhall_connection_skill.TOKEN_SHAPE` refuses in a rendered file.
TOKEN_SHAPE = re.compile(r"rh_[a-z]+_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}")
NAME_SHAPE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
BLOB_FILE = "token.dpapi"
ENTROPY_PREFIX = b"RelayHall connector token v1\x00"
CRYPTPROTECT_UI_FORBIDDEN = 0x01

UNSUPPORTED_PLATFORM = (
    "the connector keeps its token in the operating system's own keystore, and this version "
    "supports Windows only (DPAPI, per user). macOS Keychain and Linux Secret Service support "
    "come in a later release; until then set this client up by hand from the dashboard's "
    "manual blocks. Nothing was installed."
)


class CustodyError(Exception):
    """A custody failure. Its text never carries the token."""


class UnsupportedPlatform(CustodyError):
    """This operating system has no custody backend in this version."""


def validate_token(value):
    """The token, stripped, if it has the board's credential shape.

    The refusal names the expected SHAPE and nothing of what was entered, so a
    mistyped secret never reaches a terminal or a log through an error.
    """
    candidate = (value or "").strip()
    if not TOKEN_SHAPE.fullmatch(candidate):
        raise CustodyError(
            "that is not a RelayHall credential (expected rh_<env>_<keyId>.<secret>, as the "
            "dashboard showed it once). Nothing was stored.")
    return candidate


def validate_name(name):
    if not isinstance(name, str) or not NAME_SHAPE.fullmatch(name):
        raise CustodyError(
            "a connector name is 1-63 lowercase letters, digits or '-', starting with a letter or "
            "digit.")
    return name


def default_root(environ=None):
    """`%LOCALAPPDATA%\\RelayHall\\connector`, the per-user folder of every connector."""
    environ = os.environ if environ is None else environ
    base = environ.get("LOCALAPPDATA")
    if not base:
        raise CustodyError("LOCALAPPDATA is not set, so there is no per-user folder for the connector. "
                           "Nothing was stored.")
    return Path(base) / "RelayHall" / "connector"


def entropy_for(name):
    return ENTROPY_PREFIX + validate_name(name).encode("ascii")


class WindowsDpapiCustody:
    """DPAPI CurrentUser, through ctypes. Windows only."""

    kind = "windows-dpapi-currentuser"
    label = "Windows DPAPI (CurrentUser)"

    def __init__(self, root):
        self.root = Path(root)

    # ── the two DPAPI calls ────────────────────────────────────────────────
    @staticmethod
    def _api():
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(DATA_BLOB), wintypes.LPCWSTR, ctypes.POINTER(DATA_BLOB),
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB)]
        crypt32.CryptProtectData.restype = wintypes.BOOL
        crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(DATA_BLOB), ctypes.c_void_p, ctypes.POINTER(DATA_BLOB),
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB)]
        crypt32.CryptUnprotectData.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        return ctypes, DATA_BLOB, crypt32, kernel32

    @classmethod
    def protect(cls, plaintext, entropy, description):
        ctypes, DATA_BLOB, crypt32, kernel32 = cls._api()
        source = ctypes.create_string_buffer(plaintext, len(plaintext))
        extra = ctypes.create_string_buffer(entropy, len(entropy))
        blob_in = DATA_BLOB(len(plaintext), ctypes.cast(source, ctypes.POINTER(ctypes.c_char)))
        blob_entropy = DATA_BLOB(len(entropy), ctypes.cast(extra, ctypes.POINTER(ctypes.c_char)))
        blob_out = DATA_BLOB()
        try:
            if not crypt32.CryptProtectData(ctypes.byref(blob_in), description, ctypes.byref(blob_entropy),
                                            None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out)):
                raise CustodyError(f"Windows refused to protect the token (error {ctypes.get_last_error()}). "
                                   "Nothing was stored.")
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            ctypes.memset(source, 0, len(plaintext))
            if blob_out.pbData:
                kernel32.LocalFree(blob_out.pbData)

    @classmethod
    def unprotect(cls, blob, entropy):
        ctypes, DATA_BLOB, crypt32, kernel32 = cls._api()
        source = ctypes.create_string_buffer(blob, len(blob))
        extra = ctypes.create_string_buffer(entropy, len(entropy))
        blob_in = DATA_BLOB(len(blob), ctypes.cast(source, ctypes.POINTER(ctypes.c_char)))
        blob_entropy = DATA_BLOB(len(entropy), ctypes.cast(extra, ctypes.POINTER(ctypes.c_char)))
        blob_out = DATA_BLOB()
        if not crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, ctypes.byref(blob_entropy),
                                          None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out)):
            raise CustodyError(
                f"Windows could not decrypt the stored token (error {ctypes.get_last_error()}): it was stored "
                "by another Windows user, on another machine, or under another connector name. "
                "Re-run `relayhall connector install`.")
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            if blob_out.pbData:
                ctypes.memset(blob_out.pbData, 0, blob_out.cbData)
                kernel32.LocalFree(blob_out.pbData)

    # ── the store ──────────────────────────────────────────────────────────
    def path(self, name):
        return self.root / validate_name(name) / BLOB_FILE

    def describe(self, name):
        return f"{self.label} blob at {self.path(name)}"

    def exists(self, name):
        return self.path(name).is_file()

    def store(self, name, token):
        token = validate_token(token)
        target = self.path(name)
        if target.is_symlink():
            raise CustodyError(f"{target} is a symbolic link; refusing to write through it. Nothing was stored.")
        blob = self.protect(token.encode("ascii"), entropy_for(name), f"RelayHall connector {name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        with open(temporary, "wb") as handle:
            handle.write(blob)
        os.replace(temporary, target)
        return target

    def load(self, name):
        target = self.path(name)
        try:
            blob = target.read_bytes()
        except FileNotFoundError:
            raise CustodyError(f"no token is stored for connector {name!r} ({target} is missing). "
                               "Run `relayhall connector install`.") from None
        plaintext = self.unprotect(blob, entropy_for(name))
        try:
            return validate_token(plaintext.decode("ascii"))
        except (UnicodeDecodeError, CustodyError):
            raise CustodyError(f"the stored token for connector {name!r} is damaged. "
                               "Re-run `relayhall connector install`.") from None

    def delete(self, name):
        target = self.path(name)
        try:
            target.unlink()
            return True
        except FileNotFoundError:
            return False


class MemoryCustodyForTests:
    """In-memory custody for the CLI suite ONLY. Selected by nothing but a test."""

    kind = "memory-test-only"
    label = "in-memory test custody"

    def __init__(self):
        self._tokens = {}

    def path(self, name):
        return None

    def describe(self, name):
        return f"{self.label} entry {validate_name(name)}"

    def exists(self, name):
        return validate_name(name) in self._tokens

    def store(self, name, token):
        self._tokens[validate_name(name)] = validate_token(token)
        return None

    def load(self, name):
        try:
            return self._tokens[validate_name(name)]
        except KeyError:
            raise CustodyError(f"no token is stored for connector {name!r}. "
                               "Run `relayhall connector install`.") from None

    def delete(self, name):
        return self._tokens.pop(validate_name(name), None) is not None


def custody_for_platform(platform=None, environ=None):
    """The custody backend for this operating system, or a refusal that says why."""
    platform = sys.platform if platform is None else platform
    if platform == "win32":
        return WindowsDpapiCustody(default_root(environ))
    raise UnsupportedPlatform(UNSUPPORTED_PLATFORM)
