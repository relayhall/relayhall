// @vitest-environment jsdom
/*
 * Card f87776ad (owner ruling D37(d)). A human session's "New draft -> Save
 * immutable draft" answered 409 SKILL_LIFECYCLE_CONFLICT because the form
 * inherited the provenance of the Version it was pre-filled from: a Skill whose
 * current Version a Connector drafted ("agent-drafted") preselected Agent-drafted
 * for a human, which the server never accepts from a human creator. These tests
 * pin the default to the SESSION's kind and keep the illegal option out.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../utils/auth';
import type { Skill, SkillVersion } from '../../types/skill';
import { SkillDetailModal } from './SkillDetailModal';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
const fetchMock = vi.mocked(authenticatedFetch);
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SKILL_MD = '---\nname: connector-bootstrap\ndescription: Bootstrap a Connector\n---\n\nConnect first.\n';
const agentDrafted: SkillVersion = {
  id: 'v1', skill_id: 's1', version: 1, content_sha256: 'a'.repeat(64), description: 'Bootstrap a Connector',
  category: null, tags: [], config: {}, provenance: 'agent-drafted', source_uri: null,
  created_by_principal_id: 'connector-1', created_at: '2026-10-08T20:00:00.000Z', status: 'published',
  status_note: null, status_changed_at: '2026-10-08T20:00:00.000Z',
};
const skill = {
  id: 's1', name: 'connector-bootstrap', is_global: false, current_published_version_id: 'v1', revision: REVISION,
  created_at: agentDrafted.created_at, updated_at: agentDrafted.created_at, current_version: agentDrafted,
  published_version: agentDrafted, version: 1, status: 'published', category: null,
  description: agentDrafted.description, tags: [], config: {}, provenance: 'agent-drafted', content_sha256: agentDrafted.content_sha256,
} as Skill;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Writes = Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }>;

function serve(kind: 'human' | 'service' | null, write: (body: Record<string, unknown>) => Response = () =>
  json({ success: true, skill }, 201)): Writes {
  const writes: Writes = [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (url.endsWith('/principals/me')) {
      return kind ? json({ success: true, principal: { id: 'me', handle: 'ada', kind, status: 'active' }, scopes: ['root'] })
        : json({ success: false, error: 'No principal' }, 404);
    }
    if (method === 'GET' && url.endsWith('/skills/s1/versions')) return json({ success: true, versions: [agentDrafted] });
    if (method === 'GET' && url.endsWith('/skills/s1/versions/v1/content')) {
      return json({ success: true, version: { ...agentDrafted, skill_md: SKILL_MD } });
    }
    if (method === 'PUT' || method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ url, method, headers: init?.headers as Record<string, string>, body });
      return write(body);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return writes;
}

const offered = (select: HTMLElement) => within(select).getAllByRole('option').map(option => option.textContent);

async function openNewDraft(onSaved = vi.fn()) {
  const user = userEvent.setup();
  render(<SkillDetailModal skill={skill} onClose={vi.fn()} onSaved={onSaved} onDeleted={vi.fn()} />);
  // The loaded Version is the Connector's: the view shows its provenance.
  await waitFor(() => expect(screen.getByText('Connect first.', { exact: false })).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'New draft' }));
  return { user, onSaved };
}

test('a human session drafts from an agent-drafted Version as human-authored, in one click', async () => {
  const writes = serve('human');
  const { user, onSaved } = await openNewDraft();
  const select = screen.getByLabelText('Provenance') as HTMLSelectElement;
  // The red proof on main: this read 'agent-drafted', the loaded Version's provenance.
  expect(select.value).toBe('human-authored');
  await waitFor(() => expect(offered(select)).toEqual(['Human-authored', 'Imported']));
  expect(select.value).toBe('human-authored');
  await user.click(screen.getByRole('button', { name: 'Save immutable draft' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual(expect.objectContaining({ method: 'PUT', url: expect.stringMatching(/\/skills\/s1$/) }));
  expect(writes[0].headers['If-Match']).toBe(REVISION);
  expect(writes[0].body.provenance).toBe('human-authored');
  expect(screen.queryByText(/Illegal Skill lifecycle change/)).not.toBeInTheDocument();
});

test('a human session creating a Skill defaults to human-authored and is never offered Agent-drafted', async () => {
  const writes = serve('human');
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<SkillDetailModal skill={null} onClose={vi.fn()} onSaved={onSaved} onDeleted={vi.fn()} />);
  const select = screen.getByLabelText('Provenance') as HTMLSelectElement;
  await waitFor(() => expect(offered(select)).toEqual(['Human-authored', 'Imported']));
  expect(select.value).toBe('human-authored');
  await user.type(screen.getByLabelText('Agent Skills name *'), 'review-checklist');
  await user.click(screen.getByRole('button', { name: 'Save immutable draft' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(writes).toEqual([expect.objectContaining({ method: 'POST', body: expect.objectContaining({ provenance: 'human-authored' }) })]);
});

test('a choice made for one draft does not leak into the next New draft', async () => {
  serve('human');
  const { user } = await openNewDraft();
  const select = screen.getByLabelText('Provenance') as HTMLSelectElement;
  await waitFor(() => expect(offered(select)).toEqual(['Human-authored', 'Imported']));
  await user.selectOptions(select, 'imported');
  expect(select.value).toBe('imported');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'New draft' }));
  expect((screen.getByLabelText('Provenance') as HTMLSelectElement).value).toBe('human-authored');
});

test('the mirror: a service session defaults to agent-drafted and is never offered Human-authored', async () => {
  const writes = serve('service');
  const { user, onSaved } = await openNewDraft();
  const select = screen.getByLabelText('Provenance') as HTMLSelectElement;
  await waitFor(() => expect(offered(select)).toEqual(['Agent-drafted', 'Imported']));
  expect(select.value).toBe('agent-drafted');
  await user.click(screen.getByRole('button', { name: 'Save immutable draft' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(writes[0].body.provenance).toBe('agent-drafted');
});

test('with the session kind unresolved every option stays and the server refusal names the provenance', async () => {
  const refusal = "provenance 'agent-drafted' cannot be recorded by a human Principal: agent-drafted provenance requires an agent or service Principal; a human Principal may record human-authored or imported";
  const writes = serve(null, () => json({ success: false, code: 'INVALID_SKILL_VALUE', error: refusal, message: refusal,
    details: { field: 'provenance', provenance: 'agent-drafted', principalKind: 'human', allowed: ['human-authored', 'imported'] } }, 422));
  const onSaved = vi.fn();
  const { user } = await openNewDraft(onSaved);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/principals\/me$/)));
  const select = screen.getByLabelText('Provenance') as HTMLSelectElement;
  expect(offered(select)).toEqual(['Human-authored', 'Imported', 'Agent-drafted']);
  expect(select.value).toBe('human-authored');
  await user.selectOptions(select, 'agent-drafted');
  await user.click(screen.getByRole('button', { name: 'Save immutable draft' }));
  expect(await screen.findByText(refusal, { exact: false })).toBeInTheDocument();
  expect(writes[0].body.provenance).toBe('agent-drafted');
  expect(onSaved).not.toHaveBeenCalled();
});
