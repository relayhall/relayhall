import fs from 'node:fs';
import path from 'node:path';

import renderer, { act, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../../utils/auth';
import type { Project } from '../../types/project';
import type { Task } from '../../types/task';
import { ProjectDetailModal } from './ProjectDetailModal';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined, connected: false }),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => navigate,
}));

const projectId = '7c1de0a2-52a2-4b2f-9c93-2f5a1c7c9d40';

const projectFixture = (overrides: Partial<Project> = {}): Project => ({
  id: projectId,
  name: 'Demo project',
  description: 'The original description',
  status: 'active',
  ownerPrincipalId: null,
  is_hidden: false,
  revision: 'rev-project-1',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  ...overrides,
});

const taskFixture: Task = {
  id: '8ede2a98-de8f-4cfb-9e74-5891d545d6d9',
  title: 'Historic task',
  description: 'Work done before the project was archived',
  status: 'completed',
  priority: 'normal',
  subtasks: [],
  links: [],
  autoStart: false,
  blockedBy: [],
  tags: [],
  created: '2026-08-01T00:00:00Z',
  updated: '2026-08-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Default routing for the modal's mount-time reads. */
const mockBackgroundReads = (tasks: Task[] = []) => {
  vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/tasks')) return jsonResponse({ success: true, tasks });
    if (u.includes('/sessions')) return jsonResponse({ success: true, sessions: [] });
    if (u.includes('/resources')) return jsonResponse({ success: true, resources: [] });
    return jsonResponse({ success: true });
  });
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const renderModal = async (project: Project): Promise<ReactTestRenderer> => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <MemoryRouter>
        <ProjectDetailModal project={project} onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await settle();
  });
  return tree;
};

const statusBadge = (tree: ReactTestRenderer): ReactTestInstance =>
  tree.root.find(node => node.type === 'span' && node.props['aria-label'] === 'Project status');

const secretToggle = (tree: ReactTestRenderer): ReactTestInstance =>
  tree.root.find(node => typeof node.props?.className === 'string' && node.props.className.startsWith('btn-secret-toggle'));

const mutationCalls = () =>
  vi.mocked(authenticatedFetch).mock.calls.filter(([, options]) =>
    options?.method && options.method !== 'GET');

const conflictNotices = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll(node => node.props?.['data-testid'] === 'project-conflict');

beforeEach(() => {
  vi.resetAllMocks();
  navigate.mockReset();
});

describe('project mutations are revision-bound', () => {
  test('a mutation sends PATCH with If-Match from the loaded record and adopts the rotated revision', async () => {
    mockBackgroundReads();
    const tree = await renderModal(projectFixture());

    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({
      success: true,
      project: projectFixture({ is_hidden: true, revision: 'rev-project-2' }),
    }));

    await act(async () => {
      secretToggle(tree).props.onClick();
      await settle();
    });

    expect(mutationCalls()).toHaveLength(1);
    const [url, options] = mutationCalls()[0];
    expect(String(url)).toBe(`/api/projects/${projectId}`);
    expect(options?.method).toBe('PATCH');
    expect((options?.headers as Record<string, string>)['If-Match']).toBe('rev-project-1');
    expect(JSON.parse(String(options?.body))).toEqual({ is_hidden: true });

    // The next mutation uses the rotated revision from the response.
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({
      success: true,
      project: projectFixture({ is_hidden: false, revision: 'rev-project-3' }),
    }));
    await act(async () => {
      secretToggle(tree).props.onClick();
      await settle();
    });
    const [, secondOptions] = mutationCalls()[1];
    expect((secondOptions?.headers as Record<string, string>)['If-Match']).toBe('rev-project-2');

    act(() => tree.unmount());
  });

  test('status is a read-only badge — the active·archived subset offers no status editing (A11.1)', async () => {
    mockBackgroundReads();
    const tree = await renderModal(projectFixture());

    expect(statusBadge(tree)).toBeTruthy();
    const actions = tree.root.findByProps({ className: 'project-detail-actions' });
    expect(actions.findAll(node => node.type === 'button' && node.props['aria-controls'])).toHaveLength(1);
    expect(tree.root.findAll(node => node.type === 'select' && node.props['aria-label'] === 'Project status')).toHaveLength(0);

    act(() => tree.unmount());
  });

  test('description save sends PATCH with If-Match', async () => {
    mockBackgroundReads();
    const tree = await renderModal(projectFixture());

    await act(async () => {
      tree.root.find(node => node.props?.title === 'Edit description').props.onClick();
    });
    await act(async () => {
      tree.root
        .find(node => node.props?.className === 'project-description-textarea')
        .props.onChange({ target: { value: 'A sharper description' } });
    });

    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({
      success: true,
      project: projectFixture({ description: 'A sharper description', revision: 'rev-project-2' }),
    }));
    await act(async () => {
      tree.root.find(node => node.props?.className === 'btn-description-save').props.onClick();
      await settle();
    });

    expect(mutationCalls()).toHaveLength(1);
    const [url, options] = mutationCalls()[0];
    expect(String(url)).toBe(`/api/projects/${projectId}`);
    expect(options?.method).toBe('PATCH');
    expect((options?.headers as Record<string, string>)['If-Match']).toBe('rev-project-1');
    expect(JSON.parse(String(options?.body))).toEqual({ description: 'A sharper description' });

    act(() => tree.unmount());
  });
});

describe('412 REVISION_MISMATCH shows the reload conflict notice', () => {
  test('a stale save surfaces the notice; reload fetches the latest record and clears it', async () => {
    mockBackgroundReads();
    const tree = await renderModal(projectFixture());
    expect(conflictNotices(tree)).toHaveLength(0);

    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse(
      { success: false, error: 'Revision mismatch', code: 'REVISION_MISMATCH', message: 'Revision mismatch' },
      412,
    ));
    await act(async () => {
      secretToggle(tree).props.onClick();
      await settle();
    });

    expect(conflictNotices(tree)).toHaveLength(1);
    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('This project changed since it was loaded');

    // Reload action: GET the project, adopt the fresh revision, clear the notice.
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({
      success: true,
      project: projectFixture({ is_hidden: false, revision: 'rev-project-9' }),
    }));
    await act(async () => {
      tree.root.find(node => node.props?.className === 'btn-project-reload').props.onClick();
      await settle();
    });

    const allCalls = vi.mocked(authenticatedFetch).mock.calls;
    const reloadCall = allCalls[allCalls.length - 1];
    expect(String(reloadCall[0])).toBe(`/api/projects/${projectId}`);
    expect(reloadCall[1]?.method ?? 'GET').toBe('GET');
    expect(conflictNotices(tree)).toHaveLength(0);

    // The next mutation is built on the reloaded revision.
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({
      success: true,
      project: projectFixture({ is_hidden: true, revision: 'rev-project-10' }),
    }));
    await act(async () => {
      secretToggle(tree).props.onClick();
      await settle();
    });
    const patches = mutationCalls();
    const [, options] = patches[patches.length - 1];
    expect((options?.headers as Record<string, string>)['If-Match']).toBe('rev-project-9');

    act(() => tree.unmount());
  });
});

describe('project Task rows use the canonical routed Task details page', () => {
  const openTaskRow = async (tree: ReactTestRenderer) => {
    // Switch to the Work section (second section tab), then open the task row.
    // Match the `tab` CLASS TOKEN, not a string prefix: the section tabs are
    // kit buttons now, so their className begins with `btn ...` (482e21fa).
    const workTab = tree.root.findAll(node =>
      node.type === 'button' && String(node.props.className || '').split(/\s+/).includes('tab'))[1];
    await act(async () => {
      workTab.props.onClick();
      await settle();
    });
    const taskRow = tree.root.find(node =>
      String(node.props?.className || '').includes('task-item-clickable'));
    await act(async () => {
      taskRow.props.onClick();
      await settle();
    });
  };

  test('opening a task row on an archived project closes the modal and navigates without PUT/DELETE', async () => {
    mockBackgroundReads([taskFixture]);
    const tree = await renderModal(projectFixture({ status: 'archived' }));

    await openTaskRow(tree);

    expect(navigate).toHaveBeenCalledWith(`/tasks/${taskFixture.id}`);
    expect(mutationCalls()).toHaveLength(0);

    act(() => tree.unmount());
  });

  test('an active project uses the same routed path rather than a nested modal', async () => {
    mockBackgroundReads([taskFixture]);
    const tree = await renderModal(projectFixture());

    await openTaskRow(tree);

    expect(navigate).toHaveBeenCalledWith(`/tasks/${taskFixture.id}`);
    expect(mutationCalls()).toHaveLength(0);

    act(() => tree.unmount());
  });
});

describe('the inbox phase setting (card b13e5ac9, Charter v5 §6.1)', () => {
  const phases = [
    { id: 'phase-1', name: 'Release lane', status: 'in-progress', position: 10, restrictedAccess: false },
    { id: 'phase-inbox', name: 'Inbox - to be sorted', status: 'todo', position: 15, restrictedAccess: false },
    { id: 'phase-secret', name: 'Blind test', status: 'todo', position: 20, restrictedAccess: true },
  ];
  const mockReadsWithPhases = () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/phases')) return jsonResponse({ success: true, phases });
      if (u.includes('/tasks')) return jsonResponse({ success: true, tasks: [] });
      if (u.includes('/sessions')) return jsonResponse({ success: true, sessions: [] });
      if (u.includes('/resources')) return jsonResponse({ success: true, resources: [] });
      return jsonResponse({ success: true });
    });
  };
  const inboxSelect = (tree: ReactTestRenderer): ReactTestInstance =>
    tree.root.find(node => node.type === 'select' && node.props.id === `project-inbox-phase-${projectId}`);
  const optionValues = (select: ReactTestInstance): string[] =>
    select.findAll(node => node.type === 'option').map(node => String(node.props.value));

  test('offers "No inbox phase" and every Phase that can be the inbox - never a restricted one', async () => {
    mockReadsWithPhases();
    const tree = await renderModal(projectFixture());
    const select = inboxSelect(tree);
    expect(select.props.value).toBe('');
    expect(optionValues(select)).toEqual(['', 'phase-1', 'phase-inbox']);
    act(() => tree.unmount());
  });

  test('choosing a Phase PATCHes inboxPhaseId under If-Match and adopts the returned record', async () => {
    mockReadsWithPhases();
    const tree = await renderModal(projectFixture());
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({
      success: true, project: projectFixture({ inboxPhaseId: 'phase-inbox', revision: 'rev-project-2' }),
    }));
    await act(async () => {
      inboxSelect(tree).props.onChange({ target: { value: 'phase-inbox' } });
      await settle();
    });
    expect(mutationCalls()).toHaveLength(1);
    const [url, options] = mutationCalls()[0];
    expect(String(url)).toBe(`/api/projects/${projectId}`);
    expect(options?.method).toBe('PATCH');
    expect((options?.headers as Record<string, string>)['If-Match']).toBe('rev-project-1');
    expect(JSON.parse(String(options?.body))).toEqual({ inboxPhaseId: 'phase-inbox' });
    expect(inboxSelect(tree).props.value).toBe('phase-inbox');

    // Clearing sends null under the rotated revision.
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({
      success: true, project: projectFixture({ inboxPhaseId: null, revision: 'rev-project-3' }),
    }));
    await act(async () => {
      inboxSelect(tree).props.onChange({ target: { value: '' } });
      await settle();
    });
    const [, second] = mutationCalls()[1];
    expect((second?.headers as Record<string, string>)['If-Match']).toBe('rev-project-2');
    expect(JSON.parse(String(second?.body))).toEqual({ inboxPhaseId: null });
    act(() => tree.unmount());
  });

  test('a stale save surfaces the conflict notice', async () => {
    mockReadsWithPhases();
    const tree = await renderModal(projectFixture());
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({ success: false, code: 'REVISION_MISMATCH' }, 412));
    await act(async () => {
      inboxSelect(tree).props.onChange({ target: { value: 'phase-inbox' } });
      await settle();
    });
    expect(conflictNotices(tree)).toHaveLength(1);
    act(() => tree.unmount());
  });

  test('a stored inbox phase that is no longer in force stays shown, marked suspended', async () => {
    mockReadsWithPhases();
    const tree = await renderModal(projectFixture({ inboxPhaseId: 'phase-secret' }));
    const select = inboxSelect(tree);
    expect(select.props.value).toBe('phase-secret');
    const suspended = select.findAll(node => node.type === 'option' && node.props.value === 'phase-secret');
    expect(suspended).toHaveLength(1);
    expect(JSON.stringify(suspended[0].children)).toContain('(suspended)');
    act(() => tree.unmount());
  });

  test('an archived Project shows the setting read-only', async () => {
    mockReadsWithPhases();
    const tree = await renderModal(projectFixture({ status: 'archived', inboxPhaseId: 'phase-inbox' }));
    expect(inboxSelect(tree).props.disabled).toBe(true);
    act(() => tree.unmount());
  });

  test('the Work tab quick create sends no status and no phase, so the server files it in the inbox', async () => {
    mockReadsWithPhases();
    const tree = await renderModal(projectFixture({ inboxPhaseId: 'phase-inbox' }));
    const workTab = tree.root.findAll(node =>
      node.type === 'button' && String(node.props.className || '').split(/\s+/).includes('tab'))[1];
    await act(async () => { workTab.props.onClick(); await settle(); });
    const openForm = tree.root.find(node => node.type === 'button' && String(node.props.className || '').includes('btn-create-task'));
    await act(async () => { openForm.props.onClick(); await settle(); });
    const title = tree.root.find(node => node.type === 'input' && node.props.className === 'create-task-input');
    await act(async () => { title.props.onChange({ target: { value: 'Quick card' } }); await settle(); });
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(jsonResponse({ success: true, task: { ...taskFixture, title: 'Quick card' } }, 201));
    const save = tree.root.find(node => node.type === 'button' && String(node.props.className || '').includes('btn-save-link'));
    await act(async () => { save.props.onClick(); await settle(); });
    const posts = mutationCalls().filter(([url, options]) => String(url) === '/api/tasks' && options?.method === 'POST');
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0][1]?.body));
    expect(body).toMatchObject({ title: 'Quick card', project: 'Demo project' });
    expect('status' in body).toBe(false);
    expect('phaseId' in body).toBe(false);
    act(() => tree.unmount());
  });
});

describe('project removal surface', () => {
  test('the modal offers Archive and no project delete control', async () => {
    mockBackgroundReads();
    const tree = await renderModal(projectFixture());

    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('Archive');
    expect(serialized).not.toContain('Delete forever');
    expect(serialized).not.toContain('btn-delete-project');
    expect(serialized).not.toContain('Delete project');

    act(() => tree.unmount());
  });
});

describe('control kit consumption', () => {
  test('the module imports the ratified kit controls (Button, IconButton)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'projects', 'ProjectDetailModal.tsx'),
      'utf8',
    );
    expect(source).toContain("from '../Button'");
    expect(source).toContain("from '../ui/IconButton'");
  });
});

describe('Blueprint entry and provenance on the Project', () => {
  const blueprintReads = (scopes: string[]) => {
    vi.mocked(authenticatedFetch).mockImplementation(async url => {
      const value = String(url);
      if (value.endsWith('/principals/me')) return jsonResponse({ principal: { id: 'caller-one', handle: 'caller' }, scopes });
      if (value.includes('/tasks')) return jsonResponse({ success: true, tasks: [] });
      if (value.includes('/sessions')) return jsonResponse({ success: true, sessions: [] });
      if (value.includes('/resources')) return jsonResponse({ success: true, resources: [] });
      return jsonResponse({ success: true });
    });
  };
  const childText = (children: (ReactTestInstance | string)[]): string => children.map(child => typeof child === 'string' ? child : childText(child.children)).join('');
  const entryButtons = (tree: ReactTestRenderer) => tree.root.findAll(node => node.type === 'button' && childText(node.children).includes('Use a Blueprint in this Project'));
  test('a use-capable caller enters the registry with the existing Project preserved', async () => {
    blueprintReads(['blueprints:use']); const tree = await renderModal(projectFixture());
    expect(entryButtons(tree)).toHaveLength(1); await act(async () => entryButtons(tree)[0].props.onClick());
    expect(navigate).toHaveBeenCalledWith(`/blueprints?project=${projectId}`); expect(mutationCalls()).toHaveLength(0); tree.unmount();
  });
  test('the entry is hidden without use authority and disabled on an archived Project', async () => {
    blueprintReads(['blueprints:read']); const hidden = await renderModal(projectFixture()); expect(entryButtons(hidden)).toHaveLength(0); hidden.unmount();
    blueprintReads(['blueprints:use']); const archived = await renderModal(projectFixture({ status: 'archived' })); expect(entryButtons(archived)[0].props.disabled).toBe(true); archived.unmount();
  });
  test('the immutable provenance stamp links to Blueprint and ledger with no upgrade act', async () => {
    blueprintReads([]); const tree = await renderModal(projectFixture({ blueprintKey: 'incident-investigation', blueprintVersion: 2, instantiationId: 'instance-one' }));
    const links = tree.root.findAll(node => node.type === 'a').map(node => node.props.href);
    expect(links).toContain('/blueprints?blueprint=incident-investigation'); expect(links).toContain('/blueprints?blueprint=incident-investigation&instantiation=instance-one');
    expect(JSON.stringify(tree.toJSON())).toContain('publishing a newer version does not update this Project'); expect(mutationCalls()).toHaveLength(0); tree.unmount();
  });
});
