"""Owner ruling E467: `relayhall actions` reads the Action Center queue and does nothing else.

The command is a pure read of `GET /notifications/actions/owner`. These tests
pin the exact request (one GET, no body), what it prints for an item the caller
reads and for one it does not (kind and id only), the raw envelope under
--json, the kind filter, and that no verb exists to decide, mark seen or change
anything. The last group runs the real `main()` dispatcher with a recording
double so the wiring is proved, not just the module.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest

from relayhall_actions import ROUTE, register, run, waited

CLI_PATH = Path(__file__).with_name('relayhall')
loader = SourceFileLoader('actions_cli', str(CLI_PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)

TASK = 'e4670000-0000-4000-8000-000000000001'
HIDDEN = 'e4670000-0000-4000-8000-000000000002'
APPROVAL = 'e4670000-0000-4000-8000-000000000003'

ANSWER = {
    'success': True,
    'scope': 'owning-account',
    'items': [
        {'key': f'verify:{TASK}', 'kind': 'verify', 'seen': False, 'reasons': ['verifier'], 'since': '2026-10-24T13:00:00.000Z',
         'waitedSeconds': 26 * 60, 'readable': True, 'waitingOn': 'account',
         'object': {'type': 'task', 'id': TASK, 'title': 'HP-01 Reconcile current evidence'},
         'project': {'id': 'p1', 'name': 'homelab'}, 'href': f'/tasks/{TASK}', 'detail': {}},
        {'key': f'verify:{HIDDEN}', 'kind': 'verify', 'seen': True, 'reasons': [], 'since': '2026-10-24T12:00:00.000Z',
         'waitedSeconds': 3 * 3600 + 5 * 60, 'readable': False, 'waitingOn': 'account',
         'object': {'type': 'task', 'id': HIDDEN, 'title': None}, 'project': None, 'href': f'/tasks/{HIDDEN}', 'detail': {}},
        {'key': f'decision:{APPROVAL}', 'kind': 'decision', 'seen': False, 'reasons': [], 'since': '2026-10-23T12:00:00.000Z',
         'waitedSeconds': 2 * 86400 + 4 * 3600, 'readable': False, 'waitingOn': 'both',
         'object': {'type': 'approval', 'id': APPROVAL, 'title': None}, 'project': None,
         'href': f'/notifications?tab=approvals&approval={APPROVAL}', 'detail': {}},
    ],
    'counts': {'decision': 1, 'verify': 2, 'stuck': 0, 'skill': 0, 'total': 3, 'unseen': 2},
    'capped': {'decision': False, 'verify': False, 'stuck': False, 'skill': False},
    'asOf': '2026-10-24T13:26:00.000Z',
}


def parse(*argv):
    parser = argparse.ArgumentParser()
    register(parser.add_subparsers(dest='command'))
    return parser.parse_args(['actions', *argv])


def run_module(*argv, answer=ANSWER):
    calls = []

    def request(method, path, *rest, **named):
        calls.append((method, path, rest, named))
        return answer

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        result = run(parse(*argv), request)
    return calls, out.getvalue(), result


def test_one_get_of_the_owner_route_and_nothing_else():
    calls, _, result = run_module()
    assert calls == [('GET', '/notifications/actions/owner', (), {})]
    assert ROUTE == '/notifications/actions/owner'
    assert result is ANSWER
    # `list` is the same read as the bare command.
    calls, _, _ = run_module('list')
    assert calls == [('GET', '/notifications/actions/owner', (), {})]


def test_readable_item_shows_its_title_and_an_unreadable_one_only_kind_and_id():
    _, out, _ = run_module()
    assert 'verify   ' + TASK in out
    assert '"HP-01 Reconcile current evidence"' in out
    assert 'proj homelab' in out
    assert 'waiting 26m' in out
    # The hidden Task and the approval: kind, id, wait, link, and no title at all.
    hidden = [row for row in out.splitlines() if HIDDEN in row][0]
    assert '(not readable by you: kind and id only)' in hidden
    assert 'waiting 3h 05m' in hidden and 'seen' in hidden and f'/tasks/{HIDDEN}' in hidden
    approval = [row for row in out.splitlines() if APPROVAL in row][0]
    assert 'decision' in approval and 'waiting 2d 04h' in approval and 'on the Account and you' in approval
    assert 'tab=approvals&approval=' + APPROVAL in approval
    assert "Waiting on your person's Account and you: 3 item(s), 2 unseen." in out


def test_json_is_the_envelope_the_board_returned():
    _, out, _ = run_module('--json')
    assert json.loads(out) == ANSWER


def test_kind_filter_narrows_the_listing_only():
    calls, out, _ = run_module('--kind', 'decision')
    assert calls == [('GET', '/notifications/actions/owner', (), {})]
    assert APPROVAL in out and TASK not in out and HIDDEN not in out
    _, as_json, _ = run_module('--kind', 'verify', '--json')
    assert [item['key'] for item in json.loads(as_json)['items']] == [f'verify:{TASK}', f'verify:{HIDDEN}']


def test_a_caller_with_its_own_list_only_is_told_so():
    own = dict(ANSWER, scope='own', items=[])
    _, out, _ = run_module(answer=own)
    assert out.strip() == 'Nothing is waiting on you.'


def test_cap_is_said_out_loud():
    capped = dict(ANSWER, capped={'decision': False, 'verify': True, 'stuck': False, 'skill': False})
    _, out, _ = run_module(answer=capped)
    assert 'More than the cap of 200 are waiting for: verify.' in out


def test_waited_text():
    assert [waited(value) for value in (0, 59, 60, 26 * 60, 3 * 3600 + 300, 2 * 86400 + 4 * 3600, None)] == [
        '0s', '59s', '1m', '26m', '3h 05m', '2d 04h', '0s']


@pytest.mark.parametrize('verb', ['decide', 'seen', 'mark-seen', 'mark', 'dismiss', 'approve', 'reject', 'delete'])
def test_no_verb_decides_marks_or_changes_anything(verb):
    with contextlib.redirect_stderr(io.StringIO()), pytest.raises(SystemExit):
        parse(verb, TASK)


def test_no_write_flag_exists():
    with contextlib.redirect_stderr(io.StringIO()), pytest.raises(SystemExit):
        parse('--mark-seen')
    with contextlib.redirect_stderr(io.StringIO()), pytest.raises(SystemExit):
        parse('list', '--decide', TASK)


def dispatch(monkeypatch, argv, response=ANSWER):
    """Run `relayhall <argv>` through the real main() with a recording api double."""
    calls = []

    def api(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
        calls.append((method, path, data, headers))
        return response

    monkeypatch.setattr(cli, 'api', api)
    monkeypatch.setattr(sys, 'argv', ['relayhall', *argv])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        cli.main()
    return calls, out.getvalue()


def test_main_dispatches_actions_as_one_get(monkeypatch):
    calls, out = dispatch(monkeypatch, ['actions'])
    assert calls == [('GET', '/notifications/actions/owner', None, None)]
    assert HIDDEN in out
    calls, out = dispatch(monkeypatch, ['actions', 'list', '--json'])
    assert calls == [('GET', '/notifications/actions/owner', None, None)]
    assert json.loads(out) == ANSWER


def test_main_never_sends_a_body_or_a_write_method(monkeypatch):
    for argv in (['actions'], ['actions', 'list'], ['actions', '--json'], ['actions', '--kind', 'stuck']):
        calls, _ = dispatch(monkeypatch, argv)
        assert [(method, data) for method, _, data, _ in calls] == [('GET', None)]
