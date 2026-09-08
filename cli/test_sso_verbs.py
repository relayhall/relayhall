"""CLI SSO verbs: identity-provider and invitation (RH-P5.SSO.W2, owner D4).

Loaded the same way the other CLI suites load the extensionless `relayhall`
script. These cover the argument surface and the output contract, and in
particular the two places where the CLI has to carry a design rule rather than
merely relay a request:

  - SS-21's `subjectImmutable` declaration has no default at the schema, none
    at the route, and none here either: argparse REQUIRES the operator to
    choose, because an omitted declaration is not a declaration.
  - SS-22's account-XOR-intent, refused before a request is made, so an
    operator gets a sentence rather than a constraint violation.

And the one output contract that matters most: an Invitation code is printed
ONCE, with the warning, exactly as a freshly issued credential secret is —
it is stored hashed, never audited, and cannot be read back.
"""
import importlib.machinery
import importlib.util
import io
import subprocess
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_sso",
        importlib.machinery.SourceFileLoader("relayhall_cli_sso", str(CLI_PATH)),
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
    calls = []
    responses = {}

    def fake_api(method, path, data=None, **kwargs):
        calls.append((method, path, data))
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


def cli_run(*argv):
    """The real process, for the argparse-level refusals."""
    return subprocess.run(
        [sys.executable, str(CLI_PATH), *argv],
        capture_output=True, text=True,
    )


PROVIDER = {
    "id": "11111111-0000-4000-8000-000000000001",
    "name": "Estate SSO",
    "issuer": "https://idp.example.test/application/o/relayhall",
    "status": "active",
    "provisioningMode": "invited",
    "clientId": "relayhall",
    "clientAuthMethod": "client_secret_basic",
    "hasClientSecret": True,
    "subjectImmutable": True,
    "groupBindingMode": "manual",
}


# ── the surface ───────────────────────────────────────────────────────────

def test_list_reports_each_provider(api):
    api.responses[("GET", "/identity-providers")] = {"identityProviders": [PROVIDER]}
    out, _, _ = run(cli.cmd_identity_provider_list, Args())
    assert "Estate SSO" in out
    assert PROVIDER["issuer"] in out


def test_list_says_so_when_there_are_none(api):
    api.responses[("GET", "/identity-providers")] = {"identityProviders": []}
    out, _, code = run(cli.cmd_identity_provider_list, Args())
    assert code is None
    assert "No Identity providers configured." in out


def test_list_flags_the_visibility_controls_the_sitting_ratified(api):
    # The ratified Access-manager controls are a private-address badge and the
    # subject_immutable declaration. The CLI is a surface too, so it shows them.
    api.responses[("GET", "/identity-providers")] = {
        "identityProviders": [{**PROVIDER, "allowPrivateIssuerAddress": True, "subjectImmutable": False}]
    }
    out, _, _ = run(cli.cmd_identity_provider_list, Args())
    assert "private-address" in out
    assert "SUBJECT-NOT-IMMUTABLE" in out


def test_get_never_prints_a_secret_even_when_the_payload_carries_one(api):
    # The service's return type has no secret field, so a secret cannot reach
    # this verb today. The test exists for the day someone widens that type:
    # a planted VALUE must still not be printed. Scanning for the word "secret"
    # would be the wrong instrument — "client_secret_basic" is an auth method
    # name, not a leak — so the needle is a distinctive value instead.
    needle = "SECRET-VALUE-THAT-MUST-NOT-APPEAR-9f3a1c"
    api.responses[("GET", "/identity-providers/")] = {
        "identityProvider": {**PROVIDER, "clientSecret": needle, "clientPrivateKey": needle},
        "health": {"metadataFetchedAt": None, "jwksFetchedAt": None},
    }
    out, _, _ = run(cli.cmd_identity_provider_get, Args(id=PROVIDER["id"]))
    # Non-vacuity: the verb really rendered, so "the needle is absent" is not
    # a statement about an empty string.
    assert "metadata fetched:" in out
    assert PROVIDER["issuer"] in out
    assert needle not in out


def test_get_renders_a_warmed_cache_timestamp(api):
    # The cold path returns before it ever touches datetime, so only this test
    # exercises the formatting — and only this test would have caught that the
    # module has no datetime in scope at all.
    api.responses[("GET", "/identity-providers/")] = {
        "identityProvider": PROVIDER,
        "health": {"metadataFetchedAt": 1788000000000, "jwksFetchedAt": None},
    }
    out, _, _ = run(cli.cmd_identity_provider_get, Args(id=PROVIDER["id"]))
    assert "2026-" in out                      # a real formatted instant
    assert "jwks fetched:       never" in out  # and the cold half stays honest


def test_get_reports_a_cold_cache_as_cold_not_as_a_failure(api):
    api.responses[("GET", "/identity-providers/")] = {
        "identityProvider": PROVIDER,
        "health": {"metadataFetchedAt": None, "jwksFetchedAt": None},
    }
    out, _, _ = run(cli.cmd_identity_provider_get, Args(id=PROVIDER["id"]))
    assert "cache cold" in out
    # A cache that has never been warmed is not a provider that is down, and
    # the wording must not let an operator read it as one.
    assert "error" not in out.lower()
    assert "fail" not in out.lower()


def test_create_sends_the_explicit_subject_declaration(api):
    api.responses[("POST", "/identity-providers")] = {"identityProvider": PROVIDER}
    run(cli.cmd_identity_provider_create, Args(
        name="Estate SSO", issuer=PROVIDER["issuer"], client_id="relayhall",
        client_secret="s3cret", discovery_url=None, client_auth_method=None,
        status=None, provisioning_mode=None, handle_claim=None,
        display_name_claim=None, email_claim=None, groups_claim=None,
        scopes_requested=None, allow_private_issuer_address=False,
        additional_endpoint_origin=None, subject_immutable=True,
    ))
    method, path, body = api.calls[-1]
    assert (method, path) == ("POST", "/identity-providers")
    assert body["subjectImmutable"] is True


def test_create_carries_a_false_declaration_through_rather_than_dropping_it(api):
    # A falsy value must still be SENT: dropping it would turn an explicit
    # "this provider does not guarantee immutable subjects" into an omission,
    # and the route would then refuse for the wrong reason.
    api.responses[("POST", "/identity-providers")] = {"identityProvider": PROVIDER}
    run(cli.cmd_identity_provider_create, Args(
        name="x", issuer="https://i.test", client_id="c", client_secret=None,
        discovery_url=None, client_auth_method=None, status=None,
        provisioning_mode=None, handle_claim=None, display_name_claim=None,
        email_claim=None, groups_claim=None, scopes_requested=None,
        allow_private_issuer_address=False, additional_endpoint_origin=None,
        subject_immutable=False,
    ))
    _, _, body = api.calls[-1]
    assert "subjectImmutable" in body
    assert body["subjectImmutable"] is False


@pytest.fixture(scope="module")
def pem():
    """A REAL throwaway ed25519 key, generated per test run.

    Deliberately not a stored literal: the publish gate's secret scan refuses
    any private-key block in the tree — fake or not — and it is right to. A
    generated key also tests the reader against a genuine PEM rather than an
    invented shape. The key signs nothing and dies with the test run.
    """
    result = subprocess.run(
        ["openssl", "genpkey", "-algorithm", "ed25519"],
        capture_output=True, text=True, check=True,
    )
    return result.stdout


def test_create_sends_the_private_key_for_private_key_jwt(tmp_path, api, pem):
    # Review round 3, R3 B1: private_key_jwt was an advertised --client-auth-method
    # choice with no way to supply the key, so the method was unreachable through
    # the CLI the owner ruling (D4) named.
    key_file = tmp_path / "client.pem"
    key_file.write_text(pem)
    api.responses[("POST", "/identity-providers")] = {"identityProvider": PROVIDER}
    run(cli.cmd_identity_provider_create, Args(
        name="x", issuer="https://i.test", client_id="c", client_secret=None,
        client_private_key_file=str(key_file), discovery_url=None,
        client_auth_method="private_key_jwt", status=None, provisioning_mode=None,
        handle_claim=None, display_name_claim=None, email_claim=None,
        groups_claim=None, scopes_requested=None, allow_private_issuer_address=False,
        additional_endpoint_origin=None, subject_immutable=True,
    ))
    _, path, body = api.calls[-1]
    assert path == "/identity-providers"
    assert body["clientAuthMethod"] == "private_key_jwt"
    assert body["clientPrivateKey"].startswith("-----BEGIN PRIVATE KEY-----")


def test_the_private_key_is_never_printed(tmp_path, api, pem):
    # It is read from a FILE and not an argument precisely so it stays out of
    # argv and the shell history; it must stay out of stdout too.
    key_file = tmp_path / "client.pem"
    key_file.write_text(pem)
    api.responses[("POST", "/identity-providers")] = {"identityProvider": PROVIDER}
    out, err, _ = run(cli.cmd_identity_provider_create, Args(
        name="x", issuer="https://i.test", client_id="c", client_secret=None,
        client_private_key_file=str(key_file), discovery_url=None,
        client_auth_method="private_key_jwt", status=None, provisioning_mode=None,
        handle_claim=None, display_name_claim=None, email_claim=None,
        groups_claim=None, scopes_requested=None, allow_private_issuer_address=False,
        additional_endpoint_origin=None, subject_immutable=True,
    ))
    body_lines = [l for l in pem.splitlines() if l and "-----" not in l]
    assert body_lines, "the generated key has a body"
    for line in body_lines:
        assert line not in out and line not in err
    assert "BEGIN PRIVATE KEY" not in out


def test_update_can_replace_the_private_key(tmp_path, api, pem):
    key_file = tmp_path / "new.pem"
    key_file.write_text(pem)
    api.responses[("PATCH", "/identity-providers/")] = {"identityProvider": PROVIDER}
    run(cli.cmd_identity_provider_update, Args(
        id=PROVIDER["id"], name=None, status=None, client_secret=None,
        client_private_key_file=str(key_file), provisioning_mode=None,
        subject_immutable=None,
    ))
    _, _, body = api.calls[-1]
    assert body["clientPrivateKey"].startswith("-----BEGIN PRIVATE KEY-----")


def test_a_marker_bearing_non_key_file_is_refused(tmp_path, api):
    # Round-4 R3 B1, verbatim: a file whose complete contents are the two words
    # the old substring check looked for. It must exit 2 with ZERO api calls.
    fake = tmp_path / "fake.pem"
    fake.write_text("PRIVATE KEY\n")
    _, err, code = run(cli.cmd_identity_provider_create, Args(
        name="x", issuer="https://i.test", client_id="c", client_secret=None,
        client_private_key_file=str(fake), discovery_url=None,
        client_auth_method="private_key_jwt", status=None, provisioning_mode=None,
        handle_claim=None, display_name_claim=None, email_claim=None,
        groups_claim=None, scopes_requested=None, allow_private_issuer_address=False,
        additional_endpoint_origin=None, subject_immutable=True,
    ))
    assert code == 2
    assert api.calls == []


def test_mismatched_pem_armor_is_refused(tmp_path, api):
    # BEGIN and END labels must agree; a truncated or spliced file must not pass.
    bad = tmp_path / "spliced.pem"
    bad.write_text("-----BEGIN PRIVATE KEY-----\nQUJDREVGRw==\n-----END EC PRIVATE KEY-----\n")
    _, err, code = run(cli.cmd_identity_provider_create, Args(
        name="x", issuer="https://i.test", client_id="c", client_secret=None,
        client_private_key_file=str(bad), discovery_url=None,
        client_auth_method="private_key_jwt", status=None, provisioning_mode=None,
        handle_claim=None, display_name_claim=None, email_claim=None,
        groups_claim=None, scopes_requested=None, allow_private_issuer_address=False,
        additional_endpoint_origin=None, subject_immutable=True,
    ))
    assert code == 2
    assert api.calls == []


def test_a_file_that_is_not_a_private_key_is_refused(tmp_path, api):
    # The control: the reader validates rather than posting whatever it found.
    bad = tmp_path / "notes.txt"
    bad.write_text("this is not a key\n")
    _, err, code = run(cli.cmd_identity_provider_create, Args(
        name="x", issuer="https://i.test", client_id="c", client_secret=None,
        client_private_key_file=str(bad), discovery_url=None,
        client_auth_method="private_key_jwt", status=None, provisioning_mode=None,
        handle_claim=None, display_name_claim=None, email_claim=None,
        groups_claim=None, scopes_requested=None, allow_private_issuer_address=False,
        additional_endpoint_origin=None, subject_immutable=True,
    ))
    assert code == 2
    assert "does not look like a PEM private key" in err
    assert api.calls == []


def test_update_with_no_fields_refuses_instead_of_sending_an_empty_patch(api):
    _, err, code = run(cli.cmd_identity_provider_update, Args(
        id="x", name=None, status=None, client_secret=None,
        provisioning_mode=None, subject_immutable=None,
    ))
    assert code == 2
    assert "Nothing to update" in err
    assert api.calls == []


def test_links_renders_the_envelope_the_ROUTE_actually_returns(api):
    # Review round 2, R3 B1. The verb read result["identityLinks"] with
    # camelCase fields; the route returns {"links": [...]} carrying the query's
    # SNAKE_CASE column names, so the verb printed "No Identity links" for every
    # provider however many existed. The old CLI test could not see it because
    # it invented its own envelope. This one uses the route's ACTUAL shape,
    # copied from backend/src/routes/identityProviders.ts.
    api.responses[("GET", "/identity-providers/")] = {"links": [
        {"id": "link-1", "state": "proven", "account_principal_id": "acct-9",
         "promoted_at": "2026-08-30T10:00:00Z", "revoked_at": None},
        {"id": "link-2", "state": "proven", "account_principal_id": "acct-7",
         "promoted_at": "2026-08-29T10:00:00Z", "revoked_at": "2026-08-30T12:00:00Z"},
    ]}
    out, _, _ = run(cli.cmd_identity_provider_links, Args(id=PROVIDER["id"]))
    assert "No Identity links" not in out
    assert "link-1" in out and "link-2" in out
    assert "acct-9" in out
    assert "proven" in out
    assert "revoked" in out          # the revoked row is labelled from revoked_at


def test_links_still_reports_an_empty_provider(api):
    # The control: the "no links" message is not simply unreachable now.
    api.responses[("GET", "/identity-providers/")] = {"links": []}
    out, _, _ = run(cli.cmd_identity_provider_links, Args(id=PROVIDER["id"]))
    assert "No Identity links at this provider." in out


def test_unlink_says_that_sessions_go_with_the_link(api):
    out, _, _ = run(cli.cmd_identity_provider_unlink, Args(link_id="link-1"))
    assert api.calls[-1][:2] == ("DELETE", "/identity-providers/links/link-1")
    assert "terminated" in out


# ── invitations ───────────────────────────────────────────────────────────

def test_mint_prints_the_code_once_with_the_warning(api):
    api.responses[("POST", "/identity-providers/")] = {
        "invitation": {"id": "inv-1", "expiresAt": "2026-09-01T00:00:00Z"},
        "invitationCode": "rhinv_abcdef123456",
    }
    out, _, _ = run(cli.cmd_invitation_mint, Args(
        provider=PROVIDER["id"], account=None, new_account_intent=True,
        intended_handle="casey", ttl_seconds=None,
    ))
    assert "rhinv_abcdef123456" in out
    assert "only time" in out
    assert "cannot be read back" in out


def test_mint_for_an_existing_account_sends_no_new_account_intent(api, monkeypatch):
    monkeypatch.setattr(cli, "_resolve_principal_id", lambda handle: "principal-7")
    api.responses[("POST", "/identity-providers/")] = {
        "invitation": {"id": "inv-2"}, "invitationCode": "rhinv_x",
    }
    run(cli.cmd_invitation_mint, Args(
        provider=PROVIDER["id"], account="casey", new_account_intent=False,
        intended_handle=None, ttl_seconds=None,
    ))
    _, _, body = api.calls[-1]
    assert body["accountPrincipalId"] == "principal-7"
    assert body["newAccountIntent"] is False


def test_list_invitations_distinguishes_consumed_from_open(api):
    api.responses[("GET", "/identity-providers/")] = {"invitations": [
        {"id": "inv-1", "expiresAt": "2026-09-01T00:00:00Z", "consumedAt": None,
         "accountPrincipalId": None, "intendedHandle": "casey"},
        {"id": "inv-2", "expiresAt": "2026-09-01T00:00:00Z",
         "consumedAt": "2026-08-30T10:00:00Z", "accountPrincipalId": "p-1", "intendedHandle": None},
    ]}
    out, _, _ = run(cli.cmd_invitation_list, Args(provider=PROVIDER["id"]))
    assert "open" in out and "consumed" in out
    assert "(new account intent)" in out


# ── the two declarations, at the argparse layer ───────────────────────────

def test_create_refuses_without_an_explicit_subject_declaration():
    result = cli_run("identity-provider", "create", "--name", "x",
                     "--issuer", "https://i.test", "--client-id", "c")
    assert result.returncode != 0
    assert "--subject-immutable" in result.stderr


def test_create_accepts_either_declaration_but_demands_one():
    # The control for the refusal above: the command IS reachable, so the
    # refusal is about the missing declaration and not about a broken parser.
    for flag in ("--subject-immutable", "--no-subject-immutable"):
        result = cli_run("identity-provider", "create", "--name", "x",
                         "--issuer", "https://i.test", "--client-id", "c", flag, "--help")
        assert result.returncode == 0, f"{flag} should parse"


def test_invitation_refuses_both_an_account_and_a_new_account_intent():
    result = cli_run("invitation", "mint", "p", "--account", "casey", "--new-account")
    assert result.returncode != 0
    assert "not allowed with argument" in result.stderr


def test_invitation_refuses_neither():
    result = cli_run("invitation", "mint", "p")
    assert result.returncode != 0
    assert "--account" in result.stderr
