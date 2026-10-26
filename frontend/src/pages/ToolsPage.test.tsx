// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { ToolsPage } from './ToolsPage';
import { authenticatedFetch } from '../utils/auth';
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const tools = [
  { name: 'relayhall_task_list', description: 'Read board tasks', plane: 'introspection', effect: 'read', requiredScope: 'tasks:read', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'relayhall_task_create', description: 'Create a task', plane: 'work', effect: 'change', requiredScope: 'tasks:write', inputSchema: { type: 'object' } },
];
// Admitted on the work plane (bootstrap-gated) but changes nothing: the label follows the effect.
const gatedRead = { name: 'relayhall_blueprint_list', description: 'List Blueprints', plane: 'work', effect: 'read', requiredScope: 'blueprints:read', inputSchema: { type: 'object' } };
const sessionSetup = { name: 'relayhall_brief_compile', description: 'Compile the session brief', plane: 'bootstrap', effect: 'session', requiredScope: null, inputSchema: { type: 'object' } };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const mount = () => render(<MemoryRouter><ToolsPage /></MemoryRouter>);
test('loads actual metadata, searches, filters and exposes schema without an execution control', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(reply({ success: true, tools }));
  const user = userEvent.setup(); mount();
  expect(await screen.findByText('2 of 2 tools')).toBeInTheDocument();
  expect(authenticatedFetch).toHaveBeenCalledWith('/api/tool-catalogue', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.getByText(/Listing a tool does not grant access/)).toBeInTheDocument();
  await user.type(screen.getByRole('searchbox'), 'tasks:write');
  expect(screen.getByText('1 of 2 tools')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'relayhall_task_list' })).not.toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox'));
  await user.selectOptions(screen.getByRole('combobox'), 'read');
  expect(screen.getByRole('heading', { name: 'relayhall_task_list' })).toBeInTheDocument();
  await user.click(screen.getByText('Parameters and schema'));
  expect(screen.getByText(/"limit"/)).toBeVisible();
  await user.type(screen.getByRole('searchbox'), 'no match');
  expect(screen.getByText(/No tools match/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run|execute|invoke/i })).not.toBeInTheDocument();
});
test('labels a work-plane tool that only reads as Read-only and files it under that filter', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(reply({ success: true, tools: [...tools, gatedRead, sessionSetup] }));
  const user = userEvent.setup(); mount();
  expect(await screen.findByText('4 of 4 tools')).toBeInTheDocument();
  const label = (name: string) => within(screen.getByRole('heading', { name }).closest('article') as HTMLElement).getByText(/^(Session setup|Read-only|Board changes)$/);
  expect(label('relayhall_blueprint_list')).toHaveTextContent('Read-only');
  expect(label('relayhall_task_list')).toHaveTextContent('Read-only');
  expect(label('relayhall_task_create')).toHaveTextContent('Board changes');
  expect(label('relayhall_brief_compile')).toHaveTextContent('Session setup');
  await user.selectOptions(screen.getByRole('combobox'), 'read');
  expect(screen.getByText('2 of 4 tools')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'relayhall_blueprint_list' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'relayhall_task_create' })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox'), 'change');
  expect(screen.getByText('1 of 4 tools')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'relayhall_blueprint_list' })).not.toBeInTheDocument();
});
test.each([403, 500])('shows HTTP %s as error, not empty; retry recovers', async status => {
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(reply({}, status)).mockResolvedValueOnce(reply({ success: true, tools }));
  const user = userEvent.setup(); mount();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.queryByText(/No built-in tools/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('2 of 2 tools')).toBeInTheDocument();
});
test.each([{}, { success: true, tools: [{}] }, { success: true, tools: [{ ...tools[0], effect: undefined }] },
  { success: true, tools: [{ ...tools[0], effect: 'introspection' }] }])('rejects malformed or missing catalogue', async data => {
  vi.mocked(authenticatedFetch).mockResolvedValue(reply(data)); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('invalid tool catalogue');
});
test('distinguishes a valid empty catalogue', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(reply({ success: true, tools: [] })); mount();
  expect(await screen.findByText(/No built-in tools/)).toBeInTheDocument();
});
