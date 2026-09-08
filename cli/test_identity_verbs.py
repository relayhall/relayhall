"""CLI identity verbs: whoami, principals, principal create, key issue/list/rotate/revoke.

Loaded the same way the other CLI suites load the extensionless `relayhall`
script. These cover the argument surface and the output contract — in
particular that a freshly issued secret is printed once with a warning, and
that a missing principal is a clean error rather than a traceback.
"""
import importlib.util
import io
import os
import subprocess
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_identity",
        importlib.machinery.SourceFileLoader("relayhall_cli_identity", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Args:
    def __init__(self, **kw):
        self.__dict__.update(kw)


@pytest.fixture
def api(monkeypatch):
    """Records calls and replays scripted responses."""
    calls = []
    responses = {}

    def fake_api(method, path, data=None, **kwargs):
        calls.append((method, path, data))
        # Longest prefix wins, so a rule for "/principals/" is not shadowed by
        # one for "/principals".
        for (m, p), value in sorted(responses.items(), key=lambda kv: -len(kv[0][1])):
            if m == method and (p == path or path.startswith(p)):
                return value
        return {}

    monkeypatch.setattr(cli, "api", fake_api)
    fake_api.calls = calls
    fake_api.responses = responses
    return fake_api


def run(fn, args):
    out, err = io.StringIO(), io.StringIO()
    code = None
    with redirect_stdout(out), redirect_stderr(err):
        try:
            fn(args)
        except SystemExit as exc:
            code = exc.code
    return out.getvalue(), err.getvalue(), code


PRINCIPALS = {
    "principals": [
        {"id": "aaaaaaaa-0000-4000-8000-000000000001", "handle": "dashboard_user",
         "kind": "human", "role": "orchestrator", "status": "active", "lastSeenAt": None},
        {"id": "bbbbbbbb-0000-4000-8000-000000000002", "handle": "casey",
         "kind": "human", "role": "user", "status": "active", "lastSeenAt": "2026-08-01T09:00:00Z"},
    ]
}


def test_whoami_reports_principal_and_scopes(api):
    api.responses[("GET", "/principals/me")] = {
        "principal": {"id": "id-1", "handle": "casey", "kind": "human",
                      "role": "user", "status": "active", "displayName": "Casey"},
        "scopes": ["tasks:read", "reports:read"],
    }
    out, _, _ = run(cli.cmd_whoami, Args())
    assert "casey" in out
    assert "tasks:read, reports:read" in out


def test_whoami_handles_no_principal_without_crashing(api):
    # A legacy token or an unmigrated environment is a valid state, not an error.
    api.responses[("GET", "/principals/me")] = {}
    out, _, code = run(cli.cmd_whoami, Args())
    assert code is None
    assert "No principal resolved" in out


def test_principals_lists_every_row(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    out, _, _ = run(cli.cmd_principals, Args())
    assert "dashboard_user" in out and "casey" in out
    assert "never" in out  # null lastSeenAt renders as 'never', not 'None'


def test_relayhall_entry_point_owns_its_help_surface():
    result = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "relayhall"), "--help"],
        text=True, capture_output=True, check=True,
    )
    assert result.stdout.startswith("usage: relayhall ")
    # The estate word must not appear anywhere on the primary help surface.
    assert "clawboard" not in result.stdout.lower()


def test_principal_create_posts_the_expected_body(api):
    api.responses[("POST", "/principals")] = {"principal": {"handle": "casey", "id": "id-9"}}
    run(cli.cmd_principal_create,
        Args(handle="casey", kind="human", display_name="Casey", role=None))
    method, path, body = api.calls[-1]
    assert (method, path) == ("POST", "/principals")
    assert body == {"handle": "casey", "kind": "human", "displayName": "Casey"}


def test_principal_update_resolves_handle_and_sets_status(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    api.responses[("PATCH", "/principals/")] = {"principal": {"handle": "casey", "status": "disabled"}}
    run(cli.cmd_principal_update, Args(principal="casey", display_name=None, status="disabled"))
    assert api.calls[-1] == (
        "PATCH", "/principals/bbbbbbbb-0000-4000-8000-000000000002", {"status": "disabled"}
    )


def test_personality_create_and_update_use_registry_api(api):
    api.responses[("POST", "/personalities")] = {"personality": {"name": "Local Reviewer", "slug": "local-reviewer"}}
    run(cli.cmd_personality_create, Args(
        slug="local-reviewer", name="Local Reviewer", description=None,
        category="custom", color="blue", content=None,
    ))
    assert api.calls[-1][0:2] == ("POST", "/personalities")
    api.responses[("GET", "/personalities/local-reviewer")] = {"success": True, "personality": {"id": "personality-1"}}
    api.responses[("PATCH", "/personalities/")] = {"personality": {"name": "Local Reviewer", "slug": "local-reviewer"}}
    run(cli.cmd_personality_update, Args(
        personality="local-reviewer", name=None, description="Adversarial",
        category=None, color=None, content=None,
    ))
    assert api.calls[-1] == ("PATCH", "/personalities/personality-1", {"description": "Adversarial"})


def test_personality_content_file_loads_a_reviewed_file_wholesale(api, tmp_path):
    # The import-by-agent-review path: an agent reviews an external personality
    # file and imports it verbatim without shell-quoting the markdown.
    md = "# Mission\nDesign maintainable services.\n"
    src = tmp_path / "backend-architect.md"
    src.write_text(md, encoding="utf-8")

    api.responses[("POST", "/personalities")] = {"personality": {"name": "Backend Architect", "slug": "backend-architect"}}
    run(cli.cmd_personality_create, Args(
        slug="backend-architect", name="Backend Architect", description=None,
        category="custom", color="green", content=None, content_file=str(src),
    ))
    method, path, body = api.calls[-1]
    assert (method, path) == ("POST", "/personalities")
    assert body["content"] == md

    api.responses[("GET", "/personalities/backend-architect")] = {"success": True, "personality": {"id": "personality-2"}}
    api.responses[("PATCH", "/personalities/")] = {"personality": {"name": "Backend Architect", "slug": "backend-architect"}}
    run(cli.cmd_personality_update, Args(
        personality="backend-architect", name=None, description=None,
        category=None, color=None, content=None, content_file=str(src),
    ))
    assert api.calls[-1] == ("PATCH", "/personalities/personality-2", {"content": md})


def test_personality_content_file_missing_fails_closed(api):
    # run() captures the SystemExit and returns its code.
    _, err, code = run(cli.cmd_personality_create, Args(
        slug="x", name="X", description=None, category="custom", color="blue",
        content=None, content_file="/nonexistent/personality.md",
    ))
    assert code == 1
    assert "Cannot read --content-file" in err
    assert not any(method == "POST" for method, _, _ in api.calls)


def test_key_issue_prints_the_secret_once_with_a_warning(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    api.responses[("POST", "/principals/")] = {
        "keyId": "abc123", "scopes": ["tasks:read"], "secretOnce": "rh_dev_abc123.SECRETVALUE",
    }
    out, _, _ = run(cli.cmd_key_issue,
                    Args(principal="casey", scopes="tasks:read", label="x", expires_at=None))
    assert "rh_dev_abc123.SECRETVALUE" in out
    assert "only time" in out
    # Issued against the resolved id, not the handle.
    method, path, body = api.calls[-1]
    assert path == "/principals/bbbbbbbb-0000-4000-8000-000000000002/credentials"
    assert body["scopes"] == ["tasks:read"]


def test_key_issue_splits_and_trims_the_scope_list(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    api.responses[("POST", "/principals/")] = {"keyId": "k", "scopes": [], "secretOnce": "s"}
    run(cli.cmd_key_issue,
        Args(principal="casey", scopes=" tasks:read , reports:write ,", label=None, expires_at=None))
    assert api.calls[-1][2]["scopes"] == ["tasks:read", "reports:write"]


def test_unknown_principal_is_a_clean_error(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    out, err, code = run(cli.cmd_key_list, Args(principal="nobody"))
    assert code == 1
    assert "No principal matching" in err


def test_principal_resolves_by_id_prefix(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    api.responses[("GET", "/principals/")] = {"credentials": []}
    run(cli.cmd_key_list, Args(principal="bbbbbbbb"))
    assert api.calls[-1][1].startswith("/principals/bbbbbbbb-0000-4000-8000-000000000002")


def test_key_list_never_prints_a_secret(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    api.responses[("GET", "/principals/")] = {
        "credentials": [{
            "id": "cred-1", "keyId": "abc123", "label": "x", "scopes": ["tasks:read"],
            "revokedAt": None, "lastUsedAt": None,
        }]
    }
    out, _, _ = run(cli.cmd_key_list, Args(principal="casey"))
    assert "abc123" in out and "active" in out
    assert "secret" not in out.lower()


def test_key_list_marks_revoked_rows(api):
    api.responses[("GET", "/principals")] = PRINCIPALS
    api.responses[("GET", "/principals/")] = {
        "credentials": [{"id": "c", "keyId": "k", "scopes": [], "revokedAt": "2026-08-01T00:00:00Z"}]
    }
    out, _, _ = run(cli.cmd_key_list, Args(principal="casey"))
    assert "revoked" in out


def test_key_rotate_reports_both_keys_and_the_grace_window(api):
    api.responses[("POST", "/credentials/")] = {
        "keyId": "new1", "previousKeyId": "old1", "graceHours": 24, "secretOnce": "rh_dev_new1.SECRET",
    }
    out, _, _ = run(cli.cmd_key_rotate, Args(credential_id="cred-1", grace_hours=24))
    assert "old1" in out and "new1" in out and "24h" in out
    assert "rh_dev_new1.SECRET" in out
    assert api.calls[-1][2] == {"graceHours": 24}


def test_key_revoke_is_explicit_about_a_no_op(api):
    api.responses[("POST", "/credentials/")] = {"success": True, "alreadyRevoked": True}
    out, _, _ = run(cli.cmd_key_revoke, Args(credential_id="cred-1", reason=None))
    assert "Already revoked" in out


def test_key_revoke_passes_the_reason_through(api):
    api.responses[("POST", "/credentials/")] = {"success": True}
    run(cli.cmd_key_revoke, Args(credential_id="cred-1", reason="compromised"))
    assert api.calls[-1][2] == {"reason": "compromised"}


# ── The role-change verb (owner ruling 60307311 §1.2, card 27322abb) ────────
#
# The CLI is one of the four surfaces the ruling names, and it is the ONLY one
# an operator reaches without a browser. Three properties are load-bearing:
# the verb resolves a handle to an id and POSTs only the role; it prints what
# the SERVER said about when the change takes effect rather than guessing; and
# a refusal exits non-zero with the server's own sentence, plus the one hint
# that turns the two session refusals into something a person can act on.

ROLE_PRINCIPALS = {
    "principals": [
        {"id": "cccccccc-0000-4000-8000-000000000003", "handle": "tessa",
         "kind": "human", "role": "viewer", "status": "active", "lastSeenAt": None},
    ]
}


def test_principal_role_posts_only_the_role(api):
    api.responses[("GET", "/principals")] = ROLE_PRINCIPALS
    api.responses[("POST", "/principals/cccccccc-0000-4000-8000-000000000003/role")] = {
        "success": True,
        "principal": {"handle": "tessa", "role": "editor"},
        "previousRole": "viewer",
        "effectiveFrom": "next-request",
        "note": "tessa carries the role 'editor' from their next request; no re-login is required.",
    }
    out, _, code = run(cli.cmd_principal_role, Args(principal="tessa", role="editor"))
    assert code is None
    method, path, body = [call for call in api.calls if call[0] == "POST"][0]
    assert path == "/principals/cccccccc-0000-4000-8000-000000000003/role"
    # Only the role: the CLI never sends a client-asserted actor or scope.
    assert body == {"role": "editor"}
    assert "viewer" in out and "editor" in out
    # The server's sentence, not a locally invented one.
    assert "no re-login is required" in out


def test_principal_role_refusal_exits_non_zero_with_the_server_sentence(api):
    api.responses[("GET", "/principals")] = ROLE_PRINCIPALS
    api.responses[("POST", "/principals/cccccccc-0000-4000-8000-000000000003/role")] = {
        "success": False,
        "error": "Forbidden",
        "code": "ROLE_ABOVE_YOUR_AUTHORITY",
        "message": "Cannot assign role 'admin' - it is above your own authority ('operator').",
        "status": 403,
    }
    _, err, code = run(cli.cmd_principal_role, Args(principal="tessa", role="admin"))
    assert code == 1
    assert "above your own authority" in err
    # Not the session hint: this refusal is about the CEILING, and pointing the
    # person at `relayhall login` would send them to fix the wrong thing.
    assert "relayhall login" not in err


def test_principal_role_names_the_session_requirement_when_that_is_the_refusal(api):
    api.responses[("GET", "/principals")] = ROLE_PRINCIPALS
    api.responses[("POST", "/principals/cccccccc-0000-4000-8000-000000000003/role")] = {
        "success": False,
        "error": "Forbidden",
        "code": "ROLE_ACT_REQUIRES_SESSION",
        "message": "Changing a role is a login-session act (AZ-18).",
        "status": 403,
    }
    _, err, code = run(cli.cmd_principal_role, Args(principal="tessa", role="editor"))
    assert code == 1
    assert "login-session act" in err
    assert "relayhall login" in err


def test_api_error_bodies_carry_message_and_code_to_the_caller():
    # `api(..., exit_on_error=False)` used to return only the generic `error`
    # word, so every refusal reached its caller as "Forbidden" with the reason
    # discarded. The verb above is unusable without this.
    import json as _json
    import urllib.error

    body = _json.dumps({
        "error": "Forbidden", "code": "ROLE_ACT_REQUIRES_SESSION", "message": "a sentence",
    }).encode()

    class _Response(io.BytesIO):
        pass

    def _raise(*_args, **_kwargs):
        raise urllib.error.HTTPError("u", 403, "Forbidden", {}, _Response(body))

    original = cli.urllib.request.urlopen
    original_token = cli.get_token
    cli.urllib.request.urlopen = _raise
    cli.get_token = lambda: "t"
    try:
        result = cli.api("POST", "/x", {"a": 1}, exit_on_error=False)
    finally:
        cli.urllib.request.urlopen = original
        cli.get_token = original_token
    assert result["message"] == "a sentence"
    assert result["code"] == "ROLE_ACT_REQUIRES_SESSION"
    assert result["status"] == 403
    assert result["success"] is False


def test_role_verb_offers_every_assignable_role_and_no_other():
    result = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "relayhall"), "principal", "role", "--help"],
        text=True, capture_output=True, check=True,
    )
    # The vocabulary migration 062's CHECK admits, and nothing else. `root` is
    # a SCOPE sentinel, not a role, and must never be offered here.
    for role in ["admin", "operator", "editor", "user", "viewer",
                 "orchestrator", "reviewer", "qa", "agent"]:
        assert role in result.stdout
    assert "root" not in result.stdout.replace("relayhall", "")


# ── the two acts the board refuses, refused here first (card 5592baf6) ──────


def test_service_creation_carries_its_purpose(api):
    """A17.1: a service Account declares what it is for, and the verb sends it."""
    api.responses[("POST", "/principals")] = {
        "success": True, "principal": {"handle": "ci-bot", "id": "p1"},
    }
    run(cli.cmd_principal_create, Args(
        handle="ci-bot", kind="service", display_name="CI bot", role="agent",
        purpose="Runs the nightly build.",
    ))
    method, path, body = api.calls[-1]
    assert (method, path) == ("POST", "/principals")
    assert body["purpose"] == "Runs the nightly build."
    assert body["kind"] == "service"


def test_service_without_a_purpose_is_refused_before_any_request(api):
    """The defect this card closes, on the CLI surface.

    The docs advertised exactly this command without a purpose, and the board
    answered 422 PURPOSE_REQUIRED. The refusal now happens here, in the route's
    own words, and NOTHING is sent -- which is the assertion that matters: a
    verb that refuses after posting has not refused, it has failed.
    """
    _out, err, code = run(cli.cmd_principal_create, Args(
        handle="ci-bot", kind="service", display_name=None, role=None, purpose=None,
    ))
    assert code == 1
    assert api.calls == []
    assert "must declare a purpose" in err


def test_agent_kind_is_refused_with_a_reason_not_a_422(api):
    """POST /principals answers 422 AGENT_MINT_ONLY; the verb says why instead."""
    _out, err, code = run(cli.cmd_principal_create, Args(
        handle="some-agent", kind="agent", display_name=None, role=None, purpose=None,
    ))
    assert code == 1
    assert api.calls == []
    assert "delegation machinery" in err


def test_a_human_still_needs_no_purpose(api):
    """CONTROL: the rule is bounded to services, so it cannot creep."""
    api.responses[("POST", "/principals")] = {
        "success": True, "principal": {"handle": "colleague", "id": "p2"},
    }
    run(cli.cmd_principal_create, Args(
        handle="colleague", kind="human", display_name=None, role="user", purpose=None,
    ))
    method, path, body = api.calls[-1]
    assert (method, path) == ("POST", "/principals")
    assert "purpose" not in body


def test_the_purpose_flag_exists_on_the_verb():
    result = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "relayhall"), "principal", "create", "--help"],
        text=True, capture_output=True, check=True,
    )
    assert "--purpose" in result.stdout
