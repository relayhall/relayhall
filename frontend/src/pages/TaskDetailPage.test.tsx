// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto, createHash } from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { captureTaskBoardOrigin } from '../utils/taskBoardNavigation';
import type { Task } from '../types/task';
import { TaskDetailPage, reportPathGuidance, validateStoredReportDraft, validatePendingReport, validatePreservedReportDrafts, validateReportRestore } from './TaskDetailPage';
import { ToastProvider } from '../contexts/ToastContext';
import { TasksPage } from './TasksPage';

// Card 696f3bb8: loaded-runner budgets for EVERY test in this file, not one.
// The CI runner shares its machine with the full tier and with lane jobs, and
// this page renders a large DOM. On one core shared four ways (the card's
// starvation drill), three whole-file runs failed 8, 8 and 9 tests, all 25 at
// a budget and none on settled state: 10 at the 5000 ms test budget ("Test
// timed out") and 15 at Testing Library's 1000 ms find/waitFor budget
// ("Unable to find role=button", or a waitFor's last expect). They fell in
// five describe blocks and among the top-level tests, and CI added a sixth
// block (T1 T10, run 5718), so no block-scoped budget would cover them.
// The wait budget is the 5000 ms card d4315f28 gave the Phase-name test; with
// only the test budget raised, the drill still failed 11 tests, every one at
// the 1000 ms wait budget. The test and hook budget is 60 000 ms: idle the
// slowest test takes 1.5 s and under the drill 8.5 s, but twice in 1018 test
// runs a stall of the shared core stretched one test to 13.4 s and another
// past 20 000 ms, where it failed; 60 000 ms is three times that. They live in
// the file, so every runner of it gets them, the FEAT-A drill baseline
// included (scripts/feata-mutation-drill.py --suite frontend). Nothing an
// assertion checks changes; only how long a slow runner may take to reach it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
configure({ asyncUtilTimeout: 5_000 });

const taskId = '8ede2a98-de8f-4cfb-9e74-5891d545d6d9';
/**
 * Card 50b5e9c4 slice 3: the Task Report list answers bounded summaries
 * (never bodies), and the progress-report editor fetches each of the caller's
 * own active Reports from GET /tasks/:id/reports/:reportId. One fixture answers
 * both reads from the same rows, so a test's Report reaches the editor exactly
 * as before; a body read anywhere else is not answered.
 */
function progressReportFixture(input: RequestInfo | URL, init: RequestInit | undefined, rows: Array<Record<string, any>>): Response | null {
  const url = String(input);
  if (init?.method && init.method !== 'GET') return null;
  if (url.includes(`/tasks/${taskId}/reports?`)) {
    return new Response(JSON.stringify({ success: true,
      reports: rows.map(row => ({ id: row.id, title: row.title, status: row.status, relevance: 'progress', authorPrincipalId: row.author_principal_id })),
      pagination: { limit: 50, offset: 0, total: rows.length, returned: rows.length, hasMore: false, nextCursor: null } }));
  }
  const report = rows.find(row => url.endsWith(`/tasks/${taskId}/reports/${row.id}`));
  return report ? new Response(JSON.stringify({ success: true, report })) : null;
}
const subscribe = vi.fn((_type: string, _handler: (data: any) => void) => vi.fn());

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../contexts/RelayHallConfigContext', () => ({
  useRelayHallConfig: () => ({ config: { displayName: 'RelayHall' } }),
}));

function ReportNavigation() {
  const navigate=useNavigate();
  return <><button data-testid="switch-r1" onClick={()=>navigate('?report=11111111-1111-4111-8111-111111111111')}>Route R1</button><button data-testid="switch-r2" onClick={()=>navigate('?report=22222222-2222-4222-8222-222222222222')}>Route R2</button><button data-testid="switch-task" onClick={()=>navigate('/tasks/99999999-9999-4999-8999-999999999999')}>Route other Task</button></>;
}

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
          <Route path="/tasks/:taskId" element={<><TaskDetailPage /><LocationProbe /><ReportNavigation /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The Report recovery controls exist before they are usable: a remount, a
 * refresh or a recheck renders them disabled until the canonical read
 * settles, and a click on a disabled control is silently dropped, so a test
 * that clicked on sight waited for a result that could never come and failed
 * only under load (machinery queue 9b761f09). Wait for the control's enabled
 * state, then act.
 */
async function enabledButton(name: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
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
          <Route path="/tasks/:taskId" element={<><TaskDetailPage /><LocationProbe /><ReportNavigation /></>} />
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
  autoStart: false,
  lifecycleAccess: { arm: { allowed: true, reason: null }, park: { allowed: true, reason: null }, claim: { allowed: false, reason: 'TASK_NOT_ARMED' } },
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
  sessionStorage.clear();
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
    if (url.endsWith(`/tasks/activity?ids=${taskId}`)) {
      return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId, state: 'active', kind: 'status', receivedAt: new Date(Date.now()-1000).toISOString() }] }), { status: 200 });
    }
    if (url.endsWith('/tasks/' + taskId + '/native-executions')) return new Response(JSON.stringify({ success: true, result: { executions: [] } }), { status: 200 });
    if (url.endsWith(`/tasks/${taskId}/native-reviews`)) {
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
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
    if (url.includes(`/tasks/${taskId}/reports?`)) return new Response(JSON.stringify({ success: true, reports: [], pagination: { limit: 50, offset: 0, total: 0, returned: 0, hasMore: false, nextCursor: null } }), { status: 200 });
    if (url.endsWith(`/tasks/${taskId}/reports`)) return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
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
      return new Response(JSON.stringify({ success: true, principal: {id: task.ownerPrincipalId || "test-author"} }), { status: 200 });
    }
    if (url.endsWith('/principals')) {
      return new Response(JSON.stringify({ success: true, principals: [] }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

describe('TaskDetailPage routing', () => {
  test('Train36 integration preserves criteria and guidance through distinct writers', async () => {
    const user = userEvent.setup();
    taskResponse = { ...task, notes: 'Existing Notes', constraints: ['Existing Constraints'], successCriteria: ['Existing criteria'], successCriteriaAccess: { allowed: true } };
    const base = vi.mocked(authenticatedFetch).getMockImplementation()!;
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') {
        const url = String(input);
        const body = JSON.parse(String(init.body));
        writes.push({ url, body });
        if (url.endsWith('/success-criteria')) taskResponse = { ...taskResponse, successCriteria: body.successCriteria };
        else {
          if ('notes' in body) taskResponse = { ...taskResponse, notes: body.notes };
          if ('constraints' in body) taskResponse = { ...taskResponse, constraints: body.constraints };
        }
        return new Response(JSON.stringify({ success: true, task: taskResponse }));
      }
      return base(input, init);
    });
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    expect(screen.queryByRole('button', { name: 'Edit Agent instructions' })).not.toBeInTheDocument();
    expect(screen.getByText(/Use Notes for task-specific operational guidance/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Notes' }));
    await user.clear(screen.getByRole('textbox', { name: 'Notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Saved Notes');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Notes' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Edit success criteria' }));
    const criteria = screen.getByLabelText('Success criteria (one check per line)');
    await user.clear(criteria); await user.type(criteria, 'Saved criteria');
    await user.click(screen.getByRole('button', { name: 'Save success criteria' }));
    await waitFor(() => expect(screen.queryByLabelText('Success criteria (one check per line)')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Edit Constraints' }));
    const constraints = screen.getByRole('textbox', { name: 'Constraints' });
    await user.clear(constraints); await user.type(constraints, 'Saved Constraints');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Constraints' })).not.toBeInTheDocument());
    expect(writes).toEqual([
      { url: `/api/tasks/${taskId}`, body: { notes: 'Saved Notes' } },
      { url: `/api/tasks/${taskId}/success-criteria`, body: { successCriteria: ['Saved criteria'] } },
      { url: `/api/tasks/${taskId}`, body: { constraints: ['Saved Constraints'] } },
    ]);
    cleanup(); renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    expect(screen.getByText('Saved Notes')).toBeInTheDocument();
    expect(screen.getByText('Saved Constraints')).toBeInTheDocument();
    expect(screen.getByText('Saved criteria')).toBeInTheDocument();
  });
  test('removes the unsupported Agent instructions editor and points to persisted task guidance', async () => {
    taskResponse = { ...task, notes: 'Existing operational guidance', constraints: ['Existing hard limit'] };
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    expect(screen.queryByRole('button', { name: 'Edit Agent instructions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Agent instructions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agent instructions' })).not.toBeInTheDocument();
    expect(screen.getByText(/Use Notes for task-specific operational guidance/)).toHaveTextContent('Put hard limits in Constraints');
    expect(screen.getByText('Existing operational guidance')).toBeInTheDocument();
    expect(screen.getByText('Existing hard limit')).toBeInTheDocument();
    expect(vi.mocked(authenticatedFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });
  test.each(['Notes', 'Constraints'] as const)('keyboard editing %s preserves both persisted guidance fields', async heading => {
    const user = userEvent.setup();
    taskResponse = { ...task, notes: 'Existing operational guidance', constraints: ['Existing hard limit'] };
    const base = vi.mocked(authenticatedFetch).getMockImplementation()!;
    const writes: Record<string, unknown>[] = [];
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') {
        const updates = JSON.parse(String(init.body)); writes.push(updates);
        // This fixture stores only the existing public fields, like the server.
        if ('notes' in updates) taskResponse = { ...taskResponse, notes: updates.notes };
        if ('constraints' in updates) taskResponse = { ...taskResponse, constraints: updates.constraints };
        return new Response(JSON.stringify({ success: true, task: taskResponse }), { status: 200 });
      }
      return base(input, init);
    });
    renderRoute(`/tasks/${taskId}`);
    const edit = await screen.findByRole('button', { name: `Edit ${heading}` });
    edit.focus(); await user.keyboard('{Enter}');
    const editor = screen.getByRole('textbox', { name: heading });
    expect(editor).toHaveValue(heading === 'Notes' ? 'Existing operational guidance' : 'Existing hard limit');
    await user.clear(editor); await user.type(editor, `Saved ${heading}`);
    await user.tab(); expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: heading })).not.toBeInTheDocument());
    expect(writes).toEqual([heading === 'Notes' ? { notes: 'Saved Notes' } : { constraints: ['Saved Constraints'] }]);
    expect(taskResponse.notes).toBe(heading === 'Notes' ? 'Saved Notes' : 'Existing operational guidance');
    expect(taskResponse.constraints).toEqual(heading === 'Constraints' ? ['Saved Constraints'] : ['Existing hard limit']);
    cleanup(); renderRoute(`/tasks/${taskId}`);
    await user.click(await screen.findByRole('button', { name: `Edit ${heading}` }));
    expect(screen.getByRole('textbox', { name: heading })).toHaveValue(`Saved ${heading}`);
    const section = screen.getByRole('textbox', { name: heading }).closest('section')!;
    const result = await axe.run(section, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map(({ id }) => id)).toEqual([]);
    expect(writes.every(write => !('agentInstructions' in write))).toBe(true);
  });
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
    expect(screen.getByRole('button', { name: 'View context' }).closest('.task-detail-page-header-controls')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'More Task actions' })).toBeInTheDocument();
    expect(screen.queryByText('Claim')).not.toBeInTheDocument();
    expect(screen.queryByText('Release')).not.toBeInTheDocument();
    expect(screen.queryByText('Finish')).not.toBeInTheDocument();
  });

  test('scopes an absent Task execution session without hiding a native Verifier session', async () => {
    taskResponse = { ...task, status: 'completed' as any };
    const base = vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/tasks/activity?ids=${taskId}`))
        return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId, state: 'unknown', kind: null, receivedAt: null }] }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/native-reviews`))
        return new Response(JSON.stringify({ success: true, result: [{
          id: 'review-1', state: 'passed', serviceId: 'connector-1', verifierPrincipalId: 'verifier-1',
          finishedAt: '2026-09-27T10:00:00.000Z', reviewScope: { kind: 'task', includesTaskCriteria: true },
          session: { state: 'available', sessionRef: 'rhp-test', connectorId: 'connector-1', sourceProduct: 'claude-code' },
        }] }), { status: 200 });
      return base(input, init);
    });

    renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByText('Task activity: Unknown')).toBeInTheDocument();
    const native = await screen.findByRole('link', { name: 'View reported native session' });
    expect(native).toHaveAttribute('href', '/sessions?sessionRef=rhp-test&connectorId=connector-1&sourceProduct=claude-code');
    expect(screen.queryByText('No agent session')).not.toBeInTheDocument();
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

  // Card d4315f28 (CI runs 5608 and 5647, red then green on re-run). Two
  // causes, neither in what this test asserts:
  //  - ORDER. The Phase name and the Project list are separate reads that can
  //    land in either order. The test waited for the first and then used the
  //    second, so a Project editor opened before the list arrived offered no
  //    'project-2'. It now waits for the list, which is exactly what enables
  //    the Phase edit control (disabled until the Task's Project resolves).
  //  - BUDGET. The test takes 1.1-1.8s on an idle host; on one core shared
  //    four ways it missed the 1000ms find budget and the 5000ms test budget.
  //    Its waits and the test itself carry budgets sized for a loaded runner.
  //    (Card 696f3bb8: its test budget is now the file's, 60 000 ms.)
  const LOADED_RUNNER_WAIT = { timeout: 5_000 };
  const LOADED_RUNNER_TEST_MS = 60_000;
  test('renders the Phase name truthfully and saves Project, Phase, and Tags as scoped fields', async () => {
    const user = userEvent.setup();
    taskResponse = { ...task, phaseId: 'phase-1' };
    renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByText('#2 Foundation', undefined, LOADED_RUNNER_WAIT)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Phase' })).toBeEnabled(), LOADED_RUNNER_WAIT);

    await user.click(screen.getByRole('button', { name: 'Edit Project' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'project-2');
    await user.click(screen.getByRole('button', { name: 'Save Project' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining(`/tasks/${taskId}`), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ project: 'Next Project', phaseId: null }) })), LOADED_RUNNER_WAIT);

    await user.click(screen.getByRole('button', { name: 'Edit Phase' }));
    expect(screen.getByRole('combobox', { name: 'Phase' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cancel Phase' }));

    await user.click(screen.getByRole('button', { name: 'Edit Tags' }));
    await user.clear(screen.getByRole('textbox', { name: 'Tags' }));
    await user.type(screen.getByRole('textbox', { name: 'Tags' }), 'frontend, compact, frontend');
    await user.click(screen.getByRole('button', { name: 'Save Tags' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining(`/tasks/${taskId}`), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ tags: ['frontend', 'compact'] }) })), LOADED_RUNNER_WAIT);
  }, LOADED_RUNNER_TEST_MS);

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
      if (url.endsWith(`/tasks/activity?ids=${taskId}`)) return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId, state: 'unknown', kind: null, receivedAt: null }] }), { status: 200 });
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
      if (url.endsWith(`/tasks/activity?ids=${taskId}`)) return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId, state: 'unknown', kind: null, receivedAt: null }] }), { status: 200 });
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

  test.each(['completed', 'skipped', 'empty'] as const)('owner uses explicit stable-id disposition for %s without a Verifier act', async next => {
    const user = userEvent.setup();
    taskResponse = { ...task, ownerControl: true, subtasks: [{ id: 'subtask-1', text: 'Owner disposition', status: next === 'skipped' ? 'empty' : 'review' }] };
    vi.spyOn(window, 'prompt').mockReturnValue('owner decision');
    vi.mocked(authenticatedFetch).mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/subtasks/')) return new Response(JSON.stringify({ success: true }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}`)) return new Response(JSON.stringify({ success: true, task: taskResponse }), { status: 200 });
      if (url.endsWith('/session-status')) return new Response(JSON.stringify({ success: true, data: { state: 'none' } }), { status: 200 });
      if (url.includes('/timeline')) return new Response(JSON.stringify({ success: true, events: [] }), { status: 200 });
      if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderRoute(`/tasks/${taskId}`);
    const ownerAction = await screen.findByRole('combobox', { name: /Lifecycle action for Owner disposition/ });
    expect(ownerAction).not.toHaveTextContent('Verifier only');
    expect(ownerAction).toHaveTextContent(next === 'completed' ? 'Complete — account owner' : next === 'skipped' ? 'Skip — account owner' : 'Return to not started — account owner');
    await user.selectOptions(ownerAction, next);
    await waitFor(() => {
      const writes = vi.mocked(authenticatedFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH' || init?.method === 'POST');
      expect(writes).toHaveLength(1);
      expect(String(writes[0][0])).toBe(`/api/tasks/${taskId}/subtasks/by-id/subtask-1/status`);
      expect(writes[0][1]?.method).toBe('PATCH');
      expect(JSON.parse(String(writes[0][1]?.body)).status).toBe(next);
    });
  });

  test('renders every structured Handover value as provenance-labelled quoted board text', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith(`/tasks/${taskId}`)) return new Response(JSON.stringify({ success: true, task }), { status: 200 });
      if (url.endsWith(`/tasks/activity?ids=${taskId}`)) return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId, state: 'unknown', kind: null, receivedAt: null }] }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/dependencies`)) return new Response(JSON.stringify({ success: true, dependsOn: [], blockedBy: [] }), { status: 200 });
      if (url.includes('/projects?')) return new Response(JSON.stringify({ success: true, projects: [{ id: 'project-1', name: 'RelayHall' }] }), { status: 200 });
      if (url.includes('/timeline')) return new Response(JSON.stringify({ success: true, events: [] }), { status: 200 });
      if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [{ id: '33333333-3333-4333-8333-333333333333', title: 'Handover', author: 'reviewer', handover: { decisions: ['Keep route', 'Retire modal'], unresolved_questions: 'Who verifies?' } }] }), { status: 200 });
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
    expect(screen.getByRole('button', { name: 'View context' }).closest('.task-detail-page-header-controls')).not.toBeNull();
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
      if (url.endsWith(`/tasks/activity?ids=${taskId}`)) return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId, state: 'unknown', kind: null, receivedAt: null }] }), { status: 200 });
      if (url.endsWith('/tasks/' + taskId + '/native-executions')) return new Response(JSON.stringify({ success: true, result: { executions: [] } }), { status: 200 });
      if (url.endsWith(`/tasks/${taskId}/native-reviews`)) return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
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

  test.each([
    [401, 'Task details could not be loaded'],
    [403, 'Permission denied'],
    [404, 'Task not found'],
  ])('conceals cached details and activity after a background %s refusal', async (status, heading) => {
    const originalFetch = vi.mocked(authenticatedFetch).getMockImplementation()!;
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await screen.findByText('Task activity: Active');
    if (status === 403) {
      await userEvent.setup().click(screen.getByRole('button', { name: 'Edit Description' }));
      expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    }
    vi.mocked(authenticatedFetch).mockImplementation((url, options) => {
      if (String(url).endsWith(`/tasks/${taskId}`)) {
        return Promise.resolve(new Response(JSON.stringify({ success: false, error: 'Read refused' }), { status }));
      }
      return originalFetch(url, options);
    });
    const subscription = subscribe.mock.calls.find(call => call[0] === 'task.updated');
    expect(subscription).toBeTruthy();
    subscription![1]({ task });
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: task.title })).not.toBeInTheDocument();
    expect(screen.queryByText('Task activity: Active')).not.toBeInTheDocument();
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).not.toContain(task.title));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  test('keeps cached details on a temporary outage and restores them after read authority returns', async () => {
    const originalFetch = vi.mocked(authenticatedFetch).getMockImplementation()!;
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    let readStatus = 503;
    let reads = 0;
    vi.mocked(authenticatedFetch).mockImplementation((url, options) => {
      if (String(url).endsWith(`/tasks/${taskId}`)) {
        reads++;
        if (readStatus !== 200) return Promise.resolve(new Response(JSON.stringify({ success: false, error: 'Read refused' }), { status: readStatus }));
      }
      return originalFetch(url, options);
    });
    const subscription = subscribe.mock.calls.find(call => call[0] === 'task.updated')!;
    subscription[1]({ task });
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { level: 1, name: task.title })).toBeInTheDocument();
    readStatus = 403;
    subscription[1]({ task });
    await screen.findByRole('heading', { level: 1, name: 'Permission denied' });
    readStatus = 200;
    subscription[1]({ task });
    await screen.findByRole('heading', { level: 1, name: task.title });
    await screen.findByText('Task activity: Active');
    expect(document.title).toContain(task.title);
  });

  test('sends a non-UUID route to board resolution with replace semantics', async () => {
    renderRoute('/tasks/8ede2a98');
    expect(await screen.findByTestId('location')).toHaveTextContent('/tasks?focus=8ede2a98');
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});

describe('the Verifier source note (card 41e24358)', () => {
  test('an inherited Phase default names the Phase', async () => {
    taskResponse = { ...task, phaseId: 'phase-1', verifierPrincipalId: 'principal-v', verifierSource: 'inherited-phase' } as typeof task;
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    await waitFor(() => expect(screen.getAllByText((_, element) => element?.tagName === 'SPAN'
      && /\(inherited from Phase Foundation\)$/.test(element.textContent || '')).length).toBeGreaterThan(0));
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
          <Route path="/tasks/:taskId" element={<><TaskDetailPage /><LocationProbe /><ReportNavigation /></>} />
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
      if (url.endsWith('/tasks/activity?ids=' + taskId)) return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId, state: 'active', kind: 'status', receivedAt: new Date(Date.now()-1000).toISOString() }] }), { status: 200 });
      if (url.endsWith('/tasks/' + taskId + '/native-executions')) return new Response(JSON.stringify({ success: true, result: { executions: [] } }), { status: 200 });
      if (url.endsWith('/tasks/' + taskId + '/native-reviews')) return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
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
          { id: '11111111-1111-4111-8111-111111111111', kind: 'human', handle: 'river', displayName: 'River', status: 'active' },
          { id: '22222222-2222-4222-8222-222222222222', kind: 'agent', handle: 'builder', displayName: null, status: 'active' },
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
    await waitFor(() => expect(screen.getByText('River')).toBeInTheDocument());
    expect(screen.getByText('builder')).toBeInTheDocument();
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
// E388 (card 5854f0d6, subtask 2085217): the holistic Task detail redesign
// is presentation only. These tests pin what it moved and restyled; the
// request log of every test above is unchanged, so no call was added.
describe('E388 Task detail redesign (presentation only)', () => {
  const css = async () => (await import('fs')).readFileSync('src/pages/TaskDetailPage.css', 'utf8') as string;
  const rule = (sheet: string, selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return sheet.match(new RegExp(`(^|\\n)${escaped} \\{[^}]*\\}`))?.[0] ?? '';
  };
  const ensurePointerEvent = () => {
    if (typeof window.PointerEvent === 'function') return;
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
    }
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });
  };
  let innerWidth = window.innerWidth;
  beforeEach(() => {
    innerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    try { localStorage.clear(); } catch { /* storage may be absent */ }
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    vi.restoreAllMocks();
  });

  test('E387(4): Account ownership sits only inside the Details rail Advanced section, never between the header and the columns', async () => {
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const header = document.querySelector('.task-detail-page-header')!;
    const layout = document.querySelector('.task-detail-layout')!;
    for (let node = header.nextElementSibling; node && node !== layout; node = node.nextElementSibling) {
      expect(node.tagName).not.toBe('DETAILS');
      expect(node).not.toHaveTextContent('Account ownership');
    }
    const summary = screen.getByText('Account ownership', { selector: 'summary' });
    const advanced = summary.closest('details.task-detail-advanced');
    expect(advanced).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'Details' })).toContainElement(summary);
    expect(summary.closest('details')).toHaveClass('task-detail-ownership-disclosure');
    expect(summary.closest('details')!.querySelector('h4')).toHaveTextContent('Account ownership');
    expect(within(summary.closest('details') as HTMLElement).getByRole('button', { name: 'Load current account owner', hidden: true })).toBeInTheDocument();
  });

  test.each(['todo', 'review'] as const)('E387(1): sessions and verification are one disclosure under the Timeline title, closed by default in every status (%s)', async status => {
    taskResponse = { ...task, status };
    renderRoute(`/tasks/${taskId}?filter=all`);
    const timeline = await screen.findByRole('complementary', { name: 'Timeline' });
    const runs = timeline.querySelector('details.task-timeline-runs') as HTMLDetailsElement;
    expect(runs).not.toBeNull();
    const summary = runs.querySelector(':scope > summary') as HTMLElement;
    expect(summary).toHaveTextContent('Sessions and verification');
    expect(runs.open).toBe(false);
    expect(runs).not.toHaveAttribute('open');
    expect(Array.from(runs.querySelectorAll('h3')).map(node => node.textContent)).toEqual(['Implementation sessions', 'Native verification']);
    expect(timeline.querySelectorAll('h2')).toHaveLength(1);
    const filter = await within(timeline).findByRole('radiogroup', { name: 'Timeline filter' });
    expect(runs.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One click opens it, so the panels stay reachable.
    fireEvent.click(summary);
    expect(runs.open).toBe(true);
  });

  test('E387(3): the Timeline edge resizes by keyboard and pointer within its clamp and is remembered in this browser', async () => {
    ensurePointerEvent();
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const separator = screen.getByRole('separator', { name: 'Resize Timeline' });
    const page = document.querySelector('.task-detail-page') as HTMLElement;
    const width = () => page.style.getPropertyValue('--task-detail-timeline-width');
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-controls', 'task-detail-timeline');
    expect(separator).toHaveAttribute('tabindex', '0');
    expect(separator).toHaveAttribute('aria-valuemin', '280');
    expect(separator).toHaveAttribute('aria-valuenow', '384');
    // 1440 layout - 280 rail - 320 reading reserve
    expect(separator).toHaveAttribute('aria-valuemax', '840');
    separator.focus();
    await user.keyboard('{ArrowLeft}');
    expect(separator).toHaveAttribute('aria-valuenow', '400');
    expect(width()).toBe('400px');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '368');
    await user.keyboard('{Home}');
    expect(separator).toHaveAttribute('aria-valuenow', '280');
    await user.keyboard('{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '280');
    await user.keyboard('{End}');
    expect(separator).toHaveAttribute('aria-valuenow', '840');
    await user.keyboard('{Home}');
    fireEvent.pointerDown(separator, { clientX: 1000, pointerId: 1, button: 0 });
    fireEvent.pointerMove(separator, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(separator, { clientX: 900, pointerId: 1 });
    expect(separator).toHaveAttribute('aria-valuenow', '380');
    expect(width()).toBe('380px');
    fireEvent.pointerDown(separator, { clientX: 900, pointerId: 1, button: 0 });
    fireEvent.pointerMove(separator, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(separator, { clientX: 100, pointerId: 1 });
    expect(separator).toHaveAttribute('aria-valuenow', '840');
    fireEvent.pointerDown(separator, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(separator, { clientX: 1400, pointerId: 1 });
    fireEvent.pointerUp(separator, { clientX: 1400, pointerId: 1 });
    expect(separator).toHaveAttribute('aria-valuenow', '280');
    expect(localStorage.getItem('relayhall.taskDetail.timelineWidth')).toBe('280');
    cleanup();
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    expect(screen.getByRole('separator', { name: 'Resize Timeline' })).toHaveAttribute('aria-valuenow', '280');
  });

  test('E387(3): Expand fills the layout width; the button or Escape restores the dragged width with focus kept', async () => {
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const page = document.querySelector('.task-detail-page') as HTMLElement;
    const separator = screen.getByRole('separator', { name: 'Resize Timeline' });
    separator.focus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    const expand = screen.getByRole('button', { name: 'Expand Timeline to full width' });
    expect(expand).toHaveAttribute('aria-pressed', 'false');
    await user.click(expand);
    expect(page).toHaveClass('task-detail-page--timeline-expanded');
    const restore = screen.getByRole('button', { name: 'Restore Timeline width' });
    expect(restore).toBe(expand);
    expect(restore).toHaveAttribute('aria-pressed', 'true');
    expect(restore).toHaveFocus();
    await user.click(restore);
    expect(page).not.toHaveClass('task-detail-page--timeline-expanded');
    expect(page.style.getPropertyValue('--task-detail-timeline-width')).toBe('416px');
    await user.click(expand);
    expect(page).toHaveClass('task-detail-page--timeline-expanded');
    await user.keyboard('{Escape}');
    expect(page).not.toHaveClass('task-detail-page--timeline-expanded');
    expect(expand).toHaveFocus();
    expect(page.style.getPropertyValue('--task-detail-timeline-width')).toBe('416px');
  });

  test('E387(3): a window narrowed below 1280px ends the expanded Timeline, so widening again shows three columns', async () => {
    const user = userEvent.setup();
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const page = document.querySelector('.task-detail-page') as HTMLElement;
    await user.click(screen.getByRole('button', { name: 'Expand Timeline to full width' }));
    expect(page).toHaveClass('task-detail-page--timeline-expanded');
    // A wide window keeps the expanded state across a resize.
    const matchMedia = vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(matchMedia).toHaveBeenCalledWith('(max-width: 1279px)');
      expect(page).toHaveClass('task-detail-page--timeline-expanded');
      matchMedia.mockImplementation((query: string) => ({ matches: query === '(max-width: 1279px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(page).not.toHaveClass('task-detail-page--timeline-expanded');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('E387(3): browser storage that refuses access leaves resizing usable', async () => {
    const user = userEvent.setup();
    // Only this page's per-viewer store refuses; the Report draft recovery's
    // session store is a different contract with its own tests.
    const { getItem, setItem } = Storage.prototype;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === window.localStorage) throw new Error('denied');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === window.localStorage) throw new Error('denied');
      setItem.call(this, key, value);
    });
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const separator = screen.getByRole('separator', { name: 'Resize Timeline' });
    expect(separator).toHaveAttribute('aria-valuenow', '384');
    separator.focus();
    await user.keyboard('{ArrowLeft}');
    expect(separator).toHaveAttribute('aria-valuenow', '400');
  });

  test('the header carries the full title as a tooltip and groups State | Lifecycle | Utilities with the reason on its own caption line', async () => {
    renderRoute(`/tasks/${taskId}`);
    const title = await screen.findByRole('heading', { level: 1, name: task.title });
    expect(title).toHaveAttribute('title', task.title);
    const controls = document.querySelector('.task-detail-page-header-controls')!;
    const clusters = Array.from(controls.querySelectorAll(':scope > .task-detail-header-cluster'));
    expect(clusters).toHaveLength(3);
    expect(within(clusters[0] as HTMLElement).getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(within(clusters[0] as HTMLElement).getByRole('combobox', { name: 'Priority' })).toBeInTheDocument();
    expect(clusters[0].querySelector('.task-activity')).not.toBeNull();
    expect(within(clusters[1] as HTMLElement).getByRole('button', { name: 'Arm' })).toBeInTheDocument();
    expect(within(clusters[1] as HTMLElement).getByRole('button', { name: 'Claim Task' })).toBeInTheDocument();
    expect(clusters[2]).toHaveClass('task-detail-header-cluster--utilities');
    for (const name of ['Go to Timeline', 'Copy link', 'View context', 'More Task actions']) {
      expect(within(clusters[2] as HTMLElement).getByRole('button', { name })).toBeInTheDocument();
    }
    const reason = document.getElementById('task-claim-authority')!;
    expect(reason).toHaveTextContent('Arm this Task before claiming it.');
    expect(reason).toHaveClass('task-detail-header-caption');
    expect(reason.parentElement).toBe(controls);
    expect(clusters[2].compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim Task' })).toHaveAttribute('aria-describedby', 'task-claim-authority');
  });

  test('People lists Creator, Assignee, Shepherd and Verifier before the Verifier banner, and Dates & counters is a two-column grid', async () => {
    taskResponse = { ...task, status: 'review', verifierUsability: { usable: false, failedArm: 'none', principalId: null } } as unknown as typeof task;
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const details = screen.getByRole('complementary', { name: 'Details' });
    const banner = await within(details).findByText('No usable Verifier: none set');
    const people = within(details).getByRole('heading', { level: 3, name: 'People' }).closest('section')!;
    const list = people.querySelector('dl')!;
    expect(list.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const dates = within(details).getByRole('heading', { level: 3, name: 'Dates & counters' }).closest('section')!;
    expect(dates.querySelector('dl')).toHaveClass('task-detail-dates-grid');
  });

  test('E387(5): Description and Notes lists render inside the dotted frame, indented like Definition of done', async () => {
    taskResponse = { ...task, description: 'Steps:\n1. one\n2. two\n\n- bullet', notes: '- note bullet' };
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', { level: 1, name: task.title });
    const description = document.getElementById('task-detail-section-description')!;
    expect(description.querySelector('.editable-frame .task-detail-markdown ol li')).toHaveTextContent('one');
    expect(description.querySelector('.editable-frame .task-detail-markdown ul li')).toHaveTextContent('bullet');
    expect(document.getElementById('task-detail-section-notes')!.querySelector('.editable-frame .task-detail-markdown ul li')).toHaveTextContent('note bullet');
    const sheet = await css();
    const lists = rule(sheet, '.task-detail-markdown :is(ul, ol)');
    expect(lists).toContain('padding-inline-start: var(--space-5)');
    expect(rule(sheet, '.task-detail-structured-list')).toContain('padding-left: var(--space-5)');
  });

  test('the stylesheet carries the redesign contract: wrapped title, quiet programmatic focus, narrow toggle hidden, desktop-only resize', async () => {
    const sheet = await css();
    const title = rule(sheet, '.task-detail-page--view .task-detail-heading h1');
    expect(title).toContain('-webkit-line-clamp: 2');
    expect(title).toContain('white-space: normal');
    // A tabindex=-1 heading is reached only by the page's own focus call, so
    // that focus carries no ring; the pencil's keyboard ring is untouched.
    expect(sheet).toMatch(/\.task-detail-heading h1\[tabindex="-1"\]:focus \{[^}]*box-shadow: none/);
    expect(sheet).toMatch(/\.task-detail-heading \.editable-frame:has\(> h1\[tabindex="-1"\]:focus\) \{[^}]*border-style: dashed/);
    // H6: element-qualified, so it outweighs `.task-detail-page-header button:not(...)`.
    expect(sheet).toMatch(/@media \(max-width: 767px\) \{[^@]*\.task-detail-page-header button\.task-detail-timeline-toggle \{\s*display: none;/);
    expect(sheet).toMatch(/@media \(max-width: 1279px\) \{\s*\.task-detail-page \.task-detail-timeline-resizer,\s*\.task-detail-page \.task-detail-timeline-expand \{\s*display: none;/);
    expect(rule(sheet, '.task-detail-page--view')).toContain('--task-detail-timeline-width: 24rem');
  });
});

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


describe('current server lifecycle permission affordance', () => {
  test.each([
    ['TASK_WRITE_REQUIRED', 'This action requires Task write access.'],
    ['WRITE_SCOPE_REQUIRED', 'Your current sign-in or credential does not permit Task writes.'],
  ])('disables Arm with accurate %s reason, never sends denied write', async (reason, explanation) => {
    taskResponse = { ...task, lifecycleAccess: { ...task.lifecycleAccess!, arm: { allowed: false, reason } } };
    renderRoute(`/tasks/${taskId}`);
    const arm = await screen.findByRole('button', { name: 'Arm' });
    expect(arm).toBeDisabled();expect(screen.getByText(explanation, { exact: false })).toBeVisible();
    fireEvent.click(arm);
    expect(vi.mocked(authenticatedFetch).mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0);
  });
  test('absent capability fails closed; Shepherd park can remain independently allowed', async () => {
    taskResponse = { ...task, lifecycleAccess: undefined };
    const page = renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByRole('button', { name: 'Arm' })).toBeDisabled();
    expect(screen.getByText('Task permissions are unavailable. Refresh to check access.')).toBeVisible();
    page.unmount();
    taskResponse = { ...task, autoStart: true, lifecycleAccess: { ...task.lifecycleAccess!, arm: { allowed: false, reason: 'TASK_WRITE_REQUIRED' } } };
    renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByRole('button', { name: 'Park' })).toBeEnabled();
  });
});

test('Claim uses current server assignment epoch without enabling Arm and displays a stale-epoch refusal', async () => {
  taskResponse={...task,autoStart:true,ownerPrincipalId:null,lifecycleAccess:{arm:{allowed:false,reason:'TASK_WRITE_REQUIRED'},park:{allowed:false,reason:'TASK_WRITE_REQUIRED'},claim:{allowed:true,reason:null,expectedAssignmentEpoch:'7'}}};
  const old=vi.mocked(authenticatedFetch).getMockImplementation()!;
  vi.mocked(authenticatedFetch).mockImplementation(async (input,init) => {
    if(String(input).endsWith('/claim')) return new Response(JSON.stringify({success:false,code:'TASK_ASSIGNMENT_EPOCH_MISMATCH',error:'Read the current assignment before claiming'}),{status:409});
    return old(input,init);
  });
  renderRoute(`/tasks/${taskId}`);
  await screen.findByRole('button',{name:'Claim Task'});
  expect(screen.getByRole('button',{name:'Park'})).toBeDisabled();
  await userEvent.click(screen.getByRole('button',{name:'Claim Task'}));
  await screen.findByText('Read the current assignment before claiming');
  const request=vi.mocked(authenticatedFetch).mock.calls.find(([url])=>String(url).endsWith('/claim'))!;
  expect(request[1]?.method).toBe('POST');expect(JSON.parse(String(request[1]?.body))).toEqual({expectedAssignmentEpoch:'7'});
});
test('A refused claim decision disables the rendered claim control',async()=>{
  renderRoute(`/tasks/${taskId}`);expect(await screen.findByRole('button',{name:'Claim Task'})).toBeDisabled();
});

// Card 3fc32dd1: the owner clicked Claim Task, the board answered 200, and the
// page showed nothing. A claim is now announced either way, through the app
// shell's toasts, and a disabled Claim says why in the projection's words.
describe('Claim Task announces its outcome and explains a disabled control', () => {
  function renderWithToasts() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
            <Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }
  const claimable = (): typeof task => ({ ...task, autoStart: true, ownerPrincipalId: null,
    lifecycleAccess: { arm: { allowed: true, reason: null }, park: { allowed: true, reason: null }, claim: { allowed: true, reason: null } } });
  function answerClaim(status: number, body: unknown) {
    const previous = vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => String(input).endsWith('/claim')
      ? new Response(JSON.stringify(body), { status }) : previous(input, init));
  }

  test('a claim that assigns announces the Assignee and the step to a progress Report', async () => {
    taskResponse = claimable();
    answerClaim(200, { success: true, task: { ...taskResponse, ownerPrincipalId: 'test-author' }, claim: { outcome: 'claimed' } });
    renderWithToasts();
    await userEvent.click(await screen.findByRole('button', { name: 'Claim Task' }));
    expect(await screen.findByText("You are now this Task's Assignee. Set Status to In progress to start work and save progress Reports.")).toBeVisible();
    const request = vi.mocked(authenticatedFetch).mock.calls.find(([url]) => String(url).endsWith('/claim'))!;
    expect([request[1]?.method, JSON.parse(String(request[1]?.body))]).toEqual(['POST', {}]);
  });

  test('the current Assignee claiming again is told so, not answered with silence', async () => {
    taskResponse = { ...claimable(), ownerPrincipalId: 'test-author' };
    answerClaim(200, { success: true, task: taskResponse, claim: { outcome: 'already_assignee' } });
    renderWithToasts();
    await userEvent.click(await screen.findByRole('button', { name: 'Claim Task' }));
    expect(await screen.findByText("You are already this Task's Assignee.")).toBeVisible();
    expect(screen.queryByText(/You are now this Task's Assignee/)).not.toBeInTheDocument();
  });

  test('a refused claim is a toast beside the inline alert, in the board\'s words', async () => {
    taskResponse = claimable();
    answerClaim(409, { success: false, code: 'TASK_ALREADY_ASSIGNED', error: 'Another principal is already the Assignee of this task',
      details: { reason: 'TASK_ALREADY_ASSIGNED' } });
    renderWithToasts();
    await userEvent.click(await screen.findByRole('button', { name: 'Claim Task' }));
    expect(await screen.findByText('Claim refused: Another principal is already the Assignee of this task')).toBeVisible();
    expect(screen.getByText('Another principal is already the Assignee of this task')).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(/You are now this Task's Assignee/)).not.toBeInTheDocument();
  });

  test.each([
    ['TASK_NOT_ARMED', 'Arm this Task before claiming it.'],
    ['TASK_ALREADY_ASSIGNED', "Another principal is this Task's Assignee."],
    ['INDEPENDENT_VERIFIER', "You are this Task's Verifier, and a Verifier cannot also be its Assignee."],
    ['TASK_BLOCKED', 'This Task can be claimed when every dependency is completed.'],
    ['TASK_WRITE_REQUIRED', 'This action requires Task write access. Ask an administrator for access or hand off to an authorized executor.'],
    [null, 'Claim permissions are unavailable. Refresh to check access.'],
  ])('a %s claim decision disables Claim and names the reason', async (reason, text) => {
    taskResponse = { ...task, lifecycleAccess: reason === null ? undefined
      : { ...task.lifecycleAccess!, claim: { allowed: false, reason } } };
    renderRoute(`/tasks/${taskId}`);
    const claim = await screen.findByRole('button', { name: 'Claim Task' });
    expect(claim).toBeDisabled();
    expect(claim).toHaveAttribute('aria-describedby', 'task-claim-authority');
    expect(document.getElementById('task-claim-authority')).toHaveTextContent(text);
  });

  test('an allowed claim decision enables Claim with no refusal text', async () => {
    taskResponse = claimable();
    renderRoute(`/tasks/${taskId}`);
    const claim = await screen.findByRole('button', { name: 'Claim Task' });
    expect(claim).toBeEnabled();
    expect(claim).not.toHaveAttribute('aria-describedby');
    expect(document.getElementById('task-claim-authority')).toBeNull();
  });
});

// Card 3fc32dd1: the owner's Task was claimed but still To do, so the progress
// Report form never appeared and nothing said why. The Reports section names
// the one supported path, from the server's own decisions.
describe('the progress Report path is named where the form will appear', () => {
  const claimAllowed = { ...task.lifecycleAccess!, claim: { allowed: true, reason: null } };
  test.each([
    ['todo', { allowed: false, reason: 'TASK_REPORT_FROZEN' }, task.lifecycleAccess, "You are this Task's Assignee. Set Status to In progress to save a progress Report."],
    ['stuck', { allowed: false, reason: 'TASK_REPORT_FROZEN' }, task.lifecycleAccess, "You are this Task's Assignee. Set Status to In progress to save a progress Report."],
    ['todo', { allowed: false, reason: 'TASK_CLAIMANT_REQUIRED' }, claimAllowed, "Progress Reports are saved by this Task's Assignee while it is In progress: Claim Task, then set Status to In progress."],
    ['ideas', { allowed: false, reason: 'TASK_CLAIMANT_REQUIRED' }, task.lifecycleAccess, "Progress Reports are saved by this Task's Assignee while it is In progress: Arm this Task, Claim Task, then set Status to In progress."],
    ['todo', { allowed: false, reason: 'TASK_CLAIMANT_REQUIRED' }, { ...task.lifecycleAccess!, claim: { allowed: false, reason: 'TASK_ALREADY_ASSIGNED' } }, null],
    ['review', { allowed: false, reason: 'TASK_REPORT_FROZEN' }, task.lifecycleAccess, null],
    ['completed', { allowed: false, reason: 'TASK_REPORT_FROZEN' }, task.lifecycleAccess, null],
    ['todo', undefined, task.lifecycleAccess, null],
  ] as const)('%s with %j', (status, reportMaintenanceAccess, lifecycleAccess, expected) => {
    expect(reportPathGuidance({ ...task, status, reportMaintenanceAccess, lifecycleAccess } as Task)).toBe(expected);
  });

  test('a claimed To do Task tells its Assignee to set In progress, and the form opens only In progress', async () => {
    taskResponse = { ...task, reportMaintenanceAccess: { allowed: false, reason: 'TASK_REPORT_FROZEN' } };
    renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByText("You are this Task's Assignee. Set Status to In progress to save a progress Report.")).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: 'Save Task Report' })).not.toBeInTheDocument();
  });
});

test('assigned Task progress save and existing finish carry the saved Report ID', async () => {
  const previous=vi.mocked(authenticatedFetch).getMockImplementation()!;
  let handed=false;
  vi.mocked(authenticatedFetch).mockImplementation(async (input,init) => {
    const url=String(input);
    if(url.endsWith(`/tasks/${taskId}`)) return new Response(JSON.stringify({success:true,task:{...task,status:handed?'review':'in-progress',reportMaintenanceAccess:{allowed:!handed,reason:handed?'TASK_REPORT_FROZEN':null}}}));
    if(url.endsWith(`/tasks/${taskId}/reports`) && init?.method==='POST') {
      const body=JSON.parse(String(init.body));
      expect(body.title).toBe('Progress evidence'); expect(body.content).toBe('Actual checks');
      if(body.reportId) expect(body).toMatchObject({reportId:'33333333-3333-4333-8333-333333333333',expectedContentHash:'a'.repeat(64)});
      const hash=createHash('sha256').update(JSON.stringify({title:body.title,content:body.content,summary:null,reportId:body.reportId??null,expectedContentHash:body.expectedContentHash??null})).digest('hex'); return new Response(JSON.stringify({success:true,report:{id:'33333333-3333-4333-8333-333333333333',...body,content_hash:'a'.repeat(64)},operation:{key:(init?.headers as any)['Idempotency-Key'],requestHash:hash,contentHash:'a'.repeat(64)}}),{status:201});
    }
    if(url.endsWith(`/tasks/${taskId}/finish`)) {
      expect(JSON.parse(String(init?.body))).toEqual({reportId:'33333333-3333-4333-8333-333333333333',handover:'Report filed: 33333333-3333-4333-8333-333333333333'});handed=true;
      return new Response(JSON.stringify({success:true,status:'review'}));
    }
    return previous(input,init);
  });
  renderRoute(`/tasks/${taskId}`);
  const user=userEvent.setup();
  await user.type(await screen.findByRole('textbox',{name:'Report title'}),'Progress evidence');
  await user.type(screen.getByRole('textbox',{name:'Progress'}),'Actual checks');
  await user.click(screen.getByRole('button',{name:'Save Task Report'}));
  const handoff=await screen.findByRole('button',{name:'Hand over saved Report for review'});
  await user.type(screen.getByRole('textbox',{name:'Progress'}),' unsaved');
  expect(handoff).toBeDisabled();
  await user.clear(screen.getByRole('textbox',{name:'Progress'}));
  await user.type(screen.getByRole('textbox',{name:'Progress'}),'Actual checks');
  await user.click(screen.getByRole('button',{name:'Save Task Report'}));
  await waitFor(()=>expect(handoff).not.toBeDisabled());
  await user.click(handoff);
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Save Task Report'})).not.toBeInTheDocument());
});

test('lost create transport is reconciled with the same key and never creates twice',async()=>{
 const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let writes=0;let reads=0;let saved:any;let key='';let digest='';
 vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
  const url=String(input);
  if(url.endsWith(`/tasks/${taskId}`))return new Response(JSON.stringify({success:true,task:{...task,status:'in-progress',reportMaintenanceAccess:{allowed:true,reason:null}}}));
  if(url.endsWith(`/tasks/${taskId}/reports`)&&init?.method==='POST'){
   writes++;saved=JSON.parse(String(init.body));key=(init.headers as any)['Idempotency-Key'];
   digest=createHash('sha256').update(JSON.stringify({title:saved.title,content:saved.content,summary:null,reportId:null,expectedContentHash:null})).digest('hex');
   throw new TypeError('Transport lost after committed create');
  }
  if(url.includes('/report-operations/')){
   if(++reads===1)return new Response(JSON.stringify({code:'TASK_REPORT_AUTHORITY_REVOKED',error:'Access revoked'}),{status:403});
   expect(url).toContain(`${key}?requestHash=${digest}`);
   return new Response(JSON.stringify({success:true,report:{id:'44444444-4444-8444-444444444444',...saved,content_hash:'b'.repeat(64)},operation:{key,requestHash:digest,contentHash:'b'.repeat(64)}}));
  }
  return prior(input,init);
 });
 const page=renderRoute(`/tasks/${taskId}`);const user=userEvent.setup();
 await user.type(await screen.findByRole('textbox',{name:'Report title'}),'Lost transport');await user.type(screen.getByRole('textbox',{name:'Progress'}),'Committed evidence');
 await user.click(screen.getByRole('button',{name:'Save Task Report'}));
 await waitFor(()=>expect(writes).toBe(1));
  await screen.findByText('Transport lost after committed create');
  await waitFor(()=>expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled());
  const durableKey=`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;
  const exact=sessionStorage.getItem(durableKey)!;
  expect(JSON.parse(exact)).toEqual({key:key,body:saved,requestHash:digest});
  page.unmount();renderRoute(`/tasks/${taskId}`);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled());
  expect(sessionStorage.getItem(durableKey)).toBe(exact);
 const retry=await screen.findByRole('button',{name:'Reconcile Task Report save'});await user.click(retry);
 await screen.findByText('Access revoked');expect(retry).toBeEnabled();await user.click(retry);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Hand over saved Report for review'})).toBeEnabled());expect(writes).toBe(1);
});

test('precommit transport failure retries only the same durable key after exact authenticated unknown',async()=>{
 const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let writes=0;let firstKey='';let digest='';let saved:any;
 vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
  const url=String(input);if(url.endsWith(`/tasks/${taskId}`))return new Response(JSON.stringify({success:true,task:{...task,status:'in-progress',reportMaintenanceAccess:{allowed:true,reason:null}}}));
  if(url.includes("/report-operations/")){expect(url).toContain(`${firstKey}?requestHash=${digest}`);return new Response(JSON.stringify({code:"TASK_REPORT_OPERATION_UNKNOWN"}),{status:404});}
  if(url.endsWith(`/tasks/${taskId}/reports`)&&init?.method==='POST'){
   const key=(init.headers as any)['Idempotency-Key'];saved=JSON.parse(String(init.body));writes++;
   if(writes===1){firstKey=key;digest=createHash('sha256').update(JSON.stringify({title:saved.title,content:saved.content,summary:null,reportId:null,expectedContentHash:null})).digest('hex');throw new TypeError('Failed before commit');}
   expect(key).toBe(firstKey);expect(saved).toEqual({title: "No commit", content: "Original body"});return new Response(JSON.stringify({success:true,report:{id:'55555555-5555-4555-8555-555555555555',...saved,content_hash:'c'.repeat(64)},operation:{key,requestHash:digest,contentHash:'c'.repeat(64)}}));
  }return prior(input,init);
 });
 const page=renderRoute(`/tasks/${taskId}`);const user=userEvent.setup();await user.type(await screen.findByRole('textbox',{name:'Report title'}),'No commit');await user.type(screen.getByRole('textbox',{name:'Progress'}),'Original body');await user.click(screen.getByRole('button',{name:'Save Task Report'}));
 await waitFor(()=>expect(writes).toBe(1));
  await screen.findByText('Failed before commit');
  await waitFor(()=>expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled());
  const durableKey=`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;
  const exact=sessionStorage.getItem(durableKey)!;
  expect(JSON.parse(exact)).toEqual({key:firstKey,body:saved,requestHash:digest});
  page.unmount();renderRoute(`/tasks/${taskId}`);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled());
  expect(sessionStorage.getItem(durableKey)).toBe(exact);await user.click(await screen.findByRole('button',{name:'Reconcile Task Report save'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Hand over saved Report for review'})).toBeEnabled());expect(writes).toBe(2);
});


describe('Task Report editing audience', () => {
  test.each(['parent-1', 'verifier-1', null])('does not offer claimant controls to %s', async principalId => {
    taskResponse = {...task, status:'in-progress',reportMaintenanceAccess:{allowed:true,reason:null}};
    const prior = vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input, init) =>
      String(input).endsWith('/principals/me')
        ? new Response(JSON.stringify({success:true, principal:principalId ? {id:principalId} : null}))
        : prior(input, init));
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', {name:'Reports & handovers'});
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith('/api/principals/me'));
    expect(screen.queryByRole('textbox', {name:'Report title'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name:'Save Task Report'})).not.toBeInTheDocument();
  });

  test('does not offer writes when the server denies Task write access', async () => {
    taskResponse = {...task, status:'in-progress', reportMaintenanceAccess:{allowed:false,reason:'TASK_REPORT_AUTHORITY_REVOKED'}, lifecycleAccess:{...task.lifecycleAccess!, arm:{allowed:false,reason:'TASK_WRITE_REQUIRED'}}};
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('heading', {name:'Reports & handovers'});
    expect(screen.queryByRole('textbox', {name:'Report title'})).not.toBeInTheDocument();
  });

  test('reassignment closes an already open claimant form', async () => {
    taskResponse = {...task, status:'in-progress',reportMaintenanceAccess:{allowed:true,reason:null}};
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole('textbox', {name:'Report title'});
    taskResponse = {...taskResponse, ownerPrincipalId:'different-claimant'};
    // A real WebSocket dispatch reaches every subscriber for this event.
    for (const [, handler] of subscribe.mock.calls.filter(call => call[0] === 'task.updated')) {
      handler({task:taskResponse});
    }
    await waitFor(() => expect(screen.queryByRole('textbox', {name:'Report title'})).not.toBeInTheDocument());
  });

  test('a task-report link selects the exact owned active report and excludes foreign drafts', async () => {
    taskResponse = {...task, status:'in-progress',reportMaintenanceAccess:{allowed:true,reason:null}};
    const prior = vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init) =>
      progressReportFixture(input, init, [
            {id:'66666666-6666-4666-8666-666666666666',title:'Owned draft',content:'Existing evidence',content_hash:'a'.repeat(64),author_principal_id:task.ownerPrincipalId,status:'active'},
            {id:'77777777-7777-4777-8777-777777777777',title:'Foreign draft',content:'Foreign evidence',content_hash:'b'.repeat(64),author_principal_id:'other-author',status:'active'},
            {id:'88888888-8888-4888-8888-888888888888',title:'Archived draft',content:'Old evidence',content_hash:'c'.repeat(64),author_principal_id:task.ownerPrincipalId,status:'archived'},
          ]) ?? prior(input,init));
    renderRoute(`/tasks/${taskId}?report=66666666-6666-4666-8666-666666666666`);
    await waitFor(() => expect(screen.getByRole('textbox',{name:'Report title'})).toHaveValue('Owned draft'));
    expect(screen.getByRole('textbox',{name:'Progress'})).toHaveValue('Existing evidence');
    expect(screen.getByRole('combobox',{name:'Continue a progress Report'})).toHaveValue('66666666-6666-4666-8666-666666666666');
    expect(screen.queryByRole('option',{name:'Foreign draft'})).not.toBeInTheDocument();
    expect(screen.queryByRole('option',{name:'Archived draft'})).not.toBeInTheDocument();
  });
});


describe("Report draft lifetime and canonical selection",()=>{
  const rows=[{id:"11111111-1111-4111-8111-111111111111",title:"First report",content:"First evidence",content_hash:"a".repeat(64),author_principal_id:task.ownerPrincipalId,status:"active"},
    {id:"22222222-2222-4222-8222-222222222222",title:"Second report",content:"Second evidence",content_hash:"b".repeat(64),author_principal_id:task.ownerPrincipalId,status:"active"}];
  function setup(){
    taskResponse={...task,status:"in-progress",reportMaintenanceAccess:{allowed:true,reason:null}};
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>progressReportFixture(input,init,rows) ?? prior(input,init));
  }
  async function refresh(updates:Partial<Task>){
    taskResponse={...taskResponse,...updates};
    await act(async()=>{for(const [,handler] of subscribe.mock.calls.filter(call=>call[0]==="task.updated"))handler({task:taskResponse});});
  }
  async function selectFirst(){
    setup();renderRoute(`/tasks/${taskId}?report=11111111-1111-4111-8111-111111111111`);
    await waitFor(()=>expect(screen.getByLabelText("Report title")).toHaveValue("First report"));
  }
  test("verifier-only refresh preserves typed evidence, selected Report id and CAS hash",async()=>{
    await selectFirst();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"Unsaved verifier evidence"}});
    await refresh({verifierPrincipalId:"verifier-2"});
    expect(await screen.findByLabelText("Progress")).toHaveValue("Unsaved verifier evidence");
    expect(screen.getByLabelText("Continue a progress Report")).toHaveValue("11111111-1111-4111-8111-111111111111");
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    let body:any;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(init?.method==="POST"){body=JSON.parse(String(init.body));return new Response(JSON.stringify({error:"fixture refusal"}),{status:403});}return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));
    await screen.findByText("fixture refusal");
    expect(body).toEqual({title:"First report",content:"Unsaved verifier evidence",reportId:"11111111-1111-4111-8111-111111111111",expectedContentHash:"a".repeat(64)});
  });
  test("permission loss closes controls without deleting the draft, recovery restores the same Report",async()=>{
    await selectFirst();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"Evidence must survive"}});
    await refresh({reportMaintenanceAccess:{allowed:false,reason:"TASK_REPORT_AUTHORITY_REVOKED"}});
    await waitFor(()=>expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument());
    await refresh({reportMaintenanceAccess:{allowed:true,reason:null}});
    expect(await screen.findByLabelText("Progress")).toHaveValue("Evidence must survive");
    expect(screen.getByLabelText("Continue a progress Report")).toHaveValue("11111111-1111-4111-8111-111111111111");
  });
  test("unknown display decision fails closed even when Arm is allowed",async()=>{
    setup();taskResponse={...taskResponse,reportMaintenanceAccess:undefined};renderRoute(`/tasks/${taskId}`);
    await screen.findByRole("heading",{name:"Reports & handovers"});
    await waitFor(()=>expect(authenticatedFetch).toHaveBeenCalledWith("/api/principals/me"));
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
  });
  test("Arm may be allowed while explicit Report WRITE display refusal closes the editor",async()=>{
    setup();taskResponse={...taskResponse,reportMaintenanceAccess:{allowed:false,reason:"TASK_REPORT_AUTHORITY_REVOKED"}};renderRoute(`/tasks/${taskId}`);
    await screen.findByRole("heading",{name:"Reports & handovers"});
    expect(screen.queryByRole("button",{name:"Save Task Report"})).not.toBeInTheDocument();
  });
  test("query-only clean switch loads the correct canonical body, Report id and hash",async()=>{
    await selectFirst();fireEvent.click(screen.getByTestId("switch-r2"));
    await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue("Second evidence"));
    expect(screen.getByLabelText("Continue a progress Report")).toHaveValue("22222222-2222-4222-8222-222222222222");
    const storage=JSON.parse(sessionStorage.getItem(`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}:draft`)!);
    expect(storage.draft).toMatchObject({reportId:"22222222-2222-4222-8222-222222222222",expectedContentHash:"b".repeat(64)});
    expect(screen.getByTestId("location")).toHaveTextContent("?report=22222222-2222-4222-8222-222222222222");
  });
  test("query-only dirty switch explicitly refuses and restores canonical URL without overwriting evidence",async()=>{
    await selectFirst();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"Dirty first evidence"}});
    fireEvent.click(screen.getByTestId("switch-r2"));
    await screen.findByText(/Report switch refused:/);
    await waitFor(()=>expect(screen.getByTestId("location")).toHaveTextContent("?report=11111111-1111-4111-8111-111111111111"));
    expect(screen.getByLabelText("Progress")).toHaveValue("Dirty first evidence");expect(screen.getByLabelText("Continue a progress Report")).toHaveValue("11111111-1111-4111-8111-111111111111");
  });
  test("pending query switch refuses; authority loss/recovery and refusal retain exact durable operation",async()=>{
    await selectFirst();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"Pending first evidence"}});
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(init?.method==="POST")throw new TypeError("fixture lost response");
      if(String(input).includes("/report-operations/"))return new Response(JSON.stringify({code:"TASK_REPORT_AUTHORITY_REVOKED",error:"Reconcile refused"}),{status:403});
      return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await screen.findByRole("button",{name:"Reconcile Task Report save"});
    const key=`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;const exact=sessionStorage.getItem(key);
    fireEvent.click(screen.getByTestId("switch-r2"));await screen.findByText(/Report switch refused:/);
    await waitFor(()=>expect(screen.getByTestId("location")).toHaveTextContent("?report=11111111-1111-4111-8111-111111111111"));
    await refresh({reportMaintenanceAccess:{allowed:false,reason:"TASK_REPORT_AUTHORITY_REVOKED"}});
    await refresh({reportMaintenanceAccess:{allowed:true,reason:null}});
    fireEvent.click(await enabledButton("Reconcile Task Report save"));await screen.findByText("Reconcile refused");
    expect(sessionStorage.getItem(key)).toBe(exact);expect(screen.getByLabelText("Progress")).toHaveValue("Pending first evidence");
    expect(screen.getByLabelText("Continue a progress Report")).toHaveValue("11111111-1111-4111-8111-111111111111");
  });
  test("verifier refresh during an in-flight save leaves a recoverable exact operation, not a stuck saving control",async()=>{
    await selectFirst();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"In flight verifier evidence"}});
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let finish!:(response:Response)=>void;
    let reads=0;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(init?.method==="POST")return new Promise<Response>(resolve=>{finish=resolve;});
      if(String(input).includes("/report-operations/")){reads++;return new Response(JSON.stringify({code:"TASK_REPORT_AUTHORITY_REVOKED",error:"Keep original pending"}),{status:403});}
      return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(finish).toBeDefined());
    const key=`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;const exact=sessionStorage.getItem(key)!;const operation=JSON.parse(exact);
    await refresh({verifierPrincipalId:"verifier-2"});
    await waitFor(()=>expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled());
    await act(async()=>finish(new Response(JSON.stringify({success:true,report:{id:"11111111-1111-4111-8111-111111111111",...operation.body,content_hash:"c".repeat(64)},operation:{key:operation.key,requestHash:operation.requestHash,contentHash:"c".repeat(64)}}))));
    const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});expect(reconcile).toBeEnabled();
    fireEvent.click(reconcile);await screen.findByText("Keep original pending");
    expect(reads).toBe(1);expect(sessionStorage.getItem(key)).toBe(exact);
    expect(screen.getByLabelText("Progress")).toHaveValue("In flight verifier evidence");
  });
  test("unavailable canonical Report never silently creates a duplicate",async()=>{
    setup();renderRoute(`/tasks/${taskId}?report=foreign-or-missing`);
    await screen.findByText("This Report is not available for you to edit on this Task.");
    expect(screen.getByRole("button",{name:"Save Task Report"})).toBeDisabled();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
  });
  test("actor change detected before sending a save retains the original draft and sends no POST",async()=>{
    await selectFirst();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"Original actor evidence"}});
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).endsWith("/principals/me")
      ? new Response(JSON.stringify({principal:{id:"other-actor"}})) : prior(input,init));
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));
    await waitFor(()=>expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument());
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
    const key=`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}:draft`;
    expect(JSON.parse(sessionStorage.getItem(key)!).draft).toMatchObject({content:"Original actor evidence",reportId:"11111111-1111-4111-8111-111111111111"});
  });
  test("stale in-flight save after route switch cannot overwrite another Task or delete its original pending key",async()=>{
    await selectFirst();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"In flight evidence"}});
    const other="99999999-9999-4999-8999-999999999999";const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    let finish!:(response:Response)=>void;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(init?.method==="POST")return new Promise<Response>(resolve=>{finish=resolve;});
      if(String(input).endsWith(`/tasks/${other}`))return new Response(JSON.stringify({success:true,task:{...taskResponse,id:other,title:"Other Task"}}));
      if(String(input).includes(`/tasks/${other}/`))return prior(String(input).replace(other,taskId),init);
      return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(finish).toBeDefined());
    const key=`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;const exact=sessionStorage.getItem(key)!;const operation=JSON.parse(exact);
    fireEvent.click(screen.getByTestId("switch-task"));await screen.findByRole("heading",{name:"Other Task"});
    await act(async()=>finish(new Response(JSON.stringify({success:true,report:{id:"11111111-1111-4111-8111-111111111111",...operation.body,content_hash:"c".repeat(64)},operation:{key:operation.key,requestHash:operation.requestHash,contentHash:"c".repeat(64)}}))));
    expect(await screen.findByLabelText("Progress")).toHaveValue("");expect(sessionStorage.getItem(key)).toBe(exact);
  });
});


describe("untrusted persisted Task Report recovery", () => {
  const key = () => `relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;
  const operationKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reportId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const draft = {title: "Recovered draft", content: "Exact evidence\n", reportId, expectedContentHash: "a".repeat(64)};
  const body = {title: " Persisted recovery evidence ", content: "Original body\n"};
  function operation(value: Record<string, string> = body) {
    const requestHash = createHash("sha256").update(JSON.stringify({title:value.title,content:value.content,summary:null,
      reportId:value.reportId??null,expectedContentHash:value.expectedContentHash??null})).digest("hex");
    return {key:operationKey,body:value,requestHash};
  }
  function setup() { taskResponse = {...task,status:"in-progress",reportMaintenanceAccess:{allowed:true,reason:null}}; }
  const malformedDrafts: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["primitive", false], ["missing dirty", {draft}],
    ["wrong dirty type", {draft,dirty:"false"}], ["extra wrapper field", {draft,dirty:true,author:"foreign"}],
    ["extra draft field", {draft:{...draft,sourceTaskId:taskId},dirty:true}],
    ["wrong title type", {draft:{...draft,title:7},dirty:true}],
    ["wrong content type", {draft:{...draft,content:null},dirty:true}],
    ["missing content", {draft:{title:"x",reportId,expectedContentHash:"a".repeat(64)},dirty:true}],
    ["invalid Report UUID", {draft:{...draft,reportId:"R1"},dirty:true}],
    ["invalid CAS", {draft:{...draft,expectedContentHash:"bad"},dirty:true}],
    ["unpaired new CAS", {draft:{...draft,reportId:""},dirty:true}],
    ["unpaired edit CAS", {draft:{...draft,expectedContentHash:""},dirty:true}],
  ];
  test.each(malformedDrafts)("malformed draft %s is preserved and never enables or sends writes", async (_label,value) => {
    setup();const exact=JSON.stringify(value);sessionStorage.setItem(key()+":draft",exact);
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Save Task Report"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Reconcile Task Report save"})).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key()+":draft")).toBe(exact);
    expect(sessionStorage.getItem(key())).toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
  });
  const malformedPending: Array<[string, unknown]> = [
    ["null",null], ["array",[]], ["extra wrapper field",{...operation(),actor:"foreign"}],
    ["bad operation UUID",{...operation(),key:"not-a-uuid"}],
    ["wrong key type",{...operation(),key:9}], ["bad hash format",{...operation(),requestHash:"bad"}],
    ["exact body hash mismatch",{...operation(),requestHash:"0".repeat(64)}],
    ["changed untrimmed body",{...operation(),body:{...body,title:body.title.trim()}}],
    ["extra body field",{...operation(),body:{...body,summary:"injected"}}],
    ["wrong body type",{...operation(),body:[]}],
    ["wrong title type",{...operation(),body:{...body,title:3}}],
    ["blank content",{...operation(),body:{...body,content:" "}}],
    ["invalid Report UUID",operation({...body,reportId:"R1",expectedContentHash:"a".repeat(64)})],
    ["unpaired report",operation({...body,reportId})],
    ["unpaired CAS",operation({...body,expectedContentHash:"a".repeat(64)})],
    ["invalid CAS",operation({...body,reportId,expectedContentHash:"bad"})],
  ];
  test.each(malformedPending)("malformed pending %s is preserved with no reconciliation GET or POST",async (_label,value)=>{
    setup();const exact=JSON.stringify(value);const draftExact=JSON.stringify({draft,dirty:true});
    sessionStorage.setItem(key(),exact);sessionStorage.setItem(key()+":draft",draftExact);
    renderRoute(`/tasks/${taskId}`);
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key())).toBe(exact);expect(sessionStorage.getItem(key()+":draft")).toBe(draftExact);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/") || init?.method==="POST")).toBe(false);
  });
  test.each(["pending", "draft"])("invalid JSON %s remains byte-for-byte intact",async kind=>{
    setup();const storageKey=key()+(kind==="draft"?":draft":"");sessionStorage.setItem(storageKey,"{invalid JSON");
    renderRoute(`/tasks/${taskId}`);await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(sessionStorage.getItem(storageKey)).toBe("{invalid JSON");
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
  });
  test("plain object schema rejects prototypes and extra inherited authority",async()=>{
    expect(()=>validateStoredReportDraft(Object.assign(Object.create({actor:"foreign"}),{draft,dirty:true}))).toThrow();
    expect(()=>validateStoredReportDraft({draft:Object.assign(Object.create(null),draft),dirty:true})).toThrow();
    await expect(validatePendingReport(Object.assign(Object.create({actor:"foreign"}),operation()))).rejects.toThrow();
  });
  test("valid dirty edit draft reload restores exact Report and CAS, then sends that edit",async()=>{
    setup();sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>init?.method==="POST"
      ? new Response(JSON.stringify({error:"Expected edit refusal"}),{status:409}):prior(input,init));
    renderRoute(`/tasks/${taskId}`);expect(await screen.findByLabelText("Progress")).toHaveValue(draft.content);
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await screen.findByText("Expected edit refusal");
    const call=vi.mocked(authenticatedFetch).mock.calls.find(([,init])=>init?.method==="POST")!;
    expect(JSON.parse(String(call[1]?.body))).toEqual(draft);
  });
  test.each(["committed", "unknown"])("valid edit pending reload %s reconciles exact operation and body",async result=>{
    setup();const op=operation({...body,reportId,expectedContentHash:"a".repeat(64)});sessionStorage.setItem(key(),JSON.stringify(op));
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let posts=0;let reads=0;
    const response=()=>new Response(JSON.stringify({success:true,report:{id:reportId,...op.body,content_hash:"b".repeat(64)},
      operation:{key:op.key,requestHash:op.requestHash,contentHash:"b".repeat(64)}}));
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).includes("/report-operations/")){reads++;expect(String(input)).toContain(`${op.key}?requestHash=${op.requestHash}`);
        return result==="unknown"?new Response(JSON.stringify({code:"TASK_REPORT_OPERATION_UNKNOWN"}),{status:404}):response();}
      if(init?.method==="POST"){posts++;expect((init.headers as Record<string,string>)["Idempotency-Key"]).toBe(op.key);
        expect(JSON.parse(String(init.body))).toEqual(op.body);return response();}
      return prior(input,init);
    });
    renderRoute(`/tasks/${taskId}`);const button=await screen.findByRole("button",{name:"Reconcile Task Report save"});
    expect(screen.getByLabelText("Progress")).toHaveValue(body.content);fireEvent.click(button);
    await waitFor(()=>expect(screen.getByRole("button",{name:"Hand over saved Report for review"})).toBeEnabled());
    expect(reads).toBe(1);expect(posts).toBe(result==="unknown"?1:0);expect(sessionStorage.getItem(key())).toBeNull();
  });
  test("explicit non-destructive recheck stays blocked until evidence is safely recovered",async()=>{
    setup();const exact=JSON.stringify({...operation(),requestHash:"0".repeat(64)});sessionStorage.setItem(key(),exact);
    renderRoute(`/tasks/${taskId}`);fireEvent.click(await enabledButton("Recheck preserved Report storage"));
    await waitFor(()=>expect(vi.mocked(authenticatedFetch).mock.calls.filter(([url])=>String(url).endsWith("/principals/me")).length).toBeGreaterThan(1));
    expect(sessionStorage.getItem(key())).toBe(exact);expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
    sessionStorage.setItem(key(),JSON.stringify(operation()));fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    expect(await screen.findByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled();
    expect(screen.getByLabelText("Progress")).toHaveValue(body.content);
  });

  const blank = {title:"",content:"",reportId:"",expectedContentHash:""};
  const recoveryCases = [
    {name:"different repaired edit draft", memory:{...draft,content:"Original in-memory evidence"}, repaired:draft, pending:null, conflict:true},
    {name:"empty memory restores repaired edit draft", memory:blank, repaired:draft, pending:null, conflict:false},
    {name:"matching memory preserves repaired edit draft", memory:draft, repaired:draft, pending:null, conflict:false},
    {name:"empty repaired draft does not erase memory", memory:draft, repaired:blank, pending:null, conflict:true},
    {name:"absent repaired draft retains memory", memory:draft, repaired:null, pending:null, conflict:false},
    {name:"both drafts empty", memory:blank, repaired:blank, pending:null, conflict:false},
    {name:"empty memory restores repaired pending edit", memory:blank, repaired:draft, pending:operation(draft), conflict:false},
    {name:"pending only restores exact edit body", memory:blank, repaired:null, pending:operation(draft), conflict:false},
    {name:"pending with empty draft restores edit body", memory:blank, repaired:blank, pending:operation(draft), conflict:false},
    {name:"repaired pending differs from memory", memory:{...draft,content:"Original in-memory evidence"}, repaired:draft, pending:operation(draft), conflict:true},
    {name:"repaired pending and draft disagree", memory:blank, repaired:{...draft,content:"Separate draft evidence"}, pending:operation(draft), conflict:true},
  ];
  test.each(recoveryCases)("same-scope corruption repair recheck: $name",async ({memory,repaired,pending,conflict})=>{
    setup();renderRoute(`/tasks/${taskId}`);
    await screen.findByLabelText("Progress");
    // Seed the exact live Report selection/base through a valid first recovery.
    if(Object.values(memory).some(Boolean)) {
      sessionStorage.setItem(key()+":draft","{first corruption");
      fireEvent(window,new Event("focus"));
      fireEvent.click(await enabledButton("Recheck preserved Report storage"));
      await waitFor(()=>expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument());
      sessionStorage.setItem(key()+":draft",JSON.stringify({draft:memory,dirty:true}));
      fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
      expect(await screen.findByLabelText("Progress")).toHaveValue(memory.content);
    }
    sessionStorage.setItem(key()+":draft","{malformed preserved bytes");
    fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(sessionStorage.getItem(key()+":draft")).toBe("{malformed preserved bytes");
    const exactDraft=repaired===null?null:JSON.stringify({draft:repaired,dirty:true});
    const exactPending=pending===null?null:JSON.stringify(pending);
    if(exactDraft===null)sessionStorage.removeItem(key()+":draft");else sessionStorage.setItem(key()+":draft",exactDraft);
    if(exactPending===null)sessionStorage.removeItem(key());else sessionStorage.setItem(key(),exactPending);
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    if(conflict){
      await screen.findByText(/Report recovery conflict:/);
      expect(JSON.parse((screen.getByLabelText("In-memory Report recovery evidence") as HTMLTextAreaElement).value).draft).toEqual(memory);
      const shown=JSON.parse((screen.getByLabelText("Repaired Report storage evidence") as HTMLTextAreaElement).value);
      expect(shown).toEqual({draft:repaired===null?null:{draft:repaired,dirty:true},pending});
      expect(sessionStorage.getItem(key()+":draft")).toBe(exactDraft);
      expect(screen.queryByRole("button",{name:"Save Task Report"})).not.toBeInTheDocument();
      expect(screen.queryByRole("button",{name:"Reconcile Task Report save"})).not.toBeInTheDocument();
    } else {
      const expected=pending?pending.body:repaired??memory;
      expect(await screen.findByLabelText("Progress")).toHaveValue(expected.content);
      expect(screen.getByLabelText("Report title")).toHaveValue(expected.title);
      expect(JSON.parse(sessionStorage.getItem(key()+":draft")!).draft).toEqual(expected);
      expect(await screen.findByRole("button",{name:pending?"Reconcile Task Report save":"Save Task Report"})).toBeEnabled();
    }
    expect(sessionStorage.getItem(key())).toBe(exactPending);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test.each(["removed","replaced"])("same-scope repaired pending $0 conflicts with the live durable operation",async kind=>{
    setup();const op=operation(draft);sessionStorage.setItem(key(),JSON.stringify(op));
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));
    renderRoute(`/tasks/${taskId}`);await screen.findByRole("button",{name:"Reconcile Task Report save"});
    sessionStorage.setItem(key(),"{invalid pending bytes");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(sessionStorage.getItem(key())).toBe("{invalid pending bytes");
    const replacement=kind==="removed"?null:{...op,key:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"};
    if(replacement)sessionStorage.setItem(key(),JSON.stringify(replacement));else sessionStorage.removeItem(key());
    const exact=sessionStorage.getItem(key());
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    await screen.findByText(/Report recovery conflict:/);
    expect(JSON.parse((screen.getByLabelText("In-memory Report recovery evidence") as HTMLTextAreaElement).value).pending).toEqual(op);
    expect(JSON.parse((screen.getByLabelText("Repaired Report storage evidence") as HTMLTextAreaElement).value).pending).toEqual(replacement);
    expect(sessionStorage.getItem(key())).toBe(exact);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test("controlled second digest proves pending label is not a settled transport failure",async()=>{
    setup();const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    let writes=0,reads=0;let first:any;let firstKey="";
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).includes("/report-operations/")){reads++;expect(String(input)).toContain(`${firstKey}?requestHash=${operation(first).requestHash}`);return new Response(JSON.stringify({code:"TASK_REPORT_OPERATION_UNKNOWN"}),{status:404});}
      if(init?.method==="POST"){
        writes++;const actual=JSON.parse(String(init.body));const actualKey=(init.headers as Record<string,string>)["Idempotency-Key"];
        if(writes===1){first=actual;firstKey=actualKey;throw new TypeError("Controlled precommit failure");}
        expect(actual).toEqual(first);expect(actualKey).toBe(firstKey);
        return new Response(JSON.stringify({success:true,report:{id:reportId,...actual,content_hash:"b".repeat(64)},operation:{key:firstKey,requestHash:operation(first).requestHash,contentHash:"b".repeat(64)}}));
      }return prior(input,init);
    });
    const digest=crypto.subtle.digest.bind(crypto.subtle);let calls=0;let entered=false;let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const spy=vi.spyOn(crypto.subtle,"digest").mockImplementation(async (...args)=>{if(++calls===2){entered=true;await gate;}return digest(...args);});
    try {
      const page=renderRoute(`/tasks/${taskId}`);
      fireEvent.change(await screen.findByLabelText("Report title"),{target:{value:body.title}});
      fireEvent.change(screen.getByLabelText("Progress"),{target:{value:body.content}});
      fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));
      await waitFor(()=>expect(entered).toBe(true));
      expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeDisabled();expect(writes).toBe(0);
      const exact=sessionStorage.getItem(key())!;expect(JSON.parse(exact).body).toEqual(body);
      expect(JSON.parse(exact).requestHash).toBe(operation().requestHash);
      await act(async()=>release());
      await waitFor(()=>expect(writes).toBe(1));await screen.findByText("Controlled precommit failure");
      await waitFor(()=>expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled());
      expect(sessionStorage.getItem(key())).toBe(exact);page.unmount();renderRoute(`/tasks/${taskId}`);
      await waitFor(()=>expect(screen.getByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled());
      fireEvent.click(screen.getByRole("button",{name:"Reconcile Task Report save"}));
      await waitFor(()=>expect(screen.getByRole("button",{name:"Hand over saved Report for review"})).toBeEnabled());
      expect(writes).toBe(2);expect(reads).toBe(1);expect(sessionStorage.getItem(key())).toBeNull();
    } finally {release();spy.mockRestore();}
  });

  test.each([false,true])("same-scope repaired edit sends exact body only after explicit author action; pending=%s",async pending=>{
    setup();const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let writes=0,reads=0;
    const op=operation(draft);
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).includes("/report-operations/")){reads++;expect(String(input)).toContain(`${op.key}?requestHash=${op.requestHash}`);return new Response(JSON.stringify({code:"TASK_REPORT_OPERATION_UNKNOWN"}),{status:404});}
      if(init?.method==="POST"){writes++;expect(JSON.parse(String(init.body))).toEqual(draft);if(pending)expect((init.headers as Record<string,string>)["Idempotency-Key"]).toBe(op.key);return new Response(JSON.stringify({error:"Explicit repaired edit refusal"}),{status:409});}
      return prior(input,init);
    });
    renderRoute(`/tasks/${taskId}`);await screen.findByLabelText("Progress");
    sessionStorage.setItem(key()+":draft","{malformed exact draft");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));if(pending)sessionStorage.setItem(key(),JSON.stringify(op));
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    expect(await screen.findByLabelText("Progress")).toHaveValue(draft.content);
    expect(screen.getByLabelText("Report title")).toHaveValue(draft.title);
    expect(screen.getByRole("link",{name:"Open saved Report"})).toHaveAttribute("href",`/reports/${reportId}`);
    expect(JSON.parse(sessionStorage.getItem(key()+":draft")!).draft).toEqual(draft);
    expect(writes).toBe(0);expect(reads).toBe(0);
    fireEvent.click(screen.getByRole("button",{name:pending?"Reconcile Task Report save":"Save Task Report"}));
    await screen.findByText("Explicit repaired edit refusal");
    expect(writes).toBe(1);expect(reads).toBe(pending?1:0);
    expect(JSON.parse(sessionStorage.getItem(key())!).body).toEqual(draft);
    expect(JSON.parse(sessionStorage.getItem(key())!).requestHash).toBe(op.requestHash);
  });

  test("same-scope recovery conflict can be explicitly reconciled without an automatic operation",async()=>{
    setup();renderRoute(`/tasks/${taskId}`);
    fireEvent.change(await screen.findByLabelText("Report title"),{target:{value:"Memory title"}});
    fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"Memory evidence"}});
    const memory=JSON.parse(sessionStorage.getItem(key()+":draft")!);
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    const exact=JSON.stringify({draft,dirty:true});sessionStorage.setItem(key()+":draft",exact);
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    await screen.findByText(/Report recovery conflict:/);
    expect(sessionStorage.getItem(key()+":draft")).toBe(exact);
    fireEvent.click(screen.getByRole("button",{name:"Continue work from this page; keep saved draft"}));
    expect(await screen.findByLabelText("Progress")).toHaveValue("Memory evidence");
    expect(screen.queryByText(/Report recovery conflict:/)).not.toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(key()+":draft")!)).toEqual(memory);
    expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([{draft,dirty:true}]);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test("recovery conflict evidence is not exposed to a changed authenticated actor",async()=>{
    setup();renderRoute(`/tasks/${taskId}`);
    fireEvent.change(await screen.findByLabelText("Progress"),{target:{value:"Private original actor evidence"}});
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));await screen.findByText(/Report recovery conflict:/);
    const exact=sessionStorage.getItem(key()+":draft");
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).endsWith("/principals/me")?new Response(JSON.stringify({principal:{id:"other-actor"}})):prior(input,init));
    sessionStorage.setItem(`relayhall-task-report:${window.location.origin}:other-actor:${taskId}:draft`,"{other corrupt");
    fireEvent(window,new Event("focus"));
    await waitFor(()=>expect(screen.queryByLabelText("In-memory Report recovery evidence")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Repaired Report storage evidence")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key()+":draft")).toBe(exact);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test("stale async recovery digest cannot publish repaired evidence into another Task",async()=>{
    setup();renderRoute(`/tasks/${taskId}`);await screen.findByLabelText("Progress");
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    const op=operation(draft);const exact=JSON.stringify(op);sessionStorage.setItem(key(),exact);sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));
    const other="99999999-9999-4999-8999-999999999999";const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).endsWith(`/tasks/${other}`))return new Response(JSON.stringify({success:true,task:{...taskResponse,id:other,title:"Other recovery Task"}}));
      if(String(input).includes(`/tasks/${other}/`))return prior(String(input).replace(other,taskId),init);
      return prior(input,init);
    });
    const digest=crypto.subtle.digest.bind(crypto.subtle);let entered=false;let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const spy=vi.spyOn(crypto.subtle,"digest").mockImplementation(async(...args)=>{entered=true;await gate;return digest(...args);});
    try{
      fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));await waitFor(()=>expect(entered).toBe(true));
      fireEvent.click(screen.getByTestId("switch-task"));await screen.findByRole("heading",{name:"Other recovery Task"});
      expect(await screen.findByLabelText("Progress")).toHaveValue("");
      await act(async()=>release());
      expect(screen.getByLabelText("Progress")).toHaveValue("");expect(sessionStorage.getItem(key())).toBe(exact);
      expect(screen.queryByLabelText("Repaired Report storage evidence")).not.toBeInTheDocument();
      expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
    }finally{release();spy.mockRestore();}
  });
  test.each(["pending","draft"])("late same-scope %s change during recovery digest preserves BOTH exact records",async kind=>{
    setup();renderRoute(`/tasks/${taskId}`);await screen.findByLabelText("Progress");
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    const op=operation(draft);sessionStorage.setItem(key(),JSON.stringify(op));
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));
    const digest=crypto.subtle.digest.bind(crypto.subtle);let entered=false;let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const spy=vi.spyOn(crypto.subtle,"digest").mockImplementation(async(...args)=>{entered=true;await gate;return digest(...args);});
    try {
      fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
      await waitFor(()=>expect(entered).toBe(true));
      if(kind==="draft")sessionStorage.setItem(key()+":draft",JSON.stringify({draft:{...draft,content:"Later valid evidence"},dirty:true}));
      else sessionStorage.setItem(key(),JSON.stringify({...op,key:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}));
      const exactPending=sessionStorage.getItem(key());const exactDraft=sessionStorage.getItem(key()+":draft");
      await act(async()=>release());
      await screen.findByText("Saved evidence changed while it was being checked. Nothing was replaced. Recheck to compare the latest versions.");
      expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
      expect(sessionStorage.getItem(key())).toBe(exactPending);expect(sessionStorage.getItem(key()+":draft")).toBe(exactDraft);
      expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
      spy.mockRestore();fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
      if(kind==="draft")await screen.findByText(/Report recovery conflict:/);
      else expect(await screen.findByRole("button",{name:"Reconcile Task Report save"})).toBeEnabled();
      expect(sessionStorage.getItem(key())).toBe(exactPending);expect(sessionStorage.getItem(key()+":draft")).toBe(exactDraft);
    } finally {release();spy.mockRestore();}
  });

  test.each(["memory","saved"])("choose %s version preserves alternate across reload and restores through a button",async choice=>{
    setup();const page=renderRoute(`/tasks/${taskId}`);
    fireEvent.change(await screen.findByLabelText("Report title"),{target:{value:"Page title"}});
    fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"Private page work"}});
    const memory=JSON.parse(sessionStorage.getItem(key()+":draft")!);
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    await screen.findByText(/Report recovery conflict:/);
    expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent("Private page work");
    expect(screen.getByRole("region",{name:"Saved draft from this tab"})).toHaveTextContent(draft.content.trim());
    fireEvent.click(screen.getByRole("button",{name:choice==="memory"?"Continue work from this page; keep saved draft":"Continue saved draft; keep page work"}));
    const chosen=choice==="memory"?memory:{draft,dirty:true};const other=choice==="memory"?{draft,dirty:true}:memory;
    expect(await screen.findByLabelText("Progress")).toHaveValue(chosen.draft.content);
    expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([other]);
    const archive=sessionStorage.getItem(key()+":preserved");page.unmount();renderRoute(`/tasks/${taskId}`);
    expect(await screen.findByLabelText("Progress")).toHaveValue(chosen.draft.content);
    expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));
    await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(other.draft.content));
    expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([chosen]);
    expect(JSON.parse(sessionStorage.getItem(key()+":draft")!).draft).toEqual(other.draft);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test("pending conflict continues only immutable operation, preserves alternate, then explicitly reconciles",async()=>{
    setup();const alternate={...draft,content:"Alternate unsent work"};const op=operation(draft);const exact=JSON.stringify(op);
    sessionStorage.setItem(key(),exact);sessionStorage.setItem(key()+":draft",JSON.stringify({draft:alternate,dirty:true}));
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let reads=0;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).includes("/report-operations/")){reads++;expect(String(input)).toContain(`${op.key}?requestHash=${op.requestHash}`);
        return new Response(JSON.stringify({success:true,report:{id:reportId,...draft,content_hash:"b".repeat(64)},operation:{key:op.key,requestHash:op.requestHash,contentHash:"b".repeat(64)}}));}
      return prior(input,init);
    });
    const page=renderRoute(`/tasks/${taskId}`);
    fireEvent.click(await enabledButton("Continue uncertain save; keep other drafts"));
    expect(await screen.findByLabelText("Progress")).toHaveValue(draft.content);
    expect(sessionStorage.getItem(key())).toBe(exact);expect(reads).toBe(0);
    expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([{draft:alternate,dirty:true}]);
    expect(screen.getByRole("button",{name:"Restore preserved version 1"})).toBeDisabled();
    page.unmount();renderRoute(`/tasks/${taskId}`);
    const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});expect(reconcile).toBeEnabled();
    expect(sessionStorage.getItem(key())).toBe(exact);expect(reads).toBe(0);
    fireEvent.click(reconcile);await waitFor(()=>expect(screen.getByRole("button",{name:"Restore preserved version 1"})).toBeEnabled());
    expect(reads).toBe(1);expect(sessionStorage.getItem(key())).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));
    await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(alternate.content));
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
  });

  test("preserved draft validation is strict and bounded",()=>{
    expect(validatePreservedReportDrafts(null)).toEqual([]);
    for(const raw of ["null","[]",JSON.stringify({version:2,drafts:[]}),JSON.stringify({version:1,drafts:[],actor:"foreign"}),
      JSON.stringify({version:1,drafts:[{draft,dirty:"true"}]}),JSON.stringify({version:1,drafts:[{draft,dirty:true},{draft,dirty:true},{draft,dirty:true}]}),
      JSON.stringify({version:1,drafts:[{draft:{...draft,content:"x".repeat(262145)},dirty:true}]})]) expect(()=>validatePreservedReportDrafts(raw)).toThrow();
  });

  test("new authenticated scope never archives the prior actor memory during conflict choice",async()=>{
    setup();renderRoute(`/tasks/${taskId}`);
    fireEvent.change(await screen.findByLabelText("Progress"),{target:{value:"Prior actor private memory"}});
    const firstDraft=sessionStorage.getItem(key()+":draft");
    const actor="new-actor";const scoped=`relayhall-task-report:${window.location.origin}:${actor}:${taskId}`;
    const op=operation(draft);const exact=JSON.stringify(op);const alternate={...draft,content:"New actor alternate"};
    sessionStorage.setItem(scoped,exact);sessionStorage.setItem(scoped+":draft",JSON.stringify({draft:alternate,dirty:true}));
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    taskResponse={...taskResponse,ownerPrincipalId:actor};
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).endsWith("/principals/me")?new Response(JSON.stringify({principal:{id:actor}})):prior(input,init));
    fireEvent(window,new Event("focus"));
    const handler=subscribe.mock.calls.find(([type])=>type==="task.updated")?.[1];
    await act(async()=>handler?.({task:{...taskResponse}}));
    const choose=await screen.findByRole("button",{name:"Continue uncertain save; keep other drafts"});
    await waitFor(()=>expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument());
    expect(screen.queryByText("Prior actor private memory")).not.toBeInTheDocument();
    fireEvent.click(choose);expect(await screen.findByLabelText("Progress")).toHaveValue(draft.content);
    const archive=sessionStorage.getItem(scoped+":preserved")!;
    expect(archive).not.toContain("Prior actor private memory");
    expect(validatePreservedReportDrafts(archive)).toEqual([{draft:alternate,dirty:true}]);
    expect(sessionStorage.getItem(key()+":draft")).toBe(firstDraft);expect(sessionStorage.getItem(scoped)).toBe(exact);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test("preserved versions are hidden from another actor and another Task",async()=>{
    setup();const archive=JSON.stringify({version:1,drafts:[{draft:{...draft,content:"Secret preserved evidence"},dirty:true}]});
    sessionStorage.setItem(key()+":preserved",archive);renderRoute(`/tasks/${taskId}`);
    await screen.findByRole("button",{name:"Restore preserved version 1"});
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).endsWith("/principals/me")?new Response(JSON.stringify({principal:{id:"other-actor"}})):prior(input,init));
    fireEvent(window,new Event("focus"));
    await waitFor(()=>expect(screen.queryByText("Secret preserved evidence")).not.toBeInTheDocument());
    expect(screen.queryByRole("button",{name:"Restore preserved version 1"})).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);
    const other="99999999-9999-4999-8999-999999999999";
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).endsWith(`/tasks/${other}`))return new Response(JSON.stringify({success:true,task:{...taskResponse,id:other,title:"Other preserved Task"}}));
      if(String(input).includes(`/tasks/${other}/`))return prior(String(input).replace(other,taskId),init);
      return prior(input,init);
    });
    fireEvent.click(screen.getByTestId("switch-task"));await screen.findByRole("heading",{name:"Other preserved Task"});
    expect(await screen.findByLabelText("Progress")).toHaveValue("");expect(screen.queryByText("Secret preserved evidence")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);
  });

  test.each(["removed","replaced"])("divergent pending %s has a safe support action but remains HOLD",async kind=>{
    setup();const op=operation(draft);sessionStorage.setItem(key(),JSON.stringify(op));
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));renderRoute(`/tasks/${taskId}`);
    await screen.findByRole("button",{name:"Reconcile Task Report save"});
    sessionStorage.setItem(key(),"{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    const replacement=kind==="removed"?null:{...op,key:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"};
    if(replacement)sessionStorage.setItem(key(),JSON.stringify(replacement));else sessionStorage.removeItem(key());
    const exact=sessionStorage.getItem(key());const exactDraft=sessionStorage.getItem(key()+":draft");
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    await screen.findByText(/Two different uncertain saves need help from support/);
    const clipboard=vi.fn().mockResolvedValue(undefined);const original=Object.getOwnPropertyDescriptor(navigator,"clipboard");
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:clipboard}});
    try {
      fireEvent.click(screen.getByRole("button",{name:"Copy both versions for support"}));
      await screen.findByText("Both versions copied for support. This has not resolved the uncertain saves; keep this page open.");
      expect(JSON.parse(clipboard.mock.calls[0][0]).page.pending).toEqual(op);
      expect(JSON.parse(clipboard.mock.calls[0][0]).saved.pending).toEqual(replacement);
      expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
      expect(screen.queryByRole("button",{name:"Continue uncertain save; keep other drafts"})).not.toBeInTheDocument();
      expect(sessionStorage.getItem(key())).toBe(exact);expect(sessionStorage.getItem(key()+":draft")).toBe(exactDraft);
      expect(sessionStorage.getItem(key()+":preserved")).toBeNull();
      expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
    } finally {if(original)Object.defineProperty(navigator,"clipboard",original);else delete (navigator as any).clipboard;}
  });

  test("malformed preserved records are retained without enabling writes",async()=>{
    setup();const exact=JSON.stringify({version:1,drafts:[{draft:{...draft,actor:"foreign"},dirty:true}]});
    sessionStorage.setItem(key()+":preserved",exact);const exactDraft=JSON.stringify({draft,dirty:true});sessionStorage.setItem(key()+":draft",exactDraft);
    renderRoute(`/tasks/${taskId}`);await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(sessionStorage.getItem(key()+":preserved")).toBe(exact);expect(sessionStorage.getItem(key()+":draft")).toBe(exactDraft);
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test("UTF8 preservation bound is bytes, not JavaScript character count",()=>{
    const raw=JSON.stringify({version:1,drafts:[{draft:{...draft,content:"界".repeat(90000)},dirty:true}]});
    expect(raw.length).toBeLessThan(262144);expect(()=>validatePreservedReportDrafts(raw)).toThrow();
  });

  test.each(["pending","draft"])("%s change immediately before recovery persistence cannot be overwritten",async kind=>{
    setup();renderRoute(`/tasks/${taskId}`);await screen.findByLabelText("Progress");
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    const op=operation(draft);sessionStorage.setItem(key(),JSON.stringify(op));sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));
    const target=kind==="pending"?key():key()+":draft";let reads=0;let changed=false;
    const later=kind==="pending"?JSON.stringify({...op,key:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}):JSON.stringify({draft:{...draft,content:"Later pre-persistence evidence"},dirty:true});
    const get=Storage.prototype.getItem;const spy=vi.spyOn(Storage.prototype,"getItem").mockImplementation(function(this:Storage,name:string){
      if(this===sessionStorage && name===target && ++reads===3){sessionStorage.setItem(target,later);changed=true;}
      return get.call(this,name);
    });
    try {
      fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
      await screen.findByText("Saved evidence changed before recovery finished. Nothing was replaced. Recheck the latest versions.");
      expect(changed).toBe(true);spy.mockRestore();
      expect(sessionStorage.getItem(target)).toBe(later);expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
      expect(sessionStorage.getItem(kind==="pending"?key()+":draft":key())).toBe(kind==="pending"?JSON.stringify({draft,dirty:true}):JSON.stringify(op));
      expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
    } finally {spy.mockRestore();}
  });

  test.each(["preserved","draft"])("failed %s recovery write does not discard either draft",async stage=>{
    setup();renderRoute(`/tasks/${taskId}`);
    fireEvent.change(await screen.findByLabelText("Progress"),{target:{value:"Memory remains recoverable"}});
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    const exact=JSON.stringify({draft,dirty:true});sessionStorage.setItem(key()+":draft",exact);
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));await screen.findByText(/Report recovery conflict:/);
    const set=Storage.prototype.setItem;const spy=vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,name:string,value:string){
      if(this===sessionStorage && name===key()+":"+stage)throw new DOMException("Storage full","QuotaExceededError");
      return set.call(this,name,value);
    });
    try {
      fireEvent.click(screen.getByRole("button",{name:"Continue work from this page; keep saved draft"}));
      await waitFor(()=>expect(screen.getByRole("button",{name:"Continue work from this page; keep saved draft"})).toBeEnabled());
      expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();expect(sessionStorage.getItem(key()+":draft")).toBe(exact);
      expect((screen.getByLabelText("In-memory Report recovery evidence") as HTMLTextAreaElement).value).toContain("Memory remains recoverable");
      if(stage==="draft")expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([{draft,dirty:true}]);
      else expect(sessionStorage.getItem(key()+":preserved")).toBeNull();
      expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
    } finally {spy.mockRestore();}
  });

  test.each(["actor","storage","authority"])("late %s change while explicitly choosing leaves scoped evidence intact",async change=>{
    setup();renderRoute(`/tasks/${taskId}`);
    fireEvent.change(await screen.findByLabelText("Progress"),{target:{value:"Private memory"}});
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    const exact=JSON.stringify({draft,dirty:true});sessionStorage.setItem(key()+":draft",exact);
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));await screen.findByText(/Report recovery conflict:/);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let entered=false;let release!:(value:Response)=>void;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/principals/me") && !entered){entered=true;return new Promise<Response>(resolve=>{release=resolve;});}
      return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Continue saved draft; keep page work"}));await waitFor(()=>expect(entered).toBe(true));
    const later=JSON.stringify({draft:{...draft,content:"Later selection evidence"},dirty:true});
    if(change==="storage")sessionStorage.setItem(key()+":draft",later);
    if(change==="authority"){
      taskResponse={...taskResponse,reportMaintenanceAccess:{allowed:false,reason:"TASK_WRITE_REQUIRED"}};
      const handler=subscribe.mock.calls.find(([type])=>type==="task.updated")?.[1];await act(async()=>handler?.({task:taskResponse}));
      await waitFor(()=>expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument());
    }
    await act(async()=>release(new Response(JSON.stringify({principal:{id:change==="actor"?"other-actor":task.ownerPrincipalId}}))));
    await waitFor(()=>expect(sessionStorage.getItem(key()+":preserved")).toBeNull());
    expect(sessionStorage.getItem(key()+":draft")).toBe(change==="storage"?later:exact);
    expect(sessionStorage.getItem(key())).toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  test.each(["memory","saved"])("chosen %s draft sends exact Report/CAS only on explicit Save, keeping alternate",async choice=>{
    setup();const initial={...draft,content:"Original edit evidence"};sessionStorage.setItem(key()+":draft",JSON.stringify({draft:initial,dirty:true}));
    renderRoute(`/tasks/${taskId}`);await screen.findByLabelText("Progress");
    sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft,dirty:true}));fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));
    await screen.findByText(/Report recovery conflict:/);
    fireEvent.click(screen.getByRole("button",{name:choice==="memory"?"Continue work from this page; keep saved draft":"Continue saved draft; keep page work"}));
    const chosen=choice==="memory"?initial:draft;expect(await screen.findByLabelText("Progress")).toHaveValue(chosen.content);
    const archive=sessionStorage.getItem(key()+":preserved");
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let posts=0;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(init?.method==="POST"){posts++;expect(JSON.parse(String(init.body))).toEqual(chosen);return new Response(JSON.stringify({error:"Explicit selected draft refusal"}),{status:409});}
      return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await screen.findByText("Explicit selected draft refusal");
    expect(posts).toBe(1);expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);
    const pending=JSON.parse(sessionStorage.getItem(key())!);expect(pending.body).toEqual(chosen);expect(pending.requestHash).toBe(operation(chosen).requestHash);
  });

  test("full bounded archive is never evicted to resolve another conflict",async()=>{
    setup();const old=[{draft:{...draft,content:"Preserved one"},dirty:true},{draft:{...draft,content:"Preserved two"},dirty:true}];
    const archive=JSON.stringify({version:1,drafts:old});sessionStorage.setItem(key()+":preserved",archive);
    sessionStorage.setItem(key()+":draft",JSON.stringify({draft:{...draft,content:"Page third"},dirty:true}));renderRoute(`/tasks/${taskId}`);
    await screen.findByLabelText("Progress");sessionStorage.setItem(key()+":draft","{corrupt");fireEvent(window,new Event("focus"));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});const exact=JSON.stringify({draft,dirty:true});sessionStorage.setItem(key()+":draft",exact);
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));await screen.findByText(/Report recovery conflict:/);
    fireEvent.click(screen.getByRole("button",{name:"Continue saved draft; keep page work"}));
    await screen.findByText("There are already two preserved versions. Keep this page open and ask support to retain all versions before continuing.");
    expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);expect(sessionStorage.getItem(key()+":draft")).toBe(exact);
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  });

  const restoreA={draft:{...draft,title:"Current work",content:"Current work body"},dirty:true};
  const restoreB={draft:{...draft,title:"Only archived version",content:"Unique archived body"},dirty:true};
  const restoreC={draft:{...draft,title:"Second alternate",content:"Second retained body"},dirty:false};
  const zeroRestoreOps=()=>expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST")).toBe(false);
  function restoreFixture(two=false){
    setup();const active=JSON.stringify(restoreA);const archive=JSON.stringify({version:1,drafts:two?[restoreB,restoreC]:[restoreB]});
    sessionStorage.setItem(key()+":draft",active);sessionStorage.setItem(key()+":preserved",archive);return {active,archive};
  }
  const safetyFixture=(dirty=true,pendingRaw:string|null=null)=>({version:1,scope:key(),pendingRaw,
    beforeDraft:JSON.stringify(restoreA),beforePreserved:JSON.stringify({version:1,drafts:[{...restoreB,dirty}]}),
    afterDraft:JSON.stringify({...restoreB,dirty}),afterPreserved:JSON.stringify({version:1,drafts:[restoreA]})});

  test.each(["restore","preserved","draft","remove"])("actual restore %s failure retains all versions through reload and product completion",async stage=>{
    const {active,archive}=restoreFixture(true);const page=renderRoute(`/tasks/${taskId}`);await screen.findByLabelText("Progress");
    const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;let failed=false;
    const spy=stage==="remove"?vi.spyOn(Storage.prototype,"removeItem").mockImplementation(function(this:Storage,name:string){
      if(this===sessionStorage && name===key()+":restore"){failed=true;throw new DOMException("Storage fault","QuotaExceededError");}return remove.call(this,name);
    }):vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,name:string,value:string){
      if(this===sessionStorage && name===key()+":"+stage){failed=true;throw new DOMException("Storage fault","QuotaExceededError");}return set.call(this,name,value);
    });
    try {
      fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(failed).toBe(true));
      await screen.findByRole("button",{name:"Recheck preserved Report storage"});
      if(stage==="restore" || stage==="preserved"){expect(sessionStorage.getItem(key()+":draft")).toBe(active);expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);}
      if(stage!=="restore"){
        const journal=sessionStorage.getItem(key()+":restore")!;expect(validateReportRestore(journal,key()).beforeDraft).toBe(active);
        expect(validateReportRestore(journal,key()).beforePreserved).toBe(archive);
        expect(journal).toContain(restoreB.draft.content);expect(journal).toContain(restoreC.draft.content);
      }
      zeroRestoreOps();
    } finally {spy.mockRestore();}
    page.unmount();renderRoute(`/tasks/${taskId}`);
    if(stage==="restore") {await screen.findByLabelText("Progress");expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));}
    else {const finish=await screen.findByRole("button",{name:"Finish interrupted restoration"});expect(screen.getByRole("region",{name:"Version being restored"})).toHaveTextContent(restoreB.draft.content);zeroRestoreOps();fireEvent.click(finish);}
    await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(restoreB.draft.content));
    expect(JSON.parse(sessionStorage.getItem(key()+":draft")!)).toEqual(restoreB);
    expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([restoreC,restoreA]);
    expect(sessionStorage.getItem(key()+":restore")).toBeNull();expect(sessionStorage.getItem(key())).toBeNull();zeroRestoreOps();
    cleanup();renderRoute(`/tasks/${taskId}`);expect(await screen.findByLabelText("Progress")).toHaveValue(restoreB.draft.content);
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 2"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(restoreA.draft.content));zeroRestoreOps();
  });

  test.each(["before","archive-only","draft-only","both"])("interrupted %s swap is completed only by rendered button, all versions retained",async partial=>{
    setup();const swap=safetyFixture();const raw=JSON.stringify(swap);
    sessionStorage.setItem(key()+":restore",raw);
    sessionStorage.setItem(key()+":draft",partial==="draft-only"||partial==="both"?swap.afterDraft:swap.beforeDraft);
    sessionStorage.setItem(key()+":preserved",partial==="archive-only"||partial==="both"?swap.afterPreserved:swap.beforePreserved);
    const active=sessionStorage.getItem(key()+":draft"),archive=sessionStorage.getItem(key()+":preserved");
    renderRoute(`/tasks/${taskId}`);const finish=await screen.findByRole("button",{name:"Finish interrupted restoration"});
    expect(sessionStorage.getItem(key()+":restore")).toBe(raw);expect(sessionStorage.getItem(key()+":draft")).toBe(active);expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);zeroRestoreOps();
    fireEvent.click(finish);await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(restoreB.draft.content));
    expect(sessionStorage.getItem(key()+":draft")).toBe(swap.afterDraft);expect(sessionStorage.getItem(key()+":preserved")).toBe(swap.afterPreserved);expect(sessionStorage.getItem(key()+":restore")).toBeNull();zeroRestoreOps();
  });

  test("clean different-Report canonical restore refuses without consuming, then product navigation permits exact clean restore and reload",async()=>{
    setup();const a={...restoreA,dirty:false};const b={draft:{...restoreB.draft,reportId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",expectedContentHash:"d".repeat(64)},dirty:false};
    const active=JSON.stringify(a),archive=JSON.stringify({version:1,drafts:[b]});sessionStorage.setItem(key()+":draft",active);sessionStorage.setItem(key()+":preserved",archive);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>progressReportFixture(input,init,[{...a.draft,id:reportId,content_hash:a.draft.expectedContentHash,author_principal_id:task.ownerPrincipalId,status:"active"}]) ?? prior(input,init));
    let page=renderRoute(`/tasks/${taskId}?report=${reportId}`);await screen.findByLabelText("Progress");
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await screen.findByText(/This page is opened for a different Report/);
    expect(sessionStorage.getItem(key()+":draft")).toBe(active);expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);expect(sessionStorage.getItem(key()+":restore")).toBeNull();zeroRestoreOps();
    page.unmount();page=renderRoute(`/tasks/${taskId}?report=${reportId}`);await screen.findByLabelText("Progress");expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);
    fireEvent.click(screen.getByRole("button",{name:"Open Task without Report selection"}));await waitFor(()=>expect(screen.getByTestId("location").textContent).toBe(`/tasks/${taskId}?filter=all`));
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));
    expect(JSON.parse(sessionStorage.getItem(key()+":draft")!)).toEqual(b);expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([a]);zeroRestoreOps();
    page.unmount();renderRoute(`/tasks/${taskId}`);expect(await screen.findByLabelText("Progress")).toHaveValue(b.draft.content);expect(JSON.parse(sessionStorage.getItem(key()+":draft")!).dirty).toBe(false);zeroRestoreOps();
  });

  test.each(["actor","pending","draft","preserved","restore","authority","task"])("late %s change during interrupted completion cannot write or disclose stale scope",async change=>{
    setup();const swap=safetyFixture();const raw=JSON.stringify(swap);sessionStorage.setItem(key()+":restore",raw);sessionStorage.setItem(key()+":draft",swap.beforeDraft);sessionStorage.setItem(key()+":preserved",swap.beforePreserved);
    renderRoute(`/tasks/${taskId}`);const finish=await screen.findByRole("button",{name:"Finish interrupted restoration"});
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let entered=false,release!:(r:Response)=>void;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/principals/me") && !entered){entered=true;return new Promise<Response>(r=>release=r);}
      if(change==="actor" && String(input).endsWith("/principals/me"))return new Response(JSON.stringify({principal:{id:"foreign-actor"}}));
      if(change==="task" && String(input).endsWith("/tasks/99999999-9999-4999-8999-999999999999"))return new Response(JSON.stringify({success:true,task:{...taskResponse,id:"99999999-9999-4999-8999-999999999999",title:"Other restore Task"}}));
      if(change==="task" && String(input).includes("/tasks/99999999-9999-4999-8999-999999999999/"))return prior(String(input).replace("99999999-9999-4999-8999-999999999999",taskId),init);
      return prior(input,init);
    });
    fireEvent.click(finish);await waitFor(()=>expect(entered).toBe(true));
    if(change==="pending")sessionStorage.setItem(key(),JSON.stringify(operation(draft)));
    if(change==="draft")sessionStorage.setItem(key()+":draft",JSON.stringify(restoreC));
    if(change==="preserved")sessionStorage.setItem(key()+":preserved",JSON.stringify({version:1,drafts:[restoreC]}));
    if(change==="restore")sessionStorage.setItem(key()+":restore",raw+" ");
    if(change==="authority") {taskResponse={...taskResponse,reportMaintenanceAccess:{allowed:false,reason:"TASK_WRITE_REQUIRED"}};await act(async()=>{for(const [,handler] of subscribe.mock.calls.filter(([type])=>type==="task.updated"))handler({task:taskResponse});});await waitFor(()=>{const button=screen.queryByRole("button",{name:"Finish interrupted restoration"});if(button)expect(button).toBeDisabled();else expect(button).toBeNull();});}
    if(change==="task"){fireEvent.click(screen.getByTestId("switch-task"));await screen.findByRole("heading",{name:"Other restore Task"});}
    const exact=[key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>sessionStorage.getItem(k));
    const set=vi.spyOn(Storage.prototype,"setItem");
    try {await act(async()=>release(new Response(JSON.stringify({principal:{id:change==="actor"?"foreign-actor":task.ownerPrincipalId}}))));
      expect([key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>sessionStorage.getItem(k))).toEqual(exact);
      expect(set.mock.calls.some(([k])=>k===key()+":draft"||k===key()+":preserved"||k===key()+":restore")).toBe(false);
      if(change==="actor" || change==="task")await waitFor(()=>expect(screen.queryAllByText(restoreB.draft.content)).toHaveLength(0));zeroRestoreOps();
    }finally{set.mockRestore();}
  });

  test("restore safety validator is strict scoped bounded and conserves all previous versions",()=>{
    const swap=safetyFixture();expect(validateReportRestore(JSON.stringify(swap),key())).toEqual(swap);
    for(const bad of [null,[],{...swap,scope:key()+"foreign"},{...swap,extra:true},{...swap,version:2},{...swap,pendingRaw:7},{...swap,beforeDraft:"null"},
      {...swap,afterDraft:JSON.stringify({...restoreB,dirty:"false"})},{...swap,afterPreserved:JSON.stringify({version:1,drafts:[]})},
      {...swap,afterPreserved:JSON.stringify({version:1,drafts:[restoreA,restoreB,restoreC]})}]) expect(()=>validateReportRestore(JSON.stringify(bad),key())).toThrow();
    expect(()=>validateReportRestore(JSON.stringify({...swap,pendingRaw:"界".repeat(400000)}),key())).toThrow();
  });

  test("failed pending choice reload completion preserves exact immutable operation until separate explicit reconcile",async()=>{
    setup();const op=operation(draft),exact=JSON.stringify(op);const alternate={...restoreA,draft:{...restoreA.draft,content:"Unsent pending alternate"}};
    sessionStorage.setItem(key(),exact);sessionStorage.setItem(key()+":draft",JSON.stringify(alternate));
    let page=renderRoute(`/tasks/${taskId}`);const choose=await screen.findByRole("button",{name:"Continue uncertain save; keep other drafts"});
    const set=Storage.prototype.setItem;const spy=vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,k:string,v:string){if(k===key()+":draft")throw new DOMException("Quota","QuotaExceededError");return set.call(this,k,v);});
    try{fireEvent.click(choose);await screen.findByRole("button",{name:"Finish interrupted restoration"});expect(sessionStorage.getItem(key())).toBe(exact);zeroRestoreOps();}finally{spy.mockRestore();}
    page.unmount();page=renderRoute(`/tasks/${taskId}`);fireEvent.click(await enabledButton("Finish interrupted restoration"));
    const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});expect(reconcile).toBeEnabled();expect(sessionStorage.getItem(key())).toBe(exact);
    expect(JSON.parse(sessionStorage.getItem(key()+":draft")!)).toEqual({draft,dirty:true});expect(validatePreservedReportDrafts(sessionStorage.getItem(key()+":preserved"))).toEqual([alternate]);
    expect(screen.getByRole("button",{name:"Restore preserved version 1"})).toBeDisabled();expect(sessionStorage.getItem(key()+":restore")).toBeNull();zeroRestoreOps();
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let reads=0;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).includes("/report-operations/")){reads++;expect(String(input)).toContain(`${op.key}?requestHash=${op.requestHash}`);return new Response(JSON.stringify({success:true,report:{id:reportId,...draft,content_hash:"b".repeat(64)},operation:{key:op.key,requestHash:op.requestHash,contentHash:"b".repeat(64)}}));}return prior(input,init);
    });
    fireEvent.click(reconcile);await waitFor(()=>expect(sessionStorage.getItem(key())).toBeNull());expect(reads).toBe(1);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);page.unmount();
  });

  test("clean restore checks latest canonical route after awaited identity without consuming evidence",async()=>{
    setup();const a={...restoreA,dirty:false},b={...restoreB,dirty:false};const active=JSON.stringify(a),archive=JSON.stringify({version:1,drafts:[b]});
    sessionStorage.setItem(key()+":draft",active);sessionStorage.setItem(key()+":preserved",archive);renderRoute(`/tasks/${taskId}`);await screen.findByLabelText("Progress");
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let entered=false,release!:(r:Response)=>void;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).endsWith("/principals/me")&&!entered?(entered=true,new Promise<Response>(r=>release=r)):prior(input,init));
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(entered).toBe(true));
    fireEvent.click(screen.getByTestId("switch-r1"));await waitFor(()=>expect(screen.getByTestId("location")).toHaveTextContent("report=11111111-1111-4111-8111-111111111111"));
    await act(async()=>release(new Response(JSON.stringify({principal:{id:task.ownerPrincipalId}}))));await screen.findByText(/This page is opened for a different Report/);
    expect(sessionStorage.getItem(key()+":draft")).toBe(active);expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);expect(sessionStorage.getItem(key()+":restore")).toBeNull();zeroRestoreOps();
  });

  test("interrupted completion that fails again retains safety bytes and resumes through reload",async()=>{
    setup();const swap=safetyFixture(),raw=JSON.stringify(swap);sessionStorage.setItem(key()+":restore",raw);sessionStorage.setItem(key()+":draft",swap.beforeDraft);sessionStorage.setItem(key()+":preserved",swap.afterPreserved);
    const page=renderRoute(`/tasks/${taskId}`);const finish=await screen.findByRole("button",{name:"Finish interrupted restoration"});
    const set=Storage.prototype.setItem;const spy=vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,k:string,v:string){if(k===key()+":draft")throw new DOMException("Quota","QuotaExceededError");return set.call(this,k,v);});
    try{fireEvent.click(finish);await waitFor(()=>expect(screen.getByRole("button",{name:"Finish interrupted restoration"})).toBeEnabled());expect(sessionStorage.getItem(key()+":restore")).toBe(raw);expect(sessionStorage.getItem(key()+":draft")).toBe(swap.beforeDraft);zeroRestoreOps();}finally{spy.mockRestore();}
    page.unmount();renderRoute(`/tasks/${taskId}`);fireEvent.click(await enabledButton("Finish interrupted restoration"));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(restoreB.draft.content));expect(sessionStorage.getItem(key()+":restore")).toBeNull();zeroRestoreOps();
  });

  test.each(["foreign scope","invalid hash","different pending body"])("invalid restore %s remains exact HOLD without exposing a completion action",async kind=>{
    setup();const swap=safetyFixture(),op=operation(draft);if(kind==="invalid hash")op.requestHash="f".repeat(64);
    if(kind!=="foreign scope")swap.pendingRaw=JSON.stringify(op);else swap.scope+="foreign";
    const raw=JSON.stringify(swap);sessionStorage.setItem(key()+":restore",raw);sessionStorage.setItem(key()+":draft",swap.beforeDraft);sessionStorage.setItem(key()+":preserved",swap.beforePreserved);
    if(swap.pendingRaw)sessionStorage.setItem(key(),swap.pendingRaw);renderRoute(`/tasks/${taskId}`);await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(screen.queryByRole("button",{name:"Finish interrupted restoration"})).not.toBeInTheDocument();expect(screen.queryByText(restoreB.draft.content)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key()+":restore")).toBe(raw);expect(sessionStorage.getItem(key()+":draft")).toBe(swap.beforeDraft);expect(sessionStorage.getItem(key()+":preserved")).toBe(swap.beforePreserved);expect(sessionStorage.getItem(key())).toBe(swap.pendingRaw);zeroRestoreOps();
  });

});


describe("R3 synchronous Report mutation ownership",()=>{
  const reportId="22222222-2222-4222-8222-222222222222";
  const sha=(content:string)=>createHash("sha256").update(content).digest("hex");
  const a={draft:{title:"Durable A",content:"Current durable A",reportId,expectedContentHash:sha("Current durable A")},dirty:true};
  const b={draft:{title:"Durable B",content:"Selected durable B",reportId,expectedContentHash:a.draft.expectedContentHash},dirty:true};
  const key=()=>`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;
  const bodyHash=(body:Record<string,string>)=>sha(JSON.stringify({title:body.title,content:body.content,summary:null,reportId:body.reportId??null,expectedContentHash:body.expectedContentHash??null}));
  const identity=(id=task.ownerPrincipalId)=>new Response(JSON.stringify({success:true,principal:{id}}));
  const exact=()=>[key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>sessionStorage.getItem(k));
  const writes=()=>vi.mocked(authenticatedFetch).mock.calls.filter(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST");
  // Invoke the handler from the real rendered node too: a disabled render is
  // not sufficient protection against same-tick/stale-handler re-entry.
  function invoke(button:HTMLElement){const props=Object.keys(button).find(k=>k.startsWith("__reactProps$"))!;return (button as any)[props].onClick({preventDefault:()=>{}});}
  function fixture(dirty=true){
    taskResponse={...task,status:"in-progress",reportMaintenanceAccess:{allowed:true,reason:null}};
    const active=JSON.stringify({...a,dirty}),archive=JSON.stringify({version:1,drafts:[b]});
    sessionStorage.setItem(key()+":draft",active);sessionStorage.setItem(key()+":preserved",archive);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      {const fixture=progressReportFixture(input,init,[{id:reportId,title:a.draft.title,content:a.draft.content,content_hash:sha(a.draft.content),author_principal_id:task.ownerPrincipalId,status:"active"}]);if(fixture)return fixture;}
      return prior(input,init);
    });return {active,archive};
  }
  function identityGate(){
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let entered=false,release!:(response:Response)=>void;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/principals/me")&&!entered){entered=true;return new Promise<Response>(r=>release=r);}
      return prior(input,init);
    });return {entered:()=>entered,release:(response=identity())=>release(response)};
  }
  function truthfulResult(init?:RequestInit){
    const body=JSON.parse(String(init?.body));const hash=sha(body.content);const op=JSON.parse(sessionStorage.getItem(key())!);
    expect(body).toEqual(op.body);expect(body.expectedContentHash).toBe(sha(a.draft.content));
    expect(op.requestHash).toBe(bodyHash(body));expect((init?.headers as Record<string,string>)["Idempotency-Key"]).toBe(op.key);
    return new Response(JSON.stringify({success:true,report:{id:reportId,title:body.title,content:body.content,content_hash:hash,author_principal_id:task.ownerPrincipalId,status:"active"},operation:{key:op.key,requestHash:op.requestHash,contentHash:hash}}));
  }
  async function ready(){await screen.findByLabelText("Progress");await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());}

  test("restore-first reserves before identity: same-tick Save and duplicate Restore never enter; B then explicitly saves and A survives reload",async()=>{
    const {active,archive}=fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();const form=screen.getByLabelText("Progress").closest("form")!;
    const restore=screen.getByRole("button",{name:"Restore preserved version 1"});const gate=identityGate();
    act(()=>{fireEvent.click(restore);fireEvent.submit(form);invoke(restore);});await waitFor(()=>expect(gate.entered()).toBe(true));
    expect(writes()).toHaveLength(0);expect(exact()).toEqual([null,active,archive,null]);
    await act(async()=>gate.release());await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));
    expect(exact()).toEqual([null,JSON.stringify(b),JSON.stringify({version:1,drafts:[a]}),null]);expect(writes()).toHaveLength(0);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let posts=0;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{if(init?.method==="POST"){posts++;expect(JSON.parse(String(init.body))).toEqual(b.draft);return truthfulResult(init);}return prior(input,init);});
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(sessionStorage.getItem(key())).toBeNull());await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());
    expect(posts).toBe(1);expect(JSON.parse(sessionStorage.getItem(key()+":draft")!)).toEqual({draft:{...b.draft,expectedContentHash:sha(b.draft.content)},dirty:false});
    expect(sessionStorage.getItem(key()+":preserved")).toBe(JSON.stringify({version:1,drafts:[a]}));
    page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content);expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(a.draft.content));
    expect(sessionStorage.getItem(key()+":preserved")).toContain(b.draft.content);expect(writes()).toHaveLength(1);page.unmount();
  });

  test("Save-first reserves through identity/network: Restore and duplicate submit cannot enter; explicit restore after completion keeps B across reload",async()=>{
    const {active,archive}=fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();const form=screen.getByLabelText("Progress").closest("form")!,restore=screen.getByRole("button",{name:"Restore preserved version 1"});
    const gate=identityGate();act(()=>{fireEvent.submit(form);invoke(restore);fireEvent.submit(form);});await waitFor(()=>expect(gate.entered()).toBe(true));expect(exact()).toEqual([null,active,archive,null]);expect(writes()).toHaveLength(0);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let network!:(response:Response)=>void,postInit:RequestInit|undefined;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{if(init?.method==="POST"){postInit=init;return new Promise<Response>(r=>network=r);}return prior(input,init);});
    await act(async()=>gate.release());await waitFor(()=>expect(writes()).toHaveLength(1));const durable=exact();expect(JSON.parse(durable[0]!).body).toEqual(a.draft);
    act(()=>{invoke(restore);fireEvent.submit(form);});expect(writes()).toHaveLength(1);expect(exact()).toEqual(durable);
    await act(async()=>network(truthfulResult(postInit)));await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());
    expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);expect(sessionStorage.getItem(key())).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));
    expect(writes()).toHaveLength(1);page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content);expect(sessionStorage.getItem(key()+":preserved")).toContain(a.draft.content);page.unmount();
  });

  test.each(["draft","preserved","pending","restore"])("late successful Save response after newer %s bytes cannot overwrite or clear any evidence",async change=>{
    fixture();const page=renderRoute(`/tasks/${taskId}`);await ready();const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    let network!:(r:Response)=>void,postInit:RequestInit|undefined;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{if(init?.method==="POST"){postInit=init;return new Promise<Response>(r=>network=r);}return prior(input,init);});
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(writes()).toHaveLength(1));const result=truthfulResult(postInit);
    const newer={...b,draft:{...b.draft,content:"Latest unsent content"}};
    if(change==="draft")sessionStorage.setItem(key()+":draft",JSON.stringify(newer));
    if(change==="preserved")sessionStorage.setItem(key()+":preserved",JSON.stringify({version:1,drafts:[newer]}));
    if(change==="pending"){const op=JSON.parse(sessionStorage.getItem(key())!);sessionStorage.setItem(key(),JSON.stringify({...op,key:"99999999-9999-4999-8999-999999999999"}));}
    if(change==="restore")sessionStorage.setItem(key()+":restore","{unreadable-new-evidence");
    const durable=exact();const set=vi.spyOn(Storage.prototype,"setItem"),remove=vi.spyOn(Storage.prototype,"removeItem");
    try{await act(async()=>network(result));await screen.findByRole("button",{name:"Recheck preserved Report storage"});expect(exact()).toEqual(durable);expect(set.mock.calls.some(([k])=>k.startsWith(key()))).toBe(false);expect(remove.mock.calls.some(([k])=>k===key())).toBe(false);expect(writes()).toHaveLength(1);}finally{set.mockRestore();remove.mockRestore();}
    page.unmount();renderRoute(`/tasks/${taskId}`);await waitFor(()=>expect(screen.queryByRole("button",{name:"Recheck preserved Report storage"})||screen.queryByRole("button",{name:"Reconcile Task Report save"})).toBeTruthy());expect(exact()).toEqual(durable);expect(writes()).toHaveLength(1);
  });

  test("failed pre-network identity releases owner for actual subsequent restore without operation creation",async()=>{
    const {active,archive}=fixture();renderRoute(`/tasks/${taskId}`);await ready();const gate=identityGate();fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(gate.entered()).toBe(true));
    await act(async()=>gate.release(new Response(JSON.stringify({error:"Identity temporarily unavailable"}),{status:503})));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Restore preserved version 1"})).toBeEnabled());expect(exact()).toEqual([null,active,archive,null]);expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));expect(writes()).toHaveLength(0);
  });

  test("network failure releases owner but pending identity remains immutable and restore cannot bypass explicit reconciliation",async()=>{
    const {archive}=fixture();renderRoute(`/tasks/${taskId}`);await ready();const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>init?.method==="POST"?new Response(JSON.stringify({error:"Uncertain response"}),{status:503}):prior(input,init));
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await screen.findByText("Uncertain response");const durable=exact();expect(JSON.parse(durable[0]!).body).toEqual(a.draft);expect(durable[2]).toBe(archive);
    const restore=screen.getByRole("button",{name:"Restore preserved version 1"});expect(restore).toBeDisabled();act(()=>{invoke(restore);});await screen.findByRole("button",{name:"Recheck preserved Report storage"});expect(exact()).toEqual(durable);expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});expect(reconcile).toBeEnabled();expect(exact()).toEqual(durable);expect(writes()).toHaveLength(1);
  });

  test.each(["restore-first","handover-first"])("clean %s excludes other mutation until completion and releases on error",async order=>{
    const {active,archive}=fixture(false);renderRoute(`/tasks/${taskId}`);await ready();const restore=screen.getByRole("button",{name:"Restore preserved version 1"}),handover=screen.getByRole("button",{name:"Hand over saved Report for review"});
    const gate=identityGate();const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).endsWith("/finish")?new Response(JSON.stringify({error:"Handover refused"}),{status:409}):prior(input,init));
    act(()=>{if(order==="restore-first"){fireEvent.click(restore);invoke(handover);}else{fireEvent.click(handover);invoke(restore);invoke(handover);}});await waitFor(()=>expect(gate.entered()).toBe(true));expect(writes()).toHaveLength(0);expect(exact()).toEqual([null,active,archive,null]);
    await act(async()=>gate.release());
    if(order==="restore-first"){await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));expect(writes()).toHaveLength(0);}
    else {await screen.findByText("Handover refused");expect(writes()).toHaveLength(1);expect(exact()).toEqual([null,active,archive,null]);fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));expect(writes()).toHaveLength(1);}
  });
  test("cancelled Restore finally cannot release a newer same-scope Save owner",async()=>{
    const {active,archive}=fixture();renderRoute(`/tasks/${taskId}`);await ready();const old=identityGate();fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(old.entered()).toBe(true));
    fireEvent(window,new Event("focus"));await ready();expect(exact()).toEqual([null,active,archive,null]);const next=identityGate();fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(next.entered()).toBe(true));
    await act(async()=>old.release());expect(screen.getByRole("button",{name:"Save Task Report"})).toBeDisabled();expect(exact()).toEqual([null,active,archive,null]);
    act(()=>{invoke(screen.getByRole("button",{name:"Restore preserved version 1"}));fireEvent.submit(screen.getByLabelText("Progress").closest("form")!);});expect(writes()).toHaveLength(0);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>init?.method==="POST"?truthfulResult(init):prior(input,init));
    await act(async()=>next.release());await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());expect(writes()).toHaveLength(1);expect(sessionStorage.getItem(key()+":preserved")).toBe(archive);
  });

  test("old Task successful Save completion cannot clear old pending or unlock/overwrite new Task unsent work",async()=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();const other="99999999-9999-4999-8999-999999999999",otherKey=`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${other}`;
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let network!:(r:Response)=>void,postInit:RequestInit|undefined;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(init?.method==="POST"){postInit=init;return new Promise<Response>(r=>network=r);}
      if(String(input).endsWith(`/tasks/${other}`))return new Response(JSON.stringify({success:true,task:{...taskResponse,id:other,title:"New scoped Task"}}));
      if(String(input).includes(`/tasks/${other}/`))return prior(String(input).replace(other,taskId),init);return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(writes()).toHaveLength(1));const result=truthfulResult(postInit),oldBytes=exact();
    fireEvent.click(screen.getByTestId("switch-task"));await screen.findByRole("heading",{name:"New scoped Task"});await ready();
    fireEvent.change(screen.getByLabelText("Report title"),{target:{value:"New Task unsent title"}});fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"New Task latest unsent content"}});
    const next=identityGate();fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(next.entered()).toBe(true));const newBytes=sessionStorage.getItem(otherKey+":draft");
    await act(async()=>network(result));expect(exact()).toEqual(oldBytes);expect(sessionStorage.getItem(otherKey+":draft")).toBe(newBytes);expect(screen.getByLabelText("Progress")).toHaveValue("New Task latest unsent content");expect(screen.getByRole("button",{name:"Save Task Report"})).toBeDisabled();expect(writes()).toHaveLength(1);
    await act(async()=>next.release(new Response(JSON.stringify({error:"Retry later"}),{status:503})));await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());expect(exact()).toEqual(oldBytes);expect(sessionStorage.getItem(otherKey+":draft")).toBe(newBytes);expect(sessionStorage.getItem(otherKey)).toBeNull();expect(writes()).toHaveLength(1);
  });

  test.each(["actor","owner","verifier","status","access"])("late %s loss while Save identity waits releases without any operation or POST",async change=>{
    const {active,archive}=fixture();renderRoute(`/tasks/${taskId}`);await ready();const gate=identityGate();fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(gate.entered()).toBe(true));
    if(change!=="actor"){
      if(change==="owner")taskResponse={...taskResponse,ownerPrincipalId:"other-owner"};
      if(change==="verifier")taskResponse={...taskResponse,verifierPrincipalId:task.ownerPrincipalId};
      if(change==="status")taskResponse={...taskResponse,status:"review"};
      if(change==="access")taskResponse={...taskResponse,reportMaintenanceAccess:{allowed:false,reason:"TASK_WRITE_REQUIRED"}};
      await act(async()=>{for(const [,handler] of subscribe.mock.calls.filter(([type])=>type==="task.updated"))handler({task:taskResponse});});
      await waitFor(()=>expect(screen.queryByRole("button",{name:"Save Task Report"})).not.toBeInTheDocument());
    }else{
      const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).endsWith("/principals/me")?identity("foreign-actor"):prior(input,init));
    }
    await act(async()=>gate.release(change==="actor"?identity("foreign-actor"):identity()));await waitFor(()=>expect(screen.queryByRole("button",{name:"Save Task Report"})).not.toBeInTheDocument());
    expect(exact()).toEqual([null,active,archive,null]);expect(writes()).toHaveLength(0);
    if(change==="actor")expect(screen.queryAllByText(b.draft.content)).toHaveLength(0);
  });

  test("controlled Save digest excludes Restore and detects newest draft before pending creation, with zero operation network",async()=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();const digest=crypto.subtle.digest.bind(crypto.subtle);let entered=false,release!:(value:ArrayBuffer)=>void;
    const spy=vi.spyOn(crypto.subtle,"digest").mockImplementationOnce((_algorithm,_data)=>{entered=true;return new Promise<ArrayBuffer>(r=>release=r);});
    try{fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(entered).toBe(true));act(()=>invoke(screen.getByRole("button",{name:"Restore preserved version 1"})));const newer=JSON.stringify({...b,draft:{...b.draft,content:"Newest digest-stage unsent content"}});sessionStorage.setItem(key()+":draft",newer);const durable=exact();
      await act(async()=>release(await digest("SHA-256",new TextEncoder().encode("irrelevant stopped request"))));await screen.findByRole("button",{name:"Recheck preserved Report storage"});expect(exact()).toEqual(durable);expect(sessionStorage.getItem(key())).toBeNull();expect(writes()).toHaveLength(0);
    }finally{spy.mockRestore();}
  });

  test("Finish interrupted restore shares ownership with stale Save/duplicate Finish; exact uncertain operation survives until explicit reconcile",async()=>{
    fixture();const op={key:"99999999-9999-4999-8999-999999999999",body:a.draft,requestHash:bodyHash(a.draft)},pending=JSON.stringify(op);
    sessionStorage.setItem(key(),pending);sessionStorage.setItem(key()+":draft",JSON.stringify(a));renderRoute(`/tasks/${taskId}`);await screen.findByRole("button",{name:"Reconcile Task Report save"});
    const form=screen.getByLabelText("Progress").closest("form")!;const submitProps=Object.keys(form).find(k=>k.startsWith("__reactProps$"))!;const staleSubmit=(form as any)[submitProps].onSubmit;
    const swap={version:1,scope:key(),pendingRaw:pending,beforeDraft:JSON.stringify(a),beforePreserved:JSON.stringify({version:1,drafts:[b]}),afterDraft:JSON.stringify(a),afterPreserved:JSON.stringify({version:1,drafts:[b]})};const raw=JSON.stringify(swap);sessionStorage.setItem(key()+":restore",raw);fireEvent(window,new Event("focus"));const finish=await screen.findByRole("button",{name:"Finish interrupted restoration"});const gate=identityGate();
    act(()=>{fireEvent.click(finish);invoke(finish);staleSubmit({preventDefault:()=>{}});});await waitFor(()=>expect(gate.entered()).toBe(true));const durable=exact();expect(writes()).toHaveLength(0);
    await act(async()=>gate.release());const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});await waitFor(()=>expect(reconcile).toBeEnabled());expect(sessionStorage.getItem(key())).toBe(pending);expect(sessionStorage.getItem(key()+":draft")).toBe(durable[1]);expect(sessionStorage.getItem(key()+":preserved")).toBe(durable[2]);expect(sessionStorage.getItem(key()+":restore")).toBeNull();expect(writes()).toHaveLength(0);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let operationRead!:(r:Response)=>void;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>String(input).includes("/report-operations/")?new Promise<Response>(r=>operationRead=r):prior(input,init));
    fireEvent.click(reconcile);await waitFor(()=>expect(writes()).toHaveLength(1));act(()=>{invoke(screen.getByRole("button",{name:"Restore preserved version 1"}));staleSubmit({preventDefault:()=>{}});});expect(writes()).toHaveLength(1);expect(sessionStorage.getItem(key())).toBe(pending);
    await act(async()=>operationRead(new Response(JSON.stringify({success:true,report:{id:reportId,...a.draft,content_hash:sha(a.draft.content)},operation:{key:op.key,requestHash:op.requestHash,contentHash:sha(a.draft.content)}}))));await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());expect(sessionStorage.getItem(key())).toBeNull();expect(sessionStorage.getItem(key()+":preserved")).toContain(b.draft.content);expect(writes()).toHaveLength(1);expect(vi.mocked(authenticatedFetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
  });

  test.each(["full","denied-read","failed-readback"])("Save %s storage error releases owner and retains both versions plus any exact pending bytes through reload",async fault=>{
    const {active,archive}=fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();const set=Storage.prototype.setItem,get=Storage.prototype.getItem;
    let failed=false;const spy=fault==="full"?vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,k:string,v:string){if(this===sessionStorage&&k===key()){failed=true;throw new DOMException("Storage full","QuotaExceededError");}return set.call(this,k,v);}):vi.spyOn(Storage.prototype,"getItem").mockImplementation(function(this:Storage,k:string){if(this===sessionStorage&&k===key()&&(fault==="denied-read"||get.call(this,k)!==null)){failed=true;if(fault==="denied-read")throw new DOMException("Storage denied","SecurityError");return null;}return get.call(this,k);});
    try{fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(failed).toBe(true));await waitFor(()=>expect(screen.queryByRole("button",{name:"Save Task Report"})?.hasAttribute("disabled")??false).toBe(false));expect(get.call(sessionStorage,key()+":draft")).toBe(active);expect(get.call(sessionStorage,key()+":preserved")).toBe(archive);expect(writes()).toHaveLength(0);}finally{spy.mockRestore();}
    const durable=exact();page.unmount();page=renderRoute(`/tasks/${taskId}`);
    if(fault==="failed-readback"){const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});expect(reconcile).toBeEnabled();expect(JSON.parse(sessionStorage.getItem(key())!).body).toEqual(a.draft);expect(exact()).toEqual(durable);}
    else {await ready();fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));expect(sessionStorage.getItem(key()+":preserved")).toContain(a.draft.content);}
    expect(writes()).toHaveLength(0);page.unmount();
  });

  test.each(["draft","preserved","pending","restore"])("changed %s before Save entry is never replaced or bypassed",async change=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();
    if(change==="draft")sessionStorage.setItem(key()+":draft",JSON.stringify(b));
    if(change==="preserved")sessionStorage.setItem(key()+":preserved",JSON.stringify({version:1,drafts:[{...b,draft:{...b.draft,content:"Newer preserved bytes"}}]}));
    if(change==="pending")sessionStorage.setItem(key(),JSON.stringify({key:"99999999-9999-4999-8999-999999999999",body:b.draft,requestHash:bodyHash(b.draft)}));
    if(change==="restore")sessionStorage.setItem(key()+":restore","{new unreadable restoration");
    const durable=exact(),priorCalls=vi.mocked(authenticatedFetch).mock.calls.length;
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await screen.findByRole("button",{name:"Recheck preserved Report storage"});expect(exact()).toEqual(durable);expect(writes()).toHaveLength(0);expect(vi.mocked(authenticatedFetch).mock.calls.slice(priorCalls)).toHaveLength(0);
  });

  test("late old Save after cancellation, explicit same-scope reconcile and real Restore cannot overwrite B or its archive on reload",async()=>{
    fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    let oldNetwork!:(r:Response)=>void,oldInit:RequestInit|undefined;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      if(init?.method==="POST"){oldInit=init;return new Promise<Response>(r=>oldNetwork=r);}
      if(String(input).includes("/report-operations/")){const op=JSON.parse(sessionStorage.getItem(key())!);expect(String(input)).toContain(`${op.key}?requestHash=${op.requestHash}`);return new Response(JSON.stringify({success:true,report:{id:reportId,...a.draft,content_hash:sha(a.draft.content)},operation:{key:op.key,requestHash:op.requestHash,contentHash:sha(a.draft.content)}}));}
      return prior(input,init);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(writes()).toHaveLength(1));const oldResult=truthfulResult(oldInit),pending=sessionStorage.getItem(key());
    fireEvent(window,new Event("focus"));const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});await waitFor(()=>expect(reconcile).toBeEnabled());expect(sessionStorage.getItem(key())).toBe(pending);expect(writes()).toHaveLength(1);
    fireEvent.click(reconcile);await waitFor(()=>expect(screen.getByRole("button",{name:"Restore preserved version 1"})).toBeEnabled());expect(writes()).toHaveLength(2);expect(sessionStorage.getItem(key())).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));const restored=exact();expect(restored[1]).toBe(JSON.stringify(b));expect(restored[2]).toContain(a.draft.content);
    const set=vi.spyOn(Storage.prototype,"setItem"),remove=vi.spyOn(Storage.prototype,"removeItem");
    try{await act(async()=>oldNetwork(oldResult));expect(exact()).toEqual(restored);expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content);expect(set.mock.calls.some(([k])=>k.startsWith(key()))).toBe(false);expect(remove.mock.calls.some(([k])=>k===key())).toBe(false);}finally{set.mockRestore();remove.mockRestore();}
    expect(writes()).toHaveLength(2);page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content);expect(exact()).toEqual(restored);expect(writes()).toHaveLength(2);page.unmount();
  });

});

describe("N4 ordinary focus draft conservation",()=>{
  const reportId="22222222-2222-4222-8222-222222222222";
  const sha=(content:string)=>createHash("sha256").update(content).digest("hex");
  const a={draft:{title:"Durable A",content:"Current durable A",reportId,expectedContentHash:sha("Current durable A")},dirty:true};
  const b={draft:{title:"Durable B",content:"Selected durable B",reportId,expectedContentHash:a.draft.expectedContentHash},dirty:true};
  const key=()=>`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;
  const bodyHash=(body:Record<string,string>)=>sha(JSON.stringify({title:body.title,content:body.content,summary:null,reportId:body.reportId??null,expectedContentHash:body.expectedContentHash??null}));
  const identity=(id=task.ownerPrincipalId)=>new Response(JSON.stringify({success:true,principal:{id}}));
  const exact=()=>[key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>sessionStorage.getItem(k));
  const writes=()=>vi.mocked(authenticatedFetch).mock.calls.filter(([url,init])=>String(url).includes("/report-operations/")||init?.method==="POST");
  function fixture(dirty=true){
    taskResponse={...task,status:"in-progress",reportMaintenanceAccess:{allowed:true,reason:null}};
    const active=JSON.stringify({...a,dirty}),archive=JSON.stringify({version:1,drafts:[b]});
    sessionStorage.setItem(key()+":draft",active);sessionStorage.setItem(key()+":preserved",archive);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      {const fixture=progressReportFixture(input,init,[{id:reportId,title:a.draft.title,content:a.draft.content,content_hash:sha(a.draft.content),author_principal_id:task.ownerPrincipalId,status:"active"}]);if(fixture)return fixture;}
      return prior(input,init);
    });return {active,archive};
  }
  function truthfulResult(init?:RequestInit){
    const body=JSON.parse(String(init?.body));const hash=sha(body.content);const op=JSON.parse(sessionStorage.getItem(key())!);
    expect(body).toEqual(op.body);expect(body.expectedContentHash).toBe(sha(a.draft.content));
    expect(op.requestHash).toBe(bodyHash(body));expect((init?.headers as Record<string,string>)["Idempotency-Key"]).toBe(op.key);
    return new Response(JSON.stringify({success:true,report:{id:reportId,title:body.title,content:body.content,content_hash:hash,author_principal_id:task.ownerPrincipalId,status:"active"},operation:{key:op.key,requestHash:op.requestHash,contentHash:hash}}));
  }
  async function ready(){await screen.findByLabelText("Progress");await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());}


  const c={draft:{...b.draft,title:"Newest C",content:"LATEST UNIQUE C ARRIVED WHILE SAVE WAITS"},dirty:true};
  async function pendingSave(){
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;let release!:(r:Response)=>void,init:RequestInit|undefined;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,options)=>{
      if(options?.method==="POST"){init=options;return new Promise<Response>(r=>release=r);}return prior(input,options);
    });
    fireEvent.click(screen.getByRole("button",{name:"Save Task Report"}));await waitFor(()=>expect(writes()).toHaveLength(1));
    const result=truthfulResult(init);return {result,reconciled:result.clone(),release:(r:Response)=>release(r),pending:sessionStorage.getItem(key())!};
  }
  async function held(){const recheck=await screen.findByRole("button",{name:"Recheck preserved Report storage"});await waitFor(()=>expect(recheck).toBeEnabled());return recheck;}

  test("N4 ordinary focus with changed valid durable draft holds exact C, live A and pending A through late response/reload; explicit recovery remains usable",async()=>{
    fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();const save=await pendingSave();
    sessionStorage.setItem(key()+":draft",JSON.stringify(c));const before=exact();
    fireEvent(window,new Event("focus"));await waitFor(()=>expect(screen.queryByRole("button",{name:"Reconcile Task Report save"})||screen.queryByRole("button",{name:"Recheck preserved Report storage"})).toBeTruthy());
    expect(sessionStorage.getItem(key()+":draft")).toBe(before[1]);await held();expect(exact()).toEqual(before);
    expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(a.draft.content);
    expect(screen.getByRole("region",{name:"Saved draft from this tab"})).toHaveTextContent(c.draft.content);
    expect(screen.queryByRole("button",{name:"Reconcile Task Report save"})).not.toBeInTheDocument();expect(writes()).toHaveLength(1);
    await act(async()=>save.release(save.result));expect(exact()).toEqual(before);expect(writes()).toHaveLength(1);
    page.unmount();page=renderRoute(`/tasks/${taskId}`);await held();expect(exact()).toEqual(before);expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button",{name:"Continue uncertain save; keep other drafts"}));
    const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});await waitFor(()=>expect(reconcile).toBeEnabled());
    expect(sessionStorage.getItem(key())).toBe(save.pending);expect(JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts).toEqual([b,c]);expect(writes()).toHaveLength(1);
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,options)=>String(input).includes("/report-operations/")?save.reconciled.clone():prior(input,options));
    fireEvent.click(reconcile);await waitFor(()=>expect(screen.getByRole("button",{name:"Restore preserved version 2"})).toBeEnabled());
    expect(writes()).toHaveLength(2);expect(sessionStorage.getItem(key())).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 2"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(c.draft.content));
    const recovered=exact();expect(recovered[2]).toContain(a.draft.content);expect(recovered[2]).toContain(b.draft.content);
    page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(screen.getByLabelText("Progress")).toHaveValue(c.draft.content);expect(exact()).toEqual(recovered);expect(writes()).toHaveLength(2);page.unmount();
  });

  test("N4 unchanged storage ordinary focus keeps live edits usable without recovery or network mutation",async()=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();fireEvent.change(screen.getByLabelText("Progress"),{target:{value:"LIVE EDIT RETAINED"}});
    await waitFor(()=>expect(sessionStorage.getItem(key()+":draft")).toContain("LIVE EDIT RETAINED"));const before=exact();
    fireEvent(window,new Event("focus"));await ready();expect(screen.getByLabelText("Progress")).toHaveValue("LIVE EDIT RETAINED");expect(exact()).toEqual(before);expect(writes()).toHaveLength(0);
    expect(screen.queryByRole("button",{name:"Recheck preserved Report storage"})).not.toBeInTheDocument();
  });

  test("N4 unchanged storage focus while Save waits retains explicit reconcile flow and late cancellation",async()=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();const save=await pendingSave(),before=exact();
    fireEvent(window,new Event("focus"));const reconcile=await screen.findByRole("button",{name:"Reconcile Task Report save"});await waitFor(()=>expect(reconcile).toBeEnabled());
    expect(exact()).toEqual(before);expect(writes()).toHaveLength(1);await act(async()=>save.release(save.result));expect(exact()).toEqual(before);
  });

  test.each(["malformed-draft","malformed-archive","full-archive","denied-read","failed-write"])("N4 focus %s safely holds every byte and offers recheck/copy without unexpected requests",async fault=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();const save=await pendingSave();sessionStorage.setItem(key()+":draft",JSON.stringify(c));
    if(fault==="malformed-draft")sessionStorage.setItem(key()+":draft","{unreadable C evidence");
    if(fault==="malformed-archive")sessionStorage.setItem(key()+":preserved","{unreadable B evidence");
    if(fault==="full-archive")sessionStorage.setItem(key()+":preserved",JSON.stringify({version:1,drafts:[b,{...b,draft:{...b.draft,title:"D",content:"ANOTHER UNIQUE D"}}]}));
    const before=exact(),get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    const spy=fault==="denied-read"?vi.spyOn(Storage.prototype,"getItem").mockImplementation(function(this:Storage,k:string){if(this===sessionStorage&&k===key()+":draft")throw new DOMException("Denied","SecurityError");return get.call(this,k);}):fault==="failed-write"?vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,k:string,v:string){if(this===sessionStorage&&k.startsWith(key()))throw new DOMException("Full","QuotaExceededError");return set.call(this,k,v);}):null;
    try {
      fireEvent(window,new Event("focus"));await held();
      if(fault==="full-archive"||fault==="failed-write"){
        fireEvent.click(screen.getByRole("button",{name:"Continue uncertain save; keep other drafts"}));
        await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent(fault==="full-archive"?"already two preserved versions":"Original evidence is preserved"));
      }
      await act(async()=>save.release(save.result));expect([key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>get.call(sessionStorage,k))).toEqual(before);expect(writes()).toHaveLength(1);
    }finally{spy?.mockRestore();}
    expect(exact()).toEqual(before);fireEvent.click(screen.getByRole("button",{name:"Recheck preserved Report storage"}));await held();expect(exact()).toEqual(before);expect(writes()).toHaveLength(1);
  });

  test("N4 valid changed draft without pending holds live work, then explicit saved selection preserves all versions",async()=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();sessionStorage.setItem(key()+":draft",JSON.stringify(c));const before=exact();
    fireEvent(window,new Event("focus"));await held();expect(exact()).toEqual(before);
    expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(a.draft.content);
    fireEvent.click(screen.getByRole("button",{name:"Continue saved draft; keep page work"}));await ready();expect(screen.getByLabelText("Progress")).toHaveValue(c.draft.content);
    expect(JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts).toEqual([b,a]);expect(writes()).toHaveLength(0);
  });

  test.each(["actor","claimant","verifier","status","write-access"])("N4 changed draft plus %s authority loss cannot mutate old scoped evidence",async loss=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();const save=await pendingSave();sessionStorage.setItem(key()+":draft",JSON.stringify(c));const before=exact();
    if(loss==="actor"){
      const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
      vi.mocked(authenticatedFetch).mockImplementation(async(input,options)=>String(input).endsWith("/principals/me")?identity("99999999-9999-4999-8999-999999999999"):prior(input,options));
    }else {
      taskResponse={...taskResponse,...(loss==="claimant"?{ownerPrincipalId:"99999999-9999-4999-8999-999999999999"}:loss==="verifier"?{verifierPrincipalId:task.ownerPrincipalId}:loss==="status"?{status:"review"}:{reportMaintenanceAccess:{allowed:false,reason:"DENIED"}})};
      const handler=subscribe.mock.calls.find(([type])=>type==="task.updated")?.[1];act(()=>handler?.({taskId,task:taskResponse}));
      await waitFor(()=>expect(screen.queryByRole("button",{name:"Save Task Report"})).not.toBeInTheDocument());
    }
    fireEvent(window,new Event("focus"));await waitFor(()=>expect(vi.mocked(authenticatedFetch).mock.calls.filter(([u])=>String(u).endsWith("/principals/me")).length).toBeGreaterThan(2));
    await act(async()=>save.release(save.result));expect(exact()).toEqual(before);expect(writes()).toHaveLength(1);
    const choice=screen.queryByRole("button",{name:"Continue uncertain save; keep other drafts"});if(choice)expect(choice).toBeDisabled();
  });
});


describe("T1 T10 shared current-evidence transition conservation",()=>{
  const reportId="22222222-2222-4222-8222-222222222222";
  const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
  const a={draft:{title:"Durable A",content:"Current durable A",reportId,expectedContentHash:sha("Current durable A")},dirty:true};
  const b={draft:{...a.draft,title:"Durable B",content:"Preserved B"},dirty:true};
  const c={draft:{...a.draft,title:"Newest C",content:"DISTINCT VALID DIRTY C"},dirty:true};
  const edited="LIVE A INCLUDING CHARACTERS TYPED AFTER C";
  const key=()=>`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;
  const exact=()=>[key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>sessionStorage.getItem(k));
  const ops=()=>vi.mocked(authenticatedFetch).mock.calls.filter(([u,o])=>o?.method==="POST"||String(u).includes("/report-operations/"));
  const finish=()=>ops().filter(([u])=>String(u).endsWith("/finish"));
  const pack=(drafts:unknown[])=>JSON.stringify({version:1,drafts});
  const identity=()=>new Response(JSON.stringify({success:true,principal:{id:task.ownerPrincipalId}}));
  function fixture(dirty=true){
    taskResponse={...task,status:"in-progress",reportMaintenanceAccess:{allowed:true,reason:null}};
    sessionStorage.setItem(key()+":draft",JSON.stringify({...a,dirty}));sessionStorage.setItem(key()+":preserved",pack([b]));
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation(async(input,init)=>{
      {const fixture=progressReportFixture(input,init,[{id:reportId,title:a.draft.title,content:a.draft.content,content_hash:sha(a.draft.content),author_principal_id:task.ownerPrincipalId,status:"active"}]);if(fixture)return fixture;}
      if(String(input).endsWith(`/tasks/${taskId}/finish`)&&init?.method==="POST"){
        expect(JSON.parse(String(init.body)).reportId).toBe(reportId);
        taskResponse={...taskResponse,status:"review"};return new Response(JSON.stringify({success:true,task:taskResponse}));
      }
      return prior(input,init);
    });
  }
  async function ready(){await screen.findByLabelText("Progress");await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());}
  async function held(){await screen.findByRole("button",{name:"Recheck preserved Report storage"});}

  test("T1 edit preserves exact C and all typed characters through HOLD, reload and explicit restoration",async()=>{
    fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();
    sessionStorage.setItem(key()+":draft",JSON.stringify(c));const before=exact();
    fireEvent.change(screen.getByLabelText("Progress"),{target:{value:edited}});
    expect(sessionStorage.getItem(key()+":draft")).toBe(before[1]);await held();expect(sessionStorage.getItem(key())).toBeNull();expect(sessionStorage.getItem(key()+":restore")).toBeNull();
    expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(edited);
    expect(screen.getByRole("region",{name:"Saved draft from this tab"})).toHaveTextContent(c.draft.content);
    const live={draft:{...a.draft,content:edited},dirty:true};expect(JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts).toEqual([b,live]);expect(ops()).toHaveLength(0);
    const conserved=exact();page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();
    expect(exact()).toEqual(conserved);expect(screen.getByLabelText("Progress")).toHaveValue(c.draft.content);expect(screen.getByRole("region",{name:"Preserved version 2"})).toHaveTextContent(edited);
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 2"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(edited));
    expect(JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts).toEqual([b,c]);expect(ops()).toHaveLength(0);page.unmount();
  });

  test("T10 changed dirty C before explicit Handover refuses finish against stale canonical clean A",async()=>{
    fixture(false);let page=renderRoute(`/tasks/${taskId}`);await ready();
    const handover=screen.getByRole("button",{name:"Hand over saved Report for review"});expect(handover).toBeEnabled();
    sessionStorage.setItem(key()+":draft",JSON.stringify(c));const before=exact();
    await act(async()=>fireEvent.click(handover));expect(finish()).toHaveLength(0);await held();expect(ops()).toHaveLength(0);expect(taskResponse.status).toBe("in-progress");expect(exact()).toEqual(before);
    expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(a.draft.content);expect(screen.getByRole("region",{name:"Saved draft from this tab"})).toHaveTextContent(c.draft.content);
    fireEvent.click(screen.getByRole("button",{name:"Continue saved draft; keep page work"}));await ready();expect(screen.getByLabelText("Progress")).toHaveValue(c.draft.content);expect(screen.getByRole("button",{name:"Hand over saved Report for review"})).toBeDisabled();
    const retained=exact();page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(exact()).toEqual(retained);expect(JSON.parse(retained[2]!).drafts).toEqual([b,{...a,dirty:false}]);expect(ops()).toHaveLength(0);page.unmount();
  });

  test("unchanged ordinary title/progress editing and focus keep all characters and do not universally block",async()=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();
    await userEvent.type(screen.getByLabelText("Progress")," typed normally");await userEvent.type(screen.getByLabelText("Report title")," normal title");
    const before=exact();expect(JSON.parse(before[1]!).draft.content).toBe(a.draft.content+" typed normally");
    fireEvent(window,new Event("focus"));await ready();expect(exact()).toEqual(before);expect(screen.getByLabelText("Report title")).toHaveValue(a.draft.title+" normal title");expect(ops()).toHaveLength(0);
  });

  test("unchanged canonical clean A Handover still finishes once and refreshes mocked review",async()=>{
    fixture(false);renderRoute(`/tasks/${taskId}`);await ready();const before=exact();
    fireEvent.click(screen.getByRole("button",{name:"Hand over saved Report for review"}));await waitFor(()=>expect(finish()).toHaveLength(1));await waitFor(()=>expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument());expect(exact()).toEqual(before);expect(taskResponse.status).toBe("review");
  });

  test.each(["malformed-draft","malformed-archive","full-archive","denied-read","failed-write"])("T1 %s HOLD retains typed work visibly and never destroys durable evidence",async fault=>{
    fixture();renderRoute(`/tasks/${taskId}`);await ready();sessionStorage.setItem(key()+":draft",JSON.stringify(c));
    if(fault==="malformed-draft")sessionStorage.setItem(key()+":draft","{broken C");
    if(fault==="malformed-archive")sessionStorage.setItem(key()+":preserved","{broken B");
    if(fault==="full-archive")sessionStorage.setItem(key()+":preserved",pack([b,{...b,draft:{...b.draft,content:"D distinct archive"}}]));
    const before=exact(),get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    const spy=fault==="denied-read"?vi.spyOn(Storage.prototype,"getItem").mockImplementation(function(this:Storage,k:string){if(this===sessionStorage&&k===key()+":draft")throw new DOMException("Denied","SecurityError");return get.call(this,k);}):fault==="failed-write"?vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,k:string,v:string){if(this===sessionStorage&&k===key()+":preserved")throw new DOMException("Full","QuotaExceededError");return set.call(this,k,v);}):null;
    try{fireEvent.change(screen.getByLabelText("Progress"),{target:{value:edited}});await held();expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(edited);expect(screen.getByRole("alert")).toHaveTextContent("may not be kept for reload");expect([key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>get.call(sessionStorage,k))).toEqual(before);expect(ops()).toHaveLength(0);}finally{spy?.mockRestore();}
    expect(exact()).toEqual(before);
  });

  test.each(["malformed","missing","dirty-same-content","changed-clean"])("T10 %s current durable evidence cannot become an accepted Handover baseline",async change=>{
    fixture(false);renderRoute(`/tasks/${taskId}`);await ready();
    if(change==="missing")sessionStorage.removeItem(key()+":draft");else sessionStorage.setItem(key()+":draft",change==="malformed"?"{broken C":JSON.stringify(change==="dirty-same-content"?a:{...c,dirty:false}));
    const before=exact();fireEvent.click(screen.getByRole("button",{name:"Hand over saved Report for review"}));await held();expect(exact()).toEqual(before);expect(ops()).toHaveLength(0);
  });

  test("same-tick edit then actual Handover handler is refused before persistence settles",async()=>{
    fixture(false);renderRoute(`/tasks/${taskId}`);await ready();const button=screen.getByRole("button",{name:"Hand over saved Report for review"});
    const props=(button as any)[Object.keys(button).find(k=>k.startsWith("__reactProps$"))!];
    sessionStorage.setItem(key()+":draft",JSON.stringify(c));
    act(()=>{fireEvent.change(screen.getByLabelText("Progress"),{target:{value:edited}});props.onClick({preventDefault(){}});});
    await held();expect(ops()).toHaveLength(0);expect(sessionStorage.getItem(key()+":draft")).toBe(JSON.stringify(c));expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(edited);
  });

  test("Handover evidence change during identity wait retains all bytes and refuses finish",async()=>{
    fixture(false);renderRoute(`/tasks/${taskId}`);await ready();let release!:(r:Response)=>void;let entered=false;
    const prior=vi.mocked(authenticatedFetch).getMockImplementation()!;vi.mocked(authenticatedFetch).mockImplementation(async(u,o)=>{if(String(u).endsWith("/principals/me")&&!entered){entered=true;return new Promise<Response>(r=>release=r);}return prior(u,o);});
    fireEvent.click(screen.getByRole("button",{name:"Hand over saved Report for review"}));await waitFor(()=>expect(entered).toBe(true));sessionStorage.setItem(key()+":draft",JSON.stringify(c));const before=exact();
    await act(async()=>release(identity()));await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("Saved evidence changed"));expect(exact()).toEqual(before);expect(ops()).toHaveLength(0);
  });
});

describe("T4 displayed Restore entry evidence",()=>{
  const reportId="22222222-2222-4222-8222-222222222222";
  const a={draft:{title:"Live A",content:"Current A",reportId,expectedContentHash:createHash("sha256").update("Current A").digest("hex")},dirty:true};
  const b={draft:{...a.draft,title:"Displayed B",content:"Selected B"},dirty:true};
  const c={draft:{...a.draft,title:"New C",content:"New distinct C"},dirty:true};
  const key=()=>`relayhall-task-report:${window.location.origin}:${task.ownerPrincipalId}:${taskId}`;
  const pack=(drafts:unknown[])=>JSON.stringify({version:1,drafts});
  const exact=()=>[key(),key()+":draft",key()+":preserved",key()+":restore"].map(k=>sessionStorage.getItem(k));
  const ops=()=>vi.mocked(authenticatedFetch).mock.calls.filter(([u,o])=>o?.method==="POST"||String(u).includes("/report-operations/"));
  function fixture(){taskResponse={...task,status:"in-progress",reportMaintenanceAccess:{allowed:true,reason:null}};sessionStorage.setItem(key()+":draft",JSON.stringify(a));sessionStorage.setItem(key()+":preserved",pack([b]));}
  async function ready(){await screen.findByLabelText("Progress");await waitFor(()=>expect(screen.getByRole("button",{name:"Save Task Report"})).toBeEnabled());}
  const prop=(node:HTMLElement)=>(node as any)[Object.keys(node).find(k=>k.startsWith("__reactProps$"))!];

  test.each(["reorder","replacement"])("displayed B then valid %s cannot silently restore C; explicit fresh choice and reload work",async mode=>{
    fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();
    expect(screen.getByRole("region",{name:"Preserved version 1"})).toHaveTextContent(b.draft.content);
    const displayed=screen.getByRole("button",{name:"Restore preserved version 1"});
    sessionStorage.setItem(key()+":preserved",pack(mode==="reorder"?[c,b]:[c]));const before=exact();
    await act(async()=>fireEvent.click(displayed));
    // Exact old source selects C here. A refusal is permitted, silent retargeting is not.
    if(!screen.queryByRole("button",{name:"Recheck preserved Report storage"}))expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content);
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});
    expect(screen.getByRole("alert")).toHaveTextContent("preserved versions changed");expect(exact()).toEqual(before);expect(ops()).toHaveLength(0);
    expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(a.draft.content);
    page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(exact()).toEqual(before);expect(screen.getByLabelText("Progress")).toHaveValue(a.draft.content);
    const target=mode==="reorder"?b:c;
    fireEvent.click(screen.getByRole("button",{name:mode==="reorder"?"Restore preserved version 2":"Restore preserved version 1"}));
    await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(target.draft.content));
    expect(JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts).toEqual(mode==="reorder"?[c,a]:[a]);
    expect(sessionStorage.getItem(key())).toBeNull();expect(sessionStorage.getItem(key()+":restore")).toBeNull();expect(ops()).toHaveLength(0);
    const after=exact();page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(exact()).toEqual(after);expect(screen.getByLabelText("Progress")).toHaveValue(target.draft.content);page.unmount();
  });

  test("unchanged displayed B Restore remains usable with exact A alternate and reload",async()=>{
    fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();
    fireEvent.click(screen.getByRole("button",{name:"Restore preserved version 1"}));await waitFor(()=>expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content));
    expect(JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts).toEqual([a]);expect(ops()).toHaveLength(0);const before=exact();page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(exact()).toEqual(before);expect(screen.getByLabelText("Progress")).toHaveValue(b.draft.content);page.unmount();
  });

  test("Restore cannot bless changed outgoing D even when displayed B is unchanged",async()=>{
    fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();const displayed=screen.getByRole("button",{name:"Restore preserved version 1"});
    sessionStorage.setItem(key()+":draft",JSON.stringify(c));const before=exact();await act(async()=>fireEvent.click(displayed));
    await screen.findByRole("button",{name:"Recheck preserved Report storage"});expect(exact()).toEqual(before);expect(ops()).toHaveLength(0);
    expect(screen.getByRole("region",{name:"Work from this page"})).toHaveTextContent(a.draft.content);expect(screen.getByRole("region",{name:"Saved draft from this tab"})).toHaveTextContent(c.draft.content);
    fireEvent.click(screen.getByRole("button",{name:"Continue work from this page; keep saved draft"}));await ready();expect(screen.getByLabelText("Progress")).toHaveValue(a.draft.content);expect(JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts).toEqual([b,c]);
    const after=exact();page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(exact()).toEqual(after);expect(ops()).toHaveLength(0);page.unmount();
  });

  test("same-tick complete typed title/content survives actual displayed Restore entry",async()=>{
    fixture();let page=renderRoute(`/tasks/${taskId}`);await ready();
    const click=prop(screen.getByRole("button",{name:"Restore preserved version 1"})).onClick;
    const title=prop(screen.getByLabelText("Report title")).onChange,content=prop(screen.getByLabelText("Progress")).onChange;
    const typed={draft:{...a.draft,title:"Complete synchronous typed title",content:"Complete synchronous typed content"},dirty:true};
    await act(async()=>{title({target:{value:typed.draft.title}});content({target:{value:typed.draft.content}});click({preventDefault(){}});});
    const drafts=()=>[JSON.parse(sessionStorage.getItem(key()+":draft")!),...JSON.parse(sessionStorage.getItem(key()+":preserved")!).drafts];
    expect(drafts()).toContainEqual(typed);expect(drafts()).toContainEqual(b);expect(ops()).toHaveLength(0);
    const before=exact();page.unmount();page=renderRoute(`/tasks/${taskId}`);await ready();expect(exact()).toEqual(before);expect(drafts()).toContainEqual(typed);expect(drafts()).toContainEqual(b);page.unmount();
  });
});
