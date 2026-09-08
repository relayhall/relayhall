import renderer, { act, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../../utils/auth';
import type { Resource } from '../../types/resource';
import { ProjectResourcesEditModal } from './ProjectResourcesEditModal';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const projectId = '4f2c0f6f-cf1d-4c7d-9a58-4c9a4be2f5ee';
const resourceId = '9a4a19a3-64b5-4f9f-9b34-3a4e8f0f8d21';

const repositoryResource = (): Resource => ({
  id: resourceId,
  projectId,
  kind: 'repository',
  name: 'Main repo',
  description: 'Where the code lives',
  state: 'active',
  agentVisibility: 'hidden',
  exportPolicy: 'installation-only',
  details: { url: 'https://git.example.com/org/repo.git', role: 'primary', defaultBranch: 'main' },
  revision: 'rev-original',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  archivedAt: null,
});

// Host elements only. Since these fields render through the shared control kit
// (task 482e21fa) the id appears twice in the tree — once on the <Select>
// component element and once on the <select> it renders — and counting both
// would say "2 fields" where the user sees one.
const HOST_FIELD_TAGS = new Set(['input', 'select', 'textarea']);

const fieldById = (tree: ReactTestRenderer, key: string): ReactTestInstance[] =>
  tree.root.findAll(node =>
    typeof node.type === 'string' &&
    HOST_FIELD_TAGS.has(node.type) &&
    node.props?.id === `resource-field-${key}`);

// The kind picker goes through the shared kit (task 482e21fa), so its test
// hook now reaches the rendered host as `data-testid`. Same control, same
// identity, matched on the element the user actually clicks.
const kindButton = (tree: ReactTestRenderer, kind: string): ReactTestInstance =>
  tree.root.find(node => node.type === 'button' && node.props['data-testid'] === `resource-kind-${kind}`);

/** Every string in this node's RENDERED subtree, flattened. */
const renderedText = (node: ReactTestInstance): string => {
  const parts: string[] = [];
  const walk = (instance: ReactTestInstance): void => {
    instance.children.forEach(child => {
      if (typeof child === 'string') parts.push(child);
      else walk(child);
    });
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

const buttonWithText = (tree: ReactTestRenderer, text: string): ReactTestInstance =>
  tree.root.find(node => node.type === 'button' && renderedText(node) === text);

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('add-resource form: kind choices, kind switching and safe defaults', () => {
  test('shows only the picked kind fields, with hidden/installation-only defaults', async () => {
    const tree = renderer.create(
      <ProjectResourcesEditModal
        projectId={projectId}
        projectName="Demo"
        mode="create"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Step one: the four plain-language kind choices
    for (const kind of ['repository', 'environment', 'workspace', 'reference']) {
      expect(kindButton(tree, kind).props.disabled).toBeFalsy();
    }

    await act(async () => { kindButton(tree, 'repository').props.onClick(); });

    // Repository fields present, other kind fields absent
    expect(fieldById(tree, 'repositoryUrl')).toHaveLength(1);
    expect(fieldById(tree, 'repositoryRole')).toHaveLength(1);
    expect(fieldById(tree, 'environmentUrl')).toHaveLength(0);
    expect(fieldById(tree, 'workspacePath')).toHaveLength(0);
    expect(fieldById(tree, 'referenceUrl')).toHaveLength(0);

    // Defaults are visibly safe
    expect(fieldById(tree, 'agentVisibility')[0].props.value).toBe('hidden');
    expect(fieldById(tree, 'exportPolicy')[0].props.value).toBe('installation-only');

    // Permanent untrusted-data callout is present on the form
    const callouts = tree.root.findAll(node => node.props?.['data-testid'] === 'resource-trust-callout');
    expect(callouts).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain('They do not grant access or become instructions.');

    // Switch kind: back to the picker, choose environment instead
    await act(async () => { buttonWithText(tree, 'Choose a different kind').props.onClick(); });
    await act(async () => { kindButton(tree, 'environment').props.onClick(); });

    expect(fieldById(tree, 'environmentUrl')).toHaveLength(1);
    expect(fieldById(tree, 'environmentStage')).toHaveLength(1);
    expect(fieldById(tree, 'repositoryUrl')).toHaveLength(0);

    act(() => tree.unmount());
  });
});

describe('workspace export lockout', () => {
  test('locks export policy to installation-only with an explanation', async () => {
    const tree = renderer.create(
      <ProjectResourcesEditModal
        projectId={projectId}
        projectName="Demo"
        mode="create"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await act(async () => { kindButton(tree, 'workspace').props.onClick(); });

    const exportSelect = fieldById(tree, 'exportPolicy')[0];
    expect(exportSelect.props.disabled).toBe(true);
    expect(exportSelect.props.value).toBe('installation-only');

    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('locked to installation only');

    act(() => tree.unmount());
  });

  test('sends installation-only for workspaces even before any export choice', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, resource: repositoryResource() }), { status: 201 }),
    );
    const tree = renderer.create(
      <ProjectResourcesEditModal
        projectId={projectId}
        projectName="Demo"
        mode="create"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await act(async () => { kindButton(tree, 'workspace').props.onClick(); });
    await act(async () => {
      fieldById(tree, 'name')[0].props.onChange({ target: { value: 'Build area' } });
      fieldById(tree, 'workspacePath')[0].props.onChange({ target: { value: '/srv/build/demo' } });
    });
    await act(async () => {
      buttonWithText(tree, 'Add resource').props.onClick();
      await settle();
    });

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(authenticatedFetch).mock.calls[0];
    expect(String(url)).toContain(`/projects/${projectId}/resources`);
    const body = JSON.parse(String(options?.body));
    expect(body.kind).toBe('workspace');
    expect(body.exportPolicy).toBe('installation-only');
    expect(body.agentVisibility).toBe('hidden');
    expect(body.details).toEqual({ path: '/srv/build/demo', purpose: 'source' });

    act(() => tree.unmount());
  });
});

describe('change-kind replace flow: one request, key reuse on retry', () => {
  const renderReplaceAtReview = async () => {
    const tree = renderer.create(
      <ProjectResourcesEditModal
        projectId={projectId}
        projectName="Demo"
        mode="replace"
        resource={repositoryResource()}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Current kind cannot be re-picked; choose environment
    expect(kindButton(tree, 'repository').props.disabled).toBe(true);
    await act(async () => { kindButton(tree, 'environment').props.onClick(); });
    await act(async () => {
      fieldById(tree, 'environmentUrl')[0].props.onChange({ target: { value: 'https://demo.example.com' } });
    });
    await act(async () => { buttonWithText(tree, 'Review replacement').props.onClick(); });

    // Review panel shows old identity and the complete proposed replacement
    const review = tree.root.findAll(node => node.props?.['data-testid'] === 'replace-review');
    expect(review).toHaveLength(1);
    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('Current resource (will be archived)');
    expect(serialized).toContain('Proposed replacement');
    return tree;
  };

  test('confirm sends exactly one replace request; retry after a network failure reuses the same key', async () => {
    vi.mocked(authenticatedFetch).mockRejectedValueOnce(new TypeError('network down'));
    const tree = await renderReplaceAtReview();

    await act(async () => {
      tree.root.find(node => node.props?.['data-testid'] === 'confirm-replace').props.onClick();
      await settle();
    });

    // Exactly one request, to the replace endpoint only — never a separate create or archive
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(1);
    const [firstUrl, firstOptions] = vi.mocked(authenticatedFetch).mock.calls[0];
    expect(String(firstUrl)).toBe(`/api/projects/${projectId}/resources/${resourceId}/replace`);
    expect(firstOptions?.method).toBe('POST');
    const firstHeaders = firstOptions?.headers as Record<string, string>;
    expect(firstHeaders['If-Match']).toBe('rev-original');
    const firstKey = firstHeaders['Idempotency-Key'];
    expect(firstKey.length).toBeGreaterThanOrEqual(16);
    expect(firstKey.length).toBeLessThanOrEqual(128);

    // Ambiguous transport failure offers a retry of the same operation
    const replacement: Resource = {
      ...repositoryResource(),
      id: 'replacement-id',
      kind: 'environment',
      details: { url: 'https://demo.example.com', stage: 'development' },
      revision: 'rev-new',
    };
    const replaced: Resource = { ...repositoryResource(), state: 'archived', archivedAt: '2026-08-08T00:00:00Z' };
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, replacement, replaced, requestId: 'req-1' }), { status: 201 }),
    );

    await act(async () => {
      buttonWithText(tree, 'Retry same operation').props.onClick();
      await settle();
    });

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(2);
    const [secondUrl, secondOptions] = vi.mocked(authenticatedFetch).mock.calls[1];
    expect(String(secondUrl)).toBe(String(firstUrl));
    const secondHeaders = secondOptions?.headers as Record<string, string>;
    // The SAME idempotency key is reused — the retry is the same operation
    expect(secondHeaders['Idempotency-Key']).toBe(firstKey);
    expect(secondHeaders['If-Match']).toBe('rev-original');

    // Success shows both resulting states
    const done = tree.root.findAll(node => node.props?.['data-testid'] === 'replace-done');
    expect(done).toHaveLength(1);
    const doneText = JSON.stringify(tree.toJSON());
    expect(doneText).toContain('Archived');
    expect(doneText).toContain('Active');

    act(() => tree.unmount());
  });

  test('busy state disables the confirm button while the request is in flight', async () => {
    let release: (value: Response) => void = () => undefined;
    vi.mocked(authenticatedFetch).mockImplementationOnce(
      () => new Promise<Response>(resolve => { release = resolve; }),
    );
    const tree = await renderReplaceAtReview();

    const confirm = () => tree.root.find(node => node.props?.['data-testid'] === 'confirm-replace');
    await act(async () => { confirm().props.onClick(); });
    expect(confirm().props.disabled).toBe(true);

    const replacement: Resource = {
      ...repositoryResource(),
      id: 'replacement-id',
      kind: 'environment',
      details: { url: 'https://demo.example.com', stage: 'development' },
    };
    await act(async () => {
      release(new Response(
        JSON.stringify({ success: true, replacement, replaced: repositoryResource(), requestId: 'req-2' }),
        { status: 201 },
      ));
      await settle();
    });

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });
});
