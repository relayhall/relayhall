"""Card d56e58e1: the CLI matches the REST/MCP contract on its list and write verbs.

Each test drives the real parser and dispatcher (``main()``) with a recording
``api``/``resource_api`` double and asserts the exact request the verb sends:
method, path, body and the Idempotency-Key header. The last group runs the CLI
as a separate process against a recording HTTP stub, so the header and the
refusal code are proved across the wire rather than at the function seam.
"""
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import threading
import urllib.parse
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).with_name('relayhall')
loader = SourceFileLoader('contract_parity_cli', str(CLI_PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)

T = 'd56e58e1-0000-4000-8000-000000000001'
T2 = 'd56e58e1-0000-4000-8000-000000000002'
LEASE = 'd56e58e1-0000-4000-8000-0000000000aa'
KEY = 'parity-retry-key-0001'


def run(monkeypatch, argv, response=None, resource=None):
    """Run ``relayhall <argv>`` in process; return (calls, exit code)."""
    calls = []

    def api(method, path, data=None, timeout=30, exit_on_error=True, headers=None):
        calls.append((method, path, data, headers))
        if callable(response):
            return response(method, path)
        return response if response is not None else {'success': True}

    def resource_api(method, path, data=None, headers=None):
        calls.append((method, path, data, headers))
        return resource if resource is not None else (200, json.dumps({'success': True}))

    monkeypatch.setattr(cli, 'api', api)
    monkeypatch.setattr(cli, 'resource_api', resource_api)
    monkeypatch.setattr(cli, 'resolve_task_id', lambda value: value)
    monkeypatch.setattr(cli, 'resolve_task_id_list', lambda values: list(values))
    monkeypatch.setattr(cli, 'resolve_project', lambda value: value)
    monkeypatch.setattr(cli, 'resolve_project_id', lambda value: value)
    monkeypatch.setattr(cli, 'resolve_resource_project', lambda value: value)
    monkeypatch.delenv('RELAYHALL_AGENT', raising=False)
    monkeypatch.setattr(sys, 'argv', ['relayhall', *argv])
    code = 0
    try:
        cli.main()
    except SystemExit as exit_:
        code = exit_.code
    return calls, code


def query_of(path):
    return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).items()}


# ── the embedded self-test (card d4290486) ──────────────────────────────────

def test_embedded_self_test_exits_zero():
    result = subprocess.run([sys.executable, str(CLI_PATH), '--test'], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout[-2000:]
    assert 'Failed: 0' in result.stdout


def test_self_test_oracle_is_the_icon_table():
    # review is the yellow marker in the docstring, the table and the docs; the
    # in-progress marker is the arrows. The oracle checks both, by name.
    assert cli.format_subtask_status({'status': 'review'}) == '\U0001F7E1'
    assert cli.format_subtask_status({'status': 'in-progress'}) == '\U0001F504'
    source = CLI_PATH.read_text(encoding='utf-8')
    assert '({"status": "review"}, "\U0001F7E1")' in source
    assert '({"status": "in-progress"}, "\U0001F504")' in source


# ── read verbs the MCP surface has and the CLI lacked ──────────────────────

def test_task_stream_reads_the_governed_stream_route(monkeypatch):
    calls, code = run(monkeypatch, ['task-stream', T], {'success': True, 'entries': []})
    assert code == 0
    assert calls == [('GET', f'/tasks/{T}/stream', None, None)]


def test_task_timeline_forwards_filter_cursor_and_limit(monkeypatch):
    calls, code = run(monkeypatch, ['task-timeline', T, '--filter', 'handover', '--before', 'c1.x', '--limit', '7'])
    assert code == 0
    method, path, data, headers = calls[0]
    assert (method, path.split('?')[0]) == ('GET', f'/tasks/{T}/timeline')
    assert query_of(path) == {'filter': 'handover', 'before': 'c1.x', 'limit': '7'}


def test_task_graph_joins_list_filters_onto_the_route_wire_form(monkeypatch):
    calls, code = run(monkeypatch, [
        'task-graph', '--status', 'todo', '--status', 'review', '--project', 'RelayHall', '--phase', 'null',
        '--priority', 'high', '--tag', 'a', '--tag', 'b', '--q', 'parity', '--lod', 'project',
        '--updated-since', '2026-10-19T00:00:00.000Z', '--include-archived', '--mine', '--unassigned',
        '--owner', 'someone', '--without-usable-verifier'])
    assert code == 0
    method, path, data, headers = calls[0]
    assert (method, path.split('?')[0]) == ('GET', '/tasks/graph')
    assert query_of(path) == {
        'statuses': 'todo,review', 'projects': 'RelayHall', 'phaseIds': 'null', 'priorities': 'high',
        'tags': 'a,b', 'q': 'parity', 'lod': 'project', 'updatedSince': '2026-10-19T00:00:00.000Z',
        'includeArchived': 'true', 'mine': 'true', 'unassigned': 'true', 'owner': 'someone',
        'verifierUnusable': 'true'}


def test_task_graph_without_filters_sends_no_query(monkeypatch):
    calls, _ = run(monkeypatch, ['task-graph'])
    assert calls == [('GET', '/tasks/graph', None, None)]


def test_task_list_offers_tag_query_and_archived_filters(monkeypatch):
    calls, code = run(monkeypatch, ['list', '--tag', 'cli', '--query', 'parity check', '--include-archived'], {'tasks': []})
    assert code == 0
    method, path, data, headers = calls[0]
    assert path.split('?')[0] == '/tasks'
    assert query_of(path) == {'tag': 'cli', 'q': 'parity check', 'includeArchived': 'true'}


def test_report_list_can_page_and_filter_like_the_search_tool(monkeypatch):
    calls, code = run(monkeypatch, ['report', 'list', '--tags', 'a b,c', '--limit', '10', '--offset', '40',
                                    '--status', 'archived', '--updated-since', '2026-10-01T00:00:00Z',
                                    '--sort', 'updated_at', '--order', 'asc'], {'reports': []})
    assert code == 0
    assert query_of(calls[0][1]) == {'tags': 'a b,c', 'limit': '10', 'offset': '40', 'status': 'archived',
                                     'updated_since': '2026-10-01T00:00:00Z', 'sort': 'updated_at', 'order': 'asc'}


def test_report_search_pages_with_offset(monkeypatch):
    calls, code = run(monkeypatch, ['report', 'search', 'parity', '--offset', '20', '--status', 'active'], {'reports': []})
    assert code == 0
    assert query_of(calls[0][1]) == {'q': 'parity', 'limit': '20', 'offset': '20', 'status': 'active'}


def test_session_brief_compiles_the_callers_own_brief(monkeypatch, capsys):
    calls, code = run(monkeypatch, ['session-brief'], {'success': True, 'brief': '# Session brief'})
    assert code == 0
    assert calls == [('POST', '/principals/me/brief', {}, None)]
    assert '# Session brief' in capsys.readouterr().out


def test_warrants_lists_the_delegation_warrants(monkeypatch):
    calls, code = run(monkeypatch, ['warrants'], {'success': True, 'warrants': []})
    assert code == 0
    assert calls == [('GET', '/delegation/warrants', None, None)]


def test_service_review_requests_pulls_the_connector_queue(monkeypatch):
    calls, code = run(monkeypatch, ['service', 'review-requests', 'svc-uuid'],
                      resource=(200, json.dumps({'success': True, 'requests': []})))
    assert code == 0
    assert calls == [('GET', '/services/svc-uuid/review-requests', None, None)]


def test_principal_remediation_queue_names_the_deprovision_signal(monkeypatch, capsys):
    row = {'principalId': T, 'kind': 'user', 'handle': 'leaver', 'status': 'disabled', 'liveCredentials': 0,
           'legacyIdentity': False, 'deprovisionSignal': 'scim-active-false', 'reason': 'deprovision detected by the directory'}
    calls, code = run(monkeypatch, ['principal', 'remediation-queue'], {'success': True, 'queue': [row]})
    assert code == 0
    assert calls == [('GET', '/principals/remediation-queue', None, None)]
    out = capsys.readouterr().out
    assert 'leaver' in out and 'scim-active-false' in out and 'deprovision detected by the directory' in out


# ── write verbs the MCP surface has and the CLI lacked ─────────────────────

def test_task_success_criteria_writes_a_list_or_a_text(monkeypatch):
    calls, code = run(monkeypatch, ['task-success-criteria', T, '--criterion', 'a', '--criterion', 'b'])
    assert code == 0
    assert calls == [('PATCH', f'/tasks/{T}/success-criteria', {'successCriteria': ['a', 'b']}, None)]
    calls, code = run(monkeypatch, ['task-success-criteria', T, '--criteria', 'one text'])
    assert calls == [('PATCH', f'/tasks/{T}/success-criteria', {'successCriteria': 'one text'}, None)]


@pytest.mark.parametrize('verb,value', [('task-arm', True), ('task-park', False)])
def test_arm_and_park_write_auto_start_with_the_retry_key(monkeypatch, verb, value):
    calls, code = run(monkeypatch, [verb, T, '--idempotency-key', KEY])
    assert code == 0
    assert calls == [('PATCH', f'/tasks/{T}', {'autoStart': value}, {'Idempotency-Key': KEY})]


@pytest.mark.parametrize('verb', ['task-arm', 'task-park'])
def test_arm_and_park_require_a_well_formed_retry_key(monkeypatch, verb):
    calls, code = run(monkeypatch, [verb, T])
    assert code == 2 and calls == []
    calls, code = run(monkeypatch, [verb, T, '--idempotency-key', 'short'])
    assert code == 2 and calls == []


def test_task_release_forwards_only_the_reason(monkeypatch):
    calls, _ = run(monkeypatch, ['task-release', T, '--reason', 'handing back'])
    assert calls == [('POST', f'/tasks/{T}/release', {'reason': 'handing back'}, None)]
    calls, _ = run(monkeypatch, ['task-release', T])
    assert calls == [('POST', f'/tasks/{T}/release', {}, None)]


def test_task_recover_sends_the_route_arguments(monkeypatch):
    calls, code = run(monkeypatch, ['task-recover', T, '--service', 'svc', '--option', 'mode=fast', '--reason', 'melted',
                                    '--role-grant-expires-at', '2026-12-01T00:00:00Z'])
    assert code == 0
    assert calls == [('POST', f'/tasks/{T}/recover', {
        'executionProfile': {'serviceId': 'svc', 'options': {'mode': 'fast'}},
        'reason': 'melted', 'roleGrantExpiresAt': '2026-12-01T00:00:00Z'}, None)]
    calls, _ = run(monkeypatch, ['task-recover', T, '--service', 'svc', '--warrant', T2])
    assert calls[0][2] == {'executionProfile': {'serviceId': 'svc', 'options': {}}, 'executionWarrantId': T2}


def test_task_recover_requires_the_connector(monkeypatch):
    calls, code = run(monkeypatch, ['task-recover', T])
    assert code == 2 and calls == []


def test_lease_claim_renew_release(monkeypatch):
    calls, _ = run(monkeypatch, ['lease', 'claim', T, '--lease-seconds', '300'], {'lease': {'id': LEASE}})
    assert calls == [('POST', f'/tasks/orchestration/{T}/claim', {'leaseSeconds': 300}, None)]
    calls, _ = run(monkeypatch, ['lease', 'renew', T, LEASE], {'lease': {'id': LEASE}})
    assert calls == [('POST', f'/tasks/orchestration/{T}/lease/{LEASE}/heartbeat', {}, None)]
    calls, _ = run(monkeypatch, ['lease', 'release', T, LEASE, '--reason', 'done'])
    assert calls == [('POST', f'/tasks/orchestration/{T}/lease/{LEASE}/release', {'reason': 'done'}, None)]


def test_bulk_archive_names_every_task_in_input_order(monkeypatch):
    calls, code = run(monkeypatch, ['bulk-archive', T2, T, '--reason', 'sprint closed'], {'success': True, 'results': []})
    assert code == 0
    assert calls == [('POST', '/tasks/bulk-archive', {'taskIds': [T2, T], 'reason': 'sprint closed'}, None)]


def test_bulk_archive_refuses_more_than_two_hundred_before_sending(monkeypatch):
    ids = [T] * 201
    calls, code = run(monkeypatch, ['bulk-archive', *ids])
    assert code == 2 and calls == []


def test_knowledge_note_propose_preview_commit(monkeypatch):
    calls, _ = run(monkeypatch, ['knowledge', 'propose', '--title', 'Parity', '--content', 'Body', '--source', T,
                                 '--note-type', 'decision', '--tag', 'cli', '--target', 'personal', '--task', T2,
                                 '--basis', 'h1', '--expected-revision', 'absent'])
    assert calls == [('POST', '/knowledge-writes/propose', {
        'title': 'Parity', 'content': 'Body', 'source': T, 'noteType': 'decision', 'tags': ['cli'],
        'target': 'personal', 'taskId': T2, 'basis': ['h1'], 'expectedRevision': 'absent'}, None)]
    calls, _ = run(monkeypatch, ['knowledge', 'propose', '--title', 'P', '--content', 'B', '--target', T2])
    assert calls[0][2]['target'] == {'compartmentId': T2}
    calls, _ = run(monkeypatch, ['knowledge', 'preview', T])
    assert calls == [('POST', '/knowledge-writes/preview', {'proposalId': T}, None)]
    digest = 'a' * 64
    calls, _ = run(monkeypatch, ['knowledge', 'commit', T, '--preview-digest', digest, '--expected-revision', 'absent',
                                 '--idempotency-key', KEY])
    assert calls == [('POST', '/knowledge-writes/commit',
                      {'proposalId': T, 'previewDigest': digest, 'expectedRevision': 'absent'}, {'Idempotency-Key': KEY})]


def test_knowledge_commit_requires_the_retry_key(monkeypatch):
    calls, code = run(monkeypatch, ['knowledge', 'commit', T, '--preview-digest', 'a' * 64, '--expected-revision', 'absent'])
    assert code == 2 and calls == []


def test_access_request_actions(monkeypatch, tmp_path):
    calls, _ = run(monkeypatch, ['access-request', 'preview', '--target-type', 'grant.rows', '--object-type', 'task', '--target-id', T])
    assert calls[0][0] == 'GET' and calls[0][1].split('?')[0] == '/delegation/access-requests/preview'
    assert query_of(calls[0][1]) == {'targetType': 'grant.rows', 'objectType': 'task', 'targetId': T}
    change = tmp_path / 'change.json'
    change.write_text(json.dumps({'scopes': ['tasks:read']}), encoding='utf-8')
    calls, _ = run(monkeypatch, ['access-request', 'file', '--kind', 'change', '--target-type', 'credential.scopes',
                                 '--target-id', T2, '--change-file', str(change), '--reason', 'the parity lane needs this read',
                                 '--related-task', T])
    assert calls == [('POST', '/delegation/access-requests', {
        'kind': 'change', 'targetType': 'credential.scopes', 'targetId': T2, 'change': {'scopes': ['tasks:read']},
        'reason': 'the parity lane needs this read', 'relatedTaskId': T}, None)]
    calls, _ = run(monkeypatch, ['access-request', 'file', '--kind', 'credential', '--scope', 'tasks:read',
                                 '--reason', 'a second harness needs its own key', '--related-phase', T2])
    assert calls[0][2] == {'kind': 'credential', 'requestedScopes': ['tasks:read'],
                           'reason': 'a second harness needs its own key', 'relatedPhaseId': T2}
    calls, _ = run(monkeypatch, ['access-request', 'status', '--approval', T])
    assert calls == [('GET', f'/delegation/access-requests/{T}', None, None)]
    calls, _ = run(monkeypatch, ['access-request', 'withdraw', T])
    assert calls == [('POST', f'/delegation/access-requests/{T}/withdraw', {}, None)]
    calls, _ = run(monkeypatch, ['access-request', 'collect', T])
    assert calls == [('POST', f'/delegation/access-requests/{T}/collect', {}, None)]


def test_access_request_status_lists_every_kind_with_the_mints(monkeypatch, capsys):
    def response(method, path):
        if 'kind=agent-mint' in path:
            return {'success': True, 'approvals': [{'id': 'mint', 'requestedAt': '2026-10-19T02:00:00Z'}]}
        return {'success': True, 'approvals': [{'id': 'grant', 'requestedAt': '2026-10-19T01:00:00Z'}]}
    calls, _ = run(monkeypatch, ['access-request', 'status', '--status', 'pending'], response)
    assert [query_of(c[1]) for c in calls] == [{'status': 'pending'}, {'status': 'pending', 'kind': 'agent-mint'}]
    assert [row['id'] for row in json.loads(capsys.readouterr().out)['approvals']] == ['mint', 'grant']


def test_credential_reveal(monkeypatch):
    calls, _ = run(monkeypatch, ['credential', 'reveal', T])
    assert calls == [('POST', f'/credentials/{T}/reveal', {}, None)]


def test_native_execution_and_review_route_like_the_tools(monkeypatch, tmp_path):
    payload = tmp_path / 'p.json'
    payload.write_text('{"x": 1}', encoding='utf-8')
    root = f'/tasks/{T}/native-executions'
    calls, _ = run(monkeypatch, ['native-execution', T, 'list'])
    assert calls == [('GET', root, None, None)]
    calls, _ = run(monkeypatch, ['native-execution', T, 'open', '--payload-file', str(payload)])
    assert calls == [('POST', root, {'x': 1}, None)]
    calls, _ = run(monkeypatch, ['native-execution', T, 'heartbeat', '--execution-id', T2, '--payload-file', str(payload)])
    assert calls == [('POST', f'{root}/{T2}/heartbeat', {'x': 1}, None)]
    calls, code = run(monkeypatch, ['native-execution', T, 'heartbeat', '--payload-file', str(payload)])
    assert code == 2 and calls == []
    root = f'/tasks/{T}/native-reviews'
    calls, _ = run(monkeypatch, ['native-review', T, 'inputs'])
    assert calls == [('GET', f'{root}/inputs', None, None)]
    calls, _ = run(monkeypatch, ['native-review', T, 'list'])
    assert calls == [('GET', root, None, None)]
    calls, _ = run(monkeypatch, ['native-review', T, 'request', '--payload-file', str(payload)])
    assert calls == [('POST', root, {'x': 1}, None)]
    calls, _ = run(monkeypatch, ['native-review', T, 'verdict', '--review-id', T2, '--payload-file', str(payload)])
    assert calls == [('POST', f'{root}/{T2}/verdict', {'x': 1}, None)]


def test_native_generation_reads_its_payload_file_in_the_real_module(monkeypatch, tmp_path):
    # test_native_generation.py injects Path into a namespace; this drives the
    # module as installed, where the name must be imported.
    payload = tmp_path / 'p.json'
    payload.write_text('{"schemaVersion": 2}', encoding='utf-8')
    calls, code = run(monkeypatch, ['native-generation', T, 'reserve', '--payload-file', str(payload)])
    assert code == 0
    assert calls == [('POST', f'/tasks/{T}/native-executions/generations', {'schemaVersion': 2}, None)]


def test_project_flag_accepts_the_project_id_the_route_accepts(monkeypatch):
    # Found by the live drill: create/update/list --project <UUID> exited
    # "No project found" although POST /tasks and the MCP tools take an id.
    projects = {'projects': [{'id': T, 'name': 'Parity drill'}, {'id': T2, 'name': 'Other'}]}
    monkeypatch.setattr(cli, 'api', lambda method, path, data=None, **kw: projects)
    assert cli.resolve_project(T) == T
    assert cli.resolve_project(T.upper()) == T
    assert cli.resolve_project('Parity drill') == 'Parity drill'


# ── fields and retry keys on existing write verbs ──────────────────────────

def test_task_append_forwards_the_reference_and_the_retry_key(monkeypatch):
    calls, _ = run(monkeypatch, ['task-append', T, '--content', 'note', '--referenced-entry', T2, '--idempotency-key', KEY])
    assert calls == [('POST', f'/tasks/{T}/stream', {
        'content': 'note', 'provenance': 'authored', 'eventType': 'handover.note', 'dryRun': False,
        'referencedEntryId': T2}, {'Idempotency-Key': KEY})]


def test_task_reference_add_forwards_metadata_and_the_retry_key(monkeypatch):
    calls, _ = run(monkeypatch, ['task-reference', 'add', T, '--kind', 'report', '--target-id', T2, '--label', 'Evidence',
                                 '--metadata', '{"pinned": true}', '--idempotency-key', KEY])
    assert calls == [('POST', f'/tasks/{T}/references', {
        'kind': 'report', 'targetId': T2, 'targetUri': None, 'label': 'Evidence', 'dryRun': False,
        'metadata': {'pinned': True}}, {'Idempotency-Key': KEY})]


def test_move_with_notes_appends_a_note_and_never_replaces_the_task_notes(monkeypatch):
    calls, code = run(monkeypatch, ['move', T, 'review', '--notes', 'Ready for review', '--idempotency-key', KEY],
                      {'success': True, 'task': {'id': T, 'status': 'review', 'title': 't'}})
    assert code == 0
    assert calls == [
        ('POST', f'/tasks/{T}/notes', {'text': 'Ready for review'}, {'Idempotency-Key': KEY}),
        ('PATCH', f'/tasks/{T}', {'status': 'review'}, {'Idempotency-Key': KEY}),
    ]


def test_move_with_notes_and_no_key_mints_one_and_prints_it(monkeypatch, capsys):
    calls, code = run(monkeypatch, ['move', T, 'review', '--notes', 'Ready'],
                      {'success': True, 'task': {'id': T, 'status': 'review', 'title': 't'}})
    assert code == 0
    note_key = calls[0][3]['Idempotency-Key']
    assert calls[1][3] == {'Idempotency-Key': note_key} and 16 <= len(note_key) <= 128
    assert note_key in capsys.readouterr().err


def test_move_without_notes_sends_only_the_status(monkeypatch):
    calls, _ = run(monkeypatch, ['move', T, 'review'], {'success': True, 'task': {'id': T, 'status': 'review', 'title': 't'}})
    assert calls == [('PATCH', f'/tasks/{T}', {'status': 'review'}, None)]


def test_create_forwards_the_retry_key_warrant_and_grant_expiry(monkeypatch):
    def response(method, path):
        if path == '/personalities':
            return {'success': True, 'personalities': []}
        return {'success': True, 'task': {'id': T, 'title': 'x', 'status': 'todo', 'subtasks': [{}], 'project': 'p', 'description': 'd'}}
    calls, code = run(monkeypatch, ['create', 'x', '--no-subtasks', '--service', 'svc', '--warrant', T2,
                                    '--idempotency-key', KEY], response)
    assert code == 0
    method, path, data, headers = calls[-1]
    assert (method, path, headers) == ('POST', '/tasks', {'Idempotency-Key': KEY})
    assert data['executionWarrantId'] == T2
    calls, _ = run(monkeypatch, ['create', 'x', '--no-subtasks', '--service', 'svc',
                                 '--role-grant-expires-at', '2026-12-01T09:00', '--role-grant-zone', 'Europe/Warsaw'], response)
    assert calls[-1][2]['roleGrantExpiresAt'] == {'local': '2026-12-01T09:00', 'zone': 'Europe/Warsaw'}
    assert calls[-1][3] is None


def test_update_forwards_the_retry_key(monkeypatch):
    calls, _ = run(monkeypatch, ['update', T, '--priority', 'high', '--idempotency-key', KEY],
                   {'success': True, 'task': {'id': T, 'status': 'todo', 'title': 't'}})
    assert calls == [('PATCH', f'/tasks/{T}', {'priority': 'high'}, {'Idempotency-Key': KEY})]


def test_report_project_phase_and_resource_creates_forward_the_retry_key(monkeypatch):
    calls, _ = run(monkeypatch, ['report', 'create', 'R', '--content', 'C', '--idempotency-key', KEY],
                   {'success': True, 'report': {'id': T}})
    assert (calls[-1][0], calls[-1][1], calls[-1][3]) == ('POST', '/reports', {'Idempotency-Key': KEY})
    calls, _ = run(monkeypatch, ['project', 'create', '--name', 'P', '--idempotency-key', KEY],
                   {'success': True, 'project': {'id': T}})
    assert (calls[-1][0], calls[-1][1], calls[-1][3]) == ('POST', '/projects', {'Idempotency-Key': KEY})
    calls, _ = run(monkeypatch, ['phase', 'create', 'Ph', '--project', 'P', '--idempotency-key', KEY],
                   resource=(201, json.dumps({'success': True, 'phase': {'id': T, 'name': 'Ph'}})))
    assert (calls[-1][0], calls[-1][1], calls[-1][3]) == ('POST', '/phases', {'Idempotency-Key': KEY})
    calls, _ = run(monkeypatch, ['project', 'resource', 'add-reference', 'P', '--name', 'Doc', '--url', 'https://example.org/doc', '--category', 'documentation',
                                 '--idempotency-key', KEY],
                   resource=(201, json.dumps({'success': True, 'resource': {'id': T}})))
    assert (calls[-1][0], calls[-1][1], calls[-1][3]) == ('POST', f'/projects/P/resources', {'Idempotency-Key': KEY})


def test_creates_without_a_key_send_no_header(monkeypatch):
    calls, _ = run(monkeypatch, ['project', 'create', '--name', 'P'], {'success': True, 'project': {'id': T}})
    assert calls[-1][3] is None


def test_a_malformed_retry_key_is_a_usage_error(monkeypatch):
    calls, code = run(monkeypatch, ['project', 'create', '--name', 'P', '--idempotency-key', 'x' * 129])
    assert code == 2 and calls == []


# ── absorbed 78b216bc: the SCIM heartbeat interval ─────────────────────────

def test_identity_provider_create_and_update_carry_the_scim_heartbeat(monkeypatch):
    calls, _ = run(monkeypatch, ['identity-provider', 'create', '--name', 'IdP', '--issuer', 'https://idp.example',
                                 '--client-id', 'c', '--subject-immutable', '--scim-heartbeat-interval-hours', '24'],
                   {'identityProvider': {'id': T}})
    assert calls[-1][2]['scimHeartbeatIntervalHours'] == 24
    calls, _ = run(monkeypatch, ['identity-provider', 'update', T, '--scim-heartbeat-interval-hours', 'none'],
                   {'identityProvider': {'id': T}})
    assert calls == [('PATCH', f'/identity-providers/{T}', {'scimHeartbeatIntervalHours': None}, None)]
    calls, code = run(monkeypatch, ['identity-provider', 'update', T, '--scim-heartbeat-interval-hours', '0'])
    assert code == 2 and calls == []


def test_identity_provider_list_renders_the_heartbeat(monkeypatch, capsys):
    providers = [{'id': T, 'name': 'A', 'subjectImmutable': True, 'scimHeartbeatIntervalHours': 12},
                 {'id': T2, 'name': 'B', 'subjectImmutable': True, 'scimHeartbeatIntervalHours': None}]
    run(monkeypatch, ['identity-provider', 'list'], {'identityProviders': providers})
    lines = capsys.readouterr().out.splitlines()
    assert 'scim-heartbeat=12h' in lines[0]
    assert 'scim-heartbeat=off' in lines[1]


# ── across the wire: a recording HTTP stub, the CLI as its own process ─────

class _Recorder(http.server.BaseHTTPRequestHandler):
    seen = []
    reply = (200, {'success': True})

    def _handle(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length).decode() if length else ''
        type(self).seen.append({'method': self.command, 'path': self.path,
                                'key': self.headers.get('Idempotency-Key'), 'body': json.loads(body) if body else None})
        status, payload = type(self).reply
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _handle

    def log_message(self, *args):
        pass


@pytest.fixture
def stub(tmp_path):
    _Recorder.seen = []
    _Recorder.reply = (200, {'success': True, 'task': {'id': T, 'status': 'review', 'title': 't'}})
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _Recorder)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {k: v for k, v in os.environ.items() if not k.startswith('RELAYHALL_')}
    env.update({'RELAYHALL_TOKEN': 'stub-token', 'RELAYHALL_CONFIG_DIR': str(tmp_path), 'HOME': str(tmp_path)})

    def call(*argv):
        return subprocess.run([sys.executable, str(CLI_PATH), '--api', f'http://127.0.0.1:{server.server_address[1]}', *argv],
                              capture_output=True, text=True, env=env, timeout=60)
    yield call
    server.shutdown()


def test_wire_arm_carries_the_header_and_body(stub):
    result = stub('task-arm', T, '--idempotency-key', KEY)
    assert result.returncode == 0, result.stderr
    assert _Recorder.seen == [{'method': 'PATCH', 'path': f'/tasks/{T}', 'key': KEY, 'body': {'autoStart': True}}]


def test_wire_move_with_notes_is_two_limbs_under_one_key(stub):
    result = stub('move', T, 'review', '--notes', 'Ready for independent review', '--idempotency-key', KEY)
    assert result.returncode == 0, result.stderr
    assert [(r['method'], r['path'], r['key'], r['body']) for r in _Recorder.seen] == [
        ('POST', f'/tasks/{T}/notes', KEY, {'text': 'Ready for independent review'}),
        ('PATCH', f'/tasks/{T}', KEY, {'status': 'review'}),
    ]


def test_wire_refusal_prints_the_stable_code(stub):
    _Recorder.reply = (409, {'success': False, 'code': 'REASSIGNMENT_REQUIRED', 'error': 'Recovery needs a Connector'})
    result = stub('task-release', T)
    assert result.returncode == 1
    assert 'API error: Recovery needs a Connector [REASSIGNMENT_REQUIRED]' in result.stderr
