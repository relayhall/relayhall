// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { BlueprintsPage } from './BlueprintsPage';
import { authenticatedFetch } from '../utils/auth';
import type { BlueprintDetail, BlueprintPreview, BlueprintResult } from '../types/blueprint';

const session = vi.hoisted(() => ({ scopes: ['blueprints:use'] as string[] }));
vi.mock('../hooks/usePrincipals', () => ({ useMyPrincipal: () => ({ scopes: session.scopes }) }));
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
const fetcher = vi.mocked(authenticatedFetch);
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body } as Response);
const detail = (): BlueprintDetail => ({ id: 'blueprint-one', key: 'incident-investigation', version: 2, name: 'Incident investigation', summary: 'Review an incident with a human decision.', tags: ['incident'], projection: 'use', status: 'published', contentSha256: 'content', identitySha256: 'identity',
  target: { mode: 'new-project', project: { name: '{{incident}}' } }, counts: { phases: 1, tasks: 3, reports: 1, humanGates: 1 },
  parameters: [{ key: 'incident', label: 'Incident', promptText: 'Which incident?', help: 'Use the incident reference.', type: 'string', required: true, order: 1, constraints: { pattern: '^INC-[0-9]{1,6}$' } }], references: [],
  availableActions: ['instantiate'], document: { schemaVersion: 'rh.blueprint/1.0', blueprint: { key: 'incident-investigation', version: 2, name: 'Incident investigation', summary: '', description: '', tags: [], provenance: 'human-authored' },
    target: { mode: 'new-project', project: { name: '{{incident}}' } }, parameters: [], references: [], phases: [], tasks: [], reports: [], humanGates: [], dependencies: [] },
});
const preview = (): BlueprintPreview => ({ blueprint: { id: 'blueprint-one', key: 'incident-investigation', version: 2 }, targetArchived: false,
  plan: { target: { mode: 'new-project' }, project: { name: 'INC-12' }, phases: [{ key: 'review', name: 'Review' }],
    tasks: [{ key: 'decision', title: 'Choose a response', autoStart: false, roles: { verifierHandle: 'reviewer' }, subtasks: [{ text: 'Deploy' }, { text: 'Hold' }] }, { key: 'announce', title: 'Announce <script>literal</script>', autoStart: false, phaseKey: 'review', roles: { shepherdHandle: 'reviewer', verifierHandle: 'observer' } }],
    reports: [{ key: 'findings', title: 'Findings', content: '<img src=x onerror=alert(1)>', task: 'announce' }], dependencies: [{ task: 'announce', dependsOn: 'decision' }],
    references: [{ kind: 'skill', name: 'optional-analysis', outcome: 'resolved', resolved: {kind:'skill',name:'optional-analysis',id:'skill-one'} }], authority: [{ operation: 'task.create', scope: 'tasks:write', allowed: true }],
    humanGates: [{ key: 'decision', decider: { handle: 'reviewer' }, arms: [{ label: 'Deploy', tasks: ['announce'] }, { label: 'Hold', tasks: ['announce'] }], allParked: true, disposition: 'All tasks stay parked. Unchosen arms remain parked.' }],
    counts: { projects: 1, phases: 1, tasks: 2, subtasks: 2, reports: 1, dependencies: 1, humanGates: 1 }, parameterValues: { incident: 'INC-12' }, refusals: [],
  },
});
const result = (): BlueprintResult => ({ instantiationId: 'instance-one', projectId: 'project-one', blueprint: { key: 'incident-investigation', version: 2 }, phases: { review: 'phase-one' }, tasks: { decision: 'task-one', announce: 'task-two' }, reports: { findings: 'report-one' }, warnings: [] });
let current: BlueprintDetail; let plan: BlueprintPreview; let requests: { path: string; options?: RequestInit }[];
let create: (options?: RequestInit) => Promise<Response>;
let extra: ((path: string, options?: RequestInit) => Promise<Response> | undefined) | undefined;
let key: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks(); session.scopes = ['blueprints:use']; current = detail(); current.document.parameters = current.parameters; plan = preview(); requests = []; extra = undefined;
  key = vi.fn().mockReturnValueOnce('confirmation-key-00000001').mockReturnValue('confirmation-key-00000002'); vi.stubGlobal('crypto', { randomUUID: key });
  create = async () => json({ success: true, ...result() }, 201);
  fetcher.mockImplementation(async (url, options) => {
    const path = String(url).replace(/^\/api/, ''); requests.push({ path, options });
    const special = extra?.(path, options); if (special) return special;
    if (path.endsWith('/instantiations/preview')) return json({ success: true, ...plan });
    if (path.endsWith('/instantiations') && options?.method === 'POST') return create(options);
    if (path === '/blueprints') return json({ success: true, blueprints: [current] });
    if (path.startsWith('/blueprints/')) return json({ success: true, blueprint: current });
    throw new Error(`Unexpected mocked route: ${path}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = (path = '/blueprints') => render(<MemoryRouter initialEntries={[path]}><BlueprintsPage /></MemoryRouter>);
async function collect() {
  fireEvent.click(await screen.findByRole('button', { name: 'Describe Incident investigation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use Blueprint' }));
  fireEvent.change(screen.getByLabelText('Which incident? (required)'), { target: { value: 'INC-12' } });
}
async function toPreview() { await collect(); fireEvent.click(screen.getByRole('button', { name: 'Preview plan' })); await screen.findByRole('button', { name: 'Create' }); }
async function toConfirm() { await toPreview(); }
const writes = () => requests.filter(row => row.path.endsWith('/instantiations') && row.options?.method === 'POST');

describe('Blueprint confirmation and request lifecycle', () => {
  test('confirmation uses secure random bytes when randomUUID is unavailable', async () => {
    const randomBytes = vi.fn((bytes: Uint8Array) => { bytes.fill(17); return bytes; }); vi.stubGlobal('crypto', { getRandomValues: randomBytes });
    mount(); await toConfirm(); expect(randomBytes).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('The work was created. All tasks remain parked.'); expect(randomBytes).toHaveBeenCalledTimes(1);
    expect((writes()[0].options?.headers as Record<string, string>)['Idempotency-Key']).toBe('11'.repeat(16));
  });
  test('only explicit confirmation creates a key and submits the exact preview body', async () => {
    mount(); await toConfirm(); expect(key).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Create' }); fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('The work was created. All tasks remain parked.');
    expect(key).toHaveBeenCalledTimes(1); expect(writes()).toHaveLength(1);
    expect(writes()[0].options?.body).toBe(requests.find(row => row.path.endsWith('/preview'))?.options?.body);
    expect((writes()[0].options?.headers as Record<string, string>)['Idempotency-Key']).toBe('confirmation-key-00000001');
    expect(screen.getByRole('link', { name: 'project-one' }).getAttribute('href')).toBe('/projects?open=project-one');
  });
  test('an uncertain response retries the identical body and key without offering edits', async () => {
    let calls = 0; create = async () => { if (++calls === 1) throw new Error('connection lost'); return json({ success: true, ...result() }, 201); };
    mount(); await toConfirm(); fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText(/request may already have committed/);
    expect(screen.queryByRole('button', { name: 'Edit answers and preview again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' })); await screen.findByText('The work was created. All tasks remain parked.');
    expect(writes()).toHaveLength(2); expect(writes()[1].options).toEqual(writes()[0].options); expect(key).toHaveBeenCalledTimes(1);
  });
  test('edited input requires a new preview, confirmation and key after a definite refusal', async () => {
    let calls = 0; create = async () => ++calls === 1 ? json({ success: false, code: 'PARAMETER_VALUE_REFUSED', error: 'Review the answer.', field: 'incident' }, 422) : json({ success: true, ...result() }, 201);
    mount(); await toConfirm(); fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit answers and preview again' }));
    fireEvent.change(screen.getByLabelText('Which incident? (required)'), { target: { value: 'INC-13' } });
    expect(key).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    await screen.findByText('The work was created. All tasks remain parked.');
    expect(key).toHaveBeenCalledTimes(2); expect(writes()[1].options?.body).toContain('INC-13');
    expect(writes()[1].options?.headers).not.toEqual(writes()[0].options?.headers);
    expect(requests.filter(row => row.path.endsWith('/preview'))).toHaveLength(2);
  });
  test.each(['authority', 'reference', 'refusal', 'archived'] as const)('preview diagnoses %s while confirmation stays disabled', async kind => {
    if (kind === 'authority') plan.plan.authority[0].allowed = false;
    if (kind === 'reference') plan.plan.references[0].outcome = 'missing-required';
    if (kind === 'refusal') plan.plan.refusals.push({ code: 'BLUEPRINT_CREATE_KIND_FORBIDDEN', error: 'Execution assignment requires Grants outside the Blueprint create allowlist', field: 'tasks.announce.defaults.executionProfile' });
    if (kind === 'archived') plan.targetArchived = true;
    mount(); await toPreview(); expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    expect(key).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
    if (kind === 'authority') expect(screen.getByText('Missing authority')).toBeTruthy();
    if (kind === 'refusal') expect(screen.getByText('BLUEPRINT_CREATE_KIND_FORBIDDEN')).toBeTruthy();
  });
});

describe('Blueprint audience and complete preview', () => {
  test('the server root scope exposes authoring entry points for an administrator session', async () => {
    session.scopes = ['root'];
    mount(); await screen.findByRole('button', { name: 'Describe Incident investigation' });
    expect(screen.getByRole('button', { name: 'Import JSON' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New Blueprint' }));
    expect(screen.getByRole('textbox', { name: 'Blueprint name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
  });
  test('registry opens the listed draft version even when no published version exists', async () => {
    current.status = 'draft'; current.version = 3; current.availableActions = ['edit'];
    extra = path => path === '/blueprints/blueprint-one' ? Promise.resolve(json({ success: false, code: 'BLUEPRINT_NOT_FOUND', error: 'Blueprint not found' }, 404)) : undefined;
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Describe Incident investigation' }));
    await screen.findByRole('button', { name: 'Edit draft' });
    expect(requests.some(row => row.path === '/blueprints/blueprint-one?version=3')).toBe(true);
  });
  test('use-only discovery hides lifecycle, authoring and history actions', async () => {
    mount(); await collect();
    for (const name of ['New Blueprint', 'Import JSON', 'Publish version', 'Retire version', 'Version history', 'Export JSON']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(requests.some(row => row.path.endsWith('/versions'))).toBe(false);
  });
  test('detail actions are authoritative even when the session has admin scope', async () => {
    session.scopes = ['blueprints:admin']; current.availableActions = []; current.projection = 'read';
    mount('/blueprints?blueprint=blueprint-one'); await screen.findByRole('heading', { name: /Incident investigation/ });
    expect(screen.queryByRole('button', { name: 'Use Blueprint' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Publish version' })).toBeNull();
  });
  test('preview renders objects, edges, role handles, optional warnings and shared arms as literal text', async () => {
    plan.plan.references[0].outcome='missing-optional';plan.plan.references[0].resolved=null;
    const view=mount(); await toPreview();expect(screen.getByText(/Optional reference unavailable; Create requires access/)).toBeTruthy();
    expect(view.container.querySelectorAll('[data-task-key="announce"]')).toHaveLength(1);
    expect(view.container.textContent).toContain('announce depends on decision'); expect(view.container.textContent).toContain('observer');
    expect(view.container.textContent).toContain('Optional reference unavailable; Create requires access.');
    expect(view.container.textContent).toContain('<img src=x onerror=alert(1)>'); expect(view.container.textContent).toContain('<script>literal</script>');
    expect(view.container.querySelector('script')).toBeNull(); expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.textContent).toContain('A task listed in more than one arm is created once.');
    expect(view.container.textContent).toContain('Choosing a gate arm grants no authority');
  });
  test('visible reference lookups load on focus under the caller and preserve selected Project', async () => {
    current.target = current.document.target = { mode: 'existing-project', project: '{{project}}' };
    current.parameters = current.document.parameters = [{ key: 'project', label: 'Project', promptText: 'Existing Project', type: 'project-ref', required: true }, { key: 'phase', label: 'Phase', promptText: 'Existing Phase', type: 'phase-ref', required: true }];
    extra = path => path === '/phases?projectId=project-one' ? Promise.resolve(json({ success: true, phases: [{ id: 'phase-one', name: 'Review' }] })) : undefined;
    mount('/blueprints?blueprint=blueprint-one&project=project-one'); fireEvent.click(await screen.findByRole('button', { name: 'Use Blueprint' }));
    expect(requests.some(row => row.path.startsWith('/phases'))).toBe(false);
    fireEvent.focus(screen.getByLabelText('Existing Phase (required)')); await waitFor(() => expect(requests.some(row => row.path === '/phases?projectId=project-one')).toBe(true));
    fireEvent.change(screen.getByLabelText('Existing Phase (required)'), { target: { value: 'phase-one' } }); fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    await screen.findByRole('button', { name: 'Create' });
    expect(JSON.parse(String(requests.find(row => row.path.endsWith('/preview'))?.options?.body))).toEqual({ target: { mode: 'existing-project', project: 'project-one' }, parameterValues: { project: 'project-one', phase: 'phase-one' } });
    expect(requests.some(row => row.path === '/principals')).toBe(false);
  });
  test('ledger labels the redacted projection without claiming raw answers are missing', async () => {
    current.availableActions = ['ledger']; current.projection = 'read';
    extra = path => path === '/instantiations/instance-one' ? Promise.resolve(json({ success: true, instantiation: { id: 'instance-one', blueprint_key: current.key, blueprint_version: 2, root_project_id: 'project-one', actor_principal_id: 'actor-one', created_at: '2026-09-06T12:00:00Z', parameter_projection: { incident: { type: 'string', sha256: 'answer-digest' } }, parameter_values: null, reference_outcomes: [], response_snapshot: result() } })) : undefined;
    mount('/blueprints?blueprint=blueprint-one&instantiation=instance-one'); await screen.findByText(/Raw answers are restricted/);
    expect(screen.getByText('answer-digest')).toBeTruthy(); expect(screen.queryByText('Raw answers visible to this session')).toBeNull();
    expect(screen.getByRole('link', { name: 'project-one' }).getAttribute('href')).toBe('/projects?open=project-one');
  });
});

describe('Blueprint keyboard, validation and authoring', () => {
  test('new draft supplies a portable starter document without publishing', async () => {
    session.scopes = ['blueprints:write']; mount(); fireEvent.click(screen.getByRole('button', { name: 'New Blueprint' }));
    expect((screen.getByLabelText('Blueprint name') as HTMLInputElement).value).toBe('New Blueprint');
    expect(screen.getByRole('button',{name:'Add Task'})).toBeTruthy();
    expect(requests.some(row => row.options?.method === 'POST')).toBe(false);
  });
  test('version selection fetches that version and replaces its action metadata', async () => {
    current.availableActions = ['history']; current.projection = 'read';
    extra = path => path.endsWith('/versions') ? Promise.resolve(json({ success: true, versions: [{ version: 1, status: 'retired', status_note: 'Superseded by version 2' }] }))
      : path.endsWith('?version=1') ? Promise.resolve(json({ success: true, blueprint: { ...current, version: 1, status: 'retired', availableActions: ['export'] } })) : undefined;
    mount('/blueprints?blueprint=blueprint-one'); fireEvent.click(await screen.findByRole('button', { name: 'Version history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Version 1' })); await screen.findByRole('button', { name: 'Export JSON' });
    expect(requests.some(row => row.path === '/blueprints/blueprint-one?version=1')).toBe(true); expect(screen.queryByRole('button', { name: 'Version history' })).toBeNull();
  });
  test('publication needs its own confirmation and displays supersession without instance mutation', async () => {
    current.availableActions = ['publish']; current.status = 'review'; current.projection = 'read';
    extra = path => path.endsWith('/publish') ? Promise.resolve(json({ success: true, blueprint: { id: current.id, version: 2, status: 'published', supersededVersion: 1 } })) : undefined;
    mount('/blueprints?blueprint=blueprint-one'); fireEvent.click(await screen.findByRole('button', { name: 'Publish version' }));
    expect(requests.some(row => row.path.endsWith('/publish'))).toBe(false); fireEvent.click(screen.getByRole('button', { name: 'Confirm publish' }));
    await screen.findByText('Version 1 was retired. Existing instances are unchanged.');
    expect(requests.filter(row => row.options?.method === 'POST').map(row => row.path)).toEqual(['/blueprints/blueprint-one/versions/2/publish']);
  });
  test('rejection requires an explicit note before its lifecycle write', async () => {
    current.availableActions = ['reject']; current.status = 'review';
    mount('/blueprints?blueprint=blueprint-one'); fireEvent.click(await screen.findByRole('button', { name: 'Reject version' }));
    expect((screen.getByRole('button', { name: 'Confirm reject' }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.some(row => row.path.endsWith('/reject'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Rejection note (required)'), { target: { value: 'Clarify the decision roles.' } }); fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));
    await waitFor(() => expect(requests.some(row => row.path.endsWith('/reject'))).toBe(true));
    expect(JSON.parse(String(requests.find(row => row.path.endsWith('/reject'))?.options?.body)).note).toBe('Clarify the decision roles.');
  });
  test('keyboard collection reports validation and focuses the first refused field', async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', { name: 'Describe Incident investigation' })); await user.click(await screen.findByRole('button', { name: 'Use Blueprint' }));
    const field = screen.getByLabelText('Which incident? (required)'); await user.click(field); await user.type(field, 'wrong'); await user.tab(); await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Preview plan' })); await user.keyboard('{Enter}');
    expect(await screen.findByText('The answer does not match the required format.')).toBeTruthy(); expect(document.activeElement).toBe(field); expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(requests.some(row => row.path.endsWith('/preview'))).toBe(false);
  });
  test('server refusal focuses the text alert and retains the answer', async () => {
    extra = path => path.endsWith('/preview') ? Promise.resolve(json({ success: false, code: 'PARAMETER_VALUE_REFUSED', error: 'Choose an available answer.', field: 'incident' }, 422)) : undefined;
    mount(); await collect(); fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    const alert = await screen.findByRole('alert'); await waitFor(() => expect(document.activeElement).toBe(alert));
    expect((screen.getByLabelText('Which incident? (required)') as HTMLInputElement).value).toBe('INC-12'); expect(alert.textContent).toContain('PARAMETER_VALUE_REFUSED');
  });
  test('import collision preserves JSON and requires explicit rename without publication', async () => {
    session.scopes = ['blueprints:write']; let imports = 0;
    extra = path => path === '/blueprints/import' ? Promise.resolve(++imports === 1 ? json({ success: false, code: 'BLUEPRINT_KEY_IN_USE', error: 'Choose another key.' }, 409) : json({ success: true, blueprint: { id: 'renamed', version: 1 } }, 201)) : undefined;
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Import JSON' })); const documentText = JSON.stringify(current.document);
    fireEvent.change(screen.getByLabelText('Blueprint JSON'), { target: { value: documentText } }); fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await screen.findByText('BLUEPRINT_KEY_IN_USE');
    expect((screen.getByLabelText('Blueprint JSON') as HTMLTextAreaElement).value).toBe(documentText); expect(imports).toBe(1);
    fireEvent.change(screen.getByLabelText('Rename key explicitly if it already exists'), { target: { value: 'renamed-incident' } }); fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(imports).toBe(2)); const sent = requests.filter(row => row.path === '/blueprints/import');
    expect(JSON.parse(String(sent[0].options?.body)).rename).toBeUndefined(); expect(JSON.parse(String(sent[1].options?.body)).rename).toBe('renamed-incident');
    expect(requests.some(row => row.path.endsWith('/publish'))).toBe(false);
  });
  test('the rendered collection and preview have no axe structural violations', async () => {
    const view = mount(); await collect();
    const config = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };
    expect((await axe.run(view.container, config)).violations).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' })); await screen.findByRole('button', { name: 'Create' });
    expect((await axe.run(view.container, config)).violations).toEqual([]);
  });
});

test('captured registry entries remain visible and select the existing Project context',async()=>{
 current.target=current.document.target={mode:'new-project',allowExisting:true,project:{name:'{{incident}}'}};
 mount('/blueprints?project=project-one');
 fireEvent.click(await screen.findByRole('button',{name:'Describe Incident investigation'}));
 fireEvent.click(await screen.findByRole('button',{name:'Use Blueprint'}));
 expect((screen.getByRole('combobox',{name:'Target Project'}) as HTMLSelectElement).value).toBe('existing-project');
 expect(screen.queryByLabelText('Which incident? (required)')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Preview plan'}));
 await screen.findByRole('button',{name:'Create'});
 expect(JSON.parse(String(requests.find(row=>row.path.endsWith('/preview'))?.options?.body))).toEqual({target:{mode:'existing-project',project:'project-one'},parameterValues:{}});
});
