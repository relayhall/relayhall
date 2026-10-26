"""`relayhall connection-skill install` (card 94e8bb0b, item 3).

The installer is driven through the REAL argparse tree and dispatcher of the
extensionless `relayhall` script, with api() replaced by a recording fake and
HOME / CODEX_HOME / CLAUDE_CONFIG_DIR pointed at a temporary directory. What
these pin:

 - Claude Code and Codex each get `relayhall-connection/SKILL.md` under their
   own skills directory, holding ONLY the alias and origin, the registry Skill
   identity/version/digest, refresh instructions and a credential reference;
 - a second run with the same inputs writes nothing (bytes AND mtime unchanged);
 - text a person wrote outside the managed block, and sibling skills, survive;
 - an unsupported harness prints manual instructions, exits 3 and writes nothing;
 - a credential is refused wherever it could be smuggled in, and never lands
   in the file even when the CLI itself is holding one;
 - a board with no published Version, or one that refuses the lookup, leaves
   the filesystem untouched;
 - the refresh step's ifNoneMatch is the quoted etag form, and the renderer
   still writes the golden block the backend sends through the real content
   route (backend/src/__tests__/connectorSkillRevalidation.test.ts).
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
SKILL_ID = "7433a98f-dad0-4e65-9217-5717c75bfaf5"
VERSION_ID = "0b7c90b0-7e68-48b4-b295-23cbfd65cd20"
SHA = "09dbcfb7b95b4835e0e72e17b3bee99aac113e7415fec01e980b930cd5328395"
NEWER_SHA = "a" * 64
REAL_TOKEN = "rh_dev_ab12cd34ef56.SECRETVALUE0000000000"
TOKEN_SHAPE = r"rh_[a-z]+_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{20,128}"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_connection_skill",
        importlib.machinery.SourceFileLoader("relayhall_cli_connection_skill", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()
import relayhall_connection_skill as installer  # noqa: E402  (the module the script registers)


def published(sha=SHA, version=1):
    return {"success": True, "skills": [
        # A near-miss name first: the lookup must take the EXACT catalog name.
        {"id": "11111111-1111-4111-8111-111111111111", "name": "relayhall-connector-bootstrap-old",
         "current_published_version_id": "22222222-2222-4222-8222-222222222222",
         "published_version": {"id": "22222222-2222-4222-8222-222222222222", "version": 9, "content_sha256": "b" * 64}},
        {"id": SKILL_ID, "name": "relayhall-connector-bootstrap", "current_published_version_id": VERSION_ID,
         "published_version": {"id": VERSION_ID, "version": version, "content_sha256": sha}},
    ]}


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    for name in ("CODEX_HOME", "CLAUDE_CONFIG_DIR", "RELAYHALL_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(cli, "_CLI_API", "https://board.example/api")
    calls = []
    state = {"reply": published()}

    def fake_api(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
        calls.append((method, path))
        return state["reply"]

    monkeypatch.setattr(cli, "api", fake_api)
    return {"home": home, "calls": calls, "state": state, "tmp": tmp_path}


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    old = sys.argv
    sys.argv = ["relayhall", *argv]
    try:
        with redirect_stdout(out), redirect_stderr(err):
            with pytest.raises(SystemExit) as exit_info:
                cli.main()
    finally:
        sys.argv = old
    return exit_info.value.code, out.getvalue(), err.getvalue()


def snapshot(root):
    """Every file under root with its bytes and mtime, for "nothing changed" claims."""
    return {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in sorted(Path(root).rglob("*")) if p.is_file()}


CLAUDE_TARGET = Path(".claude") / "skills" / "relayhall-connection" / "SKILL.md"
CODEX_TARGET = Path(".codex") / "skills" / "relayhall-connection" / "SKILL.md"


def test_claude_code_gets_a_pointer_with_only_the_permitted_fields(env):
    code, out, _ = run("connection-skill", "install", "--harness", "claude-code")
    assert code == 0
    target = env["home"] / CLAUDE_TARGET
    text = target.read_text(encoding="utf-8")
    assert f"Installed the RelayHall connection skill for Claude Code: {target}" in out
    # The registry was asked by exact name, once.
    assert env["calls"] == [("GET", "/skills?search=relayhall-connector-bootstrap")]
    # Agent-Skills frontmatter whose name matches the directory.
    assert text.startswith("---\nname: relayhall-connection\ndescription: ")
    # The four permitted kinds of content, and their values.
    assert "- MCP server alias: `relayhall`" in text
    assert "- MCP origin: https://board.example/api/mcp" in text
    assert f"id `{SKILL_ID}`, version 1, sha256 `{SHA}`" in text
    assert "- Credential: kept in the RELAYHALL_TOKEN environment variable. This file never holds it." in text
    assert "relayhall_brief_compile" in text and "ifNoneMatch" in text
    # Nothing else: the managed block is exactly the bullet list and the refresh steps.
    block = text[text.index(installer.BEGIN):text.index(installer.END) + len(installer.END)]
    bullets = [line for line in block.split("\n") if line.startswith("- ")]
    assert [b.split(":")[0] for b in bullets] == [
        "- MCP server alias", "- MCP origin", "- Credential", "- Registry Skill"]
    assert "Bearer" not in text


def test_codex_honours_codex_home(env, monkeypatch):
    codex_home = env["tmp"] / "codex-home"
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    code, out, _ = run("connection-skill", "install", "--harness", "codex")
    assert code == 0
    target = codex_home / "skills" / "relayhall-connection" / "SKILL.md"
    assert target.exists()
    assert not (env["home"] / CODEX_TARGET).exists()
    assert "for Codex" in out


def test_codex_defaults_to_the_home_directory(env):
    code, _, _ = run("connection-skill", "install", "--harness", "codex")
    assert code == 0
    assert (env["home"] / CODEX_TARGET).exists()


def test_claude_code_honours_claude_config_dir(env, monkeypatch):
    config = env["tmp"] / "claude-config"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    assert run("connection-skill", "install", "--harness", "claude-code")[0] == 0
    assert (config / "skills" / "relayhall-connection" / "SKILL.md").exists()


ANTIGRAVITY_TARGET = Path(".gemini") / "antigravity" / "skills" / "relayhall-connection" / "SKILL.md"


def test_antigravity_gets_the_pointer_where_it_reads_global_skills(env):
    """Owner ruling E475 (2): Antigravity keeps its global skills under ~/.gemini/antigravity/skills."""
    code, out, _ = run("connection-skill", "install", "--harness", "antigravity")
    assert code == 0
    target = env["home"] / ANTIGRAVITY_TARGET
    assert f"Installed the RelayHall connection skill for Antigravity: {target}" in out
    text = target.read_text(encoding="utf-8")
    assert text.startswith("---\nname: relayhall-connection\ndescription: ")
    assert f"id `{SKILL_ID}`, version 1, sha256 `{SHA}`" in text and "Bearer" not in text
    # Only that one file: nothing under Gemini CLI's own ~/.gemini/skills, nothing in the MCP config folder.
    assert list(snapshot(env["home"])) == [str(ANTIGRAVITY_TARGET)]


def test_antigravity_is_no_longer_an_unsupported_harness(env):
    assert "antigravity" in installer.HARNESSES
    code, out, _ = run("connection-skill", "install", "--harness", "antigravity", "--dry-run")
    assert code == 0 and "Not installed" not in out


@pytest.mark.parametrize("harness", ["claude-code", "codex", "antigravity"])
def test_a_second_run_changes_nothing(env, harness):
    assert run("connection-skill", "install", "--harness", harness)[0] == 0
    before = snapshot(env["home"])
    assert len(before) == 1
    code, out, _ = run("connection-skill", "install", "--harness", harness)
    assert code == 0
    assert "Unchanged:" in out and "Nothing was written." in out
    assert snapshot(env["home"]) == before


def test_control_a_newer_published_version_is_a_change(env):
    # Without this, "a second run changes nothing" could be a writer that never writes.
    assert run("connection-skill", "install", "--harness", "codex")[0] == 0
    before = snapshot(env["home"])
    env["state"]["reply"] = published(sha=NEWER_SHA, version=2)
    code, out, _ = run("connection-skill", "install", "--harness", "codex")
    assert code == 0 and "Installed" in out
    after = snapshot(env["home"])
    assert after != before
    assert f"version 2, sha256 `{NEWER_SHA}`" in (env["home"] / CODEX_TARGET).read_text(encoding="utf-8")


def test_text_outside_the_managed_block_and_sibling_skills_survive(env):
    skills = env["home"] / ".claude" / "skills"
    sibling = skills / "my-own-skill" / "SKILL.md"
    sibling.parent.mkdir(parents=True)
    sibling.write_text("---\nname: my-own-skill\ndescription: mine\n---\nkeep me\n", encoding="utf-8")
    target = skills / "relayhall-connection" / "SKILL.md"
    target.parent.mkdir(parents=True)
    mine = "---\nname: relayhall-connection\ndescription: my words\n---\n\nMy note above.\n"
    target.write_text(mine, encoding="utf-8")
    sibling_before = sibling.read_bytes()

    assert run("connection-skill", "install", "--harness", "claude-code")[0] == 0
    text = target.read_text(encoding="utf-8")
    assert text.startswith(mine)  # appended, never rewritten
    assert installer.BEGIN in text and installer.END in text

    # A person adds a line after the block; the next install keeps both of their lines.
    target.write_text(text + "My note below.\n", encoding="utf-8")
    env["state"]["reply"] = published(sha=NEWER_SHA, version=2)
    assert run("connection-skill", "install", "--harness", "claude-code")[0] == 0
    text = target.read_text(encoding="utf-8")
    assert text.startswith(mine)
    assert text.endswith(installer.END + "\nMy note below.\n")
    assert text.count(installer.BEGIN) == 1
    assert f"sha256 `{NEWER_SHA}`" in text and SHA not in text
    assert sibling.read_bytes() == sibling_before


def test_damaged_markers_are_refused_without_writing(env):
    target = env["home"] / CLAUDE_TARGET
    target.parent.mkdir(parents=True)
    target.write_text(f"intro\n{installer.BEGIN}\nhalf a block\n", encoding="utf-8")
    before = snapshot(env["home"])
    code, _, err = run("connection-skill", "install", "--harness", "claude-code")
    assert code == 1
    assert "markers in the existing file are damaged" in err
    assert snapshot(env["home"]) == before


@pytest.mark.parametrize("harness", ["gemini", "chatgpt", "vs-code"])
def test_an_unsupported_harness_gets_manual_instructions_and_no_success(env, harness):
    code, out, _ = run("connection-skill", "install", "--harness", harness)
    assert code == installer.EXIT_UNSUPPORTED == 3
    assert out.startswith(f"Not installed: this installer has no local skill location for '{harness}'")
    assert "Manual setup for" in out and "bootstrap prompt" in out
    assert "https://board.example/api/mcp" in out
    assert "No file was written." in out
    assert "Installed" not in out
    assert snapshot(env["home"]) == {}
    assert env["calls"] == []  # nothing to look up for a harness it cannot install into


@pytest.mark.parametrize("ref", [
    REAL_TOKEN,
    f"vault item {REAL_TOKEN}",
    "Bearer abc123",
    "rh_live_k3y1d0.0123456789abcdefghijKLMN",
])
def test_a_credential_is_refused_as_the_credential_reference(env, ref):
    code, _, err = run("connection-skill", "install", "--harness", "codex", "--credential-ref", ref)
    assert code == 1
    assert "looks like a credential" in err
    assert snapshot(env["home"]) == {}


def test_the_credential_the_cli_holds_never_reaches_the_file(env, monkeypatch):
    monkeypatch.setenv("RELAYHALL_TOKEN", "opaque-session-credential-value")
    code, _, err = run("connection-skill", "install", "--harness", "codex",
                       "--credential-ref", "keychain opaque-session-credential-value")
    assert code == 1 and "contains the credential this CLI is using" in err
    assert snapshot(env["home"]) == {}
    # The ordinary reference installs, and the held value is nowhere in the bytes.
    assert run("connection-skill", "install", "--harness", "codex")[0] == 0
    raw = (env["home"] / CODEX_TARGET).read_text(encoding="utf-8")
    assert "opaque-session-credential-value" not in raw


def test_control_the_token_shape_used_above_matches_a_minted_credential():
    import re
    assert re.search(TOKEN_SHAPE, REAL_TOKEN)
    assert installer.TOKEN_SHAPE.search(REAL_TOKEN)
    assert not installer.TOKEN_SHAPE.search("the RELAYHALL_TOKEN environment variable")


@pytest.mark.parametrize("origin", [
    "https://user:pass@board.example/api/mcp",
    "https://board.example/api/mcp?token=abc",
    "ftp://board.example/mcp",
    "not a url",
])
def test_an_origin_that_could_carry_a_secret_or_is_not_http_is_refused(env, origin):
    code, _, err = run("connection-skill", "install", "--harness", "codex", "--origin", origin)
    assert code == 1 and "--origin" in err
    assert snapshot(env["home"]) == {}


def test_a_board_without_a_published_version_writes_nothing(env):
    reply = published()
    reply["skills"][1]["current_published_version_id"] = None
    reply["skills"][1]["published_version"] = None
    env["state"]["reply"] = reply
    code, _, err = run("connection-skill", "install", "--harness", "claude-code")
    assert code == 1 and "has no published Version" in err
    assert snapshot(env["home"]) == {}


def test_a_refused_lookup_writes_nothing(env):
    env["state"]["reply"] = {"success": False, "error": "Forbidden", "status": 403}
    code, _, err = run("connection-skill", "install", "--harness", "claude-code")
    assert code == 1 and "HTTP 403" in err
    assert snapshot(env["home"]) == {}


def test_a_skill_the_credential_cannot_read_writes_nothing(env):
    env["state"]["reply"] = {"success": True, "skills": []}
    code, _, err = run("connection-skill", "install", "--harness", "codex")
    assert code == 1 and "is not among the Skills this credential can read" in err
    assert snapshot(env["home"]) == {}


def test_explicit_identity_skips_the_registry_and_must_be_complete(env):
    code, _, _ = run("connection-skill", "install", "--harness", "codex",
                     "--skill-id", SKILL_ID, "--skill-version", "1", "--skill-sha256", SHA)
    assert code == 0 and env["calls"] == []
    code, _, err = run("connection-skill", "install", "--harness", "codex", "--skill-id", SKILL_ID)
    assert code == 1 and "go together" in err


def test_dry_run_prints_and_writes_nothing(env):
    code, out, _ = run("connection-skill", "install", "--harness", "claude-code", "--dry-run")
    assert code == 0
    assert "Dry run for Claude Code" in out and installer.BEGIN in out and "Nothing was written." in out
    assert snapshot(env["home"]) == {}


GOLDEN = Path(__file__).resolve().parent.parent / "backend" / "src" / "__tests__" / "fixtures" / "connection-skill-block.json"
ETAG_STEP = re.compile(r"`ifNoneMatch` set to `([^`]+)`")


def test_the_refresh_step_sends_the_etag_form_never_the_bare_digest(env):
    # Round-1 blocker B1: the content route answers "not modified" only to the
    # quoted ETag. A bare digest is always a full refetch, which this pointer's
    # own rule would read as "a newer Version is published" on every refresh.
    assert run("connection-skill", "install", "--harness", "claude-code")[0] == 0
    text = (env["home"] / CLAUDE_TARGET).read_text(encoding="utf-8")
    assert ETAG_STEP.findall(text) == [f'"{SHA}"']
    assert f"set to `{SHA}`" not in text


def test_the_renderer_still_writes_the_golden_block_the_backend_revalidates_with():
    # backend/src/__tests__/connectorSkillRevalidation.test.ts sends this
    # block's ifNoneMatch value through relayhall_skill_get to the real content
    # route and expects "not modified". This binds that proof to the renderer:
    # a change to the block must regenerate the fixture both suites read.
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    inputs = golden["inputs"]
    block = installer.render_block(inputs["alias"], inputs["origin"], inputs["credentialRef"], inputs["skill"])
    assert block == golden["block"]
    assert ETAG_STEP.findall(block) == [f'"{inputs["skill"]["sha256"]}"']
