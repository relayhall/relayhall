"""Skill family CLI coverage (RH-VOCAB.3, amendment A14 Skill/Tool split).

First-ever coverage for the registry noun: the ratified vocabulary renames the
old tools registry to Skills, so this suite pins the /skills REST wiring, the
`relayhall skill <verb>` grammar, the bare-plural `relayhall skills` alias and
the complete absence of the retired `tools` noun. Loads the extensionless
`relayhall` script the same way test_relayhall_projects.py does and runs
offline: api() is replaced with a recording fake, never a live API.
"""
import importlib.machinery
import importlib.util
import io
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
SKILL_ID = "12121212-3434-4565-8787-909090909090"
OTHER_ID = "abcdabcd-1111-4222-8333-444455556666"
PROJECT_ID = "11111111-2222-4333-8444-555555555555"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_skills",
        importlib.machinery.SourceFileLoader("relayhall_cli_skills", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Args:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def list_args(**kw):
    base = dict(category=None, tag=None, search=None, project=None, verbose=False)
    base.update(kw)
    return Args(**base)


def sample_skill(**kw):
    skill = {
        "id": SKILL_ID, "name": "deploy-runner", "category": "deployment",
        "description": "Runs deployments", "usage_instructions": "Use with care.",
        "config": None, "tags": ["ci"], "is_global": True, "version": 1,
        "created_at": "t", "updated_at": "t", "revision": "99999999-8888-4777-8666-555555555554",
        "status": "published", "current_published_version_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }
    skill.update(kw)
    return skill


def run(fn, args):
    out, err = io.StringIO(), io.StringIO()
    code = None
    with redirect_stdout(out), redirect_stderr(err):
        try:
            fn(args)
        except SystemExit as exc:
            code = exc.code
    return out.getvalue(), err.getvalue(), code


def run_main(argv):
    """Drive main() through argparse, capturing streams and the exit code."""
    out, err = io.StringIO(), io.StringIO()
    code = None
    old_argv = sys.argv
    sys.argv = ["relayhall"] + argv
    try:
        with redirect_stdout(out), redirect_stderr(err):
            try:
                cli.main()
            except SystemExit as exc:
                code = exc.code
    finally:
        sys.argv = old_argv
    return out.getvalue(), err.getvalue(), code


@pytest.fixture
def rest(monkeypatch):
    """Records api() calls and replays scripted response payloads."""
    calls = []
    queue = []

    def fake(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
        calls.append((method, path, data))
        if queue:
            return queue.pop(0)
        return {"success": True, "skills": [sample_skill()]}

    monkeypatch.setattr(cli, "api", fake)
    fake.calls = calls
    fake.queue = queue
    return fake


# ─── skill list ───

def test_skill_list_happy_path_hits_skills_route(rest):
    rest.queue.append({"success": True, "skills": [sample_skill()]})
    out, _, code = run(cli.cmd_skill_list, list_args())
    assert code is None
    assert rest.calls == [("GET", "/skills", None)]
    assert "deploy-runner" in out
    assert "deployment" in out.lower()


def test_skill_list_builds_filter_query(rest):
    rest.queue.append({"success": True, "skills": [sample_skill()]})
    run(cli.cmd_skill_list, list_args(category="deployment", tag="ci", search="run"))
    assert rest.calls == [("GET", "/skills?category=deployment&tag=ci&search=run", None)]


def test_skill_list_project_scope_uses_project_skills_route(rest, monkeypatch):
    monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)
    rest.queue.append({"success": True, "skills": [
        {"id": "link-1", "project_id": PROJECT_ID, "skill_id": SKILL_ID,
         "override_instructions": None, "created_at": "t", "skill": sample_skill()},
    ]})
    out, _, code = run(cli.cmd_skill_list, list_args(project="my-project"))
    assert code is None
    assert rest.calls == [("GET", f"/projects/{PROJECT_ID}/skills", None)]
    assert "deploy-runner" in out


# ─── skill get (fuzzy name resolution) ───

def test_skill_get_resolves_fuzzy_name_then_fetches_by_id(rest):
    rest.queue.append({"success": True, "skills": [sample_skill(), sample_skill(id=OTHER_ID, name="docs-writer")]})
    rest.queue.append({"success": True, "skill": sample_skill()})
    rest.queue.append({"success": True, "versions": [{"id": "version-1", "version": 1}]})
    rest.queue.append({"success": True, "version": {"id": "version-1", "version": 1,
        "status": "published", "provenance": "imported", "content_sha256": "abc"}})
    out, err, code = run(cli.cmd_skill_get, Args(skill="deploy runner", full=False, version=None))
    assert code is None
    assert rest.calls == [("GET", "/skills", None), ("GET", f"/skills/{SKILL_ID}", None),
        ("GET", f"/skills/{SKILL_ID}/versions", None),
        ("GET", f"/skills/{SKILL_ID}/versions/version-1", None)]
    assert "deploy-runner" in out
    assert "Matched skill" in err  # fuzzy match was reported


def test_skill_get_unknown_name_fails_with_available_skills(rest):
    rest.queue.append({"success": True, "skills": [sample_skill()]})
    _, err, code = run(cli.cmd_skill_get, Args(skill="zzzzzzzz", full=False, version=None))
    assert code == 1
    assert "No skill found" in err
    assert "deploy-runner" in err


# ─── skill create ───

def test_skill_create_requires_name():
    _, err, code = run_main(["skill", "create"])
    assert code == 2  # argparse usage error, before any API call
    assert "--name" in err


def test_skill_create_posts_to_skills(rest):
    rest.queue.append({"success": True, "skill": sample_skill()})
    args = Args(name="deploy-runner", category="deployment", description=None,
                usage=None, usage_file=None, tags="ci,deploy", skill_global=True)
    out, _, code = run(cli.cmd_skill_create, args)
    assert code is None
    assert rest.calls == [("POST", "/skills", {
        "name": "deploy-runner", "category": "deployment",
        "tags": ["ci", "deploy"],
    })]
    assert "Created Skill draft" in out


def test_draft_commands_reject_retired_global_shortcuts():
    _, create_err, create_code = run_main(["skill", "create", "--name", "demo", "--global"])
    _, update_err, update_code = run_main(["skill", "update", SKILL_ID, "--global"])
    assert create_code == 2 and "unrecognized arguments: --global" in create_err
    assert update_code == 2 and "unrecognized arguments: --global" in update_err


def test_skill_audience_is_a_separate_revision_bound_admin_action(rest):
    rest.queue.append({"success": True, "skills": [sample_skill()]})
    rest.queue.append({"success": True, "skill": sample_skill(is_global=False)})
    out, _, code = run(cli.cmd_skill_audience, Args(skill=SKILL_ID, audience="project"))
    assert code is None
    assert rest.calls == [
        ("GET", "/skills", None),
        ("PATCH", f"/skills/{SKILL_ID}/audience", {"is_global": False}),
    ]
    assert "project pins only" in out


def test_skill_unpin_removes_exact_project_pin(rest, monkeypatch):
    monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)
    rest.queue.append({"success": True, "skills": [sample_skill()]})
    rest.queue.append({"success": True, "message": "removed"})
    out, _, code = run(cli.cmd_skill_unpin, Args(skill=SKILL_ID, project="proj"))
    assert code is None
    assert rest.calls == [
        ("GET", "/skills", None),
        ("DELETE", f"/projects/{PROJECT_ID}/skills/{SKILL_ID}", None),
    ]
    assert "Removed the Project pin" in out


# ─── skill delete ───

def test_skill_delete_requires_confirm(rest):
    rest.queue.append({"success": True, "skills": [sample_skill()]})
    out, _, code = run(cli.cmd_skill_delete, Args(skill=SKILL_ID, confirm=False))
    assert code == 0
    assert "--confirm" in out
    # Only the resolution GET ran; nothing was deleted.
    assert rest.calls == [("GET", "/skills", None)]


def test_skill_delete_with_confirm_deletes(rest):
    rest.queue.append({"success": True, "skills": [sample_skill()]})
    rest.queue.append({"success": True, "message": "deleted"})
    out, _, code = run(cli.cmd_skill_delete, Args(skill=SKILL_ID, confirm=True))
    assert code is None
    assert rest.calls == [("GET", "/skills", None), ("DELETE", f"/skills/{SKILL_ID}", None)]
    assert "Deleted skill" in out


# ─── bare-plural alias and grammar ───

def test_skills_bare_plural_dispatches_to_skill_list(monkeypatch):
    seen = []
    monkeypatch.setattr(cli, "cmd_skill_list", lambda args: seen.append(args))
    _, _, code = run_main(["skills"])
    assert code is None
    assert len(seen) == 1
    # The alias carries the same (defaulted) surface as `skill list`.
    args = seen[0]
    assert args.category is None and args.tag is None and args.search is None
    assert args.project is None and args.verbose is False


def test_skill_list_and_skills_alias_reach_the_same_handler(monkeypatch):
    seen = []
    monkeypatch.setattr(cli, "cmd_skill_list", lambda args: seen.append(args))
    run_main(["skill", "list"])
    run_main(["skills"])
    assert len(seen) == 2


# ─── the tools noun is retired ───

def test_tools_noun_is_gone():
    _, err, code = run_main(["tools", "list"])
    assert code == 2
    assert "invalid choice: 'tools'" in err


def test_help_is_tool_silent():
    out, err, code = run_main(["--help"])
    assert code == 0
    surface = (out + err).lower()
    assert "skill" in surface
    # Registry-sense wording is gone from the top-level surface.
    assert "tool" not in surface


# ─── docs/skills.md canonical commands run verbatim (review 70d9a309) ───

DOCS_SKILLS_MD = Path(__file__).parent.parent / "docs" / "skills.md"


def documented_skill_commands():
    """Every `relayhall skill…` line inside fenced blocks of docs/skills.md."""
    commands = []
    fenced = False
    for raw in DOCS_SKILLS_MD.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped.startswith("```"):
            fenced = not fenced
            continue
        if fenced and stripped.startswith("relayhall skill"):
            commands.append(stripped.split("#", 1)[0].strip())
    return commands


def materialise(tokens):
    """Substitute doc placeholders with concrete values so argparse can parse."""
    subs = {"<id>": SKILL_ID, "<query>": "vault", "<project>": PROJECT_ID}
    return [subs.get(token, token) for token in tokens]


def test_documented_skill_commands_run_verbatim(monkeypatch):
    """Documentation/argparse parity: each canonical command in docs/skills.md
    must parse AND perform its advertised operation through the real handlers
    (review 70d9a309 blocking finding: the documented create form could not
    parse and the documented delete form only previewed)."""
    import shlex

    commands = documented_skill_commands()
    assert commands, "docs/skills.md lost its canonical skill command block"
    # The block must document the full management family.
    documented_verbs = {shlex.split(c)[2] if shlex.split(c)[1] == "skill" else "list" for c in commands if len(shlex.split(c)) > 2}
    for verb in (
        "list", "get", "search", "create", "update", "versions", "submit-review",
        "reject", "publish", "retire", "audience", "pin", "unpin", "delete", "context",
    ):
        assert verb in documented_verbs, f"docs/skills.md no longer documents `skill {verb}`"

    for line in commands:
        calls = []

        def fake(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
            calls.append((method, path, data))
            return {
                "success": True,
                "skills": [sample_skill()],
                "skill": sample_skill(),
                "projects": [{"id": PROJECT_ID, "name": "proj", "status": "active"}],
                "project": {"id": PROJECT_ID, "name": "proj", "status": "active"},
                "message": "ok",
            }

        monkeypatch.setattr(cli, "api", fake)
        tokens = materialise(shlex.split(line))
        assert tokens[0] == "relayhall", f"unexpected doc line: {line!r}"
        out, err, code = run_main(tokens[1:])
        assert code in (None, 0), (
            f"documented command does not run verbatim: {line!r} -> exit {code}, stderr: {err.strip()}"
        )
        assert calls, f"documented command performed no API operation: {line!r}"
        verb = tokens[2] if len(tokens) > 2 else "list"
        if verb == "delete":
            assert any(m == "DELETE" for m, _, _ in calls), (
                f"documented delete form did not issue DELETE: {line!r}"
            )
        if verb == "create":
            assert any(m == "POST" and p == "/skills" for m, p, _ in calls), (
                f"documented create form did not POST /skills: {line!r}"
            )
