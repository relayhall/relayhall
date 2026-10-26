// @vitest-environment jsdom
// Card 41e24358 (design ba22fd01 Part 7): the default-Verifier picker.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../utils/auth';
import { DefaultVerifierField, canSetDefaultVerifier } from './DefaultVerifierField';

vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONNECTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STALE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const candidates = { success: true, candidates: [
  { id: PERSON, kind: 'human', handle: 'ada', displayName: 'Ada' },
  { id: CONNECTOR, kind: 'service', handle: 'main', displayName: null },
] };

function renderField(overrides: Partial<Parameters<typeof DefaultVerifierField>[0]> = {}) {
  const props = {
    target: 'projects' as const, objectId: PROJECT, projectId: PROJECT, revision: 'rev-1', value: null,
    canEdit: true, emptyLabel: 'No default Verifier', onSaved: vi.fn(), onConflict: vi.fn(), onMessage: vi.fn(),
    ...overrides,
  };
  render(<DefaultVerifierField {...props} />);
  return props;
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { cleanup(); });

describe('the default-Verifier picker', () => {
  test('lists the principals the server predicate accepts, people and Connectors labelled', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(json(candidates));
    renderField();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Ada' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'main (Connector)' })).toBeInTheDocument();
    expect(vi.mocked(authenticatedFetch).mock.calls[0][0]).toBe(`/api/projects/${PROJECT}/default-verifier/candidates`);
  });

  test('a choice is a revision-bound PUT on the dedicated route, never the generic PATCH', async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(json(candidates))
      .mockResolvedValueOnce(json({ success: true, project: { id: PROJECT, defaultVerifierPrincipalId: PERSON, revision: 'rev-2' } }));
    const props = renderField();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Ada' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Default Verifier'), { target: { value: PERSON } });
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith({ revision: 'rev-2', defaultVerifierPrincipalId: PERSON }));
    const [url, init] = vi.mocked(authenticatedFetch).mock.calls[1];
    expect(url).toBe(`/api/projects/${PROJECT}/default-verifier`);
    expect(init).toMatchObject({ method: 'PUT', headers: { 'If-Match': 'rev-1' }, body: JSON.stringify({ principalId: PERSON }) });
  });

  test('the server refusal is shown verbatim and a stale revision is a conflict', async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(json(candidates))
      .mockResolvedValueOnce(json({ success: false, code: 'DEFAULT_VERIFIER_REQUIRES_OWNER', error: 'Owner only' }, 403))
      .mockResolvedValueOnce(json({ success: false, code: 'REVISION_MISMATCH', error: 'changed' }, 412));
    const props = renderField();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Ada' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Default Verifier'), { target: { value: PERSON } });
    await waitFor(() => expect(props.onMessage).toHaveBeenCalledWith('Owner only'));
    fireEvent.change(screen.getByLabelText('Default Verifier'), { target: { value: CONNECTOR } });
    await waitFor(() => expect(props.onConflict).toHaveBeenCalled());
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  test('read-only for those the gate does not admit, and a stored default that cannot judge stays visible', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(json(candidates));
    renderField({ canEdit: false, value: STALE, target: 'phases', emptyLabel: 'Inherit from Project (Alpha)' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Current default (cannot judge cards now)' })).toBeInTheDocument());
    expect(screen.getByLabelText('Default Verifier')).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Inherit from Project (Alpha)' })).toBeInTheDocument();
  });

  test('who may edit: root, an administrator, or the person owner', () => {
    const owner = { id: PERSON, kind: 'human', role: 'user' };
    expect(canSetDefaultVerifier(owner, [], PERSON)).toBe(true);
    expect(canSetDefaultVerifier(owner, [], CONNECTOR)).toBe(false);
    expect(canSetDefaultVerifier({ ...owner, role: 'admin' }, [], CONNECTOR)).toBe(true);
    expect(canSetDefaultVerifier(null, ['root'], null)).toBe(true);
    expect(canSetDefaultVerifier({ id: CONNECTOR, kind: 'service', role: 'agent' }, [], CONNECTOR)).toBe(false);
    expect(canSetDefaultVerifier(owner, [], null)).toBe(false);
  });
});
