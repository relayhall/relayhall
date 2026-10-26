"""Connector custody (E462 slice S2; design v1.5 section 3.2).

Pins:
 - the token's shape is validated, and a refusal never quotes what was entered;
 - the in-memory test backend round-trips (store, load, exists, delete);
 - Windows gets DPAPI CurrentUser under %LOCALAPPDATA%\\RelayHall\\connector;
   macOS and Linux are refused with a sentence that says why (a later release);
 - the DPAPI store's file layout, entropy binding and flags, with the two
   crypt32 calls replaced by a reversible double (runs everywhere);
 - on Windows only, a REAL DPAPI round trip: the blob on disk never holds the
   token, a tampered blob and a blob copied under another name both refuse.
"""
import sys

import pytest

import relayhall_connector_custody as custody
from connector_testkit import TOKEN


def test_a_token_of_the_board_shape_validates_and_is_stripped():
    assert custody.validate_token(f"  {TOKEN}\n") == TOKEN


@pytest.mark.parametrize("bad", [
    "", "   ", "not-a-token", "rh_live_short.x", TOKEN + " trailing", "Bearer " + TOKEN,
    TOKEN.replace("rh_", "xx_"), TOKEN[:-40],
])
def test_a_refusal_never_quotes_what_was_entered(bad):
    with pytest.raises(custody.CustodyError) as refused:
        custody.validate_token(bad)
    text = str(refused.value)
    assert "rh_<env>_<keyId>.<secret>" in text
    for fragment in (bad.strip(), TOKEN.split(".")[1]):
        if len(fragment) >= 8:
            assert fragment not in text


@pytest.mark.parametrize("name", ["laptop-claude-code", "a", "desk-codex", "x" * 63])
def test_connector_names_that_are_accepted(name):
    assert custody.validate_name(name) == name


@pytest.mark.parametrize("name", ["", "-lead", "Upper", "has space", "../escape", "a/b", "x" * 64, None])
def test_connector_names_that_are_refused(name):
    with pytest.raises(custody.CustodyError):
        custody.validate_name(name)


def test_memory_backend_round_trip():
    store = custody.MemoryCustodyForTests()
    assert not store.exists("laptop")
    store.store("laptop", TOKEN)
    assert store.exists("laptop")
    assert store.load("laptop") == TOKEN
    assert store.delete("laptop") is True
    assert store.delete("laptop") is False
    with pytest.raises(custody.CustodyError) as missing:
        store.load("laptop")
    assert "install" in str(missing.value)


def test_memory_backend_refuses_a_malformed_token():
    store = custody.MemoryCustodyForTests()
    with pytest.raises(custody.CustodyError):
        store.store("laptop", "nope")
    assert not store.exists("laptop")


@pytest.mark.parametrize("platform", ["linux", "darwin", "freebsd13"])
def test_macos_and_linux_are_refused_with_the_reason(platform):
    with pytest.raises(custody.UnsupportedPlatform) as refused:
        custody.custody_for_platform(platform, {"LOCALAPPDATA": "/tmp/x"})
    text = str(refused.value)
    assert "Windows only" in text and "Nothing was installed" in text
    assert "macOS" in text and "Linux" in text


def test_windows_gets_dpapi_under_localappdata(tmp_path):
    store = custody.custody_for_platform("win32", {"LOCALAPPDATA": str(tmp_path)})
    assert isinstance(store, custody.WindowsDpapiCustody)
    assert store.kind == "windows-dpapi-currentuser"
    assert store.path("laptop") == tmp_path / "RelayHall" / "connector" / "laptop" / "token.dpapi"


def test_windows_without_localappdata_is_a_refusal():
    with pytest.raises(custody.CustodyError):
        custody.custody_for_platform("win32", {})


class FakeDpapi:
    """Reversible stand-in for crypt32: records what it was asked, binds entropy."""

    calls = []

    @classmethod
    def protect(cls, plaintext, entropy, description):
        cls.calls.append(("protect", entropy, description))
        key = sum(entropy) % 251 + 1
        return b"FAKEDPAPI" + bytes(b ^ key for b in plaintext) + entropy

    @classmethod
    def unprotect(cls, blob, entropy):
        cls.calls.append(("unprotect", entropy, None))
        if not blob.startswith(b"FAKEDPAPI") or not blob.endswith(entropy):
            raise custody.CustodyError("Windows could not decrypt the stored token (error 13)")
        key = sum(entropy) % 251 + 1
        return bytes(b ^ key for b in blob[len(b"FAKEDPAPI"):-len(entropy)])


@pytest.fixture
def fake_dpapi(monkeypatch):
    FakeDpapi.calls = []
    monkeypatch.setattr(custody.WindowsDpapiCustody, "protect", FakeDpapi.protect)
    monkeypatch.setattr(custody.WindowsDpapiCustody, "unprotect", FakeDpapi.unprotect)
    return FakeDpapi


def test_dpapi_store_layout_and_entropy_binding(tmp_path, fake_dpapi):
    store = custody.WindowsDpapiCustody(tmp_path)
    path = store.store("laptop", TOKEN)
    assert path == tmp_path / "laptop" / "token.dpapi"
    assert TOKEN.encode() not in path.read_bytes()
    assert TOKEN.split(".")[1].encode() not in path.read_bytes()
    assert store.load("laptop") == TOKEN
    protect = [c for c in fake_dpapi.calls if c[0] == "protect"][0]
    assert protect[1] == custody.ENTROPY_PREFIX + b"laptop"
    assert protect[2] == "RelayHall connector laptop"
    # A blob copied under another connector's name does not decrypt.
    other = tmp_path / "desktop" / "token.dpapi"
    other.parent.mkdir()
    other.write_bytes(path.read_bytes())
    with pytest.raises(custody.CustodyError):
        store.load("desktop")
    assert store.delete("laptop") is True
    assert not path.exists()
    assert store.delete("laptop") is False


def test_dpapi_load_of_a_missing_blob_says_install(tmp_path, fake_dpapi):
    with pytest.raises(custody.CustodyError) as missing:
        custody.WindowsDpapiCustody(tmp_path).load("laptop")
    assert "relayhall connector install" in str(missing.value)


def test_dpapi_store_refuses_to_write_through_a_symlink(tmp_path, fake_dpapi):
    target = tmp_path / "elsewhere"
    target.write_bytes(b"")
    link = tmp_path / "laptop" / "token.dpapi"
    link.parent.mkdir()
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")
    with pytest.raises(custody.CustodyError):
        custody.WindowsDpapiCustody(tmp_path).store("laptop", TOKEN)
    assert target.read_bytes() == b""


def test_the_flags_are_currentuser_with_no_ui():
    # CRYPTPROTECT_LOCAL_MACHINE (0x4) would widen the blob to every user of the machine.
    assert custody.CRYPTPROTECT_UI_FORBIDDEN == 0x1
    source = open(custody.__file__, encoding="utf-8").read()
    # Both crypt32 calls pass exactly that flag word, and nothing ORs another in.
    assert source.count("None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out)") == 2
    assert "CRYPTPROTECT_UI_FORBIDDEN |" not in source and "| CRYPTPROTECT_UI_FORBIDDEN" not in source


@pytest.mark.skipif(sys.platform != "win32", reason="real DPAPI exists on Windows only")
def test_real_dpapi_round_trip(tmp_path):
    store = custody.custody_for_platform("win32", {"LOCALAPPDATA": str(tmp_path)})
    path = store.store("pytest-dpapi", TOKEN)
    blob = path.read_bytes()
    assert TOKEN.encode() not in blob and TOKEN.split(".")[1].encode() not in blob
    assert store.load("pytest-dpapi") == TOKEN
    copy = tmp_path / "RelayHall" / "connector" / "pytest-other" / "token.dpapi"
    copy.parent.mkdir(parents=True)
    copy.write_bytes(blob)
    with pytest.raises(custody.CustodyError):
        store.load("pytest-other")
    path.write_bytes(blob[:-1] + bytes([blob[-1] ^ 0xFF]))
    with pytest.raises(custody.CustodyError):
        store.load("pytest-dpapi")
    assert store.delete("pytest-dpapi") is True
