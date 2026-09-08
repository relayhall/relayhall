"""Service registry CLI coverage (RH-P2.1, task a4af8cf2).

Pins the `relayhall service <verb>` grammar, the /services REST wiring
(If-Match and ?dryRun plumbing included), and documentation/argparse parity:
every canonical command in docs/services.md must parse AND perform its
advertised operation through the real handlers (the skills-family standard
from review 70d9a309). Runs offline: resource_api() is replaced with a
recording fake, never a live API.
"""
import importlib.machinery
import importlib.util
import io
import json
import shlex
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"
SERVICE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
REVISION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_services",
        importlib.machinery.SourceFileLoader("relayhall_cli_services", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


def sample_service(**kw):
    service = {
        "id": SERVICE_ID,
        "slug": "my-runner",
        "name": "My Runner",
        "description": "",
        "kind": "connector",
        "runtimeMode": "direct",
        "status": "draft",
        "visibilityTier": "assigned-only",
        "deliveryMode": "none",
        "deliveryEndpoint": None,
        "deliveryPollIntervalSeconds": None,
        "telemetryTier": "none",
        "currentDescriptorVersion": 1,
        "revision": REVISION,
        "createdByPrincipalId": "owner",
        "updatedByPrincipalId": "owner",
        "createdAt": "2026-08-10T00:00:00Z",
        "updatedAt": "2026-08-10T00:00:00Z",
        "retiredAt": None,
    }
    service.update(kw)
    return service


def sample_version(**kw):
    version = {
        "version": 1,
        "contentHash": "hash-1",
        "createdByPrincipalId": "owner",
        "createdAt": "2026-08-10T00:00:00Z",
        "retiredAt": None,
        "descriptor": {"options": []},
    }
    version.update(kw)
    return version


def run_main(argv):
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


def service_rest_fake(calls):
    def fake_resource_api(method, path, data=None, headers=None):
        calls.append((method, path, data, headers or {}))
        if method == "GET" and "/descriptor/versions/" in path:
            return 200, json.dumps({"success": True, "descriptorVersion": sample_version()})
        if method == "GET" and path.endswith("/descriptor/versions"):
            return 200, json.dumps({"success": True, "versions": [
                {"version": 2, "contentHash": "hash-2", "createdByPrincipalId": "owner", "createdAt": "now", "retiredAt": None},
                {"version": 1, "contentHash": "hash-1", "createdByPrincipalId": "owner", "createdAt": "then", "retiredAt": "now"},
            ]})
        if method == "GET" and path.endswith("/descriptor"):
            return 200, json.dumps({"success": True, "descriptorVersion": sample_version(version=2, contentHash="hash-2")})
        if method == "POST" and "/retire" in path and "/descriptor/versions/" in path:
            return 200, json.dumps({"success": True, "version": {"version": 1, "retiredAt": "now"},
                                    **({"dryRun": True} if "dryRun=true" in path else {})})
        if method == "POST" and path.split("?")[0].endswith("/retire"):
            return 200, json.dumps({"success": True, "service": sample_service(status="retired"),
                                    **({"dryRun": True} if "dryRun=true" in path else {})})
        if method == "PUT" and "/descriptor" in path:
            return 201, json.dumps({"success": True, "service": sample_service(currentDescriptorVersion=2),
                                    "descriptorVersion": sample_version(version=2, contentHash="hash-2"),
                                    **({"dryRun": True} if "dryRun=true" in path else {})})
        if method == "POST":
            return 201, json.dumps({"success": True, "service": sample_service(),
                                    **({"dryRun": True} if "dryRun=true" in path else {})})
        if method == "PATCH":
            return 200, json.dumps({"success": True, "service": sample_service(name="Renamed"),
                                    **({"dryRun": True} if "dryRun=true" in path else {})})
        if method == "DELETE":
            return 200, json.dumps({"success": True, "message": "Service deleted"})
        if method == "GET" and path.split("?")[0].endswith("/services"):
            return 200, json.dumps({"success": True, "services": [sample_service()]})
        if method == "GET":
            return 200, json.dumps({"success": True, "service": sample_service()})
        raise AssertionError(f"unexpected resource_api() call: {method} {path}")
    return fake_resource_api


@pytest.fixture
def rest(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "resource_api", service_rest_fake(calls))
    return calls


def test_service_list_hits_collection_route(rest):
    out, err, code = run_main(["service", "list"])
    assert code in (None, 0), err
    assert ("GET", "/services", None, {}) in rest
    assert "my-runner" in out


def test_service_list_filters_map_to_query(rest):
    out, err, code = run_main(["service", "list", "--kind", "connector", "--status", "published", "--include-retired"])
    assert code in (None, 0), err
    method, path, _, _ = rest[0]
    assert path == "/services?kind=connector&status=published&includeRetired=true"


def test_services_bare_plural_is_a_list_alias(rest):
    out, err, code = run_main(["services"])
    assert code in (None, 0), err
    assert ("GET", "/services", None, {}) in rest


def test_service_get_resolves_by_slug(rest):
    out, err, code = run_main(["service", "get", "my-runner"])
    assert code in (None, 0), err
    assert ("GET", "/services/my-runner", None, {}) in rest
    assert "assigned-only" in out


def test_service_register_posts_payload(rest):
    out, err, code = run_main(["service", "register", "my-runner", "--name", "My Runner", "--kind", "connector"])
    assert code in (None, 0), err
    method, path, data, headers = rest[0]
    assert (method, path) == ("POST", "/services")
    assert data == {"slug": "my-runner", "name": "My Runner", "kind": "connector"}


def test_service_register_dry_run_sends_query_and_labels_output(rest):
    out, err, code = run_main(["service", "register", "my-runner", "--name", "My Runner", "--dry-run"])
    assert code in (None, 0), err
    assert rest[0][1] == "/services?dryRun=true"
    assert "DRY RUN" in out


def test_service_update_sends_if_match(rest):
    out, err, code = run_main(["service", "update", "my-runner", "--name", "Renamed", "--revision", REVISION])
    assert code in (None, 0), err
    method, path, data, headers = rest[0]
    assert (method, path) == ("PATCH", "/services/my-runner")
    assert headers == {"If-Match": REVISION}
    assert data == {"name": "Renamed"}


def test_service_update_without_fields_fails_closed(rest):
    out, err, code = run_main(["service", "update", "my-runner", "--revision", REVISION])
    assert code == 2
    assert rest == []


def test_service_publish_descriptor_from_file(rest, tmp_path):
    f = tmp_path / "descriptor.json"
    f.write_text(json.dumps({"options": []}))
    out, err, code = run_main(["service", "publish-descriptor", "my-runner", "--file", str(f), "--revision", REVISION])
    assert code in (None, 0), err
    method, path, data, headers = rest[0]
    assert (method, path) == ("PUT", "/services/my-runner/descriptor")
    assert data == {"descriptor": {"options": []}}
    assert headers == {"If-Match": REVISION}


def test_service_publish_descriptor_rejects_invalid_json(rest):
    out, err, code = run_main(["service", "publish-descriptor", "my-runner", "--descriptor", "{not json"])
    assert code == 2
    assert rest == []


def test_service_descriptor_reads_current_and_pinned(rest):
    out, err, code = run_main(["service", "descriptor", "my-runner"])
    assert code in (None, 0), err
    assert ("GET", "/services/my-runner/descriptor", None, {}) in rest
    rest.clear()
    out, err, code = run_main(["service", "descriptor", "my-runner", "--version", "1"])
    assert code in (None, 0), err
    assert ("GET", "/services/my-runner/descriptor/versions/1", None, {}) in rest


def test_service_versions_lists_metadata_with_retired_marker(rest):
    out, err, code = run_main(["service", "versions", "my-runner"])
    assert code in (None, 0), err
    assert "v2" in out and "v1" in out and "RETIRED" in out


def test_service_retire_sends_if_match(rest):
    out, err, code = run_main(["service", "retire", "my-runner", "--revision", REVISION])
    assert code in (None, 0), err
    method, path, data, headers = rest[0]
    assert (method, path) == ("POST", "/services/my-runner/retire")
    assert headers == {"If-Match": REVISION}


def test_service_retire_descriptor_version_hits_version_route(rest):
    out, err, code = run_main(["service", "retire-descriptor-version", "my-runner", "1"])
    assert code in (None, 0), err
    assert rest[0][1] == "/services/my-runner/descriptor/versions/1/retire"


def test_service_delete_hits_delete_route(rest):
    out, err, code = run_main(["service", "delete", "my-runner"])
    assert code in (None, 0), err
    assert rest[0][0] == "DELETE"


def test_stale_revision_maps_to_conflict_exit_code(monkeypatch):
    def fake_resource_api(method, path, data=None, headers=None):
        return 412, json.dumps({"success": False, "error": "stale", "code": "REVISION_MISMATCH", "message": "stale"})
    monkeypatch.setattr(cli, "resource_api", fake_resource_api)
    out, err, code = run_main(["service", "update", "my-runner", "--name", "X", "--revision", "stale"])
    assert code == 5
    assert "REVISION_MISMATCH" in err


def test_brokered_refusal_maps_to_validation_exit_code(monkeypatch):
    def fake_resource_api(method, path, data=None, headers=None):
        return 422, json.dumps({"success": False, "error": "brokered is post-v1",
                                "code": "BROKERED_MODE_NOT_AVAILABLE", "message": "brokered is post-v1"})
    monkeypatch.setattr(cli, "resource_api", fake_resource_api)
    out, err, code = run_main(["service", "register", "x", "--name", "X"])
    assert code == 6
    assert "BROKERED_MODE_NOT_AVAILABLE" in err


# ─── docs/services.md canonical commands run verbatim (parity, skills model) ───

DOCS_SERVICES_MD = Path(__file__).parent.parent / "docs" / "services.md"


def documented_service_commands():
    """Every `relayhall service…`/`relayhall services` line inside fenced blocks."""
    commands = []
    fenced = False
    for raw in DOCS_SERVICES_MD.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped.startswith("```"):
            fenced = not fenced
            continue
        if fenced and (stripped.startswith("relayhall service") or stripped == "relayhall services"):
            commands.append(stripped.split("#", 1)[0].strip())
    return commands


def materialise(tokens, tmp_path):
    descriptor_file = tmp_path / "descriptor-doc.json"
    descriptor_file.write_text(json.dumps({"options": []}))
    subs = {
        "<service>": "my-runner",
        "<slug>": "my-runner",
        "<name>": "My Runner",
        "<file>": str(descriptor_file),
        "<revision>": REVISION,
        "<version>": "1",
    }
    return [subs.get(token, token) for token in tokens]


def test_documented_service_commands_run_verbatim(monkeypatch, tmp_path):
    commands = documented_service_commands()
    assert commands, "docs/services.md lost its canonical service command block"
    documented_verbs = {shlex.split(c)[2] for c in commands if len(shlex.split(c)) > 2}
    for verb in ("list", "get", "register", "update", "publish-descriptor",
                 "descriptor", "versions", "retire", "retire-descriptor-version", "delete"):
        assert verb in documented_verbs, f"docs/services.md no longer documents `service {verb}`"

    for line in commands:
        calls = []
        monkeypatch.setattr(cli, "resource_api", service_rest_fake(calls))
        tokens = materialise(shlex.split(line), tmp_path)
        assert tokens[0] == "relayhall", f"unexpected doc line: {line!r}"
        out, err, code = run_main(tokens[1:])
        assert code in (None, 0), (
            f"documented command does not run verbatim: {line!r} -> exit {code}, stderr: {err.strip()}"
        )
        assert calls, f"documented command performed no REST call: {line!r}"
