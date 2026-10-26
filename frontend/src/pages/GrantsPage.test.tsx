// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
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
  test('names a newly appended grant from the POST row without another list request', async () => {
    const user = userEvent.setup();
    const created = {
      ...grant, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', resourceType: 'project',
      grantee: { id: principal.id, handle: 'server-tester', displayName: 'Server identity', kind: 'human', status: 'active', compatibility: false },
      grantedBy: null,
    };
    authenticatedFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (!options) return response({ success: true, grants: [] });
      return response({ success: true, grant: created });
    });
    render(<GrantsPage />);
    await screen.findByText('No grants match this view.');
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    const edit = await screen.findByRole('button', { name: 'Edit read project grant for Server identity (server-tester)' });
    const row = edit.closest('[role="row"]') as HTMLElement;
    expect(within(row).getByText('Server identity (server-tester)')).toBeInTheDocument();
    expect(within(row).getByText('human')).toBeInTheDocument();
    expect(within(row).queryByText(/Deleted identity/)).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Revoke read project grant for Server identity (server-tester)' })).toBeInTheDocument();
    expect(authenticatedFetch.mock.calls.filter(([, options]) => !options)).toHaveLength(1);
    expect(authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  test('the loaded grant editor has accessible controls', async () => {
    const { container } = render(<GrantsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Edit read phase grant/ }));
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations'],
    });
    expect(results.violations.map(({ id, nodes }) => `${id}: ${nodes.map(({ html }) => html).join(', ')}`)).toEqual([]);
  });
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

  // Owner ruling E418(b): the revoke keeps its confirmation and then asks for
  // a step-up bound to (grant.revoke, this grant); the DELETE carries it.
  function withStepUp() {
    authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (String(url).endsWith('/auth/step-up/methods')) return response({ success: true, methods: ['password'], preferred: 'password' });
      if (String(url).endsWith('/auth/step-up')) return response({ success: true, stepUpToken: 'rhsu_revoke_1' });
      if (!options) return response({ success: true, grants: [grant] });
      return response({ success: true, grant });
    });
  }
  const deletes = () => authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'DELETE');

  test('requires explicit confirmation and then a step-up bound to (grant.revoke, this grant) before revocation', async () => {
    withStepUp();
    render(<GrantsPage />);
    const revoke = await screen.findByRole('button', { name: /Revoke read phase grant/ });
    fireEvent.click(revoke);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('remains in the audit log'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(deletes()).toHaveLength(0);
    fireEvent.change(await dialog.findByLabelText('Password'), { target: { value: 'test-password' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(`/api/grants/${grant.id}`,
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ stepUpToken: 'rhsu_revoke_1' }) })));
    const mint = authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/auth/step-up'));
    expect(JSON.parse(String(mint[1].body))).toMatchObject({ action: 'grant.revoke', targetId: grant.id });
    expect(await screen.findByRole('status')).toHaveTextContent('revoked and recorded in the audit log');
  });

  test('a declined confirmation or a cancelled step-up sends no revoke', async () => {
    withStepUp();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    render(<GrantsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Revoke read phase grant/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Revoke read phase grant/ }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deletes()).toHaveLength(0);
  });

  // Card 21787b03, the owner's reproduction on DEV (9 Oct 2026): a `service`
  // grant on one resource with an expiry, then a second grant changing only the
  // permission, went out as `write · project · every resource · no expiry`,
  // because a successful submit put Resource type back to `project`, Permission
  // back to `read` and cleared the resource ID and the expiry. Two submits in a
  // row: the form must still show what was entered, and the second request
  // body must be the first with only what the person changed. Bodies are
  // compared to each other, not to an ISO literal, so this holds in any zone.
  test('keeps every field after a grant is created, so a second grant differs only in what was changed (21787b03)', async () => {
    const user = userEvent.setup();
    let created = 0;
    authenticatedFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (!options) return response({ success: true, grants: [grant] });
      if (options.method === 'POST') {
        created += 1;
        const sent = JSON.parse(options.body as string);
        return response({ success: true, grant: { ...grant, resourceId: null, expiresAt: null, ...sent, id: `dddddddd-dddd-4ddd-8ddd-${String(created).padStart(12, '0')}` } });
      }
      return response({ success: true, grant });
    });
    const posts = () => authenticatedFetch.mock.calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([, options]) => JSON.parse(options.body as string));
    const target = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
    render(<GrantsPage />);
    await screen.findByText('Every resource of this type');
    const identity = screen.getByLabelText('Identity') as HTMLSelectElement;
    const resourceType = screen.getByLabelText('Resource type') as HTMLSelectElement;
    const permission = screen.getByLabelText('Permission') as HTMLSelectElement;
    const resourceId = screen.getByLabelText(/Specific resource ID/) as HTMLInputElement;
    const expires = screen.getByLabelText(/Expires/) as HTMLInputElement;
    const create = screen.getByRole('button', { name: 'Create grant' });

    await user.selectOptions(resourceType, 'service');
    await user.type(resourceId, target);
    fireEvent.change(expires, { target: { value: '2099-12-01T10:00' } });
    await user.click(create);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const status = await screen.findByRole('status');

    // After the first grant the form still shows exactly what was entered.
    expect(identity).toHaveValue(principal.id);
    expect(resourceType).toHaveValue('service');
    expect(permission).toHaveValue('read');
    expect(resourceId).toHaveValue(target);
    expect(expires).toHaveValue('2099-12-01T10:00');
    // And the status names what was created, for whom, and what was kept.
    expect(status).toHaveTextContent(`read · service · ${target} · expires`);
    expect(status).toHaveTextContent('for Focused Tester (tester)');
    expect(status).toHaveTextContent('The form keeps these values for the next grant');

    await user.selectOptions(permission, 'write');
    await user.click(create);
    await waitFor(() => expect(posts()).toHaveLength(2));
    const [first, second] = posts();
    // Not vacuous: the first body carries every field the person set.
    expect(first).toEqual({
      granteeType: 'principal', granteeId: principal.id, resourceType: 'service', verb: 'read',
      resourceId: target, expiresAt: new Date('2099-12-01T10:00').toISOString(),
    });
    // The second is the first with only the permission the person changed,
    expect(second).toEqual({ ...first, verb: 'write' });
    // which is also exactly what the form displays.
    expect(second).toEqual({
      granteeType: 'principal', granteeId: identity.value, resourceType: resourceType.value, verb: permission.value,
      resourceId: resourceId.value, expiresAt: new Date(expires.value).toISOString(),
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`write · service · ${target} · expires`));
    // A grant on one resource is not a wildcard: nothing asked to confirm it.
    expect(window.confirm).not.toHaveBeenCalled();
  });

  // Card 21787b03 DoD: a blank Specific resource ID is the type-wide wildcard,
  // the grant the owner did not mean to make. The form asks first, with the
  // same window.confirm revocation uses, and sends nothing on Cancel.
  test('asks before a wildcard grant and sends nothing when the person declines (21787b03)', async () => {
    const user = userEvent.setup();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    const posted = () => authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
    render(<GrantsPage />);
    await screen.findByText('Every resource of this type');
    await user.selectOptions(screen.getByLabelText('Resource type'), 'service');
    await user.selectOptions(screen.getByLabelText('Permission'), 'write');
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Grant write access to every service for Focused Tester (tester)?'));
    expect(posted()).toHaveLength(0);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(JSON.parse(posted()[0][1].body as string)).toMatchObject({ resourceType: 'service', verb: 'write' });
    expect(JSON.parse(posted()[0][1].body as string)).not.toHaveProperty('resourceId');
  });
});


test('grant narrowing edits the original ID without step-up or identity changes', async () => {
  render(<GrantsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit read phase grant/ }));
  fireEvent.change(screen.getByLabelText('Edit specific resource ID'), { target: { value: principal.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Save grant edit' }));
  await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(`/api/grants/${grant.id}`, expect.objectContaining({ method: 'PATCH' })));
  const body = JSON.parse(authenticatedFetch.mock.calls.find(([, options]) => options?.method === 'PATCH')[1].body);
  expect(body).toEqual({ verb: 'read', resourceId: principal.id, expiresAt: null });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('grant widening has no lifetime preselection and binds step-up to original grant', async () => {
  authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/auth/step-up/methods')) return response({ success: true, methods: ['password'] });
    if (url.endsWith('/auth/step-up')) return response({ success: true, stepUpToken: 'single-use-test-token' });
    if (!options) return response({ success: true, grants: [grant] });
    return response({ success: true, edit: { direction: 'widening' } });
  });
  render(<GrantsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit read phase grant/ }));
  fireEvent.change(screen.getByLabelText('Edit permission'), { target: { value: 'write' } });
  expect(screen.getByLabelText('Lifetime for this edit')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Save grant edit' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Lifetime for this edit'), { target: { value: 'keep' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save grant edit' }));
  expect(authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0);
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'test-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(`/api/grants/${grant.id}`, expect.objectContaining({ method: 'PATCH' })));
  const proof = JSON.parse(authenticatedFetch.mock.calls.find(([url]) => url.endsWith('/auth/step-up'))[1].body);
  expect(proof).toMatchObject({ action: 'grant.edit', targetId: grant.id });
  const body = JSON.parse(authenticatedFetch.mock.calls.find(([, options]) => options?.method === 'PATCH')[1].body);
  expect(body).toMatchObject({ verb: 'write', lifetime: { choice: 'keep' }, stepUpToken: 'single-use-test-token' });
  expect(body).not.toHaveProperty('granteeId');
});

test('an edit authority refusal is surfaced without retry or replacement grant', async () => {
  authenticatedFetch.mockImplementation((_url: string, options?: RequestInit) => options?.method === 'PATCH'
    ? response({ success: false, code: 'GRANT_ORIGIN_NOT_EDITABLE', message: 'assignment-carried grant' }, false)
    : response({ success: true, grants: [grant] }));
  render(<GrantsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit read phase grant/ }));
  fireEvent.change(screen.getByLabelText('Edit specific resource ID'), { target: { value: principal.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Save grant edit' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('GRANT_ORIGIN_NOT_EDITABLE');
  expect(authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
  expect(authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});
