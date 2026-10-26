"""Publisher trust for the harness binaries the connector runs (design v1.5
sections 4.2 and 4.3; owner rulings E456 and E462, slice S3).

A harness binary runs, for a quota read or for work, only if it passes the trust
policy for its product on this operating system. Trust is by VERIFIED
PUBLISHER and package identity, never by one exact version: every new version
that verifies is accepted automatically, recorded once in an append-only,
hash-chained local ledger and reported afterwards; a mismatch fails closed with
a named code. No person acts per version (E456 (1)).

THE POLICY. `connector_trust_policy.json` beside this module is the release's
CEILING (choice C5), pinned here by its sha256: an edited file refuses with
TRUST_POLICY_CHANGED. The board may serve an override at
GET /connectors/trust-policy that can only NARROW the ceiling (raise
`minimumVersion`, add `denyVersions`, remove a publisher); `validate_override`
applies the same narrow-only rule the board applies, against THIS release's
ceiling, and ignores any entry that would widen it, reporting it as
`connector.trust.override_rejected`. A new publisher or issuing chain arrives
only in a connector release.

WHAT IS VERIFIED, ON WINDOWS
- Codex (the Microsoft Store package `OpenAI.Codex`), as the PC collector does
  since P-1420: the package registration (`Get-AppxPackage`: name, publisher,
  publisher id derived from the publisher, architecture, Store signature kind,
  not a development registration); WinVerifyTrust (`Get-AuthenticodeSignature`)
  status Valid on the package's `codex.exe` AND on `AppxSignature.p7x`; for each,
  the signer subject, the required EKUs (OpenAI's durable identity EKU among
  them), an offline chain whose issuing CA matches the pinned subject pattern
  and whose remaining elements are the pinned policy CA and root, by thumbprint;
  the manifest identity equals the registration; the runtime copy the app runs
  from is byte-identical to the verified package binary.
- Claude Code (the npm package `@anthropic-ai/claude-code`, which ships a
  native `bin/claude.exe`): WinVerifyTrust status Valid on `claude.exe`; the
  signer subject is Anthropic, PBC's extended-validation subject; the
  code-signing EKU; an offline chain through the pinned DigiCert G4 code-signing
  CA to a pinned DigiCert root (either of the two paths Windows builds), by
  thumbprint; the binary sits at `bin/claude.exe` of a package whose
  `package.json` names `@anthropic-ai/claude-code`. The VERSION comes from that
  `package.json`, which npm does not sign: it is recorded and checked against
  `minimumVersion`/`denyVersions`, but it is not a cryptographic fact. What is
  cryptographic is the signature over the exact `claude.exe` bytes, whose
  sha256 the ledger records. npm registry provenance is not checked on Windows
  (that is the Linux/npm row, slice S7).

Leaf certificates are recorded, never enforced (both vendors rotate them).
Revocation is not checked (offline chain, as P-1420).

The facts are read by PowerShell (report only); every decision is made here.
"""
import copy
import datetime
import hashlib
import json
import os
import re
import stat
import sys
import xml.etree.ElementTree
from pathlib import Path

from relayhall_connector_proc import ChildError, run_bounded

HERE = Path(__file__).resolve().parent
CEILING_FILE = HERE / "connector_trust_policy.json"
CEILING_SHA256 = "d24ecd3a7b107d78fc03357d789fba1a4f06a9cdb3b0f2b5b9c4a39c1dc18dec"
POLICY_NAME = "relayhall-connector-trust"
OVERRIDE_SCHEMA = "rh.connector-trust-override/1"
OVERRIDE_FIELDS = ("minimumVersion", "denyVersions", "removePublishers")
LEDGER_FILE = "trust-ledger-v1.jsonl"
LEDGER_MAX = 4 * 1024 * 1024
POWERSHELL = os.path.join(os.environ.get("SystemRoot") or r"C:\Windows",
                          "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
HARNESS_PRODUCT = {"claude-code": "claude-code", "codex": "codex"}

HEX40 = re.compile(r"[0-9A-F]{40}")
OID = re.compile(r"[0-9]+(\.[0-9]+)+")
PUBLISHER_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"

# Every refusal this module can raise. A code outside this set is a defect.
CODES = frozenset("""
TRUST_POLICY_CHANGED TRUST_POLICY_SHAPE PRODUCT_NOT_TRUSTED_ON_OS PUBLISHER_REMOVED PLATFORM_NOT_SUPPORTED
PACKAGE_METADATA PACKAGE_METADATA_TIMEOUT PACKAGE_COUNT PACKAGE_NAME PUBLISHER_MISMATCH PUBLISHER_ID_MISMATCH
SIGNATURE_KIND PACKAGE_IDENTITY MANIFEST_IDENTITY VERSION_FORMAT VERSION_BELOW_MINIMUM VERSION_DENIED
BINARY_SIGNATURE_INVALID BINARY_SIGNER_MISMATCH BINARY_SIGNER_CHAIN PACKAGE_SIGNATURE_INVALID
PACKAGE_SIGNER_MISMATCH PACKAGE_SIGNER_CHAIN RUNTIME_BINARY_AMBIGUOUS BINARY_UNAVAILABLE BINARY_CHANGED
BINARY_SELECTION_CHANGED FILE_CUSTODY FILE_SIZE FILE_CHANGED TRUST_LEDGER_CORRUPT TRUST_LEDGER_SIZE
""".split())


class TrustRefusal(Exception):
    """A named trust refusal. args == (code,). `observed` carries bounded, non-secret facts."""

    def __init__(self, code, observed=None):
        super().__init__(code)
        self.code = code
        self.observed = observed


def need(value, code):
    if not value:
        raise TrustRefusal(code)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()


# ── file custody (the P-1420 checks: no links, no reparse points, unchanged while read) ──

def _plain_dirs(path):
    for parent in path.parents:
        try:
            entry = parent.lstat()
        except FileNotFoundError:
            raise TrustRefusal("BINARY_UNAVAILABLE") from None
        except OSError:
            raise TrustRefusal("FILE_CUSTODY") from None
        need(stat.S_ISDIR(entry.st_mode) and not parent.is_symlink()
             and not getattr(entry, "st_file_attributes", 0) & 1024, "FILE_CUSTODY")


def _key(x):
    return (x.st_dev, x.st_ino, x.st_size, x.st_nlink, x.st_mtime_ns, x.st_ctime_ns, getattr(x, "st_file_attributes", 0))


def checked_bytes(path, maximum=1048576, hardlinks=True):
    path = Path(path)
    _plain_dirs(path)
    try:
        a = path.lstat()
    except FileNotFoundError:
        raise TrustRefusal("BINARY_UNAVAILABLE") from None
    need(stat.S_ISREG(a.st_mode) and not path.is_symlink() and not getattr(a, "st_file_attributes", 0) & 1024
         and (hardlinks or a.st_nlink == 1), "FILE_CUSTODY")
    need(a.st_size <= maximum, "FILE_SIZE")
    with path.open("rb") as handle:
        raw = handle.read(maximum + 1)
        b = os.fstat(handle.fileno())
    c = path.lstat()
    need(_key(a)[:3] == _key(b)[:3] == _key(c)[:3] and _key(a) == _key(c) and len(raw) <= maximum, "FILE_CHANGED")
    return raw


def checked_sha256(path, maximum=1073741824):
    """Streaming sha256 with the same custody and change checks: (hex digest, size)."""
    path = Path(path)
    _plain_dirs(path)
    try:
        a = path.lstat()
    except FileNotFoundError:
        raise TrustRefusal("BINARY_UNAVAILABLE") from None
    need(stat.S_ISREG(a.st_mode) and not path.is_symlink() and not getattr(a, "st_file_attributes", 0) & 1024,
         "FILE_CUSTODY")
    need(a.st_size <= maximum, "FILE_SIZE")
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1048576)
            if not chunk:
                break
            size += len(chunk)
            need(size <= maximum, "FILE_SIZE")
            digest.update(chunk)
    c = path.lstat()
    need(_key(a) == _key(c) and size == a.st_size, "FILE_CHANGED")
    return digest.hexdigest(), size


# ── versions ──────────────────────────────────────────────────────────────────

def version_tuple(kind, value):
    """msix: four dotted parts 0-65535; npm-native: semver MAJOR.MINOR.PATCH (no pre-release)."""
    if kind == "msix":
        need(isinstance(value, str) and re.fullmatch(r"(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}", value),
             "VERSION_FORMAT")
        parts = tuple(int(x) for x in value.split("."))
        need(all(x <= 65535 for x in parts), "VERSION_FORMAT")
        return parts
    need(isinstance(value, str) and re.fullmatch(r"(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5})){2}", value),
         "VERSION_FORMAT")
    return tuple(int(x) for x in value.split("."))


def publisher_id(publisher):
    """Windows package publisher id: Crockford base32 of the first 64 bits of SHA-256(UTF-16LE publisher)."""
    n = int.from_bytes(hashlib.sha256(publisher.encode("utf-16-le")).digest()[:8], "big") << 1
    return "".join(CROCKFORD[(n >> (5 * (12 - i))) & 31] for i in range(13))


# ── the policy ────────────────────────────────────────────────────────────────

def _signer_shape(rule, subject=None):
    need(isinstance(rule, dict) and isinstance(rule.get("subject"), str) and rule["subject"]
         and (subject is None or rule["subject"] == subject), "TRUST_POLICY_SHAPE")
    need(isinstance(rule.get("requiredEku"), list) and rule["requiredEku"]
         and all(isinstance(x, str) and OID.fullmatch(x) for x in rule["requiredEku"]), "TRUST_POLICY_SHAPE")
    pattern = rule.get("issuingCaSubjectPattern")
    need(isinstance(pattern, str) and pattern.startswith("^") and pattern.endswith("$"), "TRUST_POLICY_SHAPE")
    try:
        re.compile(pattern)
    except re.error:
        raise TrustRefusal("TRUST_POLICY_SHAPE") from None
    anchors = rule.get("anchors")
    need(isinstance(anchors, list) and anchors, "TRUST_POLICY_SHAPE")
    for tail in anchors:
        need(isinstance(tail, list) and 1 <= len(tail) <= 3, "TRUST_POLICY_SHAPE")
        for element in tail:
            need(isinstance(element, dict) and set(element) == {"subject", "thumbprint"}
                 and isinstance(element["subject"], str) and element["subject"]
                 and isinstance(element["thumbprint"], str) and HEX40.fullmatch(element["thumbprint"]),
                 "TRUST_POLICY_SHAPE")


def validate_policy(policy):
    """The shape every policy (ceiling or effective) must have. Raises TRUST_POLICY_SHAPE."""
    need(isinstance(policy, dict) and policy.get("schemaVersion") == 1 and policy.get("policy") == POLICY_NAME
         and isinstance(policy.get("products"), dict), "TRUST_POLICY_SHAPE")
    for product, systems in policy["products"].items():
        need(isinstance(product, str) and isinstance(systems, dict), "TRUST_POLICY_SHAPE")
        for system, rule in systems.items():
            need(system in ("windows", "macos", "linux") and isinstance(rule, dict), "TRUST_POLICY_SHAPE")
            kind = rule.get("kind")
            need(kind in ("msix", "npm-native"), "TRUST_POLICY_SHAPE")
            try:
                version_tuple(kind, rule.get("minimumVersion"))
                need(isinstance(rule.get("denyVersions"), list), "TRUST_POLICY_SHAPE")
                for value in rule["denyVersions"]:
                    version_tuple(kind, value)
            except TrustRefusal:
                raise TrustRefusal("TRUST_POLICY_SHAPE") from None
            publishers = rule.get("publishers")
            need(isinstance(publishers, list), "TRUST_POLICY_SHAPE")
            ids = [p.get("id") if isinstance(p, dict) else None for p in publishers]
            need(all(isinstance(i, str) and PUBLISHER_ID.fullmatch(i) for i in ids) and len(set(ids)) == len(ids),
                 "TRUST_POLICY_SHAPE")
            for publisher in publishers:
                package = publisher.get("package")
                need(isinstance(package, dict) and isinstance(package.get("name"), str) and package["name"],
                     "TRUST_POLICY_SHAPE")
                if kind == "msix":
                    need(all(isinstance(package.get(k), str) and package[k]
                             for k in ("publisher", "publisherId", "architecture"))
                         and type(package.get("signatureKind")) is int
                         and re.fullmatch(r"[A-Za-z0-9.]{1,64}", package["name"]), "TRUST_POLICY_SHAPE")
                    need(package["publisherId"] == publisher_id(package["publisher"]), "TRUST_POLICY_SHAPE")
                    root = package.get("installRoot")
                    need(isinstance(root, dict) and isinstance(root.get("env"), str)
                         and isinstance(root.get("path"), str), "TRUST_POLICY_SHAPE")
                    binary = publisher.get("binary")
                    need(isinstance(binary, dict) and isinstance(binary.get("packageRelativePath"), str)
                         and isinstance(binary.get("runtimeCopy"), dict)
                         and all(isinstance(binary["runtimeCopy"].get(k), str) for k in ("env", "path", "name")),
                         "TRUST_POLICY_SHAPE")
                    _signer_shape(publisher.get("binarySigner"))
                    _signer_shape(publisher.get("packageSigner"), package["publisher"])
                    need(publisher["packageSigner"].get("file") == "AppxSignature.p7x", "TRUST_POLICY_SHAPE")
                else:
                    need(isinstance(package.get("binaryRelativePath"), str)
                         and re.fullmatch(r"[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*", package["binaryRelativePath"])
                         and ".." not in package["binaryRelativePath"].split("/"), "TRUST_POLICY_SHAPE")
                    _signer_shape(publisher.get("binarySigner"))
    return policy


def load_ceiling(path=None, digest=None):
    """The release's built-in policy, pinned by sha256."""
    path = Path(path or CEILING_FILE)
    digest = digest or CEILING_SHA256
    raw = checked_bytes(path, 262144)
    need(hashlib.sha256(raw).hexdigest() == digest, "TRUST_POLICY_CHANGED")
    try:
        policy = json.loads(raw)
    except ValueError:
        raise TrustRefusal("TRUST_POLICY_SHAPE") from None
    validate_policy(policy)
    policy["_sha256"] = digest
    return policy


def _reject(rejected, path, code):
    rejected.append({"path": path, "code": code})


def validate_override(ceiling, override):
    """Narrow-only (design 4.3, B3): (accepted, rejected).

    `accepted` holds only entries that narrow THIS ceiling; `rejected` names
    every entry that would widen it or is malformed, by path and code, and
    never echoes a value. The same rule the board applies, kept in step by
    connector_trust_override_cases.json, which both suites read."""
    accepted, rejected = {}, []
    if override is None:
        return accepted, rejected
    if not isinstance(override, dict) or override.get("schemaVersion") != OVERRIDE_SCHEMA:
        _reject(rejected, "", "OVERRIDE_MALFORMED")
        return {}, rejected
    for key in override:
        if key not in ("schemaVersion", "products"):
            _reject(rejected, key, "OVERRIDE_UNKNOWN_FIELD")
    products = override.get("products", {})
    if not isinstance(products, dict):
        _reject(rejected, "products", "OVERRIDE_MALFORMED")
        return {}, rejected
    for product, systems in products.items():
        base = f"products.{product}"
        if not isinstance(systems, dict):
            _reject(rejected, base, "OVERRIDE_MALFORMED")
            continue
        for system, entry in systems.items():
            where = f"{base}.{system}"
            rule = ceiling["products"].get(product, {}).get(system) if isinstance(product, str) else None
            if rule is None:
                _reject(rejected, where, "OVERRIDE_UNKNOWN_PRODUCT")  # trusting a product the release does not
                continue
            if not isinstance(entry, dict):
                _reject(rejected, where, "OVERRIDE_MALFORMED")
                continue
            kept = {}
            for field, value in entry.items():
                path = f"{where}.{field}"
                if field not in OVERRIDE_FIELDS:
                    _reject(rejected, path, "OVERRIDE_WIDENING_FIELD")  # publishers, anchors, signers, paths...
                    continue
                if field == "minimumVersion":
                    try:
                        if version_tuple(rule["kind"], value) < version_tuple(rule["kind"], rule["minimumVersion"]):
                            _reject(rejected, path, "OVERRIDE_LOWERS_MINIMUM")
                            continue
                    except TrustRefusal:
                        _reject(rejected, path, "OVERRIDE_MALFORMED")
                        continue
                    kept[field] = value
                elif field == "denyVersions":
                    try:
                        if not isinstance(value, list) or len(value) > 256:
                            raise TrustRefusal("VERSION_FORMAT")
                        for version in value:
                            version_tuple(rule["kind"], version)
                    except TrustRefusal:
                        _reject(rejected, path, "OVERRIDE_MALFORMED")
                        continue
                    kept[field] = sorted(set(value))
                else:
                    known = {p["id"] for p in rule["publishers"]}
                    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                        _reject(rejected, path, "OVERRIDE_MALFORMED")
                        continue
                    unknown = [v for v in value if v not in known]
                    if unknown:
                        _reject(rejected, path, "OVERRIDE_UNKNOWN_PUBLISHER")
                    present = sorted(set(v for v in value if v in known))
                    if present:
                        kept[field] = present
            if kept:
                accepted.setdefault(product, {})[system] = kept
    return accepted, rejected


def effective_policy(ceiling, accepted):
    """The ceiling narrowed by an accepted override. It can never be wider: checked, not assumed."""
    policy = copy.deepcopy(ceiling)
    for product, systems in accepted.items():
        for system, entry in systems.items():
            rule = policy["products"][product][system]
            kind = rule["kind"]
            if "minimumVersion" in entry and version_tuple(kind, entry["minimumVersion"]) > version_tuple(
                    kind, rule["minimumVersion"]):
                rule["minimumVersion"] = entry["minimumVersion"]
            if "denyVersions" in entry:
                rule["denyVersions"] = sorted(set(rule["denyVersions"]) | set(entry["denyVersions"]))
            if "removePublishers" in entry:
                rule["publishers"] = [p for p in rule["publishers"] if p["id"] not in set(entry["removePublishers"])]
    assert_narrower(ceiling, policy)
    policy["_override"] = accepted
    return policy


def assert_narrower(ceiling, policy):
    """Every rule of `policy` is the ceiling's rule or narrower; anything else is TRUST_POLICY_SHAPE."""
    for product, systems in policy["products"].items():
        for system, rule in systems.items():
            base = ceiling["products"].get(product, {}).get(system)
            need(base is not None, "TRUST_POLICY_SHAPE")
            kind = base["kind"]
            need(rule["kind"] == kind, "TRUST_POLICY_SHAPE")
            need(version_tuple(kind, rule["minimumVersion"]) >= version_tuple(kind, base["minimumVersion"]),
                 "TRUST_POLICY_SHAPE")
            need(set(base["denyVersions"]) <= set(rule["denyVersions"]), "TRUST_POLICY_SHAPE")
            need(all(p in base["publishers"] for p in rule["publishers"]), "TRUST_POLICY_SHAPE")


def rule_for(policy, product, system):
    rule = policy["products"].get(product, {}).get(system)
    need(rule is not None, "PRODUCT_NOT_TRUSTED_ON_OS")
    need(rule["publishers"], "PUBLISHER_REMOVED")
    return rule


def check_version(rule, version):
    parsed = version_tuple(rule["kind"], version)
    need(parsed >= version_tuple(rule["kind"], rule["minimumVersion"]), "VERSION_BELOW_MINIMUM")
    need(parsed not in {version_tuple(rule["kind"], v) for v in rule["denyVersions"]}, "VERSION_DENIED")


# ── signatures (pure) ─────────────────────────────────────────────────────────

def check_signer(sig, rule, prefix):
    """One Authenticode signature against one signer rule: status, subject, EKUs, chain."""
    need(isinstance(sig, dict), prefix + "_SIGNATURE_INVALID")
    need(sig.get("status") == "Valid" and sig.get("signatureType") == "Authenticode", prefix + "_SIGNATURE_INVALID")
    thumb, eku = sig.get("thumbprint"), sig.get("eku")
    need(sig.get("subject") == rule["subject"] and isinstance(thumb, str) and HEX40.fullmatch(thumb),
         prefix + "_SIGNER_MISMATCH")
    need(isinstance(eku, list) and all(isinstance(x, str) for x in eku) and set(rule["requiredEku"]) <= set(eku),
         prefix + "_SIGNER_MISMATCH")
    chain = sig.get("chain")
    need(sig.get("chainBuilt") is True and isinstance(chain, list) and 3 <= len(chain) <= 5, prefix + "_SIGNER_CHAIN")
    need(all(isinstance(e, dict) and isinstance(e.get("subject"), str) and isinstance(e.get("thumbprint"), str)
             and HEX40.fullmatch(e["thumbprint"]) for e in chain), prefix + "_SIGNER_CHAIN")
    need({"subject": chain[0]["subject"], "thumbprint": chain[0]["thumbprint"]}
         == {"subject": rule["subject"], "thumbprint": thumb}, prefix + "_SIGNER_CHAIN")
    need(re.fullmatch(rule["issuingCaSubjectPattern"], chain[1]["subject"]) is not None, prefix + "_SIGNER_CHAIN")
    tail = [{"subject": e["subject"], "thumbprint": e["thumbprint"]} for e in chain[2:]]
    need(any(tail == anchor for anchor in rule["anchors"]), prefix + "_SIGNER_CHAIN")
    return {"subject": rule["subject"], "thumbprint": thumb, "issuingCaSubject": chain[1]["subject"],
            "issuingCaThumbprint": chain[1]["thumbprint"], "rootThumbprint": chain[-1]["thumbprint"]}


def _first_refusal(rule, attempt):
    """Try each publisher of `rule`; the first that verifies wins. Else the first publisher's refusal."""
    first = None
    for publisher in rule["publishers"]:
        try:
            return publisher, attempt(publisher)
        except TrustRefusal as refusal:
            first = first or refusal
    raise first


def verify_codex_facts(rule, facts):
    """The installed Codex package against the msix rule (pure; the P-1420 decision, per publisher)."""
    need(isinstance(facts, dict), "PACKAGE_METADATA")
    packages = facts.get("packages")
    need(isinstance(packages, list) and all(isinstance(x, dict) for x in packages), "PACKAGE_METADATA")
    need(len(packages) == 1, "PACKAGE_COUNT")
    found = packages[0]

    def attempt(publisher):
        pk = publisher["package"]
        need(found.get("name") == pk["name"], "PACKAGE_NAME")
        need(found.get("publisher") == pk["publisher"], "PUBLISHER_MISMATCH")
        need(found.get("publisherId") == pk["publisherId"] and publisher_id(found["publisher"]) == pk["publisherId"],
             "PUBLISHER_ID_MISMATCH")
        need(type(found.get("signatureKind")) is int and found["signatureKind"] == pk["signatureKind"]
             and found.get("isDevelopmentMode") is False, "SIGNATURE_KIND")
        version = found.get("version")
        version_tuple("msix", version)
        full = f"{pk['name']}_{version}_{pk['architecture']}__{pk['publisherId']}"
        need(isinstance(found.get("architecture"), str) and found["architecture"].lower() == pk["architecture"]
             and found.get("packageFullName") == full, "PACKAGE_IDENTITY")
        check_version(rule, version)
        binary = check_signer(facts.get("binarySignature"), publisher["binarySigner"], "BINARY")
        package = check_signer(facts.get("packageSignature"), publisher["packageSigner"], "PACKAGE")
        need(isinstance(found.get("installLocation"), str), "BINARY_SELECTION_CHANGED")
        return {"version": version, "packageFullName": full, "publisherId": pk["publisherId"],
                "installLocation": found["installLocation"], "binarySigner": binary, "packageSigner": package}

    publisher, identity = _first_refusal(rule, attempt)
    identity["publisher"] = publisher["id"]
    return publisher, identity


def verify_claude_facts(rule, facts):
    """The installed Claude Code against the npm-native rule (pure)."""
    need(isinstance(facts, dict) and isinstance(facts.get("package"), dict), "PACKAGE_METADATA")
    found = facts["package"]

    def attempt(publisher):
        pk = publisher["package"]
        need(found.get("name") == pk["name"], "PACKAGE_NAME")
        version = found.get("version")
        version_tuple("npm-native", version)
        check_version(rule, version)
        binary = check_signer(facts.get("binarySignature"), publisher["binarySigner"], "BINARY")
        return {"version": version, "packageName": pk["name"], "binarySigner": binary}

    publisher, identity = _first_refusal(rule, attempt)
    identity["publisher"] = publisher["id"]
    return publisher, identity


def observed_summary(facts):
    """Bounded, non-secret facts for a refusal record. Never raises."""
    out = {}
    try:
        if not isinstance(facts, dict):
            return out
        packages = facts.get("packages")
        if isinstance(packages, list):
            out["packageCount"] = len(packages)
            first = packages[0] if packages and isinstance(packages[0], dict) else {}
        else:
            first = facts.get("package") if isinstance(facts.get("package"), dict) else {}
        for key in ("name", "version", "packageFullName", "publisherId"):
            if isinstance(first.get(key), str):
                out[key] = first[key][:256]
        for name in ("binarySignature", "packageSignature"):
            sig = facts.get(name)
            if isinstance(sig, dict):
                out[name] = {k: sig[k][:256] for k in ("status", "subject", "thumbprint") if isinstance(sig.get(k), str)}
                chain = sig.get("chain")
                if isinstance(chain, list) and len(chain) > 1 and isinstance(chain[1], dict) \
                        and isinstance(chain[1].get("subject"), str):
                    out[name]["issuingCaSubject"] = chain[1]["subject"][:256]
    except Exception:  # noqa: BLE001 - a summary never turns a refusal into a crash
        pass
    return out


# ── Windows facts (PowerShell reports; nothing is decided there) ─────────────

SIGNATURE_FUNCTION = r"""
function Sig([string]$f){ $s=Get-AuthenticodeSignature -LiteralPath $f; $c=$s.SignerCertificate; $o=[ordered]@{status=[string]$s.Status;signatureType=[string]$s.SignatureType;subject=$null;thumbprint=$null;eku=@();chainBuilt=$false;chain=@()}
 if($c){ $o.subject=$c.Subject; $o.thumbprint=$c.Thumbprint; $o.eku=@($c.Extensions|Where-Object{$_.Oid.Value -eq '2.5.29.37'}|ForEach-Object{$_.EnhancedKeyUsages|ForEach-Object{$_.Value}})
  $col=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection; $col.Import($f)
  $ch=New-Object System.Security.Cryptography.X509Certificates.X509Chain; $ch.ChainPolicy.RevocationMode='NoCheck'; $ch.ChainPolicy.VerificationFlags='IgnoreNotTimeValid'; [void]$ch.ChainPolicy.ExtraStore.AddRange($col)
  $o.chainBuilt=[bool]$ch.Build($c); $o.chain=@($ch.ChainElements|ForEach-Object{[ordered]@{subject=$_.Certificate.Subject;thumbprint=$_.Certificate.Thumbprint}}); $ch.Reset() }
 $o }
"""
PREAMBLE = ("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n")

# The package name and file paths reach PowerShell through the environment, never through the script text.
CODEX_READ = PREAMBLE + SIGNATURE_FUNCTION + r"""
$p=@(Get-AppxPackage -Name $env:RH_TRUST_PACKAGE)
$r=[ordered]@{packages=@($p|ForEach-Object{[ordered]@{name=$_.Name;packageFullName=$_.PackageFullName;publisher=$_.Publisher;publisherId=$_.PublisherId;version=[string]$_.Version;architecture=[string]$_.Architecture;signatureKind=[int]$_.SignatureKind;isDevelopmentMode=[bool]$_.IsDevelopmentMode;installLocation=$_.InstallLocation}});binarySignature=$null;packageSignature=$null}
if($p.Count -eq 1){ $r.binarySignature=Sig (Join-Path $p[0].InstallLocation $env:RH_TRUST_BINARY); $r.packageSignature=Sig (Join-Path $p[0].InstallLocation $env:RH_TRUST_SIGNATURE) }
$r|ConvertTo-Json -Compress -Depth 6"""

FILE_READ = PREAMBLE + SIGNATURE_FUNCTION + r"""
[ordered]@{binarySignature=(Sig $env:RH_TRUST_FILE)}|ConvertTo-Json -Compress -Depth 6"""

TRUST_ENV_ALLOW = ("SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "USERPROFILE", "TEMP", "TMP",
                   "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PSMODULEPATH", "USERNAME", "USERDOMAIN")


def _powershell(script, extra_env, environ, timeout=45, runner=None):
    env = {k: v for k, v in (environ or os.environ).items() if k.upper() in TRUST_ENV_ALLOW}
    env.update(extra_env)
    argv = [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]
    try:
        code, raw = (runner or run_bounded)(argv, env=env, timeout=timeout, code_prefix="PACKAGE_METADATA",
                                             max_output=262144)
    except ChildError as error:
        raise TrustRefusal("PACKAGE_METADATA_TIMEOUT" if error.code.endswith("_TIMEOUT") else "PACKAGE_METADATA") from None
    need(code == 0 and 0 < len(raw) <= 262144, "PACKAGE_METADATA")
    try:
        value = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise TrustRefusal("PACKAGE_METADATA") from None
    need(isinstance(value, dict), "PACKAGE_METADATA")
    return value


def windows_codex_facts(publisher, environ=None, runner=None):
    package = publisher["package"]["name"]
    binary = publisher["binary"]["packageRelativePath"].replace("/", "\\")
    return _powershell(CODEX_READ, {"RH_TRUST_PACKAGE": package, "RH_TRUST_BINARY": binary,
                                    "RH_TRUST_SIGNATURE": publisher["packageSigner"]["file"]}, environ, runner=runner)


def windows_file_signature(path, environ=None, runner=None):
    return _powershell(FILE_READ, {"RH_TRUST_FILE": str(path)}, environ, runner=runner).get("binarySignature")


# ── measuring the installed bytes ─────────────────────────────────────────────

MANIFEST_NS = "{http://schemas.microsoft.com/appx/manifest/foundation/windows10}"


def manifest_identity(raw):
    need(b"<!DOCTYPE" not in raw.upper() and b"<!ENTITY" not in raw.upper(), "MANIFEST_IDENTITY")
    try:
        root = xml.etree.ElementTree.fromstring(raw)
    except Exception:  # noqa: BLE001
        raise TrustRefusal("MANIFEST_IDENTITY") from None
    need(root.tag == MANIFEST_NS + "Package", "MANIFEST_IDENTITY")
    found = [e for e in root if e.tag == MANIFEST_NS + "Identity"]
    need(len(found) == 1, "MANIFEST_IDENTITY")
    a = found[0].attrib
    return a.get("Name"), a.get("Publisher"), a.get("Version"), a.get("ProcessorArchitecture")


def _env_root(spec, environ):
    base = (environ or {}).get(spec["env"]) or (environ or {}).get(spec["env"].upper())
    need(isinstance(base, str) and base, "BINARY_UNAVAILABLE")
    return Path(base).joinpath(*spec["path"].split("/"))


def select_runtime(root, name, digest, size):
    """The app's per-user copy byte-identical to the verified package binary; exactly one, else refuse."""
    root = Path(root)
    _plain_dirs(root / "x")
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except FileNotFoundError:
        raise TrustRefusal("BINARY_UNAVAILABLE") from None
    need(len(entries) <= 256, "RUNTIME_BINARY_AMBIGUOUS")
    matches = []
    for entry in entries:
        if not re.fullmatch("[0-9a-f]{16}", entry.name):
            continue
        folder = Path(entry.path)
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or folder.is_symlink() or getattr(info, "st_file_attributes", 0) & 1024:
            continue
        candidate = folder / name
        try:
            c = candidate.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(c.st_mode) or c.st_size != size:
            continue
        if checked_sha256(candidate)[0] == digest:
            matches.append(candidate)
    need(matches, "BINARY_UNAVAILABLE")
    need(len(matches) == 1, "RUNTIME_BINARY_AMBIGUOUS")
    return str(matches[0]).replace("\\", "/")


def measure_codex(publisher, identity, environ):
    pk = publisher["package"]
    root = _env_root(pk["installRoot"], environ)

    def norm(text):
        return text.replace("\\", "/").rstrip("/").lower()  # Windows paths compare without case
    need(norm(identity["installLocation"]) == norm(str(root) + "/" + identity["packageFullName"]),
         "BINARY_SELECTION_CHANGED")
    base = Path(identity["installLocation"].replace("\\", "/"))
    manifest = checked_bytes(base / "AppxManifest.xml", 1048576)
    need(manifest_identity(manifest) == (pk["name"], pk["publisher"], identity["version"], pk["architecture"]),
         "MANIFEST_IDENTITY")
    blockmap = checked_sha256(base / "AppxBlockMap.xml", 67108864)[0]
    binary, size = checked_sha256(base.joinpath(*publisher["binary"]["packageRelativePath"].split("/")))
    copy_spec = publisher["binary"]["runtimeCopy"]
    runtime = select_runtime(_env_root(copy_spec, environ), copy_spec["name"], binary, size)
    return {"appxManifestSha256": hashlib.sha256(manifest).hexdigest(), "appxBlockMapSha256": blockmap,
            "binarySha256": binary, "binarySize": size, "runtimeBinary": runtime}


def claude_package_facts(binary_path, publisher):
    """(package dir, package.json facts) for an npm-native binary path, or a named refusal."""
    binary = Path(binary_path)
    relative = publisher["package"]["binaryRelativePath"].split("/")
    package_dir = binary
    for _ in relative:
        package_dir = package_dir.parent
    need(package_dir.joinpath(*relative) == binary, "BINARY_SELECTION_CHANGED")
    raw = checked_bytes(package_dir / "package.json", 1048576)
    try:
        value = json.loads(raw)
    except ValueError:
        raise TrustRefusal("PACKAGE_METADATA") from None
    need(isinstance(value, dict), "PACKAGE_METADATA")
    return package_dir, {"name": value.get("name"), "version": value.get("version"),
                         "packageJsonSha256": hashlib.sha256(raw).hexdigest()}


# ── the ledger: append-only, hash-chained ─────────────────────────────────────

LEDGER_FIELDS = frozenset(("schemaVersion", "seq", "prevEntrySha256", "product", "os", "version", "publisher",
                           "identity", "measured", "policySha256", "verifiedAt", "repeatedVersion"))


def _ledger_key(entry):
    return (entry["product"], entry["os"], entry["version"], canonical(entry["measured"]))


def ledger_entries(path):
    """Every entry, verified. Any edit, reorder, torn line or foreign line fails closed."""
    path = Path(path)
    try:
        path.lstat()
    except FileNotFoundError:
        return [], "0" * 64, None
    raw = checked_bytes(path, LEDGER_MAX, hardlinks=False)
    need(raw == b"" or raw.endswith(b"\n"), "TRUST_LEDGER_CORRUPT")
    entries, prev = [], "0" * 64
    for seq, row in enumerate(raw.split(b"\n")[:-1], 1):
        try:
            entry = json.loads(row)
        except ValueError:
            raise TrustRefusal("TRUST_LEDGER_CORRUPT") from None
        need(isinstance(entry, dict) and set(entry) == LEDGER_FIELDS and entry.get("schemaVersion") == 1
             and entry.get("seq") == seq and entry.get("prevEntrySha256") == prev, "TRUST_LEDGER_CORRUPT")
        need(canonical(entry) == row, "TRUST_LEDGER_CORRUPT")
        prev = hashlib.sha256(row).hexdigest()
        entries.append(entry)
    return entries, prev, path.lstat()


def record_version(path, record):
    """A build not seen before is appended once, after it verified; a known build is never re-recorded."""
    path = Path(path)
    entries, prev, before = ledger_entries(path)
    for entry in entries:
        if _ledger_key(entry) == _ledger_key(record):
            return entry, False
    entry = dict(record, schemaVersion=1, seq=len(entries) + 1, prevEntrySha256=prev, verifiedAt=now_iso(),
                 repeatedVersion=any((e["product"], e["version"]) == (record["product"], record["version"])
                                     for e in entries))
    need(set(entry) == LEDGER_FIELDS, "TRUST_LEDGER_CORRUPT")
    row = canonical(entry) + b"\n"
    need(len(row) <= 16384 and (before.st_size if before else 0) + len(row) <= LEDGER_MAX, "TRUST_LEDGER_SIZE")
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = (os.O_WRONLY | os.O_APPEND | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
             | (os.O_CREAT | os.O_EXCL if before is None else 0))
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        raise TrustRefusal("TRUST_LEDGER_CORRUPT") from None
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_size == (before.st_size if before else 0)
             and (before is None or (info.st_ino, info.st_dev) == (before.st_ino, before.st_dev)),
             "TRUST_LEDGER_CORRUPT")
        need(os.write(fd, row) == len(row), "TRUST_LEDGER_CORRUPT")
        os.fsync(fd)
    finally:
        os.close(fd)
    return entry, True


# ── the one entry point ───────────────────────────────────────────────────────

def os_name(platform=None):
    platform = sys.platform if platform is None else platform
    return {"win32": "windows", "darwin": "macos"}.get(platform, "linux")


class TrustChecker:
    """Verifies one product's installed binary. Injectable seams: `facts` (the PowerShell reads) and `environ`."""

    def __init__(self, policy, ledger_path, environ=None, platform=None, codex_facts=None, file_signature=None):
        self.policy = policy
        self.ledger_path = Path(ledger_path)
        self.environ = dict(os.environ if environ is None else environ)
        self.platform = sys.platform if platform is None else platform
        self.codex_facts = codex_facts or (lambda publisher: windows_codex_facts(publisher, self.environ))
        self.file_signature = file_signature or (lambda path: windows_file_signature(path, self.environ))

    def _verify(self, product, binary_path=None):
        system = os_name(self.platform)
        need(system == "windows", "PLATFORM_NOT_SUPPORTED")
        rule = rule_for(self.policy, product, system)
        facts = None
        try:
            if rule["kind"] == "msix":
                facts = self.codex_facts(rule["publishers"][0])
                publisher, identity = verify_codex_facts(rule, facts)
                measured = measure_codex(publisher, identity, self.environ)
                run = measured["runtimeBinary"]
            else:
                need(binary_path, "BINARY_UNAVAILABLE")
                package_dir, package = claude_package_facts(binary_path, rule["publishers"][0])
                digest, size = checked_sha256(binary_path)
                facts = {"package": package, "binarySignature": self.file_signature(binary_path)}
                publisher, identity = verify_claude_facts(rule, facts)
                measured = {"binarySha256": digest, "binarySize": size,
                            "packageJsonSha256": package["packageJsonSha256"],
                            "runtimeBinary": str(Path(binary_path)).replace("\\", "/")}
                # The bytes signed are the bytes measured: hash again after the signature read.
                need(checked_sha256(binary_path) == (digest, size), "BINARY_CHANGED")
                run = measured["runtimeBinary"]
        except TrustRefusal as refusal:
            refusal.observed = observed_summary(facts)
            raise
        record = {"product": product, "os": system, "version": identity["version"], "publisher": identity["publisher"],
                  "identity": {k: v for k, v in identity.items() if k not in ("installLocation", "publisher")},
                  "measured": measured, "policySha256": self.policy["_sha256"]}
        return record, run

    def check(self, product, binary_path=None):
        """Verify, then record a new build in the ledger. Returns the record plus newlyRecorded/ledgerSeq."""
        record, run = self._verify(product, binary_path)
        entry, new = record_version(self.ledger_path, record)
        return dict(record, runBinary=run, newlyRecorded=new, ledgerSeq=entry["seq"],
                    ledgerEntrySha256=hashlib.sha256(canonical(entry)).hexdigest(), firstVerifiedAt=entry["verifiedAt"])

    def recheck(self, product, expected, binary_path=None):
        """Within one run: the very same build, else BINARY_CHANGED (before a spawn and after the child exits).

        For an npm-native binary the signed bytes are the measured bytes, so the same sha256 and size are the
        same verified build; an msix package is read again in full (its registration can change too)."""
        rule = rule_for(self.policy, product, os_name(self.platform))
        if rule["kind"] == "npm-native":
            need(binary_path and str(Path(binary_path)).replace("\\", "/") == expected["runBinary"], "BINARY_CHANGED")
            need(checked_sha256(binary_path) == (expected["measured"]["binarySha256"],
                                                 expected["measured"]["binarySize"]), "BINARY_CHANGED")
            return expected
        record, run = self._verify(product, binary_path)
        need(record["version"] == expected["version"] and record["measured"] == expected["measured"]
             and run == expected["runBinary"], "BINARY_CHANGED")
        return expected


def trust_summary(record):
    keys = ("product", "os", "version", "publisher", "measured", "identity", "policySha256", "newlyRecorded",
            "ledgerSeq", "ledgerEntrySha256", "firstVerifiedAt")
    return {k: record[k] for k in keys if k in record}


def failure_code(error):
    if isinstance(error, TrustRefusal) and error.code in CODES:
        return error.code
    return "TRUST_OTHER"
