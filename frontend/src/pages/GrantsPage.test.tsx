// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GrantsPage } from './GrantsPage';

const authenticatedFetch = vi.fn();
const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();

vi.mock('../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const principal = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', handle: 'tester', displayName: 'Focused Tester', kind: 'human', status: 'active', role: 'viewer' };
const grant = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', granteeType: 'principal', granteeId: principal.id, resourceType: 'phase', resourceId: null, verb: 'read', grantedByPrincipalId: null, expiresAt: null, createdAt: '2026-08-13T12:00:00.000Z' };

function response(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 403, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({ principals: [principal], loading: false, failed: false, reload: vi.fn() });
  authenticatedFetch.mockImplementation((_url: string, options?: RequestInit) => {
    if (!options) return response({ success: true, grants: [grant] });
    if (options.method === 'POST') return response({ success: true, grant: { ...grant, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', resourceType: 'project' } });
    return response({ success: true, grant });
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GrantsPage', () => {
  test('keeps the entire grant surface out of a non-root GUI', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'agent' }, scopes: ['tasks:read'], loading: false });
    render(<GrantsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('authorised human administrators');
    expect(screen.queryByRole('button', { name: 'Create grant' })).not.toBeInTheDocument();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  test('creates a wildcard grant with no resource id and explains audit attribution', async () => {
    const user = userEvent.setup();
    render(<GrantsPage />);
    expect(await screen.findByText('Every resource of this type')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith('/api/grants', expect.objectContaining({ method: 'POST' })));
    const call = authenticatedFetch.mock.calls.find(([, options]) => options?.method === 'POST');
    const body = JSON.parse(call[1].body as string);
    expect(body).toMatchObject({ granteeType: 'principal', granteeId: principal.id, resourceType: 'project', verb: 'read' });
    expect(body).not.toHaveProperty('resourceId');
    expect(await screen.findByRole('status')).toHaveTextContent('recorded in the audit log');
  });

  test('requires explicit confirmation before revocation', async () => {
    render(<GrantsPage />);
    const revoke = await screen.findByRole('button', { name: /Revoke read phase grant/ });
    fireEvent.click(revoke);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(`/api/grants/${grant.id}`, { method: 'DELETE' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('remains in the audit log'));
  });
});
