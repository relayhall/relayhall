// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CredentialPermissionsEditor } from './CredentialPermissionsEditor';
import type { ConnectionCredential } from '../../types/connections';
const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../access/StepUpDialog', () => ({ StepUpDialog: ({ action, targetId, onToken, onCancel }: { action: string; targetId: string; onToken: (s: string) => void; onCancel: () => void }) => <div role="dialog" aria-label="Confirm edit"><span>{action}:{targetId}</span><button onClick={() => onToken('single-use')}>Confirm edit</button><button onClick={onCancel}>Cancel edit</button></div> }));
const credential: ConnectionCredential = { id: 'credential-1', keyId: 'public-key', label: null, scopes: ['tasks:read'], transport: 'mcp', createdAt: null, expiresAt: null, revokedAt: null, lastUsedAt: null, graceUntil: null, revealCount: 0, revealable: true, state: 'live' };
const mount = (delegableScopes: string[] | null = ['tasks:read', 'tasks:write'], mayLoosenTransport = false,
  item = credential) => render(<CredentialPermissionsEditor credential={item} delegableScopes={delegableScopes} mayLoosenTransport={mayLoosenTransport} onChanged={vi.fn()} />);
afterEach(() => { cleanup(); fetchMock.mockReset(); });
describe('connection credential authority edits', () => {
  it('keeps the loaded editor and confirmation accessible', async () => {
    const { container } = mount();
    const user = userEvent.setup();
    const audit = async () => (await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations'],
    })).violations.map(({ id, nodes }) => `${id}: ${nodes.map(({ html }) => html).join(', ')}`);
    expect(await audit()).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    expect(await audit()).toEqual([]);
  });
  it('narrows immediately with optional narrow-all and keeps credential identity', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    mount(); const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'tasks:read' }));
    await user.click(screen.getByRole('checkbox', { name: /Also narrow all/ }));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/credentials/credential-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ scopes: [], transport: 'mcp', narrowAgents: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('uses an exact-target step-up and defaults widening lifetime to keep', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    mount(); const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('credential.edit:credential-1');
    await user.click(screen.getByRole('button', { name: 'Confirm edit' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ scopes: ['tasks:read', 'tasks:write'], transport: 'mcp', stepUpToken: 'single-use', lifetime: { choice: 'keep' } });
  });
  it('cannot submit widening after cancelling confirmation', async () => {
    mount(undefined, true); const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Credential transport' }), 'any');
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('offers a pinned transport only to an ordinary owner and all choices to an administrator', () => {
    mount();
    expect(screen.getAllByRole('option').filter(option => ['any', 'mcp', 'api'].includes(option.getAttribute('value') || ''))
      .map(option => option.getAttribute('value'))).toEqual(['mcp']);
    cleanup();
    mount(undefined, true);
    expect(screen.getAllByRole('option').filter(option => ['any', 'mcp', 'api'].includes(option.getAttribute('value') || ''))
      .map(option => option.getAttribute('value'))).toEqual(['any', 'mcp', 'api']);
  });
  it('preserves immediate narrowing from any to either pin for an ordinary owner', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    mount(undefined, false, { ...credential, transport: 'any' });
    const transport = screen.getByRole('combobox', { name: 'Credential transport' });
    expect(Array.from(transport.querySelectorAll('option')).map(option => option.value)).toEqual(['any', 'mcp', 'api']);
    await userEvent.selectOptions(transport, 'mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ scopes: ['tasks:read'], transport: 'mcp', narrowAgents: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('drops a selected looser transport when verified standing is withdrawn', async () => {
    const onChanged = vi.fn();
    const { rerender } = render(<CredentialPermissionsEditor credential={credential} delegableScopes={['tasks:read']}
      mayLoosenTransport onChanged={onChanged} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Credential transport' }), 'any');
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeEnabled();
    rerender(<CredentialPermissionsEditor credential={credential} delegableScopes={['tasks:read']}
      mayLoosenTransport={false} onChanged={onChanged} />);
    expect(screen.getByRole('combobox', { name: 'Credential transport' })).toHaveValue('mcp');
    expect(screen.queryByRole('combobox', { name: 'Widening lifetime' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows the owner cap refusal and never offers root or undisclosed scopes', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'EXCEEDS_ACCOUNT_AUTHORITY', message: 'phases:write lies beyond it. Nothing was saved and no request was filed.' }) });
    mount(['tasks:read', 'tasks:write', 'root']); const user = userEvent.setup();
    expect(screen.queryByRole('checkbox', { name: 'root' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    await user.click(screen.getByRole('button', { name: 'Confirm edit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('EXCEEDS_ACCOUNT_AUTHORITY: phases:write lies beyond it. Nothing was saved and no request was filed.');
  });
  it('fails closed when the session delegable catalogue is unavailable', () => {
    mount(null); expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: 'tasks:write' })).not.toBeInTheDocument();
  });
});
