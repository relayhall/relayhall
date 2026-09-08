"""RH-LENSES-a (card 74e02a05) — CLI parity for the remote-group catalog.

`B-L11a` scopes this card's CLI parity to two verbs:
`relayhall directory-group-reference list|use`. These tests measure what the
CLI SENDS and what it PRINTS, because those are the two things a person
depends on and the two things a refactor silently changes.
"""
import importlib.util
import io
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli", importlib.machinery.SourceFileLoader("relayhall_cli", os.path.join(HERE, "relayhall")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Recorder:
    """What the CLI asked the board to do — method, path and body."""

    def __init__(self, answer):
        self.calls = []
        self.answer = answer

    def __call__(self, method, path, data=None, **kwargs):
        self.calls.append((method, path, data))
        return self.answer


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(cli, "api", lambda *a, **k: pytest.fail("the test forgot to install a recorder"))


def test_list_prints_the_count_and_never_an_identity(monkeypatch, capsys):
    recorder = Recorder({
        "references": [{
            "id": "ref-1",
            "externalGroupRef": "CN=Engineering,OU=Groups",
            "displayName": "Engineering",
            "memberCount": 12,
            "sources": ["claim", "scim"],
            "boundGroupName": "Engineering",
            "firstSeenAt": "2026-09-01T00:00:00.000Z",
            "lastSeenAt": "2026-09-05T00:00:00.000Z",
        }],
    })
    monkeypatch.setattr(cli, "api", recorder)
    cli.cmd_directory_group_reference_list(object())
    out = capsys.readouterr().out
    assert recorder.calls == [("GET", "/directory-group-references", None)]
    assert "CN=Engineering,OU=Groups" in out
    assert "members: 12" in out
    assert "claim,scim" in out
    # The catalog is a COUNT and never an identity list. If a future response
    # ever carries members, this is where the CLI would start printing them.
    assert "principal" not in out.lower()


def test_list_explains_an_empty_answer_rather_than_looking_broken(monkeypatch, capsys):
    # A bearer credential -- which is what this CLI presents -- receives 200 and
    # an empty list BY DESIGN. Printing nothing would look like a bug and send
    # an administrator to check their credential.
    monkeypatch.setattr(cli, "api", Recorder({"references": []}))
    cli.cmd_directory_group_reference_list(object())
    out = capsys.readouterr().out
    assert "ROOT LOGIN SESSION" in out


def test_use_sends_only_the_fields_the_route_accepts(monkeypatch, capsys):
    recorder = Recorder({
        "groupId": "g-1", "groupName": "Engineering",
        "externalGroupRef": "CN=Engineering,OU=Groups", "memberCountApplied": 12,
    })
    monkeypatch.setattr(cli, "api", recorder)

    class Args:
        id = "ref-1"
        name = None
        description = None

    cli.cmd_directory_group_reference_use(Args())
    method, path, body = recorder.calls[0]
    assert (method, path) == ("POST", "/directory-group-references/ref-1/use")
    # An OMITTED name is omitted, not sent as null: the route rejects unknown
    # fields, and the server's default (the directory display name, else the
    # reference) is the one a person wants.
    assert body == {}
    out = capsys.readouterr().out
    assert "members applied now: 12" in out


def test_use_passes_an_explicit_name_and_description(monkeypatch):
    recorder = Recorder({
        "groupId": "g-1", "groupName": "Eng", "externalGroupRef": "ref", "memberCountApplied": 0,
    })
    monkeypatch.setattr(cli, "api", recorder)

    class Args:
        id = "ref-1"
        name = "Eng"
        description = "The engineering team"

    cli.cmd_directory_group_reference_use(Args())
    assert recorder.calls[0][2] == {"name": "Eng", "description": "The engineering team"}


def test_the_parser_offers_exactly_the_two_verbs_this_card_owns():
    # `B-L11a` scopes parity to `list` and `use`. A third verb here would be a
    # surface this card did not charter.
    source = io.open(os.path.join(HERE, "relayhall"), encoding="utf-8").read()
    assert 'dgr_sub.add_parser("list"' in source
    assert 'dgr_sub.add_parser(\n        "use"' in source or 'dgr_sub.add_parser("use"' in source
    assert 'dgr_sub.add_parser("delete"' not in source
