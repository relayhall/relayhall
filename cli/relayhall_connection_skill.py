"""Harness-local connection skill installer (card 94e8bb0b, item 3).

`relayhall connection-skill install --harness claude-code|codex|antigravity`
writes one concise pointer Skill where the harness keeps local skills:

  Claude Code  $CLAUDE_CONFIG_DIR/skills, else ~/.claude/skills
  Codex        $CODEX_HOME/skills, else ~/.codex/skills
  Antigravity  ~/.gemini/antigravity/skills (its global skills folder; owner
               ruling E475 (2)). Not ~/.gemini/skills, which is Gemini CLI's.

as `relayhall-connection/SKILL.md`. The file holds ONLY the connection alias
and MCP origin, the registry Skill's id, version and SHA-256 digest, refresh
and discovery instructions, and a reference to where the credential is kept.

Three properties, each pinned by cli/test_connection_skill.py:

  NO CREDENTIAL. The renderer is never handed one, every input is validated
  against token-shaped text, and the finished bytes are checked again before
  anything is written.
  IDEMPOTENT. A re-run with the same inputs compares bytes and writes nothing.
  PRESERVING. Only the text between the managed markers is ever replaced;
  anything a person wrote around it, and every other skill, stays as it was.

Any other harness gets manual instructions and exit status 3, never a
success line: this installer only claims what it actually wrote.
"""
import os
import re
import sys
import urllib.parse
from pathlib import Path

REGISTRY_SKILL = "relayhall-connector-bootstrap"
LOCAL_SKILL = "relayhall-connection"
DEFAULT_ALIAS = "relayhall"
DEFAULT_CREDENTIAL_REF = "the RELAYHALL_TOKEN environment variable"
BEGIN_PREFIX = "<!-- relayhall-connection:begin"
BEGIN = BEGIN_PREFIX + " (managed by `relayhall connection-skill install`; edit outside this block) -->"
END = "<!-- relayhall-connection:end -->"
EXIT_UNSUPPORTED = 3

# The credential grammar the board mints (`rh_<env>_<keyId>.<secret>`), with
# the environment segment left open so a new prefix is still caught.
TOKEN_SHAPE = re.compile(r"rh_[a-z]+_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}")
UUID_SHAPE = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
SHA256_SHAPE = re.compile(r"[0-9a-f]{64}")
ALIAS_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")

# (label, environment variable that moves the folder or None, default folder under the home directory)
HARNESSES = {
    "claude-code": ("Claude Code", "CLAUDE_CONFIG_DIR", ".claude"),
    "codex": ("Codex", "CODEX_HOME", ".codex"),
    "antigravity": ("Antigravity", None, os.path.join(".gemini", "antigravity")),
}

FRONTMATTER = (
    "---\n"
    f"name: {LOCAL_SKILL}\n"
    'description: "Reconnect this harness to its RelayHall board and revalidate the registry '
    'onboarding Skill. Use at session start, or when RelayHall tools are missing or refused."\n'
    "---\n"
)


class InstallError(Exception):
    """A refusal that leaves the filesystem untouched."""


def register(sub):
    parser = sub.add_parser(
        "connection-skill",
        help="Install a local RelayHall connection skill for Claude Code, Codex or Antigravity",
    )
    verbs = parser.add_subparsers(dest="connection_skill_command", required=True)
    install = verbs.add_parser(
        "install",
        help="Write or refresh relayhall-connection/SKILL.md for one harness (never a credential)",
    )
    install.add_argument("--harness", required=True,
                         help="claude-code, codex or antigravity; any other value prints manual instructions")
    install.add_argument("--alias", default=DEFAULT_ALIAS,
                         help=f"MCP server name in the harness configuration (default {DEFAULT_ALIAS})")
    install.add_argument("--origin",
                         help="MCP endpoint URL (default: the CLI's API URL followed by /mcp)")
    install.add_argument("--credential-ref", default=DEFAULT_CREDENTIAL_REF,
                         help="Where the credential is kept, e.g. a vault item name. Never the credential.")
    install.add_argument("--skill-id", help="Registry Skill id (skips the registry lookup with the two below)")
    install.add_argument("--skill-version", type=int, help="Registry Skill Version number")
    install.add_argument("--skill-sha256", help="Registry Skill Version SHA-256 digest")
    install.add_argument("--dry-run", action="store_true", help="Print the path and content; write nothing")


def skills_root(harness, environ=None):
    environ = os.environ if environ is None else environ
    _label, variable, default_dir = HARNESSES[harness]
    base = (environ.get(variable) if variable else None) or os.path.join(os.path.expanduser("~"), default_dir)
    return Path(base) / "skills"


def _known_secrets(environ):
    value = environ.get("RELAYHALL_TOKEN") or ""
    return [value] if len(value) >= 8 else []


def _refuse_secret(label, text, secrets):
    if TOKEN_SHAPE.search(text) or re.search(r"\bbearer\s+\S", text, re.IGNORECASE):
        raise InstallError(f"{label} looks like a credential; name where it is kept instead. Nothing was written.")
    for secret in secrets:
        if secret in text:
            raise InstallError(f"{label} contains the credential this CLI is using. Nothing was written.")


def validate_origin(origin):
    parsed = urllib.parse.urlsplit(origin or "")
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise InstallError(f"--origin must be an http(s) URL, got {origin!r}. Nothing was written.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise InstallError("--origin must not carry user information, a query or a fragment. Nothing was written.")
    return origin.rstrip("/")


def validate_inputs(alias, origin, credential_ref, environ):
    if not ALIAS_SHAPE.fullmatch(alias or ""):
        raise InstallError(f"--alias must be 1-64 letters, digits, '-' or '_', got {alias!r}. Nothing was written.")
    origin = validate_origin(origin)
    ref = (credential_ref or "").strip()
    if not ref or len(ref) > 200 or "\n" in ref or "\r" in ref:
        raise InstallError("--credential-ref must be one short line naming where the credential is kept. Nothing was written.")
    secrets = _known_secrets(environ)
    _refuse_secret("--origin", origin, secrets)
    _refuse_secret("--credential-ref", ref, secrets)
    return alias, origin, ref


def resolve_registry_skill(api, skill_id=None, version=None, sha256=None):
    """The published Version's identity, from flags or from the board's registry."""
    given = [value is not None for value in (skill_id, version, sha256)]
    if any(given) and not all(given):
        raise InstallError("--skill-id, --skill-version and --skill-sha256 go together. Nothing was written.")
    if all(given):
        identity = {"id": skill_id, "version": version, "sha256": sha256}
    else:
        query = urllib.parse.urlencode({"search": REGISTRY_SKILL})
        try:
            result = api("GET", f"/skills?{query}", exit_on_error=False)
        except OSError as error:  # urllib's URLError is an OSError: the board was not reached
            raise InstallError(f"could not reach the board ({error}). Nothing was written.") from error
        if not isinstance(result, dict) or result.get("success") is False:
            status = result.get("status") if isinstance(result, dict) else None
            raise InstallError(
                f"the board refused the Skill lookup (HTTP {status}); check the CLI's API URL and credential. "
                "Nothing was written.")
        match = next((s for s in result.get("skills") or [] if s.get("name") == REGISTRY_SKILL), None)
        if match is None:
            raise InstallError(f"{REGISTRY_SKILL} is not among the Skills this credential can read. Nothing was written.")
        published = match.get("published_version") or {}
        if not match.get("current_published_version_id") or published.get("id") != match.get("current_published_version_id"):
            raise InstallError(f"{REGISTRY_SKILL} has no published Version on this board. Nothing was written.")
        identity = {"id": match.get("id"), "version": published.get("version"), "sha256": published.get("content_sha256")}
    if not isinstance(identity["id"], str) or not UUID_SHAPE.fullmatch(identity["id"]):
        raise InstallError("the registry Skill id is not a UUID. Nothing was written.")
    if not isinstance(identity["version"], int) or isinstance(identity["version"], bool) or identity["version"] < 1:
        raise InstallError("the registry Skill version must be a positive whole number. Nothing was written.")
    if not isinstance(identity["sha256"], str) or not SHA256_SHAPE.fullmatch(identity["sha256"]):
        raise InstallError("the registry Skill digest must be 64 lowercase hex characters. Nothing was written.")
    return identity


def render_block(alias, origin, credential_ref, identity):
    """The managed block. Takes no credential, by signature."""
    lines = [
        BEGIN,
        "# RelayHall connection",
        "",
        f"- MCP server alias: `{alias}`",
        f"- MCP origin: {origin}",
        f"- Credential: kept in {credential_ref}. This file never holds it.",
        f"- Registry Skill: `{REGISTRY_SKILL}`, id `{identity['id']}`, version {identity['version']}, "
        f"sha256 `{identity['sha256']}`",
        "",
        "## Refresh and discovery",
        "",
        f"1. Call `relayhall_brief_compile` with `{{\"session\": true}}` through the `{alias}` server.",
        "2. Revalidate the Skill: `relayhall_skill_get` with the id above, `fullContent: true` and "
        f"`ifNoneMatch` set to `\"{identity['sha256']}\"`: the etag, which is the sha256 above in double "
        "quotes; the bare digest never matches. \"not modified\" means this pointer is current; new content "
        "means a newer Version is published, so follow it and re-run `relayhall connection-skill install`.",
        "3. Follow the registry Skill. This file points at it and never replaces it.",
        "4. If the server is missing or refuses the credential, stop and report; never search for, paste or "
        "store a credential.",
        END,
    ]
    return "\n".join(lines)


def merge(existing, block):
    """New file content; only the managed block ever changes."""
    if existing is None:
        return FRONTMATTER + "\n" + block + "\n"
    lines = existing.split("\n")
    begins = [i for i, line in enumerate(lines) if line.rstrip("\r").startswith(BEGIN_PREFIX)]
    ends = [i for i, line in enumerate(lines) if line.rstrip("\r") == END]
    if not begins and not ends:
        separator = "" if existing.endswith("\n") else "\n"
        return existing + separator + "\n" + block + "\n"
    if len(begins) == 1 and len(ends) == 1 and begins[0] < ends[0]:
        return "\n".join(lines[:begins[0]] + block.split("\n") + lines[ends[0] + 1:])
    raise InstallError("the managed relayhall-connection markers in the existing file are damaged; "
                       "repair or remove them by hand. Nothing was written.")


def manual_instructions(harness, alias, origin):
    supported = ", ".join(sorted(HARNESSES))
    return "\n".join([
        f"Not installed: this installer has no local skill location for {harness!r} (supported: {supported}).",
        f"Manual setup for {harness}:",
        f"  1. Register the MCP server {alias!r} at {origin}, with the credential in that client's secret store",
        "     or environment; the connection's setup blocks in the dashboard show the shape.",
        "  2. Start each session with the bootstrap prompt from the dashboard. It loads the published",
        f"     {REGISTRY_SKILL} Skill from the registry, so nothing needs to be stored locally.",
        "  3. If the client keeps persistent instructions, record there only the server alias and origin and",
        "     where the credential is kept. Never the credential.",
        "No file was written.",
    ])


def install(args, api, api_url, environ=None, out=None):
    environ = os.environ if environ is None else environ
    out = sys.stdout if out is None else out
    harness = (args.harness or "").strip().lower()
    origin_default = (api_url or "").rstrip("/") + "/mcp"
    alias, origin, credential_ref = validate_inputs(args.alias, args.origin or origin_default,
                                                    args.credential_ref, environ)
    if harness not in HARNESSES:
        print(manual_instructions(args.harness, alias, origin), file=out)
        return EXIT_UNSUPPORTED
    identity = resolve_registry_skill(api, args.skill_id, args.skill_version, args.skill_sha256)
    block = render_block(alias, origin, credential_ref, identity)
    target = skills_root(harness, environ) / LOCAL_SKILL / "SKILL.md"
    if target.is_symlink():
        raise InstallError(f"{target} is a symbolic link; refusing to write through it. Nothing was written.")
    existing = target.read_text(encoding="utf-8") if target.exists() else None
    # Belt and braces: the block is built from validated inputs only, and is
    # checked once more as the bytes that will land on disk.
    _refuse_secret("the rendered skill", block, _known_secrets(environ))
    content = merge(existing, block)
    label = HARNESSES[harness][0]
    if args.dry_run:
        print(f"Dry run for {label}: {target}", file=out)
        print(content, file=out, end="" if content.endswith("\n") else "\n")
        print("Nothing was written.", file=out)
        return 0
    if existing == content:
        print(f"Unchanged: {target} already records this connection. Nothing was written.", file=out)
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="") as handle:
        handle.write(content)
    os.replace(temporary, target)
    print(f"Installed the RelayHall connection skill for {label}: {target}", file=out)
    print(f"  {REGISTRY_SKILL} version {identity['version']}, sha256 {identity['sha256'][:12]}...", file=out)
    print(f"  Credential reference: {credential_ref}. No credential was written.", file=out)
    return 0


def run(args, api, api_url):
    try:
        if args.connection_skill_command == "install":
            return install(args, api, api_url)
    except InstallError as error:
        print(f"Not installed: {error}", file=sys.stderr)
        return 1
    return 2
