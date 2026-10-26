// @vitest-environment jsdom
/**
 * Card bedf50cc (plugin availability and settings, owner ruling E380): the
 * host-rendered form, My plugins and the administrators' panel. The board is
 * a double here (authenticatedFetch); the live backend suite
 * pluginAvailabilityLive measures the routes these call.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PluginSettingsForm, SET_BY_ADMINISTRATOR, CONFIGURED_BY_INSTALLER, BACKEND_ONLY_NOTE, REMOVE_SAVED_VALUE, parseSettingInput } from './PluginSettingsForm';
import { MyPluginsPanel } from './MyPluginsPanel';
import { PluginAdministrationPanel } from './PluginAdministrationPanel';
import type { PluginSettingDeclaration } from '../../utils/pluginSettingsApi';

const calls = vi.hoisted(() => ({ list: [] as Array<{ url: string; init?: RequestInit }>, routes: {} as Record<string, () => Response> }));
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.list.push({ url, init });
    const method = init?.method ?? 'GET';
    const handler = calls.routes[`${method} ${url}`];
    return handler ? handler() : new Response(JSON.stringify({ code: 'NOT_STUBBED' }), { status: 500 });
  }),
}));
vi.mock('../access/StepUpDialog', () => ({
  StepUpDialog: ({ action, targetId, onToken }: any) => <button onClick={() => onToken('rhsu_test_token')}>Confirm {action} {targetId}</button>,
}));

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
beforeEach(() => { calls.list = []; calls.routes = {}; });
afterEach(cleanup);

const schema: PluginSettingDeclaration[] = [
  { key: 'language', label: 'Language', type: 'enum', scope: 'account_overridable', options: [{ value: 'en', label: 'English' }, { value: 'de', label: 'German' }] },
  { key: 'short-version', label: 'Short version', type: 'boolean', scope: 'account' },
  { key: 'max-items', label: 'Items', type: 'integer', scope: 'account_overridable', min: 1, max: 50 },
  { key: 'ratio', label: 'Ratio', type: 'number', scope: 'deployment' },
  { key: 'topics', label: 'Topics', type: 'multi_enum', scope: 'account', options: [{ value: 'tech', label: 'Technology' }, { value: 'sport', label: 'Sport' }] },
  { key: 'generation-endpoint', label: 'Generator', type: 'string', scope: 'deployment', deliver: 'backend' },
  { key: 'feed-token', label: 'Feed credential', type: 'secret', scope: 'deployment' },
];

test('the form shows administrator-set and locked keys as "Set by your administrator", never a backend value, and a secret as the installer\'s', () => {
  const onSubmit = vi.fn();
  render(<PluginSettingsForm pluginName="news" schema={schema} mode="account" initial={{ 'short-version': true }}
    effective={{ language: 'de', 'short-version': true, 'max-items': 20, ratio: 0.25, topics: [] }}
    sources={{ language: { source: 'deployment', locked: true }, 'short-version': { source: 'account', locked: false },
      'max-items': { source: 'deployment', locked: false }, ratio: { source: 'deployment', locked: false },
      topics: { source: 'default', locked: false }, 'generation-endpoint': { source: 'deployment', locked: false } }}
    onSubmit={onSubmit} />);
  // Locked: the value, and the administrator note; no control.
  expect(screen.queryByLabelText('Language')).toBeNull();
  expect(screen.getAllByText(SET_BY_ADMINISTRATOR).length).toBeGreaterThanOrEqual(3);
  expect(screen.getByText(CONFIGURED_BY_INSTALLER)).toBeInTheDocument();
  expect(screen.queryByText(/generator\./)).toBeNull();
  // Editable: the Account's own keys and the unlocked overridable key.
  fireEvent.change(screen.getByLabelText('Items'), { target: { value: '7' } });
  fireEvent.click(screen.getByLabelText('Short version'));
  fireEvent.click(within(screen.getByRole('group', { name: 'Topics' })).getByLabelText('Sport'));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(onSubmit).toHaveBeenCalledWith({ 'short-version': false, 'max-items': 7, topics: ['sport'] }, []);
});

test('a person\'s own backend-only key: an untouched save leaves it out (the board keeps it), and "Remove my saved value" sends null', () => {
  const own: PluginSettingDeclaration[] = [
    { key: 'callback-url', label: 'Callback', type: 'string', scope: 'account', deliver: 'backend' },
    { key: 'short-version', label: 'Short version', type: 'boolean', scope: 'account' },
  ];
  const sources = { 'callback-url': { source: 'account' as const, locked: false }, 'short-version': { source: 'default' as const, locked: false } };
  const onSubmit = vi.fn();
  render(<PluginSettingsForm pluginName="news" schema={own} mode="account" initial={{}} effective={{ 'short-version': false }}
    sources={sources} onSubmit={onSubmit} />);
  expect(screen.getByText(BACKEND_ONLY_NOTE)).toBeInTheDocument();
  expect((screen.getByLabelText('Callback') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByLabelText('Short version'));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(onSubmit).toHaveBeenLastCalledWith({ 'short-version': true }, []);
  fireEvent.click(screen.getByLabelText(REMOVE_SAVED_VALUE));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(onSubmit).toHaveBeenLastCalledWith({ 'short-version': true, 'callback-url': null }, []);
  cleanup();
  // No saved value of the person's own: nothing to remove.
  render(<PluginSettingsForm pluginName="news" schema={own} mode="account" initial={{}} effective={{}}
    sources={{ ...sources, 'callback-url': { source: 'default', locked: false } }} onSubmit={onSubmit} />);
  expect(screen.queryByLabelText(REMOVE_SAVED_VALUE)).toBeNull();
});

test('the deployment form edits shared keys with a lock toggle per overridable key, and never an Account key', () => {
  const onSubmit = vi.fn();
  render(<PluginSettingsForm pluginName="news" schema={schema} mode="deployment" initial={{ ratio: 0.5 }} initialLocked={['language']} onSubmit={onSubmit} />);
  expect(screen.queryByText('Short version')).toBeNull();
  expect(screen.getAllByLabelText('Lock for everyone')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Generator'), { target: { value: 'https://generator.invalid/v2' } });
  fireEvent.change(screen.getByLabelText('Ratio'), { target: { value: '' } });
  fireEvent.click(screen.getAllByLabelText('Lock for everyone')[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(onSubmit).toHaveBeenCalledWith({ 'generation-endpoint': 'https://generator.invalid/v2' }, ['language', 'max-items']);
  expect(parseSettingInput(schema[2], '12')).toBe(12);
  expect(parseSettingInput(schema[2], '')).toBeUndefined();
});

test('My plugins lists each eligible plugin, switches it with If-Match and a retry key, and opens the own settings form', async () => {
  calls.routes['GET /api/plugin-host/choices'] = json({ plugins: [
    { name: 'orb', label: 'Activity orb', state: 'available', enabled: false, userControlled: true, revision: 0 },
    { name: 'news', label: 'News', state: 'required', enabled: true, userControlled: false, revision: 0 },
  ] });
  calls.routes['PUT /api/plugin-host/orb/choice'] = json({ success: true, enabled: true, revision: 1 });
  calls.routes['GET /api/plugin-host/news/settings'] = json({ name: 'news', label: 'News', revision: 3, schema,
    values: { language: 'de', 'short-version': false, 'max-items': 10, ratio: 0.5, topics: [] },
    sources: { language: { source: 'deployment', locked: true }, 'short-version': { source: 'default', locked: false },
      'max-items': { source: 'default', locked: false }, ratio: { source: 'deployment', locked: false },
      topics: { source: 'default', locked: false }, 'generation-endpoint': { source: 'deployment', locked: false } }, stale: [] });
  calls.routes['PUT /api/plugin-host/news/settings/account'] = json({ success: true, revision: 4, changedKeys: ['short-version'] });
  render(<MyPluginsPanel />);
  const panel = await screen.findByRole('region', { name: 'My plugins' });
  expect(within(panel).getByText('Required by your administrator: always on.')).toBeInTheDocument();
  expect(within(panel).getAllByRole('switch')).toHaveLength(1);
  fireEvent.click(within(panel).getByRole('switch'));
  await waitFor(() => expect(calls.list.some((call) => call.init?.method === 'PUT')).toBe(true));
  const put = calls.list.find((call) => call.init?.method === 'PUT')!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ enabled: true });
  expect((put.init!.headers as Record<string, string>)['If-Match']).toBe('0');
  expect((put.init!.headers as Record<string, string>)['Idempotency-Key']).toMatch(/.{16,}/);
  fireEvent.click(within(panel).getAllByRole('button', { name: 'Settings' })[0]);
  await screen.findByRole('form', { name: 'news settings' });
  expect(screen.getAllByText(SET_BY_ADMINISTRATOR).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByLabelText('Short version'));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(calls.list.some((call) => call.url.endsWith('/settings/account'))).toBe(true));
  const save = calls.list.find((call) => call.url.endsWith('/settings/account'))!;
  expect(JSON.parse(String(save.init!.body))).toEqual({ values: { 'short-version': true } });
  expect((save.init!.headers as Record<string, string>)['If-Match']).toBe('3');
});

test('the administration panel renders nothing for a session the board refuses', async () => {
  calls.routes['GET /api/plugin-admin'] = json({ code: 'PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR' }, 403);
  const { container } = render(<PluginAdministrationPanel />);
  await waitFor(() => expect(calls.list).toHaveLength(1));
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('the administration panel asks for a step-up bound to (plugin.admin, the plugin) before every write', async () => {
  calls.routes['GET /api/plugin-admin'] = json({ plugins: [{ name: 'orb', label: 'Activity orb', description: '', state: 'default_on', revision: 2, settings: 0 }] });
  calls.routes['GET /api/plugin-admin/orb/settings'] = json({ name: 'orb', revision: 0, schema: [], values: {}, lockedKeys: [], stale: { keys: [], lockedKeys: [], accountRows: 0 } });
  calls.routes['PUT /api/plugin-admin/orb/policy'] = json({ success: true, state: 'available', revision: 3, clearedChoices: 4 });
  render(<PluginAdministrationPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
  fireEvent.change(await screen.findByLabelText('Availability'), { target: { value: 'available' } });
  fireEvent.click(screen.getByLabelText("Also clear every person's own on/off choice"));
  fireEvent.click(screen.getByRole('button', { name: 'Save availability' }));
  expect(calls.list.some((call) => call.init?.method === 'PUT')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm plugin.admin orb' }));
  await waitFor(() => expect(calls.list.some((call) => call.init?.method === 'PUT')).toBe(true));
  const put = calls.list.find((call) => call.init?.method === 'PUT')!;
  expect(JSON.parse(String(put.init!.body))).toEqual({ availability: 'available', clearChoices: true, stepUpToken: 'rhsu_test_token' });
  expect((put.init!.headers as Record<string, string>)['If-Match']).toBe('2');
  expect(await screen.findByText('Availability saved; 4 personal choices cleared.')).toBeInTheDocument();
});
