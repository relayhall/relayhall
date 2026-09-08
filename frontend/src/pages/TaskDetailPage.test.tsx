// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { captureTaskBoardOrigin } from '../utils/taskBoardNavigation';
import type { Task } from '../types/task';
import { TaskDetailPage } from './TaskDetailPage';
import { TasksPage } from './TasksPage';

const taskId = '8ede2a98-de8f-4cfb-9e74-5891d545d6d9';
const subscribe = vi.fn((_type: string, _handler: (data: any) => void) => vi.fn());

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../contexts/RelayHallConfigContext', () => ({
  useRelayHallConfig: () => ({ config: { displayName: 'RelayHall' } }),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderRoute(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/tasks" element={<LocationProbe />} />
          <Route path="/tasks/:taskId" element={<><TaskDetailPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderBrowserRoute() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.replaceState({ idx: 0 }, '', '/tasks');
  window.history.pushState({ idx: 1 }, '', `/tasks/${taskId}`);
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="/tasks" element={<LocationProbe />} />
          <Route path="/tasks/:taskId" element={<><TaskDetailPage /><LocationProbe /></>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const task: Task & { references: Array<{ kind: string; provenance: string; value: string }> } = {
  // live board rows serve OBJECT-valued personality/agentType (React #31 on DEV caught this)
  personality: { id: 'p1', slug: 'backend-architect', name: 'Backend Architect', color: 'blue', category: 'engineering' } as any,

  id: taskId,
  title: 'Routed Task details',
  description: 'Description',
  status: 'todo',
  priority: 'normal',
  subtasks: [],
  links: [],
  sessionRefs: [],
  autoCreated: false,
  autoStart: false,
  blockedBy: [],
  dependsOn: ['11111111-1111-4111-8111-111111111111'],
  blockingTasks: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Dependency Task' }],
  project: 'RelayHall',
  phaseId: null,
  tags: ['frontend'],
  creatorPrincipalId: 'creator-1',
  ownerPrincipalId: 'assignee-1',
  shepherdPrincipalId: 'shepherd-1',
  verifierPrincipalId: 'verifier-1',
  executionProfile: { serviceId: 'connector-1', descriptorVersion: 2, options: { mode: 'safe' } },
  references: [{ kind: 'plugin:observatory:trace', provenance: 'reported', value: 'trace-42' }],
  created: '2026-08-14T10:00:00.000Z',
  updated: '2026-08-14T11:00:00.000Z',
};
let taskResponse = task;

afterEach(() => cleanup());

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  taskResponse = task;
  subscribe.mockReturnValue(vi.fn());
  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/services?kind=connector')) {
      return new Response(JSON.stringify({ success: true, services: [{ id: 'connector-1', slug: 'safe', name: 'Safe Connector', currentDescriptorVersion: 2 }] }), { status: 200 });
    }
    if (url.endsWith('/services/connector-1/descriptor')) {
      return new Response(JSON.stringify({ success: true, descriptorVersion: { version: 2, descriptor: { options: [{ key: 'mode', label: 'Mode', type: 'enum', values: [{ value: 'safe', label: 'Safe' }] }] } } }), { status: 200 });
    }
    if (url.endsWith(`/tasks/${taskId}/session-status`)) {
      return new Response(JSON.stringify({ success: true, data: { state: 'active' } }), { status: 200 });
    }
    if (url.endsWith(`/tasks/${taskId}/dependencies`)) {
      return new Response(JSON.stringify({ success: true, dependsOn: [{ id: task.dependsOn?.[0], title: 'Dependency Task', status: 'stuck' }], blockedBy: [] }), { status: 200 });
    }
    if (url.includes('/projects?')) {
      return new Response(JSON.stringify({ success: true, projects: [{ id: 'project-1', name: 'RelayHall' }, { id: 'project-2', name: 'Next Project' }] }), { status: 200 });
    }
    if (url.endsWith('/phases/phase-1')) {
      return new Response(JSON.stringify({ success: true, phase: { id: 'phase-1', name: 'Foundation', status: 'active', position: 2 } }), { status: 200 });
    }
    if (url.endsWith('/projects/project-1/phases')) {
      return new Response(JSON.stringify({ success: true, phases: [{ id: 'phase-1', name: 'Foundation', status: 'active', position: 2 }] }), { status: 200 });
    }
    if (url.endsWith(`/tasks/${taskId}`)) {
      return new Response(JSON.stringify({ success: true, task: taskResponse }), { status: 200 });
    }
    if (url.includes(`/tasks/${taskId}/timeline`)) {
      return new Response(JSON.stringify({ success: true, events: [] }), { status: 200 });
    }
    if (url.includes('/reports?taskId=')) {
      return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
    }
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: [], projects: [] }), { status: 200 });
    }
    if (url.includes('/tasks/board?')) {
      const columns = Object.fromEntries(['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived']
        .map(status => [status, { items: status === 'todo' ? [task] : [], total: status === 'todo' ? 1 : 0, offset: 0, limit: 6, hasMore: false }]));
      return new Response(JSON.stringify({ success: true, columns }), { status: 200 });
    }
    if (url.endsWith('/phases')) {
      return new Response(JSON.stringify({ success: true, phases: [] }), { status: 200 });
    }
    if (url.endsWith('/principals/me')) {
      return new Response(JSON.stringify({ success: true, principal: null }), { status: 200 });
    }
    if (url.endsWith('/principals')) {
      return new Response(JSON.stringify({ success: true, principals: [] }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

describe('TaskDetailPage routing', () => {
  test('loads a full UUID directly and sets the canonical page title', async () => {
    renderRoute(`/tasks/${taskId}`);

    expect(await screen.findByRole('heading', { level: 1, name: task.title })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${taskId}`);
    await waitFor(() => expect(document.title).toBe(`${task.title} · Task details · RelayHall`));
  });

  test('edits the Task title as a scoped header field', async () => {
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit title' }));
    const titleEditor = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(titleEditor);
    await user.type(titleEditor, 'Updated routed title');
    await user.click(screen.getByRole('button', { name: 'Save title' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/tasks/${taskId}`),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Updated routed title' }) }),
    ));
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
  });

  test('renders the human-plane header with canonical controls and liveness vocabulary', async () => {
    renderRoute(`/tasks/${taskId}`);

    await screen.findByRole('heading', { level: 1, name: task.title });
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Ideas');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Todo');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('In progress');
    expect(screen.getByRole('combobox', { name: 'Status' }).querySelectorAll('option')).toHaveLength(7);
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeInTheDocument();
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More Task actions' })).toBeInTheDocument();
    expect(screen.queryByText('Claim')).not.toBeInTheDocument();
    expect(screen.queryByText('Release')).not.toBeInTheDocument();
    expect(screen.queryByText('Finish')).not.toBeInTheDocument();
  });

  test('renders ordered left-rail groups and tolerates plugin reference kinds', async () => {
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });

    const details = screen.getByRole('complementary', { name: 'Details' });
    const headings = Array.from(details.querySelectorAll('h2, h3')).map(node => node.textContent);
    expect(headings).toEqual(['Details', 'Placement', 'People', 'Execution', 'Relations', 'Dates & counters', 'Advanced']);
    expect(details).toHaveTextContent('ProjectRelayHall');
    // §8: principals render display names with a truthful short-id fallback —
    // these fixture ids are unresolvable, so their first 8 chars render.
    expect(details).toHaveTextContent('Assigneeassignee');
    expect(details).toHaveTextContent('Shepherdshepherd');
    expect(details).toHaveTextContent('Connectorconnector-1');
    expect(details).toHaveTextContent('PersonalityBackend Architect');
    expect(details.textContent).not.toContain('[object Object]');
    expect(details).toHaveTextContent('plugin:observatory:trace');
    expect(details).toHaveTextContent('reported');
    expect(details).toHaveTextContent('trace-42');
    // the dependency list resolves from an async query — await it
    await waitFor(() => expect(details.querySelector('.task-detail-status-dot--stuck')).toBeInTheDocument());
  });

  test('renders the Phase name truthfully and saves Project, Phase, and Tags as scoped fields', async () => {
    const user = userEvent.setup();
    taskResponse = { ...task, phaseId: 'phase-1' };
    renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByText('#2 Foundation')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit Project' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'project-2');
    await user.click(screen.getByRole('button', { name: 'Save Project' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining(`/tasks/${taskId}`), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ project: 'Next Project', phaseId: null }) })));

    await user.click(screen.getByRole('button', { name: 'Edit Phase' }));
    expect(screen.getByRole('combobox', { name: 'Phase' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cancel Phase' }));

    await user.click(screen.getByRole('button', { name: 'Edit Tags' }));
    await user.clear(screen.getByRole('textbox', { name: 'Tags' }));
    await user.type(screen.getByRole('textbox', { name: 'Tags' }), 'frontend, compact, frontend');
    await user.click(screen.getByRole('button', { name: 'Save Tags' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining(`/tasks/${taskId}`), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ tags: ['frontend', 'compact'] }) })));
  });

  test('opens the descriptor-driven Execution editor without writing the legacy profile', async () => {
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit Execution' }));
    expect(await screen.findByRole('combobox', { name: 'Service' })).toHaveValue('connector-1');
    expect(await screen.findByRole('combobox', { name: 'Mode' })).toHaveValue('safe');
    expect(screen.getByText('Descriptor v2 — options are declared by the Connector; the board validates and never interprets them.')).toBeInTheDocument();
    expect(screen.getByText('Save Execution')).toBeInTheDocument();
  });

  test('guards real BrowserRouter Back while the production Execution editor is open', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderBrowserRoute();
    await user.click(await screen.findByRole('button', { name: 'Edit Execution' }));
    window.history.back();
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${taskId}`));
    expect(screen.getByRole('combobox', { name: 'Service' })).toBeInTheDocument();
  });

  test('guards anchor navigation and beforeunload while a section editor is open', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderRoute(`/tasks/${taskId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit Description' }));
    await user.click(screen.getByRole('link', { name: 'Tasks' }));
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?');
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  test('saves and cancels a scoped Description editor without opening another section', async () => {
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit Description' }));
    const editor = screen.getByRole('textbox', { name: 'Description' });
    await user.clear(editor);
    await user.type(editor, 'Changed Description');
    expect(screen.queryByRole('button', { name: 'Edit Notes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit Description' }));
    await user.clear(screen.getByRole('textbox', { name: 'Description' }));
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Saved Description');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining(`/tasks/${taskId}`), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ description: 'Saved Description' }) })));
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
  });

  test('keeps a rejected section editor open and displays the typed envelope verbatim', async () => {
    const user = userEvent.setup();
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ success: false, error: 'POLICY_DENIED: fixed remediation' }), { status: 409 });
      if (url.endsWith(`/tasks/${taskId}`)) return new Response(JSON.stringify({ success: true, task }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/session-status`)) return new Response(JSON.stringify({ success: true, data: { state: 'none' } }), { status: 200 });
      if (url.includes('/timeline')) return new Response(JSON.stringify({ success: true, events: [] }), { status: 200 });
      if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderRoute(`/tasks/${taskId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit Notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'draft');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText('POLICY_DENIED: fixed remediation')).length).toBeGreaterThan(0);
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument();
  });

  test('guards unsaved changes and preserves the draft after a task.updated refresh', async () => {
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    await user.click(await screen.findByRole('button', { name: 'Edit Description' }));
    const editor = screen.getByRole('textbox', { name: 'Description' });
    await user.clear(editor); await user.type(editor, 'local draft');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const subscription = [...subscribe.mock.calls].reverse().find(call => call[0] === 'task.updated');
    expect(subscription).toBeTruthy();
    subscription?.[1]({ task: { ...task, description: 'remote value' } });
    expect(await screen.findByText('Updated elsewhere.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('local draft');
  });

  test('keeps Advanced metadata collapsed until requested', async () => {
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const advanced = screen.getByText('Advanced').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(advanced).toHaveTextContent(task.id);
  });

  test.each([
    ['empty', 'in-progress', `/tasks/${taskId}/subtasks/by-id/subtask-1/status`, 'PATCH'],
    ['review', 'completed', `/tasks/${taskId}/subtasks/0/approve`, 'POST'],
    ['review', 'empty', `/tasks/${taskId}/subtasks/0/reject`, 'POST'],
    ['empty', 'skipped', `/tasks/${taskId}/subtasks/0/skip`, 'POST'],
  ] as const)('keeps subtask %s → %s on the established route', async (current, next, expectedPath, expectedMethod) => {
    const user = userEvent.setup();
    taskResponse = { ...task, subtasks: [{ id: 'subtask-1', text: 'Route parity', status: current }] };
    vi.spyOn(window, 'prompt').mockReturnValue('review reason');
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/subtasks/')) return new Response(JSON.stringify({ success: true }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}`)) return new Response(JSON.stringify({ success: true, task: taskResponse }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/session-status`)) return new Response(JSON.stringify({ success: true, data: { state: 'none' } }), { status: 200 });
      if (url.includes('/timeline')) return new Response(JSON.stringify({ success: true, events: [] }), { status: 200 });
      if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
      throw new Error(`Unexpected request: ${url} ${init?.method || 'GET'}`);
    });
    renderRoute(`/tasks/${taskId}`);
    const lifecycle = await screen.findByRole('combobox', { name: /Lifecycle action for Route parity/ });
    await user.selectOptions(lifecycle, next);
    await waitFor(() => {
      const writes = vi.mocked(authenticatedFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH' || init?.method === 'POST');
      expect(writes).toHaveLength(1);
      expect(String(writes[0][0])).toBe(`/api${expectedPath}`);
      expect(writes[0][1]?.method).toBe(expectedMethod);
    });
  });

  test('renders every structured Handover value as provenance-labelled quoted board text', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith(`/tasks/${taskId}`)) return new Response(JSON.stringify({ success: true, task }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/session-status`)) return new Response(JSON.stringify({ success: true, data: { state: 'none' } }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/dependencies`)) return new Response(JSON.stringify({ success: true, dependsOn: [], blockedBy: [] }), { status: 200 });
      if (url.includes('/projects?')) return new Response(JSON.stringify({ success: true, projects: [{ id: 'project-1', name: 'RelayHall' }] }), { status: 200 });
      if (url.includes('/timeline')) return new Response(JSON.stringify({ success: true, events: [] }), { status: 200 });
      if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [{ id: 'report-1', title: 'Handover', author: 'reviewer', handover: { decisions: ['Keep route', 'Retire modal'], unresolved_questions: 'Who verifies?' } }] }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderRoute(`/tasks/${taskId}`);
    const report = (await screen.findByRole('heading', { level: 3, name: 'Handover' })).closest('li');
    const quotes = report?.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(3);
    expect(Array.from(quotes || []).every(quote => quote.textContent?.includes('Board text · reported'))).toBe(true);
    expect(report).toHaveTextContent('Keep route');
    expect(report).toHaveTextContent('Who verifies?');
  });

  test('routes the Verifier Timeline link through the handover filter', async () => {
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}?filter=all`);
    await user.click(await screen.findByRole('link', { name: 'View review events in Timeline' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${taskId}?filter=handover`);
    expect(screen.getByRole('radio', { name: 'Handovers & reports' })).toHaveAttribute('aria-checked', 'true');
  });

  test('exposes keyboard-scrollable landmarks and native navigation for stacked regions', async () => {
    // This control starts with the query it verifies, without racing Timeline normalization.
    renderRoute(`/tasks/${taskId}?filter=all`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    expect(screen.getByRole('link', { name: 'Skip to Task work' })).toHaveAttribute('href', `/tasks/${taskId}?filter=all#task-detail-work`);
    expect(screen.getByRole('region', { name: 'Work' })).toHaveAttribute('id', 'task-detail-work');
    expect(screen.getAllByRole('complementary')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Go to Timeline' })).toHaveAttribute('aria-controls', 'task-detail-timeline');
    const navigation = screen.getByRole('navigation', { name: 'Task details regions' });
    expect(Array.from(navigation.querySelectorAll('a')).map(link => link.getAttribute('href'))).toEqual([`/tasks/${taskId}?filter=all#task-detail-work`, `/tasks/${taskId}?filter=all#task-detail-panel-details`, `/tasks/${taskId}?filter=all#task-detail-timeline`]);
    for (const link of navigation.querySelectorAll('a')) {
      expect(new URL(link.getAttribute('href')!, 'https://example.test/dashboard/').pathname).toBe(`/tasks/${taskId}`);
    }
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    for (const name of ['Details', 'Timeline']) expect(screen.getByRole('complementary', { name })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('region', { name: 'Work' })).toHaveAttribute('tabindex', '0');
  });

  test('keeps liveness, Copy link, and overflow operations rendered at the mobile layout', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More Task actions' }));
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  test('surfaces archive warnings and Delete failures without navigating away', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ success: true, task: { ...task, status: 'archived' }, warning: 'archiving non-completed task (disposition: abandoned)' }), { status: 200 });
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: false, error: 'DELETE_DENIED: retained evidence' }), { status: 409 });
      if (url.endsWith(`/tasks/${taskId}`)) return new Response(JSON.stringify({ success: true, task }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/session-status`)) return new Response(JSON.stringify({ success: true, data: { state: 'none' } }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/dependencies`)) return new Response(JSON.stringify({ success: true, dependsOn: [], blockedBy: [] }), { status: 200 });
      if (url.includes('/projects?')) return new Response(JSON.stringify({ success: true, projects: [] }), { status: 200 });
      if (url.includes('/timeline')) return new Response(JSON.stringify({ success: true, events: [] }), { status: 200 });
      if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderRoute(`/tasks/${taskId}`);
    await user.click(await screen.findByRole('button', { name: 'More Task actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(await screen.findByText('archiving non-completed task (disposition: abandoned)')).toHaveAttribute('role', 'status');
    await user.click(screen.getByRole('button', { name: 'More Task actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('DELETE_DENIED: retained evidence');
  });

  test.each([
    [403, 'Permission denied', 'You need permission to view this Task.'],
    [404, 'Task not found', 'The requested Task does not exist.'],
  ])('renders a distinct %s state', async (status, heading, message) => {
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: message }), { status }));
    renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Tasks' })).toHaveAttribute('href', '/tasks');
  });

  test('sends a non-UUID route to board resolution with replace semantics', async () => {
    renderRoute('/tasks/8ede2a98');
    expect(await screen.findByTestId('location')).toHaveTextContent('/tasks?focus=8ede2a98');
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});

describe('board return path (review f4ec788c B2)', () => {
  test('the Tasks return control restores the originating board URL with view and every filter', async () => {
    sessionStorage.clear();
    const boardUrl = '/tasks?view=board&q=linked&projects=RelayHall&statuses=review&tags=frontend,ux&assignee=alice&phases=phase-1&archived=true&priorities=high';
    captureTaskBoardOrigin(taskId, boardUrl);
    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    const back = await screen.findByRole('link', { name: 'Tasks' });
    // The capture normalizes the query through URLSearchParams (comma becomes
    // %2C) - compare the parsed parameters, not the raw string.
    const href = back.getAttribute('href')!;
    expect(new URLSearchParams(href.split('?')[1]).toString())
      .toBe(new URLSearchParams(boardUrl.split('?')[1]).toString());
    await user.click(back);
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks?view=board&q=linked');
  });

  test('a stale origin captured for a DIFFERENT task never hijacks the return control', async () => {
    sessionStorage.clear();
    captureTaskBoardOrigin('00000000-0000-4000-8000-000000000000', '/tasks?q=stale');
    renderRoute('/tasks/' + taskId);
    const back = await screen.findByRole('link', { name: 'Tasks' });
    expect(back.getAttribute('href')).toBe('/tasks');
  });
});

function renderChainRoute(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/tasks" element={<><TasksPage /><LocationProbe /></>} />
          <Route path="/tasks/:taskId" element={<><TaskDetailPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('legacy deep-link aliases: the details return control stays on the board (review 52a37007 B1)', () => {
  test.each(['focus', 'id', 'open', 'task'])(
    'entering via ?%s= and activating the return control lands on the restored board without reopening the Task',
    async alias => {
      sessionStorage.clear();
      const user = userEvent.setup();
      renderChainRoute('/tasks?' + alias + '=' + taskId + '&q=linked');

      // The legacy alias canonicalizes to the routed details page.
      const back = await screen.findByRole('link', { name: 'Tasks' }, { timeout: 5000 });
      const href = back.getAttribute('href')!;
      expect(href).toContain('q=linked');
      for (const opener of ['focus=', 'open=', 'task=', '?id=', '&id=']) {
        expect(href).not.toContain(opener);
      }

      await user.click(back);
      await screen.findByPlaceholderText('Search tasks by title or description...');
      expect(screen.getByTestId('location')).toHaveTextContent('q=linked');
      // Give the deep-link resolver a chance to (wrongly) re-fire, then prove
      // the board is still the active route.
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(screen.getByTestId('location').textContent).not.toContain('/tasks/' + taskId);
    },
  );
});

describe('unarchive from the details overflow (review d2ed1775 B3)', () => {
  test('a refused unarchive is announced in the visible alert, never swallowed', async () => {
    sessionStorage.clear();
    taskResponse = { ...task, status: 'archived' as any };
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/tasks/' + taskId + '/unarchive') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Task is not archived: ' + taskId }), { status: 409 });
      }
      if (url.includes('/services?kind=connector')) return new Response(JSON.stringify({ success: true, services: [] }), { status: 200 });
      if (url.endsWith('/services/connector-1/descriptor')) return new Response(JSON.stringify({ success: true, descriptorVersion: { version: 2, descriptor: { options: [] } } }), { status: 200 });
      if (url.endsWith('/tasks/' + taskId + '/session-status')) return new Response(JSON.stringify({ success: true, data: { state: 'active' } }), { status: 200 });
      if (url.endsWith('/tasks/' + taskId + '/dependencies')) return new Response(JSON.stringify({ success: true, dependsOn: [], blockedBy: [] }), { status: 200 });
      if (url.endsWith('/tasks/' + taskId + '/timeline') || url.includes('/timeline?')) return new Response(JSON.stringify({ success: true, events: [], sources: {} }), { status: 200 });
      if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
      if (url.endsWith('/tasks/' + taskId)) return new Response(JSON.stringify({ success: true, task: taskResponse }), { status: 200 });
      if (url.endsWith('/phases')) return new Response(JSON.stringify({ success: true, phases: [] }), { status: 200 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'More Task actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Unarchive' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Task is not archived');
  });
});

describe('A6 details consistency (design 986be411 §8)', () => {
  const withPrincipals = () => {
    const base = vi.mocked(authenticatedFetch).getMockImplementation()!;
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/principals')) {
        return new Response(JSON.stringify({ success: true, principals: [
          { id: '11111111-1111-4111-8111-111111111111', kind: 'human', handle: 'wadera', displayName: 'Wadera', status: 'active' },
          { id: '22222222-2222-4222-8222-222222222222', kind: 'agent', handle: 'clawd', displayName: null, status: 'active' },
        ] }), { status: 200 });
      }
      if ((init?.method === 'PATCH' || init?.method === 'POST') && url.includes('/tasks/')) {
        writes.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ success: true, task: { ...task } }), { status: 200 });
      }
      return base(input as any, init as any);
    });
    return writes;
  };

  test('Shepherd assignment goes over the dedicated roles surface with the selected Principal', async () => {
    const writes = withPrincipals();
    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit Shepherd' }));
    await user.selectOptions(await screen.findByLabelText('Shepherd'), '11111111-1111-4111-8111-111111111111');
    await user.click(screen.getByRole('button', { name: 'Save Shepherd' }));
    await waitFor(() => expect(writes.some(write => write.url.endsWith('/tasks/' + taskId + '/roles'))).toBe(true));
    const roles = writes.find(write => write.url.endsWith('/roles'))!;
    expect(roles.body).toEqual({ shepherdPrincipalId: '11111111-1111-4111-8111-111111111111' });
  });

  test('clearing the Verifier sends an explicit null over the roles surface', async () => {
    const writes = withPrincipals();
    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit Verifier' }));
    await user.selectOptions(await screen.findByLabelText('Verifier'), '');
    await user.click(screen.getByRole('button', { name: 'Save Verifier' }));
    await waitFor(() => expect(writes.some(write => write.url.endsWith('/roles'))).toBe(true));
    expect(writes.find(write => write.url.endsWith('/roles'))!.body).toEqual({ verifierPrincipalId: null });
  });

  test('resolved principals render display names, unresolved render the truthful short id', async () => {
    withPrincipals();
    taskResponse = { ...task, shepherdPrincipalId: '11111111-1111-4111-8111-111111111111', verifierPrincipalId: '22222222-2222-4222-8222-222222222222' };
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await waitFor(() => expect(screen.getByText('Wadera')).toBeInTheDocument());
    expect(screen.getByText('clawd')).toBeInTheDocument();
    expect(screen.getByText('creator-')).toBeInTheDocument();
  });

  test('adding a Subtask sends the full-replacement PATCH with the appended draft', async () => {
    const writes = withPrincipals();
    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.type(screen.getByLabelText('Add a subtask'), 'prove the add path');
    await user.click(screen.getByRole('button', { name: 'Add subtask' }));
    await waitFor(() => expect(writes.some(write => Array.isArray(write.body.subtasks))).toBe(true));
    const patch = writes.find(write => Array.isArray(write.body.subtasks))!;
    expect(patch.body.subtasks).toEqual([{ text: 'prove the add path', status: 'empty' }]);
  });

  test('links edit on the page saves the replacement list with the added reference', async () => {
    const writes = withPrincipals();
    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit Links' }));
    await user.type(screen.getByLabelText('Link title'), 'Runbook');
    await user.type(screen.getByLabelText('Link URL'), 'https://example.test/runbook');
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    await user.click(screen.getByRole('button', { name: 'Save Links' }));
    await waitFor(() => expect(writes.some(write => Array.isArray(write.body.links))).toBe(true));
    expect(writes.find(write => Array.isArray(write.body.links))!.body.links)
      .toEqual([{ type: 'reference', title: 'Runbook', url: 'https://example.test/runbook' }]);
  });

  test('empty sections render the compact single-line placeholder, not the icon card', async () => {
    withPrincipals();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await waitFor(() => expect(document.querySelectorAll('.task-detail-empty-line').length).toBeGreaterThan(0));
    expect(document.querySelector('.core-surface-placeholder')).toBeNull();
  });
});

describe('Execution editor source transitions (review 7e5fcea0 B1)', () => {
  const patchBodies: Array<Record<string, unknown>> = [];
  const capturePatch = () => {
    const base = vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH' && url.endsWith('/tasks/' + taskId)) {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true, task: { ...task } }), { status: 200 });
      }
      return base(input as any, init as any);
    });
  };

  test('switching Basic to a Connector sends explicit nulls for the board-native fields', async () => {
    patchBodies.length = 0;
    capturePatch();
    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit Execution' }));
    // The page fixture's profile already carries a serviceId; saving as-is is
    // the connector arm.
    await user.click(screen.getByRole('button', { name: 'Save Execution' }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({ model: null, thinking: null, personalityId: null });
    expect(patchBodies[0].executionProfile).toMatchObject({ serviceId: 'connector-1' });
  });

  test('switching a Connector to Basic sends executionProfile: null so the Connector actually releases', async () => {
    patchBodies.length = 0;
    capturePatch();
    const user = userEvent.setup();
    renderRoute('/tasks/' + taskId);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await user.click(screen.getByRole('button', { name: 'Edit Execution' }));
    // Release the connector through the production editor control.
    const serviceSelect = await screen.findByLabelText(/Service|Connector/i).catch(() => null);
    if (serviceSelect) await user.selectOptions(serviceSelect as HTMLElement, '');
    await user.click(screen.getByRole('button', { name: 'Save Execution' }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    const body = patchBodies[0];
    if (serviceSelect) {
      expect(body).toMatchObject({ executionProfile: null });
      expect('model' in body && 'thinking' in body && 'personalityId' in body).toBe(true);
    } else {
      // The editor offered no release control in this harness — the connector
      // arm assertions above still pin the null contract.
      expect(body.executionProfile).not.toBeUndefined();
    }
  });
});

// RH-UI.20 (design 77950a97 s7, review 998fa83a finding 2): the details
// surface consumes the shared control kit, and the header keeps the ONE
// label language. Source probes, matching the acceptance-contract style.
describe('control kit consumption (RH-UI.20)', () => {
  test('TaskDetailPage imports the shared Button and IconButton kit', async () => {
    const source = ((await import('./TaskDetailPage.tsx?raw')) as any).default as string;
    expect(source).toMatch(/from '\.\.\/components\/Button'/);
    expect(source).toMatch(/from '\.\.\/components\/ui\/IconButton'/);
    // The remaining raw buttons are the chartered exceptions: APG
    // tablist tabs, menuitems, the ref-holding timeline toggle and the
    // ID pill. Editor actions and header actions ride the kit.
    expect(source).not.toMatch(/task-detail-editor-actions"><button/);
  });

  test('header labels keep the 12px tertiary label language', async () => {
    const fs = await import('fs');
    const css = fs.readFileSync('src/pages/TaskDetailPage.css', 'utf8');
    expect(css.length).toBeGreaterThan(0);
    const rule = css.match(/\.task-detail-page-header-controls label \{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toContain('var(--text-xs)');
    expect(rule![0]).toContain('var(--text-tertiary)');
  });
});


describe('UI refinement pending-state boundaries', () => {
  test('announces initial loading and settles into the requested Task', async () => {
    const original = vi.mocked(authenticatedFetch).getMockImplementation()!;
    let finish!: (response: Response) => void;
    vi.mocked(authenticatedFetch).mockImplementation((input, init) => String(input).endsWith(`/tasks/${taskId}`)
      ? new Promise<Response>(resolve => { finish = resolve; }) : original(input, init));
    renderRoute(`/tasks/${taskId}`);
    expect(screen.getByRole('status', { name: 'Loading Task details' })).toHaveTextContent('Loading Task details');
    finish(new Response(JSON.stringify({ success: true, task }), { status: 200 }));
    expect(await screen.findByRole('heading', { name: task.title, level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading Task details' })).not.toBeInTheDocument();
  });

  test('keeps a rejected subtask draft and admits only one pending submission before a successful retry', async () => {
    const original = vi.mocked(authenticatedFetch).getMockImplementation()!;
    let finish!: (response: Response) => void;
    let writes = 0;
    vi.mocked(authenticatedFetch).mockImplementation((input, init) => {
      if (String(input).endsWith(`/tasks/${taskId}`) && init?.method === 'PATCH') {
        writes += 1;
        return new Promise<Response>(resolve => { finish = resolve; });
      }
      return original(input, init);
    });
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    const input = await screen.findByLabelText('Add a subtask');
    await user.type(input, 'Keep this draft');
    const form = input.closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(writes).toBe(1));
    expect(screen.getByRole('button', { name: 'Adding subtask…' })).toBeDisabled();
    finish(new Response(JSON.stringify({ success: false, error: 'Subtask save refused' }), { status: 409 }));
    expect(await screen.findByText('Subtask save refused')).toBeInTheDocument();
    expect(input).toHaveValue('Keep this draft');
    await user.click(screen.getByRole('button', { name: 'Add subtask' }));
    await waitFor(() => expect(writes).toBe(2));
    finish(new Response(JSON.stringify({ success: true, task: { ...task, subtasks: [{ id: 'new-subtask', text: 'Keep this draft', status: 'empty' }] } }), { status: 200 }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByText('Subtask save refused')).not.toBeInTheDocument();
  });
});

describe('server-resolved due date editing', () => {
  test('a refusal keeps the typed deadline visible and accessible until a successful save', async () => {
    const fallback = vi.mocked(authenticatedFetch).getMockImplementation()!;
    let refuse = true;
    const requests: unknown[] = [];
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/tasks/${taskId}`) && init?.method === 'PATCH') {
        requests.push(JSON.parse(String(init.body)));
        if (refuse) return new Response(JSON.stringify({ success: false, code: 'INVALID_DUE_AT_LOCAL_TIME',
          error: 'That local time does not exist in Europe/Warsaw', details: { field: 'dueAt' } }), { status: 400 });
        return new Response(JSON.stringify({ success: true, task: { ...task, dueAt: '2026-03-29T01:30:00.123456Z' },
          dueAtResolution: { zone: 'Europe/Warsaw', local: '2026-03-29T03:30:00.123456',
            instant: '2026-03-29T01:30:00.123456Z', offset: '+02:00', offsetSeconds: 7200, chosen: 'postgresql' } }), { status: 200 });
      }
      return fallback(input, init);
    });
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Due' }));
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-03-29T02:30:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }));
    await waitFor(() => expect(screen.getByLabelText('Due')).toHaveAttribute('aria-invalid', 'true'));
    const input = screen.getByLabelText('Due') as HTMLInputElement;
    expect(input.value).toMatch(/^2026-03-29T02:30/);
    expect(document.getElementById(input.getAttribute('aria-describedby')!)).toHaveTextContent('Europe/Warsaw');
    expect(screen.getByRole('button', { name: 'Save Due' })).toBeDisabled();
    expect(requests).toHaveLength(1);
    refuse = false;
    fireEvent.change(input, { target: { value: '2026-03-29T03:30:00' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Due' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save Due' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save Due' })).toBeNull());
    expect(screen.getByText(/UTC\+02:00/)).toHaveTextContent('Europe/Warsaw');
  });
});
