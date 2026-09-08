// @vitest-environment jsdom
/**
 * Bounded dynamic profile renderer (RH-P2.2). Pins: service-first flow
 * (Basic default, connectors from the registry); descriptor-driven fields
 * per declared type; secretReference renders the connector-declared NAMES
 * only (a free-text secret input must never exist — R5); per-option
 * parameters appear only once their option is set (E-17, one level);
 * an empty registry degrades to Basic with an honest message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExecutionProfileEditor from './ExecutionProfileEditor';
import { clearConnectorOptionCaches } from '../../hooks/useConnectorOptions';
import { authenticatedFetch } from '../../utils/auth';

vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(),
}));

const CONNECTOR = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  slug: 'my-runner',
  name: 'My Runner',
  currentDescriptorVersion: 3,
};

const DESCRIPTOR_VERSION = {
  version: 3,
  retiredAt: null,
  descriptor: {
    options: [
      {
        key: 'template',
        label: 'Ansible template',
        type: 'enum',
        required: true,
        values: [{ value: 'patch-fleet' }, { value: 'provision-vm' }],
        parameters: [
          { key: 'inventoryLimit', type: 'string' },
          { key: 'deployKey', type: 'secretReference', allowedReferences: ['semaphore-deploy-key'] },
        ],
      },
      { key: 'dryRun', type: 'boolean' },
    ],
  },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function armFetch(services: unknown[] = [CONNECTOR]): void {
  (authenticatedFetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
    if (url.includes('/descriptor')) return jsonResponse({ success: true, descriptorVersion: DESCRIPTOR_VERSION });
    return jsonResponse({ success: true, services });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearConnectorOptionCaches();
});

afterEach(cleanup);

describe('ExecutionProfileEditor', () => {
  it('defaults to Basic and lists published connectors from the registry', async () => {
    armFetch();
    render(<ExecutionProfileEditor value={null} onChange={() => {}} />);
    const select = await screen.findByLabelText('Service');
    expect((select as HTMLSelectElement).value).toBe('');
    await waitFor(() => expect(screen.getByText('My Runner')).toBeTruthy());
  });

  it('an empty registry degrades to Basic with an honest message', async () => {
    armFetch([]);
    render(<ExecutionProfileEditor value={null} onChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/No published Connectors are registered yet/)).toBeTruthy(),
    );
  });

  it('choosing a connector renders descriptor-driven fields with the version pinned', async () => {
    armFetch();
    render(
      <ExecutionProfileEditor
        value={{ serviceId: CONNECTOR.id, options: {} }}
        onChange={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Descriptor v3/)).toBeTruthy());
    expect(screen.getByLabelText(/Ansible template/)).toBeTruthy();
    expect(screen.getByLabelText('dryRun')).toBeTruthy();
  });

  it('per-option parameters appear only once their option is set, and secretReference offers NAMES only', async () => {
    armFetch();
    const { rerender } = render(
      <ExecutionProfileEditor value={{ serviceId: CONNECTOR.id, options: {} }} onChange={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText(/Descriptor v3/)).toBeTruthy());
    expect(screen.queryByLabelText('deployKey')).toBeNull();

    rerender(
      <ExecutionProfileEditor
        value={{ serviceId: CONNECTOR.id, options: { template: 'patch-fleet' } }}
        onChange={() => {}}
      />,
    );
    const secretSelect = await screen.findByLabelText('deployKey');
    // R5: a SELECT over declared reference names — never a free-text input.
    expect((secretSelect as HTMLElement).tagName).toBe('SELECT');
    expect(screen.getByText('semaphore-deploy-key')).toBeTruthy();
  });

  it('materializes declared defaults into the profile payload once the descriptor loads (F3)', async () => {
    armFetch();
    const onChange = vi.fn();
    render(
      <ExecutionProfileEditor value={{ serviceId: CONNECTOR.id, options: {} }} onChange={onChange} />,
    );
    // The descriptor's boolean dryRun has no default; add a defaulted enum via a
    // dedicated descriptor for this pin.
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // The effect pins the version even when no defaults exist to materialize.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: CONNECTOR.id, descriptorVersion: 3 }),
    );
  });

  it('a required defaulted option submits as selected — what the form shows is what validates (F3)', async () => {
    (authenticatedFetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/descriptor')) {
        return jsonResponse({
          success: true,
          descriptorVersion: {
            version: 7,
            retiredAt: null,
            descriptor: {
              options: [
                { key: 'workflow', type: 'enum', required: true, default: 'daily', values: [{ value: 'daily' }, { value: 'weekly' }] },
              ],
            },
          },
        });
      }
      return jsonResponse({ success: true, services: [CONNECTOR] });
    });
    const onChange = vi.fn();
    render(
      <ExecutionProfileEditor value={{ serviceId: CONNECTOR.id, options: {} }} onChange={onChange} />,
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: CONNECTOR.id,
          descriptorVersion: 7,
          options: { workflow: 'daily' },
        }),
      ),
    );
  });

  it('setting an enum option reports the change with the descriptor version pinned', async () => {
    armFetch();
    const onChange = vi.fn();
    render(
      <ExecutionProfileEditor value={{ serviceId: CONNECTOR.id, options: {} }} onChange={onChange} />,
    );
    const select = await screen.findByLabelText(/Ansible template/);
    await userEvent.selectOptions(select, 'patch-fleet');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: CONNECTOR.id,
        descriptorVersion: 3,
        options: { template: 'patch-fleet' },
      }),
    );
  });
});
