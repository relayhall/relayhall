/**
 * Card 8fe6d7bb: the deployment view default, end to end.
 *
 * A real deployment plugin file on disk is read by the real PluginLoader at
 * start; the real registry route, host bridge and host proxy then serve a real
 * upstream over HTTP. Only identity (the authenticated chain), the Account
 * lookup, the task authorization decision and the bridge's data sources are
 * doubles. `access.default: ["view"]` must give every active Account view of
 * the installation and nothing else: no non-view capability, no settings entry
 * behind one, no write through the proxy and no write description; an
 * installation without the default keeps its exact per-Account list; a
 * malformed default refuses that installation at load.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import jwt from 'jsonwebtoken';
jest.mock('../middleware/auth', () => ({ authMiddleware: async (req: any, res: any, next: any) => {
  const token = String(req.headers.authorization ?? '');
  const match = /^Bearer ([a-z-]+)$/.exec(token);
  if (!match) { res.status(401).end(); return; }
  const [account, grade] = match[1].split('-read');
  req.principal = { id: account, status: 'active' };
  req.scopes = grade === undefined ? ['services:read', 'services:write', 'tasks:read', 'tasks:write'] : ['services:read'];
  next();
} }));
jest.mock('../services/PrincipalService', () => ({ principalService: { getPrincipalById: jest.fn(async (id: string) =>
  ({ id, status: 'active', kind: 'human', parentPrincipalId: null })) } }));
jest.mock('../services/AuthorizationRepository', () => ({ authorizationRepository: { authorizePoint: jest.fn(async () => ({ allowed: true })) } }));
jest.mock('../services/UsageQuotaService', () => ({ usageQuotaService: { read: jest.fn(async (account: string) =>
  ({ schemaVersion: 'rh.usage-quota/1', accounts: [], truncated: false, account })) } }));
jest.mock('../services/TelemetryProjectionService', () => ({ telemetryProjectionService: { sessions: jest.fn(async () => ({ sessions: [] })) } }));
jest.mock('../services/PluginMetricsService', () => ({ pluginMetricsService: { read: jest.fn(async () => ({ truncated: false, sources: [] })) } }));
import { authMiddleware } from '../middleware/auth';
import { createPluginProxy } from '../middleware/pluginProxy';
import pluginRoutes, { setPluginLoader } from '../routes/plugins';
import pluginHostRoutes, { setPluginHostLoader } from '../routes/pluginHost';
import { PluginLoader } from '../services/PluginLoader';
import { validatePluginContract } from '../services/PluginHostContract';
import { principalService } from '../services/PrincipalService';
import { installPluginSettingsDouble } from './support/pluginSettingsDouble';
// Card bedf50cc: availability is ANDed into every plugin site; no row = default_on.
installPluginSettingsDouble();

// Card bedf50cc (E380): each installation holds its OWN assertion key; two
// installations sharing a key variable or a key value are refused at load.
const keyEnv = (name: string) => 'PLUGIN_VIEW_DEFAULT_TEST_KEY_' + name.toUpperCase().replace(/-/g, '_');
const keyOf = (name: string) => 'view-default-test-only-assertion-key-32b-' + name;
const personal = { id: 'personal-options', label: 'Reading', scope: 'personal', path: '/settings', capability: 'view' };
const shared = { id: 'shared-options', label: 'Shared options', scope: 'deployment', path: '/admin', capability: 'manage' };

describe('deployment view default through the loader, registry, bridge and proxy (card 8fe6d7bb)', () => {
  let directory: string, loader: PluginLoader, upstream: http.Server, host: http.Server, base: string, last: any;
  const manifest = (name: string, port: number): any => ({
    schema_version: 'rh.plugin/1', name, version: '1.0.0', description: 'fixture',
    docker: { image: 'fixture:1', ports: {}, network_mode: 'host' },
    api: { base_path: '/plugins/' + name, internal_port: port, health: '/health', allow: [
      { path: '/', methods: ['GET', 'HEAD'], capability: 'view' },
      { path: '/admin', methods: ['GET'], match: 'exact', capability: 'manage' },
      { path: '/generate', methods: ['POST'], match: 'exact', capability: 'generate' },
      { path: '/settings', methods: ['POST'], match: 'exact', capability: 'manage' },
    ] },
    ui: { enabled: true, sidebar: [{ label: name, icon: 'circle', path: '/plugins/' + name }], settings: [personal, shared] },
    relayhall: { api_version: 1, trust: 'installed', capabilities: ['usage.quotas'] },
  });
  const operator = { operator: ['view', 'manage', 'generate'] };
  const installations: Array<[string, any]> = [
    ['sample-plugin', { default: ['view'], accounts: operator, assertion_key_env: keyEnv('sample-plugin') }],
    ['plain-plugin', { accounts: operator, assertion_key_env: keyEnv('plain-plugin') }],
    ['broken-generate', { default: ['generate'], accounts: operator, assertion_key_env: keyEnv('broken-generate') }],
    ['broken-string', { default: 'view', accounts: operator, assertion_key_env: keyEnv('broken-string') }],
  ];
  const call = (route: string, account: string, init: RequestInit = {}) =>
    fetch(base + route, { ...init, headers: { authorization: 'Bearer ' + account, connection: 'close', ...(init.headers ?? {}) } });
  const registry = async (account: string) => (await (await call('/plugins', account)).json() as any).plugins as any[];
  const assertion = () => jwt.verify(last.headers['x-relayhall-assertion'], keyOf(String(last.headers['x-plugin-name'])), { issuer: 'relayhall' }) as jwt.JwtPayload;

  beforeAll(async () => {
    for (const [name] of installations) process.env[keyEnv(name)] = keyOf(name);
    process.env.DOCKER_HOST_ALIAS = '127.0.0.1';
    upstream = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('ok'); return; }
      req.resume(); req.on('end', () => { last = { path: req.url, method: req.method, headers: req.headers }; res.end('ok'); });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as any).port;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-view-default-'));
    const plugins = installations.map(([name, access]) => {
      const source = path.join(directory, name); fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest(name, port)));
      return { name, source, enabled: true, access };
    });
    fs.writeFileSync(path.join(directory, 'relayhall.plugins.json'), JSON.stringify({ plugins }));
    loader = new PluginLoader(path.join(directory, 'relayhall.plugins.json'), 3_600_000);
    await loader.initialize();
    setPluginLoader(loader); setPluginHostLoader(loader);
    const app = express();
    app.use(express.json());
    app.use(createPluginProxy(loader));
    app.use('/plugins', authMiddleware as any, pluginRoutes);
    app.use('/plugin-host', authMiddleware as any, pluginHostRoutes);
    host = http.createServer(app);
    await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + (host.address() as any).port;
  });
  afterAll(async () => {
    loader?.stop();
    for (const [name] of installations) delete process.env[keyEnv(name)];
    delete process.env.DOCKER_HOST_ALIAS;
    await Promise.all([host, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  beforeEach(() => { last = null; });

  it('lists a default-view installation to an Account with no entry, never one without the default', async () => {
    expect((await registry('newcomer')).map(entry => entry.name)).toEqual(['sample-plugin']);
    expect((await registry('operator')).map(entry => entry.name).sort()).toEqual(['plain-plugin', 'sample-plugin']);
  });
  it('shows an Account with no entry the view settings only, while explicit entries keep their settings', async () => {
    const newcomer = (await registry('newcomer')).find(entry => entry.name === 'sample-plugin');
    expect(newcomer.settings).toEqual([{ ...personal, readOnly: true }]);
    const granted = (await registry('operator')).find(entry => entry.name === 'sample-plugin');
    expect(granted.settings).toEqual([{ ...personal, readOnly: false }, { ...shared, readOnly: true }]);
  });
  it('describes no write for an Account that holds only the default', async () => {
    expect((await registry('newcomer')).find(entry => entry.name === 'sample-plugin').hostProxyAccess).toEqual({ writeCapable: false });
    expect((await registry('operator')).find(entry => entry.name === 'sample-plugin').hostProxyAccess).toEqual({ writeCapable: true });
  });
  it('states every settings entry read-only for an Account that holds only the default (card bedf50cc)', async () => {
    const newcomer = (await registry('newcomer')).find(entry => entry.name === 'sample-plugin');
    const flag = (entry: any, id: string) => entry.settings.find((setting: any) => setting.id === id)?.readOnly;
    expect(flag(newcomer, 'personal-options')).toBe(true);
    // The proxy agrees: the write the flag describes is refused to the default and admitted to the explicit grant.
    expect((await call('/plugins/sample-plugin/settings', 'newcomer', { method: 'POST' })).status).toBe(404);
    expect(last).toBeNull();
    const operator = (await registry('operator')).find(entry => entry.name === 'sample-plugin');
    expect(flag(operator, 'personal-options')).toBe(false);
    expect(flag(operator, 'shared-options')).toBe(true);
    expect((await call('/plugins/sample-plugin/settings', 'operator', { method: 'POST' })).status).toBe(200);
    expect(assertion()).toMatchObject({ sub: 'operator', capability: 'manage' });
  });
  it('admits a view read through the proxy and signs a view assertion for the caller Account', async () => {
    const response = await call('/plugins/sample-plugin/status', 'newcomer');
    expect(response.status).toBe(200);
    expect(last.path).toBe('/status');
    expect(assertion()).toMatchObject({ sub: 'newcomer', capability: 'view', aud: 'sample-plugin' });
    last = null;
    expect((await call('/plugins/plain-plugin/status', 'newcomer')).status).toBe(404);
    expect(last).toBeNull();
  });
  it('never admits a non-view capability through the proxy on the default', async () => {
    expect((await call('/plugins/sample-plugin/admin', 'newcomer')).status).toBe(404);
    expect((await call('/plugins/sample-plugin/generate', 'newcomer', { method: 'POST' })).status).toBe(404);
    expect(last).toBeNull();
    expect((await call('/plugins/sample-plugin/generate', 'operator', { method: 'POST' })).status).toBe(200);
    expect(assertion()).toMatchObject({ sub: 'operator', capability: 'generate' });
  });
  it('serves the bridge to an Account that holds only the default', async () => {
    const response = await call('/plugin-host/sample-plugin/bridge', 'newcomer-read');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schemaVersion: 'rh.plugin.bridge/1', quotas: { account: 'newcomer' } });
    expect((await call('/plugin-host/plain-plugin/bridge', 'newcomer-read')).status).toBe(404);
  });
  it('gives an inactive Account nothing from the default', async () => {
    (principalService.getPrincipalById as jest.Mock).mockResolvedValueOnce({ id: 'newcomer', status: 'disabled', kind: 'human', parentPrincipalId: null });
    expect((await call('/plugins/sample-plugin/status', 'newcomer')).status).toBe(404);
    (principalService.getPrincipalById as jest.Mock).mockResolvedValueOnce({ id: 'newcomer', status: 'active', kind: 'service', parentPrincipalId: 'parent' });
    expect((await call('/plugins/sample-plugin/status', 'newcomer')).status).toBe(404);
    expect(last).toBeNull();
  });
  it('refuses an installation with a malformed default at load and still loads the others', async () => {
    for (const name of ['broken-generate', 'broken-string']) {
      expect(loader.getPlugin(name)?.manifest).toBeNull();
      expect(loader.getPlugin(name)?.error).toMatch(/^Plugin load failed/);
      expect(loader.getProxyRoutes().some(route => route.pluginName === name)).toBe(false);
      expect((await call('/plugins/' + name + '/status', 'operator')).status).toBe(404);
    }
    expect(loader.getRegistry().map(entry => entry.name).sort()).toEqual(['plain-plugin', 'sample-plugin']);
    expect(last).toBeNull();
  });
  it('documents the default in the deployment file example with a value the loader accepts', () => {
    const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../relayhall.plugins.example.json'), 'utf-8'));
    const documented = example.plugins.filter((entry: any) => entry.access && 'default' in entry.access);
    expect(documented.length).toBeGreaterThan(0);
    for (const entry of documented) {
      expect(entry.access.default).toEqual(['view']);
      expect(() => validatePluginContract(manifest(entry.name, 8080), entry)).not.toThrow();
    }
  });
});
