"""Publisher trust for harness binaries (E456; E462 slice S3; design v1.5 sections 4.2 and 4.3).

The Codex cases are the PC collector's v8 accept/refuse cases (P-1420), ported onto the product's policy: the
same real identity read on Windows on 23 Oct 2026 is accepted, a routine re-sign (new leaf, sibling issuing CA,
new version) is accepted without a person, and every mismatch refuses with its own named code. The Claude Code
cases pin what is verified for `claude.exe` on Windows. The ledger is append-only and hash-chained. The board's
override can only narrow the release's policy; the narrow-only cases live in connector_trust_override_cases.json,
which the backend suite reads too. One guarded test reads the REAL installed Codex package and Claude Code binary
on Windows.
"""
import copy
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

import relayhall_connector_trust as T

HERE = Path(__file__).resolve().parent
POLICY = T.load_ceiling()
CODEX = POLICY["products"]["codex"]["windows"]
CLAUDE = POLICY["products"]["claude-code"]["windows"]

PFN = "OpenAI.Codex_26.1016.8120.0_x64__2p2nqsd0c76g0"
LEAF = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US'
PUB = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"
# The real identity the PC collector's own read recorded on 23 Oct 2026 (Get-AppxPackage, Get-AuthenticodeSignature,
# offline X509Chain): the stub for the PowerShell read.
REAL_FACTS = {
    "packages": [{"name": "OpenAI.Codex", "packageFullName": PFN, "publisher": PUB, "publisherId": "2p2nqsd0c76g0",
                  "version": "26.1016.8120.0", "architecture": "X64", "signatureKind": 3, "isDevelopmentMode": False,
                  "installLocation": "C:\\Program Files\\WindowsApps\\" + PFN}],
    "binarySignature": {"status": "Valid", "signatureType": "Authenticode", "subject": LEAF,
                        "thumbprint": "0A627748F8DBEA79279DB3B4A0F19618B7789E41",
                        "eku": ["1.3.6.1.4.1.311.97.1.0", "1.3.6.1.5.5.7.3.3",
                                "1.3.6.1.4.1.311.97.34411380.685553541.718322805.135574919"],
                        "chainBuilt": True,
                        "chain": [{"subject": LEAF, "thumbprint": "0A627748F8DBEA79279DB3B4A0F19618B7789E41"},
                                  {"subject": "CN=Microsoft ID Verified CS AOC CA 04, O=Microsoft Corporation, C=US",
                                   "thumbprint": "4C07413E5DA89A259A127E1D76F792AF239CD9D9"},
                                  {"subject": "CN=Microsoft ID Verified Code Signing PCA 2021, O=Microsoft Corporation, C=US",
                                   "thumbprint": "8E750F459DAF9A79D6370DB747AD2226866AD818"},
                                  {"subject": "CN=Microsoft Identity Verification Root Certificate Authority 2020, O=Microsoft Corporation, C=US",
                                   "thumbprint": "F40042E2E5F7E8EF8189FED15519AECE42C3BFA2"}]},
    "packageSignature": {"status": "Valid", "signatureType": "Authenticode", "subject": PUB,
                         "thumbprint": "614D1609C0F1C13E8B767460C3C7465E9383F214",
                         "eku": ["1.3.6.1.5.5.7.3.3", "1.3.6.1.4.1.311.76.3.1", "1.3.6.1.4.1.311.76.5.200"],
                         "chainBuilt": True,
                         "chain": [{"subject": PUB, "thumbprint": "614D1609C0F1C13E8B767460C3C7465E9383F214"},
                                   {"subject": "CN=Microsoft Marketplace CA G 024, OU=AOC, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
                                    "thumbprint": "36A8D8D308AFAA7EFFCA3828F4FC43C4A36B3C63"},
                                   {"subject": "CN=Microsoft MarketPlace PCA 2011, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
                                    "thumbprint": "EB9204785126C26ADADCBBD44FE2B0C642A71078"},
                                   {"subject": "CN=Microsoft Root Certificate Authority 2011, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
                                    "thumbprint": "8F43288AD272F3103B6FB1428485EA3014C0BCFE"}]},
}
ANTHROPIC = CLAUDE["publishers"][0]["binarySigner"]["subject"]
CLAUDE_SIGNATURE = {
    "status": "Valid", "signatureType": "Authenticode", "subject": ANTHROPIC,
    "thumbprint": "0D7581D2C51C59DF686C3000C70BF543F9F6C6CB", "eku": ["1.3.6.1.5.5.7.3.3"], "chainBuilt": True,
    "chain": [{"subject": ANTHROPIC, "thumbprint": "0D7581D2C51C59DF686C3000C70BF543F9F6C6CB"},
              {"subject": 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O="DigiCert, Inc.", C=US',
               "thumbprint": "7B0F360B775F76C94A12CA48445AA2D2A875701C"},
              {"subject": "CN=DigiCert Trusted Root G4, OU=www.digicert.com, O=DigiCert Inc, C=US",
               "thumbprint": "A99D5B79E9F1CDA59CDAB6373169D5353F5874C6"},
              {"subject": "CN=DigiCert Assured ID Root CA, OU=www.digicert.com, O=DigiCert Inc, C=US",
               "thumbprint": "0563B8630D62D75ABBC8AB1E4BDFB5A899B24D43"}]}


def facts(**changes):
    value = copy.deepcopy(REAL_FACTS)
    for path, new in changes.items():
        node, keys = value, path.split("__")
        for key in keys[:-1]:
            node = node[int(key)] if isinstance(node, list) else node[key]
        if isinstance(node, list):
            node[int(keys[-1])] = new
        else:
            node[keys[-1]] = new
    return value


def with_version(value, version):
    package = value["packages"][0]
    package["version"] = version
    package["packageFullName"] = "OpenAI.Codex_" + version + "_x64__2p2nqsd0c76g0"
    package["installLocation"] = "C:\\Program Files\\WindowsApps\\" + package["packageFullName"]
    return value


def refuses(code, function, *args):
    with pytest.raises(T.TrustRefusal) as caught:
        function(*args)
    assert caught.value.args == (code,)
    assert T.failure_code(caught.value) == code  # named, in the closed alphabet
    return caught.value


# ── the policy ────────────────────────────────────────────────────────────────

def test_the_ceiling_is_pinned_by_its_bytes():
    raw = (HERE / "connector_trust_policy.json").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == T.CEILING_SHA256 == POLICY["_sha256"]


def test_an_edited_ceiling_refuses(tmp_path):
    raw = (HERE / "connector_trust_policy.json").read_bytes()
    edited = tmp_path / "p.json"
    edited.write_bytes(raw.replace(b'"minimumVersion": "26.1016.8120.0"', b'"minimumVersion": "0.0.0.0"'))
    assert edited.read_bytes() != raw
    refuses("TRUST_POLICY_CHANGED", T.load_ceiling, edited)


def test_the_policy_names_publishers_never_a_version_hash_list():
    """Design 4.3: the policy names publishers; it never carries a per-version hash allow-list."""
    text = (HERE / "connector_trust_policy.json").read_text()
    assert "sha256" not in text.lower() and "Sha256" not in text
    for rule in (CODEX, CLAUDE):
        assert rule["publishers"] and isinstance(rule["minimumVersion"], str) and rule["denyVersions"] == []
        for publisher in rule["publishers"]:
            for signer in (publisher.get("binarySigner"), publisher.get("packageSigner")):
                if signer:
                    # Leaf certificates are recorded, never pinned: no leaf thumbprint anywhere in the policy.
                    assert "thumbprint" not in signer and all(len(tail) >= 1 for tail in signer["anchors"])
    assert "0A627748F8DBEA79279DB3B4A0F19618B7789E41" not in text and "0D7581D2C51C59DF686C3000C70BF543F9F6C6CB" not in text


def test_a_self_inconsistent_publisher_is_a_shape_error():
    policy = copy.deepcopy(POLICY)
    policy["products"]["codex"]["windows"]["publishers"][0]["package"]["publisherId"] = "8wekyb3d8bbwe"
    refuses("TRUST_POLICY_SHAPE", T.validate_policy, policy)


def test_publisher_id_derivation():
    assert T.publisher_id(PUB) == "2p2nqsd0c76g0"
    assert T.publisher_id("CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US") == "8wekyb3d8bbwe"


# ── Codex (the v8 cases) ──────────────────────────────────────────────────────

def codex(value, rule=CODEX):
    return T.verify_codex_facts(rule, value)[1]


def test_accepts_the_real_identity():
    identity = codex(facts())
    assert identity["version"] == "26.1016.8120.0" and identity["packageFullName"] == PFN
    assert identity["binarySigner"]["thumbprint"] == "0A627748F8DBEA79279DB3B4A0F19618B7789E41"
    assert identity["binarySigner"]["issuingCaThumbprint"] == "4C07413E5DA89A259A127E1D76F792AF239CD9D9"
    assert identity["publisher"] == "openai-microsoft-store"


def test_accepts_the_build_signed_under_the_eoc_marketplace_ca():
    """Read on this PC on 24 Oct 2026 after Codex updated itself to 26.1021.3705.0: the Store re-signed the package
    under `Microsoft Marketplace CA G 028, OU=EOC` (the 23 Oct build was `G 024, OU=AOC`), under the SAME pinned
    policy CA and root. The PC collector's AOC-only pattern refuses it (PACKAGE_SIGNER_CHAIN); this release's
    pattern names both OUs, still anchored to the pinned thumbprints (design 4.2 and gap 6, N17)."""
    value = with_version(facts(), "26.1021.3705.0")
    p = value["packageSignature"]
    p["thumbprint"] = p["chain"][0]["thumbprint"] = "15336635F44DA0B80C528A7902C969B33A8DF8A9"
    p["chain"][1] = {"subject": "CN=Microsoft Marketplace CA G 028, OU=EOC, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
                     "thumbprint": "D6C430B7FF43897B699F5A625FF7C03C8F54604C"}
    b = value["binarySignature"]
    b["thumbprint"] = b["chain"][0]["thumbprint"] = "A17325A972278C46C6DC6F30E73199450C2947E7"
    b["chain"][1] = {"subject": "CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US",
                     "thumbprint": "06F826F5DDBB0A47AFC6BED6549B936461FFA7D0"}
    identity = codex(value)
    assert identity["version"] == "26.1021.3705.0"
    assert identity["packageSigner"]["issuingCaSubject"].startswith("CN=Microsoft Marketplace CA G 028, OU=EOC")
    # An EOC issuing CA under another policy CA is still refused: the pattern never stands alone.
    p["chain"][2] = {"subject": "CN=Microsoft MarketPlace PCA 2011, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
                     "thumbprint": "66" * 20}
    refuses("PACKAGE_SIGNER_CHAIN", codex, value)


def test_an_issuing_ca_outside_both_ous_is_refused():
    value = facts()
    value["packageSignature"]["chain"][1]["subject"] = (
        "CN=Microsoft Marketplace CA G 024, OU=XOC, O=Microsoft Corporation, L=Redmond, S=Washington, C=US")
    refuses("PACKAGE_SIGNER_CHAIN", codex, value)


def test_accepts_a_routine_resign_renewed_leaf_sibling_issuing_ca_and_a_new_version():
    value = with_version(facts(), "26.1020.123.0")
    b = value["binarySignature"]
    b["thumbprint"] = b["chain"][0]["thumbprint"] = "AB" * 20
    b["chain"][1] = {"subject": "CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US", "thumbprint": "CD" * 20}
    p = value["packageSignature"]
    p["thumbprint"] = p["chain"][0]["thumbprint"] = "EF" * 20
    p["chain"][1] = {"subject": "CN=Microsoft Marketplace CA G 025, OU=AOC, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
                     "thumbprint": "12" * 20}
    assert codex(value)["version"] == "26.1020.123.0"


@pytest.mark.parametrize("code,value", [
    ("BINARY_SIGNER_MISMATCH", facts(binarySignature__subject='CN="Evil Corp", O="Evil Corp", C=US')),
    ("BINARY_SIGNER_MISMATCH", facts(binarySignature__eku=["1.3.6.1.4.1.311.97.1.0", "1.3.6.1.5.5.7.3.3", "1.3.6.1.4.1.311.97.1.2.3.4"])),
    ("BINARY_SIGNER_CHAIN", facts(binarySignature__chain__1={"subject": "CN=Contoso Code Signing CA, O=Contoso, C=US", "thumbprint": "11" * 20})),
    ("BINARY_SIGNER_CHAIN", facts(binarySignature__chain__2={"subject": "CN=Microsoft ID Verified Code Signing PCA 2021, O=Microsoft Corporation, C=US", "thumbprint": "22" * 20})),
    ("BINARY_SIGNER_CHAIN", facts(binarySignature__chain__3={"subject": "CN=Some Other Root, O=Other, C=US", "thumbprint": "33" * 20})),
    ("BINARY_SIGNER_CHAIN", facts(binarySignature__chainBuilt=False)),
    ("BINARY_SIGNER_CHAIN", facts(binarySignature__chain=REAL_FACTS["binarySignature"]["chain"][:3])),
    ("BINARY_SIGNER_CHAIN", facts(binarySignature__chain__0={"subject": LEAF, "thumbprint": "44" * 20})),
    ("BINARY_SIGNATURE_INVALID", facts(binarySignature__status="HashMismatch")),
    ("BINARY_SIGNATURE_INVALID", facts(binarySignature__status="NotSigned")),
    ("BINARY_SIGNATURE_INVALID", facts(binarySignature__status="valid")),
    ("BINARY_SIGNATURE_INVALID", facts(binarySignature=None)),
    ("PACKAGE_SIGNATURE_INVALID", facts(packageSignature__status="HashMismatch")),
    ("PACKAGE_SIGNER_MISMATCH", facts(packageSignature__subject="CN=00000000-0000-0000-0000-000000000000")),
    ("PACKAGE_SIGNER_CHAIN", facts(packageSignature__chain__3={"subject": "CN=Other Root", "thumbprint": "55" * 20})),
    ("PUBLISHER_ID_MISMATCH", facts(packages__0__publisherId="8wekyb3d8bbwe")),
    ("PUBLISHER_MISMATCH", facts(packages__0__publisher="CN=OpenAI")),
    ("PACKAGE_NAME", facts(packages__0__name="OpenAI.CodexBeta")),
    ("PACKAGE_COUNT", facts(packages=[])),
    ("SIGNATURE_KIND", facts(packages__0__signatureKind=1)),
    ("SIGNATURE_KIND", facts(packages__0__isDevelopmentMode=True)),
    ("PACKAGE_IDENTITY", facts(packages__0__architecture="Arm64")),
    ("PACKAGE_IDENTITY", facts(packages__0__packageFullName="OpenAI.Codex_26.1016.8120.0_x64__8wekyb3d8bbwe")),
    ("VERSION_BELOW_MINIMUM", with_version(facts(), "26.1013.4894.0")),
    ("VERSION_FORMAT", with_version(facts(), "26.1016.8120")),
])
def test_codex_refuses_by_name(code, value):
    refuses(code, codex, value)


def test_codex_refuses_two_packages():
    value = facts()
    value["packages"].append(copy.deepcopy(value["packages"][0]))
    refuses("PACKAGE_COUNT", codex, value)


def test_trust_is_never_by_one_exact_version():
    """E456: every version at or above the minimum, not denied, from the pinned publisher, is accepted."""
    for version in ("26.1016.8120.0", "26.1016.8121.0", "26.1021.3705.0", "27.0.0.0", "65535.65535.65535.65535"):
        assert codex(with_version(facts(), version))["version"] == version


def test_a_denied_version_and_a_removed_publisher_refuse():
    policy = copy.deepcopy(POLICY)
    policy["products"]["codex"]["windows"]["denyVersions"] = ["26.1016.8120.0"]
    refuses("VERSION_DENIED", codex, facts(), policy["products"]["codex"]["windows"])
    policy["products"]["codex"]["windows"]["publishers"] = []
    refuses("PUBLISHER_REMOVED", T.rule_for, policy, "codex", "windows")
    refuses("PRODUCT_NOT_TRUSTED_ON_OS", T.rule_for, POLICY, "codex", "macos")


# ── Claude Code ───────────────────────────────────────────────────────────────

def claude(signature=None, name="@anthropic-ai/claude-code", version="2.1.246", rule=CLAUDE):
    return T.verify_claude_facts(rule, {"package": {"name": name, "version": version},
                                        "binarySignature": copy.deepcopy(signature or CLAUDE_SIGNATURE)})[1]


def test_claude_accepts_the_real_signature_on_either_digicert_path():
    assert claude()["binarySigner"]["rootThumbprint"] == "0563B8630D62D75ABBC8AB1E4BDFB5A899B24D43"
    self_signed = copy.deepcopy(CLAUDE_SIGNATURE)
    self_signed["chain"] = self_signed["chain"][:2] + [
        {"subject": "CN=DigiCert Trusted Root G4, OU=www.digicert.com, O=DigiCert Inc, C=US",
         "thumbprint": "DDFB16CD4931C973A2037D3FC83A4D7D775D05E4"}]
    assert claude(self_signed)["binarySigner"]["rootThumbprint"] == "DDFB16CD4931C973A2037D3FC83A4D7D775D05E4"


def test_claude_accepts_a_renewed_leaf_and_any_newer_version():
    renewed = copy.deepcopy(CLAUDE_SIGNATURE)
    renewed["thumbprint"] = renewed["chain"][0]["thumbprint"] = "9A" * 20
    for version in ("2.1.246", "2.1.247", "2.2.0", "3.0.0"):
        assert claude(renewed, version=version)["version"] == version


def _signature(**changes):
    value = copy.deepcopy(CLAUDE_SIGNATURE)
    for key, new in changes.items():
        if key.startswith("chain") and key[5:].isdigit():
            value["chain"][int(key[5:])] = new
        else:
            value[key] = new
    return value


@pytest.mark.parametrize("code,kwargs", [
    ("BINARY_SIGNATURE_INVALID", {"signature": _signature(status="HashMismatch")}),
    ("BINARY_SIGNATURE_INVALID", {"signature": _signature(status="NotSigned")}),
    ("BINARY_SIGNER_MISMATCH", {"signature": _signature(subject='CN="Anthropic, PBC", O="Anthropic, PBC", C=US')}),
    ("BINARY_SIGNER_MISMATCH", {"signature": _signature(eku=["1.3.6.1.5.5.7.3.1"])}),
    ("BINARY_SIGNER_CHAIN", {"signature": _signature(chain1={"subject": "CN=Some Other CA, O=Other, C=US", "thumbprint": "11" * 20})}),
    ("BINARY_SIGNER_CHAIN", {"signature": _signature(chain3={"subject": "CN=DigiCert Assured ID Root CA, OU=www.digicert.com, O=DigiCert Inc, C=US", "thumbprint": "22" * 20})}),
    ("BINARY_SIGNER_CHAIN", {"signature": _signature(chainBuilt=False)}),
    ("PACKAGE_NAME", {"name": "@anthropic-ai/claude-code-fork"}),
    ("VERSION_BELOW_MINIMUM", {"version": "2.1.245"}),
    ("VERSION_FORMAT", {"version": "2.1.246-beta.1"}),
])
def test_claude_refuses_by_name(code, kwargs):
    with pytest.raises(T.TrustRefusal) as caught:
        claude(**kwargs)
    assert caught.value.args == (code,)


# ── installed trees: measuring, the run binary, the ledger ───────────────────

MANIFEST = ('\ufeff<?xml version="1.0" encoding="utf-8"?>\n<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">'
            '<Identity Name="OpenAI.Codex" ProcessorArchitecture="x64" Version="{v}" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" /></Package>')


class Tree:
    def __init__(self, root):
        self.root = Path(root)
        self.program_files = self.root / "Program Files"
        self.local = self.root / "Local"
        self.install = self.program_files / "WindowsApps"
        self.bins = self.local / "OpenAI" / "Codex" / "bin"
        self.ledger = self.root / "state" / T.LEDGER_FILE
        for folder in (self.install, self.bins):
            folder.mkdir(parents=True, exist_ok=True)
        self.environ = {"ProgramFiles": str(self.program_files), "LOCALAPPDATA": str(self.local)}

    def codex(self, version="26.1016.8120.0", exe=b"MZ-fake-codex-26.1016", copies=("a96ca4c1eee0cf35",)):
        value = with_version(facts(), version)
        pfn = value["packages"][0]["packageFullName"]
        base = self.install / pfn
        (base / "app" / "resources").mkdir(parents=True, exist_ok=True)
        (base / "AppxManifest.xml").write_bytes(MANIFEST.format(v=version).encode("utf-8"))
        (base / "AppxBlockMap.xml").write_bytes(b"<BlockMap>" + version.encode() + b"</BlockMap>")
        (base / "app" / "resources" / "codex.exe").write_bytes(exe)
        for name in copies:
            (self.bins / name).mkdir(exist_ok=True)
            (self.bins / name / "codex.exe").write_bytes(exe)
        value["packages"][0]["installLocation"] = str(self.install) + "\\" + pfn
        return value

    def checker(self, value, policy=POLICY):
        return T.TrustChecker(policy, self.ledger, environ=self.environ, platform="win32",
                              codex_facts=lambda publisher: copy.deepcopy(value),
                              file_signature=lambda path: copy.deepcopy(self.claude_signature))

    def claude(self, version="2.1.246", exe=b"MZ-fake-claude", name="@anthropic-ai/claude-code"):
        package = self.root / "npm" / "node_modules" / "@anthropic-ai" / "claude-code"
        (package / "bin").mkdir(parents=True, exist_ok=True)
        (package / "package.json").write_text(json.dumps({"name": name, "version": version}))
        (package / "bin" / "claude.exe").write_bytes(exe)
        self.claude_signature = CLAUDE_SIGNATURE
        return package / "bin" / "claude.exe"

    def lines(self):
        return self.ledger.read_bytes().split(b"\n")[:-1] if self.ledger.exists() else []


@pytest.fixture
def tree(tmp_path):
    return Tree(tmp_path)


def test_a_new_codex_version_is_verified_recorded_once_and_chained(tree):
    first = tree.checker(tree.codex()).check("codex")
    assert first["newlyRecorded"] and first["ledgerSeq"] == 1
    assert first["runBinary"] == str(tree.bins / "a96ca4c1eee0cf35" / "codex.exe").replace("\\", "/")
    assert first["measured"]["binarySha256"] == hashlib.sha256(b"MZ-fake-codex-26.1016").hexdigest()
    again = tree.checker(tree.codex()).check("codex")
    assert not again["newlyRecorded"] and again["ledgerSeq"] == 1 and len(tree.lines()) == 1
    entry = json.loads(tree.lines()[0])
    assert entry["version"] == "26.1016.8120.0" and entry["prevEntrySha256"] == "0" * 64
    assert entry["identity"]["binarySigner"]["thumbprint"] == "0A627748F8DBEA79279DB3B4A0F19618B7789E41"
    # The app auto-updates: verified, recorded once, chained. No person acts (E456 (1)).
    newer = tree.codex("26.1021.3705.0", exe=b"MZ-fake-codex-26.1021", copies=("0123456789abcdef",))
    second = tree.checker(newer).check("codex")
    assert second["newlyRecorded"] and second["ledgerSeq"] == 2
    assert json.loads(tree.lines()[1])["prevEntrySha256"] == hashlib.sha256(tree.lines()[0]).hexdigest()


def test_a_refused_build_is_never_recorded(tree):
    value = tree.codex()
    value["binarySignature"]["subject"] = "CN=Other"
    error = refuses("BINARY_SIGNER_MISMATCH", tree.checker(value).check, "codex")
    assert error.observed["binarySignature"]["subject"] == "CN=Other" and error.observed["version"] == "26.1016.8120.0"
    assert not tree.ledger.exists()


def test_a_build_change_within_a_run_refuses(tree):
    value = tree.codex()
    checker = tree.checker(value)
    first = checker.check("codex")
    assert checker.recheck("codex", first) is first
    tree.codex(exe=b"MZ-fake-codex-26.1016-other")
    refuses("BINARY_CHANGED", checker.recheck, "codex", first)


def test_runtime_copy_missing_differs_or_ambiguous(tree):
    value = tree.codex(copies=())
    refuses("BINARY_UNAVAILABLE", tree.checker(value).check, "codex")
    (tree.bins / "ffffffffffffffff").mkdir()
    (tree.bins / "ffffffffffffffff" / "codex.exe").write_bytes(b"MZ-fake-codex-26.1017")
    refuses("BINARY_UNAVAILABLE", tree.checker(value).check, "codex")
    value = tree.codex(copies=("1111111111111111", "2222222222222222"))
    refuses("RUNTIME_BINARY_AMBIGUOUS", tree.checker(value).check, "codex")


def test_the_manifest_must_match_the_registration(tree):
    value = tree.codex()
    (tree.install / PFN / "AppxManifest.xml").write_bytes(MANIFEST.format(v="26.1099.0.0").encode())
    refuses("MANIFEST_IDENTITY", tree.checker(value).check, "codex")


def test_an_install_location_outside_the_install_root_refuses(tree):
    value = tree.codex()
    value["packages"][0]["installLocation"] = str(tree.root) + "\\elsewhere\\" + PFN
    refuses("BINARY_SELECTION_CHANGED", tree.checker(value).check, "codex")


def test_claude_is_measured_signed_and_recorded(tree):
    binary = tree.claude()
    checker = tree.checker(None)
    first = checker.check("claude-code", binary)
    assert first["newlyRecorded"] and first["version"] == "2.1.246"
    assert first["measured"]["binarySha256"] == hashlib.sha256(b"MZ-fake-claude").hexdigest()
    assert first["publisher"] == "anthropic-digicert-ev"
    assert checker.recheck("claude-code", first, binary) is first
    binary.write_bytes(b"MZ-fake-claude-swapped")
    refuses("BINARY_CHANGED", checker.recheck, "claude-code", first, binary)


def test_claude_outside_its_package_or_in_another_package_refuses(tree):
    binary = tree.claude(name="@someone/claude-code")
    refuses("PACKAGE_NAME", tree.checker(None).check, "claude-code", binary)
    stray = tree.root / "elsewhere" / "claude.exe"
    stray.parent.mkdir()
    stray.write_bytes(b"MZ")
    refuses("BINARY_SELECTION_CHANGED", tree.checker(None).check, "claude-code", stray)  # not <package>/bin/claude.exe
    loose = tree.root / "loose" / "bin" / "claude.exe"
    loose.parent.mkdir(parents=True)
    loose.write_bytes(b"MZ")
    refuses("BINARY_UNAVAILABLE", tree.checker(None).check, "claude-code", loose)  # no package.json beside it


def test_trust_on_another_os_is_not_assumed(tree):
    checker = T.TrustChecker(POLICY, tree.ledger, environ={}, platform="linux")
    refuses("PLATFORM_NOT_SUPPORTED", checker.check, "codex")


def test_an_edited_ledger_fails_closed(tree):
    value = tree.codex()
    tree.checker(value).check("codex")
    raw = tree.ledger.read_bytes()
    tree.ledger.write_bytes(raw.replace(b'"seq":1', b'"seq":7'))
    refuses("TRUST_LEDGER_CORRUPT", tree.checker(value).check, "codex")
    tree.ledger.write_bytes(raw[:-1])
    refuses("TRUST_LEDGER_CORRUPT", tree.checker(value).check, "codex")
    tree.ledger.write_bytes(raw)
    assert not tree.checker(value).check("codex")["newlyRecorded"]


def test_a_rewritten_earlier_entry_breaks_the_chain(tree):
    tree.checker(tree.codex()).check("codex")
    tree.checker(tree.codex("26.1021.3705.0", exe=b"MZ-2", copies=("0123456789abcdef",))).check("codex")
    first, second = tree.lines()
    entry = json.loads(first)
    entry["measured"]["binarySha256"] = "f" * 64  # canonical JSON, right seq: only the hash chain can see it
    tree.ledger.write_bytes(T.canonical(entry) + b"\n" + second + b"\n")
    refuses("TRUST_LEDGER_CORRUPT", tree.checker(tree.codex()).check, "codex")


def test_the_ledger_only_ever_grows(tree):
    sizes = []
    for index, version in enumerate(("26.1016.8120.0", "26.1017.0.0", "26.1018.0.0")):
        previous = tree.ledger.read_bytes() if tree.ledger.exists() else b""
        tree.checker(tree.codex(version, exe=b"MZ-" + version.encode(), copies=(f"{index:016x}",))).check("codex")
        sizes.append(tree.ledger.stat().st_size)
        assert tree.ledger.read_bytes().startswith(previous)  # appended, never rewritten
    assert sizes == sorted(sizes) and len(set(sizes)) == 3


# ── the board's override: narrow-only (B3) ────────────────────────────────────

CASES = json.loads((HERE / "connector_trust_override_cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_override_cases(case):
    accepted, rejected = T.validate_override(POLICY, case["override"])
    assert accepted == case["accepted"]
    assert sorted((r["path"], r["code"]) for r in rejected) == sorted(tuple(x) for x in case["rejected"])
    effective = T.effective_policy(POLICY, accepted)
    T.assert_narrower(POLICY, effective)


def test_a_widening_attempt_never_widens_what_is_trusted():
    """Every widening shape at once: a new publisher, a new anchor, a lower minimum, a new product."""
    evil = copy.deepcopy(CODEX["publishers"][0])
    evil["id"] = "evil"
    evil["binarySigner"]["subject"] = 'CN="Evil Corp", O="Evil Corp", C=US'
    override = {"schemaVersion": T.OVERRIDE_SCHEMA, "products": {
        "codex": {"windows": {"publishers": [evil], "minimumVersion": "1.0.0.0",
                              "binarySigner": {"anchors": [[{"subject": "CN=Evil Root", "thumbprint": "77" * 20}]]}}},
        "gemini-cli": {"windows": {"minimumVersion": "0.0.1"}}}}
    accepted, rejected = T.validate_override(POLICY, override)
    assert accepted == {}
    assert {r["code"] for r in rejected} == {"OVERRIDE_WIDENING_FIELD", "OVERRIDE_LOWERS_MINIMUM",
                                            "OVERRIDE_UNKNOWN_PRODUCT"}
    effective = T.effective_policy(POLICY, accepted)
    assert {k: v for k, v in effective.items() if k != "_override"} == POLICY
    evil_facts = facts(binarySignature__subject='CN="Evil Corp", O="Evil Corp", C=US')
    refuses("BINARY_SIGNER_MISMATCH", codex, evil_facts, effective["products"]["codex"]["windows"])
    refuses("VERSION_BELOW_MINIMUM", codex, with_version(facts(), "26.1013.4894.0"),
            effective["products"]["codex"]["windows"])


def test_a_narrowing_override_narrows():
    override = {"schemaVersion": T.OVERRIDE_SCHEMA, "products": {"codex": {"windows": {
        "minimumVersion": "26.1021.0.0", "denyVersions": ["26.1021.3705.0"]}}}}
    accepted, rejected = T.validate_override(POLICY, override)
    assert rejected == []
    rule = T.effective_policy(POLICY, accepted)["products"]["codex"]["windows"]
    refuses("VERSION_BELOW_MINIMUM", codex, facts(), rule)
    refuses("VERSION_DENIED", codex, with_version(facts(), "26.1021.3705.0"), rule)
    assert codex(with_version(facts(), "26.1022.0.0"), rule)["version"] == "26.1022.0.0"


def test_assert_narrower_catches_a_widened_policy():
    widened = copy.deepcopy(POLICY)
    widened["products"]["codex"]["windows"]["minimumVersion"] = "1.0.0.0"
    refuses("TRUST_POLICY_SHAPE", T.assert_narrower, POLICY, widened)
    widened = copy.deepcopy(POLICY)
    widened["products"]["codex"]["windows"]["publishers"].append({"id": "x"})
    refuses("TRUST_POLICY_SHAPE", T.assert_narrower, POLICY, widened)


def test_every_trust_code_is_in_the_closed_alphabet():
    source = (HERE / "relayhall_connector_trust.py").read_text()
    import re
    raised = set(re.findall(r'need\([^)]*?"([A-Z][A-Z_]{3,})"\)', source, re.S)) | set(
        re.findall(r'TrustRefusal\("([A-Z_]{4,})"', source))
    raised |= {"BINARY_SIGNATURE_INVALID", "BINARY_SIGNER_MISMATCH", "BINARY_SIGNER_CHAIN",
               "PACKAGE_SIGNATURE_INVALID", "PACKAGE_SIGNER_MISMATCH", "PACKAGE_SIGNER_CHAIN"}
    assert raised and raised <= T.CODES, raised - T.CODES


# ── a real Windows read (guarded) ─────────────────────────────────────────────

@pytest.mark.skipif(sys.platform != "win32", reason="reads the installed packages with Windows' own Authenticode")
def test_the_real_installed_codex_and_claude_pass_or_refuse_by_name(tmp_path):
    """Reads the REAL installed OpenAI.Codex package and, when present, the npm-installed claude.exe, with the
    real PowerShell reads, against the release ceiling. A machine without one of them refuses by name; nothing
    is written outside tmp_path."""
    checker = T.TrustChecker(POLICY, tmp_path / T.LEDGER_FILE)
    outcomes = {}
    for product, path in (("codex", None), ("claude-code", str(Path(os.environ.get("APPDATA", "")) / "npm" /
                                                                 "node_modules" / "@anthropic-ai" / "claude-code" /
                                                                 "bin" / "claude.exe"))):
        try:
            record = checker.check(product, path)
            outcomes[product] = ("accepted", record["version"], record["identity"]["binarySigner"]["subject"])
            assert checker.recheck(product, record, path) is record
        except T.TrustRefusal as refusal:
            outcomes[product] = ("refused", refusal.code)
            assert refusal.code in T.CODES
    print(json.dumps(outcomes))
    if shutil.which("powershell") and os.environ.get("RELAYHALL_TRUST_REAL_EXPECT_ACCEPT") == "1":
        assert all(o[0] == "accepted" for o in outcomes.values()), outcomes
