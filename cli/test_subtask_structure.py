"""Card 2bc7b303 (owner ruling E374): the CLI Subtask structure verbs.

``add-subtask``, ``reorder-subtasks`` and ``rename-subtask`` are the CLI lane of
``relayhall_subtask_create``, ``_reorder`` and ``_update_text``. Each test drives
the real parser and dispatcher (``main()``) with a recording ``api`` double and
asserts the exact request the verb sends: method, path, body and the
Idempotency-Key header.
"""
import importlib.util
import json
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

CLI_PATH = Path(__file__).with_name('relayhall')
loader = SourceFileLoader('subtask_structure_cli', str(CLI_PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)

T = '2bc7b303-0000-4000-8000-000000000001'
KEY = 'subtask-structure-key-0001'


def run(monkeypatch, argv, response=None):
    calls = []

    def api(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
        calls.append((method, path, data, headers))
        return response if response is not None else {'success': True}

    monkeypatch.setattr(cli, 'api', api)
    monkeypatch.setattr(cli, 'resolve_task_id', lambda value: value)
    monkeypatch.delenv('RELAYHALL_AGENT', raising=False)
    monkeypatch.setattr(sys, 'argv', ['relayhall', *argv])
    code = 0
    try:
        cli.main()
    except SystemExit as exit_:
        code = exit_.code
    return calls, code


def test_add_subtask_appends_with_key(monkeypatch, capsys):
    calls, code = run(monkeypatch, ['add-subtask', T, 'Write the suite', '--idempotency-key', KEY],
                      response={'success': True, 'subtaskId': '42', 'position': 3, 'subtask': {'id': '42'}})
    assert code == 0
    assert calls == [('POST', f'/tasks/{T}/subtasks', {'text': 'Write the suite'}, {'Idempotency-Key': KEY})]
    assert json.loads(capsys.readouterr().out)['subtaskId'] == '42'


def test_add_subtask_position_and_status(monkeypatch):
    calls, code = run(monkeypatch, ['add-subtask', T, 'First', '--position', '1', '--status', 'in-progress'])
    assert code == 0
    assert calls == [('POST', f'/tasks/{T}/subtasks', {'text': 'First', 'position': 1, 'status': 'in-progress'}, None)]


def test_add_subtask_refuses_an_unknown_status_before_any_request(monkeypatch):
    calls, code = run(monkeypatch, ['add-subtask', T, 'x', '--status', 'done'])
    assert code == 2
    assert calls == []


def test_add_subtask_refuses_a_short_key_before_any_request(monkeypatch):
    calls, code = run(monkeypatch, ['add-subtask', T, 'x', '--idempotency-key', 'short'])
    assert code == 2
    assert calls == []


def test_reorder_subtasks_sends_every_id_in_order(monkeypatch):
    calls, code = run(monkeypatch, ['reorder-subtasks', T, '7', '5', '6', '--idempotency-key', KEY])
    assert code == 0
    assert calls == [('POST', f'/tasks/{T}/subtasks/reorder', {'order': ['7', '5', '6']}, {'Idempotency-Key': KEY})]


def test_rename_subtask_patches_the_text_route(monkeypatch):
    calls, code = run(monkeypatch, ['rename-subtask', T, '7', 'New text', '--idempotency-key', KEY])
    assert code == 0
    assert calls == [('PATCH', f'/tasks/{T}/subtasks/by-id/7/text', {'text': 'New text'}, {'Idempotency-Key': KEY})]
