"""Canonical Project Resource CLI family (P1.5f).

Loaded the same way the other CLI suites load the extensionless `relayhall`
script. Everything runs offline: resource_api / api are replaced with mocks,
so the suite exercises command wiring (method, path, headers, payload), the
stable exit-code mapping, --json passthrough and the fail-closed legacy
writers — never a live API.
"""
import importlib.machinery
import importlib.util
import io
import json
import subprocess
import sys
import types
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
PROJECT_ID = "11111111-2222-4333-8444-555555555555"
RESOURCE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
REVISION = "99999999-8888-4777-8666-555555555554"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_projects",
        importlib.machinery.SourceFileLoader("relayhall_cli_projects", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Args:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def resource_args(**kw):
    """Args prefilled with every optional resource flag left unset."""
    base = dict(project=PROJECT_ID, resource=RESOURCE_ID, json=False,
                name=None, description=None, agent_visibility=None, export_policy=None,
                url=None, role=None, default_branch=None, stage=None, path=None,
                purpose=None, category=None, revision=REVISION, idempotency_key=None,
                kind=None, include_archived=False)
    base.update(kw)
    return Args(**base)


def run(fn, args):
    out, err = io.StringIO(), io.StringIO()
    code = None
    with redirect_stdout(out), redirect_stderr(err):
        try:
            fn(args)
        except SystemExit as exc:
            code = exc.code
    return out.getvalue(), err.getvalue(), code


def envelope(**kw):
    payload = {"success": True}
    payload.update(kw)
    return json.dumps(payload)


def sample_resource(**kw):
    resource = {
        "id": RESOURCE_ID, "projectId": PROJECT_ID, "kind": "repository",
        "name": "main", "description": None, "state": "active",
        "agentVisibility": "hidden", "exportPolicy": "installation-only",
        "details": {"url": "https://git.example/x.git", "role": "primary", "defaultBranch": "main"},
        "revision": REVISION, "createdAt": "t", "updatedAt": "t", "archivedAt": None,
    }
    resource.update(kw)
    return resource


@pytest.fixture
def rest(monkeypatch):
    """Records resource_api calls and replays scripted (status, body) pairs."""
    calls = []
    queue = []

    def fake(method, path, data=None, headers=None):
        calls.append((method, path, data, headers))
        if queue:
            return queue.pop(0)
        return 200, envelope(resource=sample_resource())

    def forbidden(*_args, **_kw):
        raise AssertionError("legacy api() must not be called by this surface")

    monkeypatch.setattr(cli, "resource_api", fake)
    monkeypatch.setattr(cli, "api", forbidden)
    fake.calls = calls
    fake.queue = queue
    return fake


# ─── list / get ───

def test_list_builds_kind_and_archived_query(rest):
    rest.queue.append((200, envelope(resources=[sample_resource()], nextCursor=None)))
    out, _, code = run(cli.cmd_project_resource_list,
                       resource_args(kind="repository", include_archived=True))
    assert code == 0
    assert rest.calls == [
        ("GET", f"/projects/{PROJECT_ID}/resources?kind=repository&includeArchived=true", None, None)
    ]
    assert "main" in out


def test_list_default_is_active_only_with_no_query(rest):
    rest.queue.append((200, envelope(resources=[], nextCursor=None)))
    run(cli.cmd_project_resource_list, resource_args())
    assert rest.calls[-1][1] == f"/projects/{PROJECT_ID}/resources"


def test_list_json_prints_the_raw_envelope_unchanged(rest):
    raw = '{"success": true, "resources": [], "nextCursor": null}'
    rest.queue.append((200, raw))
    out, _, code = run(cli.cmd_project_resource_list, resource_args(json=True))
    assert out == raw + "\n"
    assert code == 0


def test_get_uses_the_canonical_route_with_one_request(rest):
    _, _, code = run(cli.cmd_project_resource_get, resource_args())
    assert code == 0
    assert rest.calls == [("GET", f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}", None, None)]


def test_project_uuid_passes_through_without_resolution(rest, monkeypatch):
    def never(_value):
        raise AssertionError("UUID projects must not hit the resolver")
    monkeypatch.setattr(cli, "resolve_project_id", never)
    run(cli.cmd_project_resource_get, resource_args())
    assert rest.calls[-1][1].startswith(f"/projects/{PROJECT_ID}/")


def test_project_name_reuses_the_existing_resolver(rest, monkeypatch):
    monkeypatch.setattr(cli, "resolve_project_id", lambda value: PROJECT_ID)
    rest.queue.append((200, envelope(resources=[], nextCursor=None)))
    run(cli.cmd_project_resource_list, resource_args(project="my-proj"))
    assert rest.calls[-1][1].startswith(f"/projects/{PROJECT_ID}/resources")


# ─── add each kind ───

def test_add_repository_posts_a_complete_typed_body(rest):
    rest.queue.append((201, envelope(resource=sample_resource())))
    args = resource_args(resource_kind="repository", name="main",
                         url="https://git.example/x.git", role="primary",
                         default_branch="main", description="Primary repo",
                         agent_visibility="available", export_policy="portable")
    _, _, code = run(cli.cmd_project_resource_add, args)
    assert code == 0
    method, path, data, headers = rest.calls[-1]
    assert (method, path, headers) == ("POST", f"/projects/{PROJECT_ID}/resources", None)
    assert data == {
        "kind": "repository", "name": "main",
        "details": {"url": "https://git.example/x.git", "role": "primary", "defaultBranch": "main"},
        "description": "Primary repo", "agentVisibility": "available", "exportPolicy": "portable",
    }


def test_add_environment_posts_url_and_stage(rest):
    rest.queue.append((201, envelope(resource=sample_resource(kind="environment"))))
    args = resource_args(resource_kind="environment", name="prod",
                         url="https://demo.example/", stage="production")
    run(cli.cmd_project_resource_add, args)
    data = rest.calls[-1][2]
    assert data["kind"] == "environment"
    assert data["details"] == {"url": "https://demo.example/", "stage": "production"}


def test_add_workspace_never_sends_an_export_policy(rest):
    rest.queue.append((201, envelope(resource=sample_resource(kind="workspace"))))
    args = resource_args(resource_kind="workspace", name="workbench",
                         path="/srv/projects/demo", purpose="source")
    run(cli.cmd_project_resource_add, args)
    data = rest.calls[-1][2]
    assert data["details"] == {"path": "/srv/projects/demo", "purpose": "source"}
    assert "exportPolicy" not in data


def test_add_reference_posts_url_and_category(rest):
    rest.queue.append((201, envelope(resource=sample_resource(kind="reference"))))
    args = resource_args(resource_kind="reference", name="docs",
                         url="https://docs.example/demo", category="documentation")
    run(cli.cmd_project_resource_add, args)
    data = rest.calls[-1][2]
    assert data["details"] == {"url": "https://docs.example/demo", "category": "documentation"}


def test_add_repository_without_url_is_a_usage_error(rest):
    args = resource_args(resource_kind="repository", name="main")
    _, err, code = run(cli.cmd_project_resource_add, args)
    assert code == 2
    assert "--url" in err
    assert rest.calls == []


def test_add_workspace_export_policy_flag_is_locked_out():
    # The workspace parser deliberately has no --export-policy flag, so this is
    # a local usage error before anything could reach the network.
    result = subprocess.run(
        [sys.executable, str(CLI_PATH), "project", "resource", "add-workspace",
         PROJECT_ID, "--name", "ws", "--path", "/srv/x", "--purpose", "source",
         "--export-policy", "portable"],
        text=True, capture_output=True, timeout=30,
    )
    assert result.returncode == 2
    assert "--export-policy" in result.stderr


# ─── edit / archive / restore ───

def test_edit_sends_one_merge_patch_with_if_match(rest):
    args = resource_args(name="renamed", description="tidied",
                         agent_visibility="available", export_policy="portable",
                         url="https://git.example/y.git", role="additional")
    _, _, code = run(cli.cmd_project_resource_edit, args)
    assert code == 0
    assert rest.calls == [(
        "PATCH", f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}",
        {"name": "renamed", "description": "tidied", "agentVisibility": "available",
         "exportPolicy": "portable",
         "details": {"url": "https://git.example/y.git", "role": "additional"}},
        {"If-Match": REVISION},
    )]


def test_edit_without_any_field_flag_is_a_usage_error(rest):
    _, err, code = run(cli.cmd_project_resource_edit, resource_args())
    assert code == 2
    assert rest.calls == []


def test_archive_posts_with_if_match(rest):
    _, _, code = run(cli.cmd_project_resource_archive, resource_args())
    assert code == 0
    assert rest.calls == [(
        "POST", f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/archive",
        None, {"If-Match": REVISION},
    )]


def test_restore_posts_with_if_match(rest):
    _, _, code = run(cli.cmd_project_resource_restore, resource_args())
    assert code == 0
    assert rest.calls == [(
        "POST", f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/restore",
        None, {"If-Match": REVISION},
    )]


# ─── replace ───

def test_replace_makes_exactly_one_request_with_both_headers(rest):
    rest.queue.append((201, envelope(
        replacement=sample_resource(kind="reference"),
        replaced=sample_resource(state="archived"), requestId="r1")))
    args = resource_args(kind="reference", name="docs", url="https://docs.example/",
                         category="documentation",
                         idempotency_key="replace-key-1234567890")  # gitleaks:allow — synthetic idempotency fixture
    _, _, code = run(cli.cmd_project_resource_replace, args)
    assert code == 0
    assert len(rest.calls) == 1  # never simulated via create+archive
    method, path, data, headers = rest.calls[0]
    assert (method, path) == ("POST", f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/replace")
    assert headers == {"If-Match": REVISION, "Idempotency-Key": "replace-key-1234567890"}  # gitleaks:allow — synthetic idempotency fixture
    assert data["kind"] == "reference"
    assert data["details"] == {"url": "https://docs.example/", "category": "documentation"}


def test_replace_without_key_noninteractive_is_a_usage_error(rest, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO())  # isatty() -> False
    args = resource_args(kind="reference", name="docs", url="https://docs.example/",
                         category="documentation")
    _, err, code = run(cli.cmd_project_resource_replace, args)
    assert code == 2
    assert "--idempotency-key" in err
    assert rest.calls == []


def test_replace_generates_and_prints_a_key_on_a_tty(rest, monkeypatch):
    class Tty:
        def isatty(self):
            return True
    monkeypatch.setattr("sys.stdin", Tty())
    rest.queue.append((201, envelope(replacement=sample_resource(kind="reference"),
                                     replaced=sample_resource())))
    args = resource_args(kind="reference", name="docs", url="https://docs.example/",
                         category="documentation")
    _, err, code = run(cli.cmd_project_resource_replace, args)
    assert code == 0
    key = rest.calls[0][3]["Idempotency-Key"]
    assert 16 <= len(key) <= 128
    assert key in err  # printed so the caller can retry safely


def test_replace_workspace_portable_is_locked_out(rest):
    args = resource_args(kind="workspace", name="ws", path="/srv/x", purpose="source",
                         export_policy="portable",
                         idempotency_key="replace-key-1234567890")  # gitleaks:allow — synthetic idempotency fixture
    _, err, code = run(cli.cmd_project_resource_replace, args)
    assert code == 2
    assert "installation-only" in err
    assert rest.calls == []


def test_replace_missing_kind_specific_field_is_a_usage_error(rest):
    args = resource_args(kind="environment", name="prod", url="https://demo.example/",
                         idempotency_key="replace-key-1234567890")  # no --stage  # gitleaks:allow (synthetic; line already carries a comment)
    _, err, code = run(cli.cmd_project_resource_replace, args)
    assert code == 2
    assert "--stage" in err
    assert rest.calls == []


# ─── stable exit codes ───

@pytest.mark.parametrize("status,expected", [
    (401, 3), (403, 3), (404, 4), (409, 5), (412, 5), (400, 6), (422, 6),
    (500, 7), (None, 7),
])
def test_stable_exit_codes(rest, status, expected):
    rest.queue.append((status, json.dumps(
        {"success": False, "error": "nope", "code": "SOME_CODE", "message": "nope"})))
    _, err, code = run(cli.cmd_project_resource_get, resource_args())
    assert code == expected
    assert "SOME_CODE" in err


def test_json_error_passthrough_keeps_the_stable_exit_code(rest):
    raw = json.dumps({"success": False, "error": "stale", "code": "REVISION_MISMATCH",
                      "message": "stale", "suggestion": "re-read the resource"})
    rest.queue.append((412, raw))
    out, _, code = run(cli.cmd_project_resource_get, resource_args(json=True))
    assert out == raw + "\n"
    assert code == 5


# ─── context / compatibility-status ───

def test_context_hits_the_canonical_route_with_no_query(rest):
    rest.queue.append((200, envelope(context={
        "project": {"name": "Demo"},
        "resources": [{"kind": "repository", "name": "main",
                       "details": {"url": "https://git.example/x.git"}}],
        "omitted": {"hidden": 1, "archived": 0, "incompatible": 2},
        "schemaVersion": 1,
    })))
    out, _, code = run(cli.cmd_project_context, Args(project=PROJECT_ID, json=False))
    assert code == 0
    assert rest.calls == [("GET", f"/projects/{PROJECT_ID}/context", None, None)]
    assert "Demo" in out
    assert "hidden: 1" in out and "incompatible: 2" in out
    assert "grant no filesystem" in out  # values are quoted data, not authority


def test_context_json_prints_the_raw_envelope_unchanged(rest):
    raw = '{"success": true, "context": {"project": {"name": "Demo"}, "resources": [], "omitted": {}, "schemaVersion": 1}}'
    rest.queue.append((200, raw))
    out, _, code = run(cli.cmd_project_context, Args(project=PROJECT_ID, json=True))
    assert out == raw + "\n"
    assert code == 0


def test_compatibility_status_uses_the_admin_route(rest):
    rest.queue.append((200, envelope(compatibility={
        "mapped": 3, "held": 1,
        "bySurface": {"cli": {"mapped": 2, "held": 1}}, "migrationVersion": 4,
    })))
    out, _, code = run(cli.cmd_project_compatibility_status, Args(project=PROJECT_ID, json=False))
    assert code == 0
    assert rest.calls == [("GET", f"/projects/{PROJECT_ID}/compatibility", None, None)]
    assert "Mapped: 3" in out and "Held: 1" in out


# ─── secret hygiene ───

def test_human_output_redacts_credential_bearing_values(rest):
    resource = sample_resource(details={"url": "https://user:hunter2@example.com/x.git"})
    rest.queue.append((200, envelope(resource=resource)))
    out, _, _ = run(cli.cmd_project_resource_get, resource_args())
    assert "hunter2" not in out


def test_plain_repository_urls_are_not_mangled(rest):
    resource = sample_resource(details={"url": "git@git.example:demo/x.git"})
    rest.queue.append((200, envelope(resource=resource)))
    out, _, _ = run(cli.cmd_project_resource_get, resource_args())
    assert "git@git.example:demo/x.git" in out


# ─── legacy writers fail closed (exit 2, no API call, replacement named) ───

LEGACY_WRITERS = [
    ("set-repo", "cmd_project_set_repo",
     dict(id="p", url="https://x"), "project resource add-repository"),
    ("set-env", "cmd_project_set_env",
     dict(id="p", prod="https://x", dev=None, staging=None), "project resource add-environment"),
    ("set-paths", "cmd_project_set_paths",
     dict(id="p", nfs="/x", ssd=None, docker=None), "project resource add-workspace"),
    ("add-notebook", "cmd_project_add_notebook",
     dict(id="p", type="documentation", nb_id="n", url="https://x", desc=None, query_tips=None),
     "project resource add-reference"),
    ("add-link", "cmd_project_add_link",
     dict(id="p", type="url", title="t", url="https://x", category=None),
     "project resource add-reference"),
    ("update-link", "cmd_project_update_link",
     dict(project_id="p", link_id="l", type=None, title=None, url=None),
     "project resource edit"),
    ("delete-link", "cmd_project_delete_link",
     dict(project_id="p", link_id="l"), "project resource archive"),
    # tools link/unlink stubs were deleted with the tools noun (RH-VOCAB.3
    # amendment A14): the retired noun no longer parses at all, which
    # test_skills.py::test_tools_noun_is_gone pins.
]


@pytest.mark.parametrize("label,command,kwargs,replacement", LEGACY_WRITERS,
                         ids=[row[0] for row in LEGACY_WRITERS])
def test_legacy_writers_fail_closed(rest, label, command, kwargs, replacement):
    _, err, code = run(getattr(cli, command), Args(**kwargs))
    assert code == 2
    assert "retired" in err
    assert replacement in err
    assert rest.calls == []  # rest fake untouched; api() fake would raise


def test_project_update_source_dir_fails_closed(rest):
    args = Args(id="p", name=None, description=None, status=None,
                source_dir="/srv/x", nfs_dir=None, revision=REVISION)
    _, err, code = run(cli.cmd_project_update, args)
    assert code == 2
    assert "project resource add-workspace" in err
    assert rest.calls == []


# ─── revision-bound project mutations (fix round, finding 1) ───

def project_update_args(**kw):
    base = dict(id=PROJECT_ID, name=None, description=None, status=None,
                source_dir=None, nfs_dir=None, revision=REVISION)
    base.update(kw)
    return Args(**base)


def sample_project(**kw):
    project = {"id": PROJECT_ID, "name": "Demo", "status": "active", "revision": REVISION}
    project.update(kw)
    return project


def test_project_update_sends_one_patch_with_if_match(rest):
    rest.queue.append((200, envelope(project=sample_project(name="Renamed", revision="r2"))))
    out, _, code = run(cli.cmd_project_update, project_update_args(name="Renamed"))
    assert code == 0
    assert rest.calls == [
        ("PATCH", f"/projects/{PROJECT_ID}", {"name": "Renamed"}, {"If-Match": REVISION})
    ]
    assert "Renamed" in out and "r2" in out


def test_project_update_stale_revision_maps_to_exit_5(rest):
    rest.queue.append((412, json.dumps(
        {"success": False, "error": "stale", "code": "REVISION_MISMATCH", "message": "stale"})))
    _, err, code = run(cli.cmd_project_update, project_update_args(status="active"))
    assert code == 5
    assert "REVISION_MISMATCH" in err


def test_project_archive_posts_with_if_match(rest):
    rest.queue.append((200, envelope(project=sample_project(status="archived", revision="r2"))))
    out, _, code = run(cli.cmd_project_archive, Args(id=PROJECT_ID, revision=REVISION))
    assert code == 0
    assert rest.calls == [
        ("POST", f"/projects/{PROJECT_ID}/archive", None, {"If-Match": REVISION})
    ]
    assert "--revision" in out  # the restore hint names the revision-bound flow


def test_project_unarchive_posts_with_if_match(rest):
    rest.queue.append((200, envelope(project=sample_project(revision="r2"))))
    _, _, code = run(cli.cmd_project_unarchive, Args(id=PROJECT_ID, revision=REVISION))
    assert code == 0
    assert rest.calls == [
        ("POST", f"/projects/{PROJECT_ID}/unarchive", None, {"If-Match": REVISION})
    ]


@pytest.mark.parametrize("argv", [
    ["project", "update", PROJECT_ID, "--name", "x"],
    ["project", "edit", PROJECT_ID, "--name", "x"],
    ["project", "archive", PROJECT_ID],
    ["project", "unarchive", PROJECT_ID],
], ids=["update", "edit-alias", "archive", "unarchive"])
def test_project_mutations_require_the_revision_flag(argv):
    result = subprocess.run([sys.executable, str(CLI_PATH), *argv],
                            text=True, capture_output=True, timeout=30)
    assert result.returncode == 2
    assert "--revision" in result.stderr


# ─── removed surfaces fail closed (fix round, finding 2) ───

@pytest.mark.parametrize("kwargs", [
    dict(id="p", confirm=False, hard=False),
    dict(id="p", confirm=True, hard=False),
    dict(id="p", confirm=True, hard=True),
], ids=["preview", "confirm", "hard"])
def test_project_delete_fails_closed_with_zero_api_calls(rest, kwargs):
    _, err, code = run(cli.cmd_project_delete, Args(**kwargs))
    assert code == 2
    assert "retired" in err
    assert "project archive" in err and "--revision" in err
    assert rest.calls == []  # api() fake would raise; resource fake untouched


@pytest.mark.parametrize("flags", [dict(init=True, nfs=False), dict(init=False, nfs=True)],
                         ids=["init", "nfs"])
def test_project_create_skeleton_flags_fail_closed(rest, flags):
    args = Args(name="demo", description=None, status=None, **flags)
    _, err, code = run(cli.cmd_project_create, args)
    assert code == 2
    assert "retired" in err
    assert "project resource add-workspace" in err
    assert rest.calls == []


def test_project_create_posts_without_touching_the_filesystem(monkeypatch):
    calls = []

    def fake_api(method, path, data=None, **_kw):
        calls.append((method, path, data))
        return {"success": True, "project": sample_project(name="demo")}

    monkeypatch.setattr(cli, "api", fake_api)
    args = Args(name="demo", description=None, status=None, init=False, nfs=False)
    out, _, code = run(cli.cmd_project_create, args)
    assert code is None  # plain return, no SystemExit
    assert calls == [("POST", "/projects", {"name": "demo"})]
    assert "demo" in out


def test_the_skeleton_helpers_are_gone():
    # Zero call sites remain, so the filesystem writers themselves are deleted.
    assert not hasattr(cli, "create_project_skeleton")
    assert not hasattr(cli, "create_nfs_skeleton")



# ─── project list (review c99117a1 finding 6) ───

def _project_list_args(**kw):
    args = types.SimpleNamespace(include_archived=False, json=False)
    for key, value in kw.items():
        setattr(args, key, value)
    return args


def test_project_list_one_get_default_excludes_archived(rest):
    rest.queue.append((200, '{"success": true, "projects": []}'))
    out, _, code = run(cli.cmd_project_list, _project_list_args())
    assert code == 0
    assert rest.calls == [("GET", "/projects", None, None)]
    assert "No projects found" in out


def test_project_list_include_archived_is_explicit(rest):
    rest.queue.append((200, '{"success": true, "projects": [{"id": "x", "name": "P", "status": "archived", "revision": "r"}]}'))
    out, _, code = run(cli.cmd_project_list, _project_list_args(include_archived=True))
    assert code == 0
    assert rest.calls == [("GET", "/projects?includeArchived=true", None, None)]
    assert "archived" in out


def test_project_list_json_passthrough(rest):
    raw = '{"success": true, "projects": []}'
    rest.queue.append((200, raw))
    out, _, code = run(cli.cmd_project_list, _project_list_args(json=True))
    assert out == raw + "\n"
    assert code == 0
