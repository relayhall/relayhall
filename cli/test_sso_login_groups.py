"""CLI verbs for the SSO-R4 login group whitelist (RH-P5.SSO.W3).

The whitelist decides WHO MAY SIGN IN at an Identity provider, and nothing
else — an admitted Account holds exactly the access it already had. These cover
the argument surface, the routes the verbs actually call, and the two output
contracts that carry a design rule rather than merely relaying a response:

  - an EMPTY allowed-group list is reported as the fail-closed state it is
    (W3-D2: enabled with nothing allowed refuses every federated sign-in), not
    as a cheerful "none configured";
  - removing the LAST group says so at the moment it happens, because that is
    the act that locks everyone out and the operator should not have to infer
    it from a silent success.
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
        "relayhall_cli_login_groups",
        importlib.machinery.SourceFileLoader("relayhall_cli_login_groups", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()

PROVIDER_ID = "11111111-0000-4000-8000-000000000001"
GROUP_ID = "22222222-0000-4000-8000-000000000002"

# The shape the route really returns, so the verb's own printer runs.
PROVIDER = {
    "id": PROVIDER_ID,
    "name": "Estate SSO",
    "issuer": "https://idp.example.test/application/o/relayhall",
    "status": "active",
    "provisioningMode": "invited",
    "hasClientSecret": True,
    "subjectImmutable": True,
}


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
    return subprocess.run([sys.executable, str(CLI_PATH), *argv], capture_output=True, text=True)


# ── listing ───────────────────────────────────────────────────────────────

def test_login_groups_lists_each_allowed_group(api):
    api.responses[("GET", f"/identity-providers/{PROVIDER_ID}/login-groups")] = {
        "loginGroups": [{"groupId": GROUP_ID, "groupName": "Staff"}],
    }
    out, _, _ = run(cli.cmd_identity_provider_login_groups, Args(id=PROVIDER_ID))
    assert "Staff" in out
    assert GROUP_ID in out


def test_an_empty_list_is_reported_as_the_fail_closed_state(api):
    api.responses[("GET", f"/identity-providers/{PROVIDER_ID}/login-groups")] = {"loginGroups": []}
    out, _, _ = run(cli.cmd_identity_provider_login_groups, Args(id=PROVIDER_ID))
    # The operator must be able to tell "nothing is allowed" from "no
    # restriction": the first refuses everyone when the switch is on.
    assert "refused" in out.lower()


# ── allowing and disallowing ──────────────────────────────────────────────

def test_allow_group_posts_the_group_id(api):
    api.responses[("POST", f"/identity-providers/{PROVIDER_ID}/login-groups")] = {
        "loginGroups": [{"groupId": GROUP_ID, "groupName": "Staff"}],
    }
    out, _, _ = run(cli.cmd_identity_provider_allow_group, Args(id=PROVIDER_ID, group_id=GROUP_ID))
    method, path, body = api.calls[0]
    assert method == "POST"
    assert path == f"/identity-providers/{PROVIDER_ID}/login-groups"
    assert body == {"groupId": GROUP_ID}
    assert "Staff" in out


def test_disallow_group_deletes_the_pair(api):
    api.responses[("DELETE", f"/identity-providers/{PROVIDER_ID}/login-groups/{GROUP_ID}")] = {
        "loginGroups": [{"groupId": "33333333-0000-4000-8000-000000000003", "groupName": "Ops"}],
    }
    _, _, _ = run(cli.cmd_identity_provider_disallow_group, Args(id=PROVIDER_ID, group_id=GROUP_ID))
    method, path, _ = api.calls[0]
    assert method == "DELETE"
    assert path == f"/identity-providers/{PROVIDER_ID}/login-groups/{GROUP_ID}"


def test_removing_the_last_group_warns_that_everyone_is_now_refused(api):
    api.responses[("DELETE", f"/identity-providers/{PROVIDER_ID}/login-groups/{GROUP_ID}")] = {
        "loginGroups": [],
    }
    out, _, _ = run(cli.cmd_identity_provider_disallow_group, Args(id=PROVIDER_ID, group_id=GROUP_ID))
    assert "refused" in out.lower()


# ── the switch rides `identity-provider update` ───────────────────────────

def test_update_sends_the_restriction_switch(api):
    api.responses[("PATCH", f"/identity-providers/{PROVIDER_ID}")] = {"identityProvider": PROVIDER}
    run(cli.cmd_identity_provider_update, Args(
        id=PROVIDER_ID, name=None, status=None, client_secret=None,
        client_private_key_file=None, provisioning_mode=None, subject_immutable=None,
        login_group_whitelist_enabled=True,
    ))
    _, _, body = api.calls[0]
    assert body == {"loginGroupWhitelistEnabled": True}


def test_update_can_turn_the_restriction_off(api):
    api.responses[("PATCH", f"/identity-providers/{PROVIDER_ID}")] = {"identityProvider": PROVIDER}
    run(cli.cmd_identity_provider_update, Args(
        id=PROVIDER_ID, name=None, status=None, client_secret=None,
        client_private_key_file=None, provisioning_mode=None, subject_immutable=None,
        login_group_whitelist_enabled=False,
    ))
    _, _, body = api.calls[0]
    # False must SURVIVE the "is it None?" filter — an off switch that never
    # reaches the route is a restriction nobody can lift.
    assert body == {"loginGroupWhitelistEnabled": False}


# ── the argument surface, through the real process ────────────────────────

def test_the_switch_flags_are_mutually_exclusive():
    result = cli_run("identity-provider", "update", PROVIDER_ID,
                     "--restrict-login-groups", "--no-restrict-login-groups")
    assert result.returncode != 0
    assert "not allowed with" in (result.stderr + result.stdout)


def test_allow_group_requires_both_ids():
    result = cli_run("identity-provider", "allow-group", PROVIDER_ID)
    assert result.returncode != 0
