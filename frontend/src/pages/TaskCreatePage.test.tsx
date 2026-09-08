// @vitest-environment jsdom
//
// RH-UI.15 (A5) — routed Task creation (design 986be411 §7, E6; declared
// amendment to 3cdf6e65 §3.7). Pins, on the production TaskCreatePage:
//   - /tasks/new renders the details design language via the SAME section
//     registry (Description, DoD, Constraints, Subtasks, Links content;
//     Placement + Execution rail) with absent sections simply not rendered;
//   - board context pre-fills status/project/phase from the query string;
//   - the create POST carries the CANONICAL structured fields
//     (definitionOfDone/constraints as lists) and the F4 connector gating
//     (a serviceId profile strips board-native model/personality/thinking);
//   - success navigates to the created Task's canonical URL;
//   - Cancel guards unsaved changes.

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { TaskCreatePage } from './TaskCreatePage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../components/tasks/ExecutionProfileEditor', () => ({
  __esModule: true,
  default: ({ value, onChange }: any) => (
    <button onClick={() => onChange({ serviceId: 'connector-1', descriptorVersion: 2, options: {} })}>
      {value?.serviceId ? `connector:${value.serviceId}` : 'Pick connector'}
    </button>
  ),
}));
vi.mock('../components/tasks/PhaseSelect', () => ({
  PhaseSelect: ({ value, onChange }: any) => (
    <select aria-label="Phase" value={value} onChange={(event: any) => onChange(event.target.value)}>
      <option value="">No phase</option>
      <option value="phase-1">Phase one</option>
    </select>
  ),
  PhaseName: ({ phaseId }: any) => <span>{phaseId}</span>,
}));

const created: Array<Record<string, unknown>> = [];

function LocationProbe() {
  const location = useLocation();
  return <><output data-testid="location">{location.pathname}</output><output data-testid="resolution">{JSON.stringify(location.state?.dueAtResolution)}</output></>;
}

const renderCreate = (entry = '/tasks/new') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tasks/new" element={<><TaskCreatePage /><LocationProbe /></>} />
          <Route path="/tasks/:taskId" element={<LocationProbe />} />
          <Route path="/tasks" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  created.length = 0;
  vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/projects')) {
      return new Response(JSON.stringify({ success: true, projects: [{ id: 'p1', name: 'RelayHall' }] }), { status: 200 });
    }
    if (url.endsWith('/personalities')) {
      return new Response(JSON.stringify({ success: true, personalities: [{ id: 'per1', slug: 'generalist', name: 'Generalist' }] }), { status: 200 });
    }
    if (url.endsWith('/tasks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      created.push(body);
      return new Response(JSON.stringify({ success: true, task: { id: '99999999-9999-4999-8999-999999999999', ...body } }), { status: 201 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('routed create mode (§7)', () => {
  test('renders the registry-ordered create sections in the details design language; absent sections do not render', async () => {
    renderCreate();
    await screen.findByRole('heading', { name: 'Description' });
    // Registry order: Description → Definition of done → Constraints → Subtasks → Links.
    const headings = Array.from(document.querySelectorAll('.task-detail-content-section h2')).map(node => node.textContent?.trim());
    expect(headings).toEqual(['Description', 'Definition of done', 'Constraints', 'Subtasks', 'Links']);
    // Absent sections (Timeline, Reports, Notes, Agent instructions,
    // Verifier settings) simply do not render in create mode.
    expect(screen.queryByText(/Reports & handovers/)).toBeNull();
    expect(screen.queryByText(/Timeline/)).toBeNull();
    expect(document.querySelector('.task-detail-left-rail')).not.toBeNull();
  });

  test('board context pre-fills status, project and phase from the query string', async () => {
    renderCreate('/tasks/new?status=review&project=RelayHall&phaseId=phase-1');
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('p1'));
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('review');
    expect((screen.getByLabelText('Phase') as HTMLSelectElement).value).toBe('phase-1');
  });

  test('the create POST carries the canonical structured fields and lands on the created Task', async () => {
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'A5 create' } });
    fireEvent.change(screen.getByLabelText('Description', { selector: 'textarea' }), { target: { value: 'Body' } });
    fireEvent.change(screen.getByLabelText('Definition of done', { selector: 'textarea' }), { target: { value: '- first\n- second' } });
    fireEvent.change(screen.getByLabelText('Constraints', { selector: 'textarea' }), { target: { value: 'only one' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'alpha, beta, alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      title: 'A5 create',
      description: 'Body',
      definitionOfDone: ['first', 'second'],
      constraints: ['only one'],
      tags: ['alpha', 'beta'],
      status: 'todo',
      priority: 'normal',
    });
    // Born parked: create never arms (strategy §2.6 direction).
    expect('autoStart' in created[0]).toBe(false);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tasks/99999999-9999-4999-8999-999999999999'));
  });

  test('a connector execution profile strips the board-native model/personality/thinking (F4)', async () => {
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Connector task' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'some-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pick connector' }));
    // The board-native execution fields leave the form once a connector owns
    // execution.
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Personality')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].executionProfile).toMatchObject({ serviceId: 'connector-1' });
    expect(created[0].model).toBeUndefined();
  });

  test('a missing title blocks the create with an announced error', async () => {
    renderCreate();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Title is required');
    expect(created).toHaveLength(0);
  });

  test('a priority-only change is guarded — the snapshot covers every control (review 26176eb3 B1)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCreate();
    await screen.findByRole('heading', { name: 'Description' });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/new');
    confirmSpy.mockRestore();
  });

  test('a due-only change is guarded — the snapshot covers the deadline too (round-1 review F6)', async () => {
    // The snapshot's own comment says EVERY editable value, and `dueAt` was
    // not in it: a form whose only change was a deadline read as clean and
    // the navigation guards discarded it without a word.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCreate();
    await screen.findByRole('heading', { name: 'Description' });
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-12-24T09:00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/new');
    confirmSpy.mockRestore();
  });

  test('an in-progress inline subtask draft is guarded (review 26176eb3 B1)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Add subtask'), { target: { value: 'half-typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('browser-history traversal is guarded like edit mode (review 26176eb3 B1)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'draft' } });
    fireEvent.popState(window, { state: { idx: 0 } });
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('Cancel guards unsaved changes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCreate();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/new');
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/\/tasks$/));
    confirmSpy.mockRestore();
  });
});

describe('shared field editors (review 52990b8e B1)', () => {
  test('both surfaces import the shared editors and neither declares a local status/priority vocabulary', async () => {
    const [createSource, detailSource, editorsSource, textEditorSource] = await Promise.all([
      import('./TaskCreatePage.tsx?raw'),
      import('./TaskDetailPage.tsx?raw'),
      import('../components/tasks/taskFieldEditors.tsx?raw'),
      import('../components/tasks/TaskTextSectionEditor.tsx?raw'),
    ]).then(modules => modules.map(module => (module as any).default as string));
    for (const source of [createSource, detailSource]) {
      expect(source).toContain("from '../components/tasks/taskFieldEditors'");
      expect(source).toContain('StatusSelect');
      expect(source).toContain('PrioritySelect');
      expect(source).toContain('ProjectSelect');
      expect(source).toContain('TagsInput');
      if (source === detailSource) {
        expect(source).toContain("from '../components/tasks/TaskTextSectionEditor'");
        expect(textEditorSource).toContain("from './taskFieldEditors'");
        expect(textEditorSource).toContain('TaskSectionShell');
      } else expect(source).toContain('TaskSectionShell');
      expect(source).not.toContain('const TASK_STATUSES');
      expect(source).not.toContain('const TASK_PRIORITIES');
    }
    for (const source of [createSource, detailSource]) {
      expect(source).toContain('PersonalitySelect');
      expect(source).toContain('ModelInput');
      expect(source).toContain('ThinkingSelect');
      expect(source).toContain('parseTagsInput');
    }
    // One vocabulary, declared once.
    expect(editorsSource).toContain('TASK_STATUS_OPTIONS');
    expect(editorsSource).toContain('TASK_PRIORITY_OPTIONS');
  });

  test('the create status editor parameterizes archived away instead of forking the vocabulary', async () => {
    renderCreate();
    const statusSelect = await screen.findByLabelText('Status');
    const values = Array.from((statusSelect as HTMLSelectElement).options).map(option => option.value);
    expect(values).toEqual(['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed']);
  });
});

describe('control kit consumption', () => {
  test('the page consumes the shared Button kit — no raw <button> markup', async () => {
    const pageSource = (await import('./TaskCreatePage.tsx?raw') as any).default as string;
    expect(pageSource).toMatch(/from '\.\.\/components\/Button'/);
    expect(pageSource).not.toMatch(/<button/);
  });

  test('the create-header label rule leaves type and ink to the canonical details-header rule', async () => {
    const fs = await import('fs');
    const cssSource = fs.readFileSync('src/pages/TaskCreatePage.css', 'utf8');
    expect(cssSource.length).toBeGreaterThan(0);
    // The ONE label language (12px tertiary, TaskDetailPage.css) must apply
    // unhidden: the local rule may arrange the row, never re-type or re-ink.
    const labelRule = cssSource.match(/\.task-create-page \.task-detail-page-header-controls label\s*\{[^}]*\}/);
    if (labelRule) {
      expect(labelRule[0]).not.toMatch(/font-size\s*:/);
      expect(labelRule[0]).not.toMatch(/[^-]color\s*:/);
    }
  });
});

test('the create response carries the server-selected offset to the destination page', async () => {
  const fallback = vi.mocked(authenticatedFetch).getMockImplementation()!;
  const resolution = { zone: 'Europe/Warsaw', local: '2026-10-25T02:30:00.000000',
    instant: '2026-10-25T01:30:00.000000Z', offset: '+01:00', offsetSeconds: 3600, chosen: 'postgresql' };
  vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith('/tasks') && init?.method === 'POST') {
      return new Response(JSON.stringify({ success: true,
        task: { id: '99999999-9999-4999-8999-999999999999', dueAt: resolution.instant }, dueAtResolution: resolution }), { status: 201 });
    }
    return fallback(input, init);
  });
  renderCreate();
  fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Fold choice' } });
  fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-25T02:30:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tasks/99999999'));
  expect(JSON.parse(screen.getByTestId('resolution').textContent!)).toEqual(resolution);
});
