import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../utils/auth';
import type { Project } from '../../types/project';
import { ProjectOwnerPanel } from './ProjectOwnerPanel';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const project: Project = {
  id, name: 'Example', description: '', goal: null, status: 'active',
  ownerPrincipalId: owner, revision: 'rev-1', is_hidden: false,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};
const access = (allowed: boolean, reason: string | null = null) => ({
  success: true, access: { allowed, reason, owner: { id: owner, handle: 'owner', displayName: 'Owner', status: 'active' } },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const props = () => ({ project, onChanged: vi.fn(), onReload: vi.fn(), onUnavailable: vi.fn() });
const rendered = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());

beforeEach(() => { vi.resetAllMocks(); });

test('pending eligibility is loading, not falsely empty or authorized', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(authenticatedFetch).mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
  const input = props(); let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); });
  expect(rendered(tree)).toContain('Loading current ownership and access');
  expect(rendered(tree)).not.toContain('Unassigned');
  expect(tree.root.findAllByType('select')).toHaveLength(0);
  await act(async () => { resolve(json(access(false, 'CURRENT_ROLE_CEILING'))); await settle(); });
  expect(rendered(tree)).toContain('role cannot administer Projects');
  expect(rendered(tree)).toContain('Current owner:');
  expect(tree.root.findAllByType('select')).toHaveLength(0);
  act(() => tree.unmount());
});

test('failed lookup is unknown, never an empty owner assertion', async () => {
  vi.mocked(authenticatedFetch).mockRejectedValue(new Error('offline'));
  const input = props(); let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); await settle(); });
  expect(rendered(tree)).toContain('could not be verified');
  expect(rendered(tree)).not.toContain('Unassigned');
  expect(tree.root.findAllByType('select')).toHaveLength(0);
  act(() => tree.unmount());
});

test('eligible administrator confirms a revision-bound transfer; stale revision reloads instead of retrying', async () => {
  const input = props();
  vi.mocked(authenticatedFetch).mockImplementation(async (url, options) => {
    if (options?.method === 'PUT') return json({ success: false, code: 'REVISION_MISMATCH' }, 412);
    if (String(url).endsWith('/owner-candidates')) return json({ success: true, candidates: [
      { id: owner, handle: 'owner', displayName: 'Owner' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', handle: 'next', displayName: 'Next' },
    ] });
    return json(access(true));
  });
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); await settle(); });
  expect(rendered(tree)).toContain('Current owner:');
  expect(tree.root.findAllByType('select')).toHaveLength(1);
  await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }); });
  await act(async () => { tree.root.findAllByType('button').find(button => button.props.children === 'Review owner change')!.props.onClick(); });
  await act(async () => { tree.root.findAllByType('button').find(button => button.props.children === 'Confirm owner change')!.props.onClick(); await settle(); });
  const write = vi.mocked(authenticatedFetch).mock.calls.find(([, options]) => options?.method === 'PUT')!;
  expect(String(write[0])).toBe(`/api/projects/${id}/owner`);
  expect((write[1]?.headers as Record<string, string>)['If-Match']).toBe('rev-1');
  expect(JSON.parse(String(write[1]?.body))).toEqual({ ownerPrincipalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  expect(input.onReload).toHaveBeenCalledTimes(1);
  expect(input.onChanged).not.toHaveBeenCalled();
  expect(rendered(tree)).toContain('Project changed');
  act(() => tree.unmount());
});

test('focus revalidation keeps an unsaved owner draft and Review; only explicit confirmation writes', async () => {
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  vi.stubGlobal('window', new EventTarget());
  try {
    const input = props();
    vi.mocked(authenticatedFetch).mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') return json({ success: true, project: { ...project, ownerPrincipalId: next, revision: 'rev-2' } });
      if (String(url).endsWith('/owner-candidates')) return json({ success: true, candidates: [
        { id: owner, handle: 'owner', displayName: 'Owner' },
        { id: next, handle: 'next', displayName: 'Next' },
      ] });
      return json(access(true));
    });
    let tree!: ReactTestRenderer;
    await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); await settle(); });
    await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: next } }); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await settle(); });
    expect(tree.root.findByType('select').props.value).toBe(next);
    expect(tree.root.findAllByType('button').some(button => button.props.children === 'Review owner change')).toBe(true);
    await act(async () => { tree.root.findAllByType('button').find(button => button.props.children === 'Review owner change')!.props.onClick(); });
    const reads = vi.mocked(authenticatedFetch).mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); await settle(); });
    expect(vi.mocked(authenticatedFetch).mock.calls.length).toBeGreaterThan(reads);
    expect(rendered(tree)).not.toContain('Loading current ownership');
    expect(tree.root.findByType('select').props.value).toBe(next);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    expect(input.onChanged).not.toHaveBeenCalled();
    await act(async () => { tree.root.findAllByType('button').find(button => button.props.children === 'Confirm owner change')!.props.onClick(); await settle(); });
    const writes = vi.mocked(authenticatedFetch).mock.calls.filter(([, options]) => options?.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ ownerPrincipalId: next });
    expect(input.onChanged).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  } finally {
    vi.unstubAllGlobals();
  }
});

test('focus revalidation drops the draft when the verified owner changed elsewhere', async () => {
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  vi.stubGlobal('window', new EventTarget());
  try {
    let currentOwner = owner;
    vi.mocked(authenticatedFetch).mockImplementation(async url => {
      if (String(url).endsWith('/owner-candidates')) return json({ success: true, candidates: [
        { id: owner, handle: 'owner', displayName: 'Owner' },
        { id: next, handle: 'next', displayName: 'Next' },
        { id: other, handle: 'other', displayName: 'Other' },
      ] });
      return json({ success: true, access: { allowed: true, reason: null, owner: { id: currentOwner, handle: 'x', displayName: null, status: 'active' } } });
    });
    let tree!: ReactTestRenderer;
    await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...props()} />); await settle(); });
    await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: next } }); });
    await act(async () => { tree.root.findAllByType('button').find(button => button.props.children === 'Review owner change')!.props.onClick(); });
    currentOwner = other;
    await act(async () => { window.dispatchEvent(new Event('focus')); await settle(); });
    expect(tree.root.findByType('select').props.value).toBe(other);
    expect(tree.root.findAllByType('button').some(button => button.props.children === 'Confirm owner change')).toBe(false);
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    act(() => tree.unmount());
  } finally {
    vi.unstubAllGlobals();
  }
});

test('denied actor stays denied across focus revalidation and never writes', async () => {
  vi.stubGlobal('window', new EventTarget());
  try {
    vi.mocked(authenticatedFetch).mockImplementation(async () => json(access(false, 'NO_PROJECT_ADMIN')));
    let tree!: ReactTestRenderer;
    await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...props()} />); await settle(); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await settle(); });
    expect(rendered(tree)).toContain('do not currently have Project administration authority');
    expect(tree.root.findAllByType('select')).toHaveLength(0);
    expect(tree.root.findAllByType('button')).toHaveLength(0);
    const calls = vi.mocked(authenticatedFetch).mock.calls;
    expect(calls.filter(([url]) => String(url).endsWith('/owner-access')).length).toBe(2);
    expect(calls.some(([url, options]) => options?.method === 'PUT' || String(url).endsWith('/owner-candidates'))).toBe(false);
    act(() => tree.unmount());
  } finally {
    vi.unstubAllGlobals();
  }
});

test('concealed Project closes owner controls and failed candidates forbid mutation', async () => {
  const input = props();
  vi.mocked(authenticatedFetch).mockResolvedValue(json({}, 404));
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); await settle(); });
  expect(input.onUnavailable).toHaveBeenCalledTimes(1);
  expect(tree.root.findAllByType('select')).toHaveLength(0);
  act(() => tree.unmount());

  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).endsWith('/owner-candidates') ? json({}, 503) : json(access(true)));
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...props()} />); await settle(); });
  expect(rendered(tree)).toContain('Eligible Account choices are unavailable');
  expect(tree.root.findAllByType('select')).toHaveLength(0);
  act(() => tree.unmount());
});

const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAllByType('button').find(candidate => candidate.props.children === label);
const puts = () => vi.mocked(authenticatedFetch).mock.calls.filter(([, options]) => options?.method === 'PUT');

test('refused write closes Confirm even when refreshed authority is unchanged; a retry needs a new Review', async () => {
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const input = props();
  vi.mocked(authenticatedFetch).mockImplementation(async (url, options) => {
    if (options?.method === 'PUT') return json({ success: false, code: 'OWNER_CHANGE_REFUSED' }, 409);
    if (String(url).endsWith('/owner-candidates')) return json({ success: true, candidates: [
      { id: owner, handle: 'owner', displayName: 'Owner' },
      { id: next, handle: 'next', displayName: 'Next' },
    ] });
    return json(access(true));
  });
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); await settle(); });
  await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: next } }); });
  await act(async () => { button(tree, 'Review owner change')!.props.onClick(); });
  const reads = vi.mocked(authenticatedFetch).mock.calls.length;
  await act(async () => { button(tree, 'Confirm owner change')!.props.onClick(); await settle(); await settle(); });
  expect(vi.mocked(authenticatedFetch).mock.calls.length).toBeGreaterThan(reads + 1);
  expect(rendered(tree)).toContain('Ownership could not be changed');
  expect(tree.root.findByType('select').props.value).toBe(next);
  expect(button(tree, 'Confirm owner change')).toBeUndefined();
  expect(button(tree, 'Review owner change')).toBeDefined();
  expect(puts()).toHaveLength(1);
  expect(input.onReload).not.toHaveBeenCalled();
  await act(async () => { button(tree, 'Review owner change')!.props.onClick(); });
  await act(async () => { button(tree, 'Confirm owner change')!.props.onClick(); await settle(); await settle(); });
  expect(puts()).toHaveLength(2);
  expect(input.onChanged).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

test('background 404 fails closed even when the parent keeps the panel mounted', async () => {
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  vi.stubGlobal('window', new EventTarget());
  try {
    let concealed = false;
    const input = props();
    vi.mocked(authenticatedFetch).mockImplementation(async url => {
      if (concealed) return json({}, 404);
      if (String(url).endsWith('/owner-candidates')) return json({ success: true, candidates: [
        { id: owner, handle: 'owner', displayName: 'Owner' },
        { id: next, handle: 'next', displayName: 'Next' },
      ] });
      return json(access(true));
    });
    let tree!: ReactTestRenderer;
    await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); await settle(); });
    await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: next } }); });
    await act(async () => { button(tree, 'Review owner change')!.props.onClick(); });
    concealed = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); await settle(); });
    expect(input.onUnavailable).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByType('select')).toHaveLength(0);
    expect(tree.root.findAllByType('button')).toHaveLength(0);
    expect(rendered(tree)).toContain('could not be verified');
    expect(rendered(tree)).not.toContain('Current owner:');
    expect(puts()).toHaveLength(0);
    act(() => tree.unmount());
  } finally {
    vi.unstubAllGlobals();
  }
});

test('focus revalidation resets draft and Review when the selected candidate is no longer eligible', async () => {
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  vi.stubGlobal('window', new EventTarget());
  try {
    let eligible = true;
    vi.mocked(authenticatedFetch).mockImplementation(async url => {
      if (String(url).endsWith('/owner-candidates')) return json({ success: true, candidates: [
        { id: owner, handle: 'owner', displayName: 'Owner' },
        ...(eligible ? [{ id: next, handle: 'next', displayName: 'Next' }] : []),
      ] });
      return json(access(true));
    });
    let tree!: ReactTestRenderer;
    await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...props()} />); await settle(); });
    await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: next } }); });
    await act(async () => { button(tree, 'Review owner change')!.props.onClick(); });
    eligible = false;
    await act(async () => { window.dispatchEvent(new Event('focus')); await settle(); });
    expect(tree.root.findByType('select').props.value).toBe(owner);
    expect(button(tree, 'Confirm owner change')).toBeUndefined();
    expect(button(tree, 'Review owner change')).toBeUndefined();
    expect(puts()).toHaveLength(0);
    act(() => tree.unmount());
  } finally {
    vi.unstubAllGlobals();
  }
});

// AZ-A12 clauses 9(e) and 12 (card 311229fd): the owner selector offers the
// Groups the server lists, and a transfer involving a Group carries a step-up
// bound to (ownership.transfer, this Project) before anything is written.
test('the selector offers Groups; a Group target asks for the step-up first and sends it with the transfer', async () => {
  const group = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const input = props();
  vi.mocked(authenticatedFetch).mockImplementation(async (url, options) => {
    if (options?.method === 'PUT') return json({ success: true, project: { ...project, ownerPrincipalId: group, revision: 'rev-2' } });
    if (String(url).endsWith('/owner-candidates')) return json({ success: true,
      candidates: [{ id: owner, handle: 'owner', displayName: 'Owner' }],
      groups: [{ id: group, name: 'Platform team', featured: true }] });
    if (String(url).includes('/auth/step-up/methods')) return json({ success: true, methods: ['password'] });
    return json(access(true));
  });
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...input} />); await settle(); });
  expect(tree.root.findAllByType('optgroup').map(node => node.props.label)).toEqual(['Accounts', 'Groups']);
  expect(rendered(tree)).toContain('Platform team');
  await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: group } }); });
  await act(async () => { button(tree, 'Review owner change')!.props.onClick(); });
  await act(async () => { void button(tree, 'Confirm owner change')!.props.onClick(); await settle(); });
  expect(puts()).toHaveLength(0);
  const { StepUpDialog } = await import('../access/StepUpDialog');
  const dialog = tree.root.findByType(StepUpDialog);
  expect([dialog.props.action, dialog.props.targetId]).toEqual(['ownership.transfer', id]);
  await act(async () => { dialog.props.onToken('step-up-token'); await settle(); await settle(); });
  expect(puts()).toHaveLength(1);
  expect(JSON.parse(String(puts()[0][1]?.body))).toEqual({ ownerPrincipalId: group, stepUpToken: 'step-up-token' });
  expect(input.onChanged).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

test('with no groups listed the selector is unchanged and a person transfer sends no step-up', async () => {
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  vi.mocked(authenticatedFetch).mockImplementation(async (url, options) => {
    if (options?.method === 'PUT') return json({ success: true, project: { ...project, ownerPrincipalId: next } });
    if (String(url).endsWith('/owner-candidates')) return json({ success: true, groups: [], candidates: [
      { id: owner, handle: 'owner', displayName: 'Owner' }, { id: next, handle: 'next', displayName: 'Next' }] });
    return json(access(true));
  });
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<ProjectOwnerPanel {...props()} />); await settle(); });
  expect(tree.root.findAllByType('optgroup')).toHaveLength(0);
  await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: next } }); });
  await act(async () => { button(tree, 'Review owner change')!.props.onClick(); });
  await act(async () => { button(tree, 'Confirm owner change')!.props.onClick(); await settle(); });
  expect(JSON.parse(String(puts()[0][1]?.body))).toEqual({ ownerPrincipalId: next });
  act(() => tree.unmount());
});
