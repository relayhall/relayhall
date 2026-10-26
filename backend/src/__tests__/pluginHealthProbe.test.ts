/**
 * Card fa519c4c, subtask 2085337: the plugin loader's health probe names the
 * installation and classifies every outcome with a closed, secret-free code.
 *
 * The case that raised it: a development backend logged
 * `plugin health check failed: (Error) [class=TypeError code=ERROR_UNCLASSIFIED]`
 * on every tick, naming no plugin. The loader never read a health body at all;
 * the TypeError was the platform fetch reporting a connection the plugin's
 * health port refused (`fetch failed`, reason on `cause`).
 *
 * NO STAND-IN FOR THE FAILURE. The transport cases below run the real fetch
 * against real local sockets (a closed port, a socket destroyed mid-request, a
 * server that never answers), so the cause shape the classifier reads is the one
 * the platform raises, not one written here. The answer bodies are the ones
 * recorded from the development estate's plugin containers on 25 Oct 2026
 * (GET /health, three answers each, identical): the Orb, Usage Limits and
 * Content Engine bodies verbatim; the GPU Gateway body reduced only in its
 * model catalogue (one model, one alias, the empty deprecation lists), every
 * other key and value as served.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PluginLoader } from '../services/PluginLoader';
import { pluginPublicBasePath } from '../services/PluginHostContract';
import {
  classifyHealthTransportFailure,
  interpretHealthAnswer,
  probePluginHealth,
  HEALTH_BODY_LIMIT_BYTES,
  PLUGIN_HEALTH_DETAILS,
} from '../services/PluginHealthProbe';
import { installPluginSettingsDouble } from './support/pluginSettingsDouble';

installPluginSettingsDouble();

const ORB = '{"status":"ok","version":"2.2.0","service":"nim-orb"}';
const USAGE = '{"status":"ok","service":"usage-limits","version":"1.4.2"}';
const CONTENT_ENGINE = '{"status":"ok","version":"0.2.0"}';
const GPU_GATEWAY = fs.readFileSync(path.join(__dirname, 'fixtures', 'pluginHealth', 'gpuGatewayHealth.json'), 'utf8');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const servers: http.Server[] = [];
async function serve(handler: Handler): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
/** A port nothing listens on: a real refused connection, not a described one. */
async function deadPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
const answer = (status: number, body: string, type = 'application/json'): Handler => (_req, res) => {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
};
const url = (port: number) => `http://127.0.0.1:${port}/health`;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('interpretHealthAnswer: the documented and the recorded shapes', () => {
  it.each([
    ['Orb', ORB], ['Usage Limits', USAGE], ['Content Engine', CONTENT_ENGINE], ['GPU Gateway', GPU_GATEWAY],
  ])('%s answers a healthy 200 with no shape note', (_name, body) => {
    expect(interpretHealthAnswer(200, body)).toEqual({ healthy: true, kind: 'ok', detail: 'NONE', httpStatus: 200 });
  });

  it('keeps the GPU Gateway fixture honest to the documented shape: its status word is "healthy", not "ok"', () => {
    const parsed = JSON.parse(GPU_GATEWAY);
    expect(parsed.status).toBe('healthy');
    expect(Object.keys(parsed)).toEqual([
      'status', 'ready', 'readiness_status', 'services', 'comfyui_capability', 'tts_backends',
      'model_catalogue', 'secondary_node', 'architecture', 'queue', 'gpus',
    ]);
  });

  it.each([
    ['plain text ok', 'ok', 'BODY_NOT_JSON'],
    ['an empty body', '', 'BODY_EMPTY'],
    ['a list', '[{"status":"ok"}]', 'BODY_NOT_OBJECT'],
    ['a bare string', '"ok"', 'BODY_NOT_OBJECT'],
    ['an object without status', '{"version":"1.0.0"}', 'STATUS_MISSING'],
    ['a boolean status', '{"status":true}', 'STATUS_NOT_STRING'],
    ['an unknown status word', '{"status":"fine-ish"}', 'STATUS_UNRECOGNISED'],
  ])('%s on a 200 is a named shape outcome that stays healthy', (_label, body, detail) => {
    expect(interpretHealthAnswer(200, body)).toEqual({ healthy: true, kind: 'shape', detail, httpStatus: 200 });
  });

  it.each(['degraded', 'error', 'unhealthy', 'down', 'FAILED'])('a 200 whose status word is %s is a plugin-reported failure', word => {
    expect(interpretHealthAnswer(200, JSON.stringify({ status: word }))).toEqual({
      healthy: false, kind: 'plugin_reported', detail: 'STATUS_REPORTED_UNHEALTHY', httpStatus: 200,
    });
  });

  it.each([301, 302, 308])('a %i is a redirect that is named, not followed', code => {
    expect(interpretHealthAnswer(code, null)).toEqual({ healthy: false, kind: 'redirect', detail: 'REDIRECT_NOT_FOLLOWED', httpStatus: code });
  });

  it.each([404, 500, 503])('a %i is a plugin-reported failure carrying the number', code => {
    expect(interpretHealthAnswer(code, null)).toEqual({ healthy: false, kind: 'plugin_reported', detail: 'HTTP_STATUS_NOT_OK', httpStatus: code });
  });

  it('an unread oversized 200 stays healthy and is named', () => {
    expect(interpretHealthAnswer(200, null, true)).toEqual({ healthy: true, kind: 'shape', detail: 'BODY_TOO_LARGE_TO_READ', httpStatus: 200 });
  });
});

describe('classifyHealthTransportFailure: typed markers only', () => {
  // The platform shape: a TypeError whose own `cause` data property holds the system error.
  const withCause = (message: string, cause: unknown) => Object.assign(new TypeError(message), { cause });
  const fetchFailed = (code: string) => withCause('fetch failed', Object.assign(new Error('private text with an address'), { code }));
  it.each([
    ['ECONNREFUSED', 'CONNECTION_REFUSED'], ['ENOTFOUND', 'HOST_NOT_FOUND'], ['EAI_AGAIN', 'HOST_NOT_FOUND'],
    ['ECONNRESET', 'CONNECTION_RESET'], ['EHOSTUNREACH', 'HOST_UNREACHABLE'], ['UND_ERR_SOCKET', 'SOCKET_CLOSED'],
    ['UND_ERR_CONNECT_TIMEOUT', 'CONNECT_TIMEOUT'],
  ])('cause code %s is %s', (code, detail) => {
    expect(classifyHealthTransportFailure(fetchFailed(code), false)).toEqual({ healthy: false, kind: 'transport', detail });
  });

  it('an anonymous fetch failure without a known cause code is TRANSPORT_OTHER', () => {
    expect(classifyHealthTransportFailure(new TypeError('fetch failed'), false)).toEqual({ healthy: false, kind: 'transport', detail: 'TRANSPORT_OTHER' });
    expect(classifyHealthTransportFailure(fetchFailed('E_SOMETHING_ELSE'), false).detail).toBe('TRANSPORT_OTHER');
  });

  it('the probe timer flag decides a timeout, whatever was thrown', () => {
    expect(classifyHealthTransportFailure(new TypeError('fetch failed'), true)).toEqual({ healthy: false, kind: 'timeout', detail: 'REQUEST_TIMEOUT' });
  });

  it('is decided by the code, never by message text', () => {
    const lying = withCause('connect ECONNREFUSED 127.0.0.1:1', Object.assign(new Error('ECONNREFUSED'), { code: 'EWHATEVER' }));
    expect(classifyHealthTransportFailure(lying, false).detail).toBe('TRANSPORT_OTHER');
  });

  it('never runs a getter on the caught value and never throws', () => {
    let ran = false;
    const hostile = new TypeError('fetch failed');
    Object.defineProperty(hostile, 'cause', { get() { ran = true; throw new Error('trap'); } });
    expect(classifyHealthTransportFailure(hostile, false)).toEqual({ healthy: false, kind: 'transport', detail: 'TRANSPORT_OTHER' });
    expect(ran).toBe(false);
    expect(classifyHealthTransportFailure('a string', false).kind).toBe('internal');
    expect(classifyHealthTransportFailure(null, false).kind).toBe('internal');
  });
});

describe('probePluginHealth against real sockets', () => {
  it.each([['Orb', ORB], ['Usage Limits', USAGE], ['Content Engine', CONTENT_ENGINE], ['GPU Gateway', GPU_GATEWAY]])(
    'the recorded %s answer is healthy', async (_name, body) => {
      const port = await serve(answer(200, body));
      expect(await probePluginHealth({ url: url(port) })).toEqual({ healthy: true, kind: 'ok', detail: 'NONE', httpStatus: 200 });
    });

  it('a refused connection is a named transport failure, not an anonymous TypeError', async () => {
    const port = await deadPort();
    expect(await probePluginHealth({ url: url(port) })).toEqual({ healthy: false, kind: 'transport', detail: 'CONNECTION_REFUSED' });
  });

  it('a socket destroyed before any answer is a named transport failure', async () => {
    const port = await serve((req) => { req.socket.destroy(); });
    const outcome = await probePluginHealth({ url: url(port) });
    expect(outcome.kind).toBe('transport');
    expect(['SOCKET_CLOSED', 'CONNECTION_RESET']).toContain(outcome.detail);
  });

  it('a server that never answers is a timeout at the bound', async () => {
    const port = await serve(() => { /* hold the request open */ });
    expect(await probePluginHealth({ url: url(port), timeoutMs: 150 })).toEqual({ healthy: false, kind: 'timeout', detail: 'REQUEST_TIMEOUT' });
  });

  it('a body that stalls after the headers is a timeout, not a hang', async () => {
    const port = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":'); });
    expect((await probePluginHealth({ url: url(port), timeoutMs: 150 })).kind).toBe('timeout');
  });

  it('a redirect is named and never followed', async () => {
    let followed = false;
    const target = await serve((_req, res) => { followed = true; res.end(ORB); });
    const port = await serve((_req, res) => { res.writeHead(302, { location: url(target) }); res.end(); });
    expect(await probePluginHealth({ url: url(port) })).toEqual({ healthy: false, kind: 'redirect', detail: 'REDIRECT_NOT_FOLLOWED', httpStatus: 302 });
    expect(followed).toBe(false);
  });

  it('a 503 is plugin-reported with its number', async () => {
    const port = await serve(answer(503, '{"status":"error"}'));
    expect(await probePluginHealth({ url: url(port) })).toEqual({ healthy: false, kind: 'plugin_reported', detail: 'HTTP_STATUS_NOT_OK', httpStatus: 503 });
  });

  it('a 200 that states itself degraded is plugin-reported', async () => {
    const port = await serve(answer(200, '{"status":"degraded","detail":"queue stuck"}'));
    expect(await probePluginHealth({ url: url(port) })).toEqual({ healthy: false, kind: 'plugin_reported', detail: 'STATUS_REPORTED_UNHEALTHY', httpStatus: 200 });
  });

  it('a plain-text ok is healthy with a named shape note', async () => {
    const port = await serve(answer(200, 'ok', 'text/plain'));
    expect(await probePluginHealth({ url: url(port) })).toEqual({ healthy: true, kind: 'shape', detail: 'BODY_NOT_JSON', httpStatus: 200 });
  });

  it('a body over the read bound stays healthy and is not buffered whole', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok","pad":"' + 'x'.repeat(HEALTH_BODY_LIMIT_BYTES + 10) + '"}');
    });
    expect(await probePluginHealth({ url: url(port) })).toEqual({ healthy: true, kind: 'shape', detail: 'BODY_TOO_LARGE_TO_READ', httpStatus: 200 });
  });

  it('every detail it can return is in the closed list', async () => {
    const port = await deadPort();
    expect(PLUGIN_HEALTH_DETAILS).toContain((await probePluginHealth({ url: url(port) })).detail);
  });
});

describe('the loader names the installation and logs only closed codes', () => {
  let directory: string, loader: PluginLoader;
  const realFetch = global.fetch;
  /** installation name -> local port; the loader asks http://<name>:<manifest port>/health. */
  const routes = new Map<string, number>();
  const manifest = (name: string): any => ({
    schema_version: 'rh.plugin/1', name, version: '1.0.0', description: 'fixture',
    docker: { image: 'fixture:1', ports: {} },
    api: { base_path: pluginPublicBasePath(name), internal_port: 8080, health: '/health' },
    relayhall: { api_version: 1, trust: 'installed', capabilities: [] },
  });
  function install(names: string[]) {
    const plugins = names.map(name => {
      const source = path.join(directory, name); fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest(name)));
      return { name, source, enabled: true };
    });
    const config = path.join(directory, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ plugins }));
    loader = new PluginLoader(config, 3_600_000);
  }
  let errors: jest.SpyInstance, warns: jest.SpyInstance, logs: jest.SpyInstance;
  const text = (spy: jest.SpyInstance) => spy.mock.calls.map(call => call.map(String).join(' '));
  const healthLines = (spy: jest.SpyInstance) => text(spy).filter(line => line.startsWith('[PluginLoader] plugin health'));

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-health-test-'));
    routes.clear();
    // Real fetch, real sockets: only the host name the loader builds is mapped to a local port.
    global.fetch = ((input: any, init?: any) => {
      const asked = new URL(String(input));
      const port = routes.get(asked.hostname);
      if (port === undefined) return realFetch(input, init);
      return realFetch(`http://127.0.0.1:${port}${asked.pathname}`, init);
    }) as typeof fetch;
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    warns = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logs = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    loader?.stop(); global.fetch = realFetch;
    errors.mockRestore(); warns.mockRestore(); logs.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('a refusing plugin is named, classified, unhealthy, and the TypeError line is gone', async () => {
    install(['gpu-gateway', 'content-engine']);
    routes.set('gpu-gateway', await deadPort());
    routes.set('content-engine', await serve(answer(200, CONTENT_ENGINE)));
    await loader.initialize();

    const lines = healthLines(errors);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PluginLoader\] plugin health check failed plugin=gpu-gateway kind=transport detail=CONNECTION_REFUSED id=[0-9a-f-]{36}$/);
    for (const line of text(errors)) expect(line).not.toMatch(/class=TypeError|ERROR_UNCLASSIFIED|plugin health check failed:/);
    expect(loader.getPlugin('gpu-gateway')?.healthy).toBe(false);
    expect(loader.getPlugin('gpu-gateway')?.error).toMatch(/^Health check failed: transport\/CONNECTION_REFUSED \(errorId [0-9a-f-]{36}\)$/);
    expect(loader.getPlugin('content-engine')?.healthy).toBe(true);
    expect(loader.getPlugin('content-engine')?.error).toBeUndefined();
    expect(text(errors).filter(line => line.includes('content-engine'))).toEqual([]);
  });

  it('logs no host, port, address, body, header or message text', async () => {
    install(['sample-plugin']);
    routes.set('sample-plugin', await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-secret-header': 'header-secret-value' });
      res.end('{"status":"degraded","detail":"body-secret-value","token":"credential-secret-value"}');
    }));
    await loader.initialize();
    const everything = [...text(errors), ...text(warns), ...text(logs)].join('\n');
    expect(everything).toContain('plugin=sample-plugin kind=plugin_reported detail=STATUS_REPORTED_UNHEALTHY http=200');
    for (const secret of ['body-secret-value', 'header-secret-value', 'credential-secret-value', '127.0.0.1', ':8080']) expect(everything).not.toContain(secret);
    expect(loader.getPlugin('sample-plugin')?.error ?? '').not.toContain('body-secret-value');
  });

  it('a non-2xx keeps the number the registry has always shown', async () => {
    install(['sample-plugin']);
    routes.set('sample-plugin', await serve(answer(503, '{"status":"error"}')));
    await loader.initialize();
    expect(loader.getPlugin('sample-plugin')?.error).toBe('Health check returned 503');
    expect(healthLines(errors)[0]).toContain('plugin=sample-plugin kind=plugin_reported detail=HTTP_STATUS_NOT_OK http=503');
  });

  it('an unchanged failure is logged once, not on every tick, and a changed one is logged again', async () => {
    install(['sample-plugin']);
    let reset = false;
    const live = await serve((req, res) => { if (reset) { req.socket.destroy(); return; } res.writeHead(200, { 'content-type': 'application/json' }); res.end(ORB); });
    routes.set('sample-plugin', await deadPort());
    await loader.initialize();
    await loader.checkAllHealth(); await loader.checkAllHealth();
    expect(healthLines(errors)).toHaveLength(1);

    routes.set('sample-plugin', live); reset = true;
    await loader.checkAllHealth();
    expect(healthLines(errors)).toHaveLength(2);
    expect(healthLines(errors)[1]).toMatch(/plugin=sample-plugin kind=transport detail=(SOCKET_CLOSED|CONNECTION_RESET)/);
  });

  it('an unchanged failure is logged again every 30th tick', async () => {
    install(['sample-plugin']);
    routes.set('sample-plugin', await deadPort());
    await loader.initialize();
    for (let tick = 1; tick <= 61; tick++) await loader.checkAllHealth();
    // the first sighting, then the 30th and 60th repeat
    expect(healthLines(errors)).toHaveLength(3);
  });

  it('recovery is announced once and clears the error', async () => {
    install(['sample-plugin']);
    const port = await serve(answer(200, ORB));
    routes.set('sample-plugin', await deadPort());
    await loader.initialize();
    expect(loader.getPlugin('sample-plugin')?.healthy).toBe(false);
    routes.set('sample-plugin', port);
    await loader.checkAllHealth(); await loader.checkAllHealth();
    expect(healthLines(logs)).toEqual(['[PluginLoader] plugin health restored plugin=sample-plugin']);
    expect(loader.getPlugin('sample-plugin')?.healthy).toBe(true);
    expect(loader.getPlugin('sample-plugin')?.error).toBeUndefined();
  });

  it('a 200 with an undocumented body is named as a warning and the plugin stays healthy', async () => {
    install(['sample-plugin']);
    routes.set('sample-plugin', await serve(answer(200, 'ok', 'text/plain')));
    await loader.initialize();
    expect(loader.getPlugin('sample-plugin')?.healthy).toBe(true);
    expect(loader.getPlugin('sample-plugin')?.error).toBe('Health answer shape not recognised: BODY_NOT_JSON');
    const lines = healthLines(warns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PluginLoader\] plugin health answer not recognised plugin=sample-plugin kind=shape detail=BODY_NOT_JSON http=200 id=[0-9a-f-]{36}$/);
    expect(healthLines(errors)).toEqual([]);
  });

  it('the recorded Orb, Usage Limits, Content Engine and GPU Gateway answers log nothing and stay healthy', async () => {
    install(['nim-orb', 'usage-limits', 'content-engine', 'gpu-gateway']);
    routes.set('nim-orb', await serve(answer(200, ORB)));
    routes.set('usage-limits', await serve(answer(200, USAGE)));
    routes.set('content-engine', await serve(answer(200, CONTENT_ENGINE)));
    routes.set('gpu-gateway', await serve(answer(200, GPU_GATEWAY)));
    await loader.initialize();
    for (const name of ['nim-orb', 'usage-limits', 'content-engine', 'gpu-gateway']) {
      expect(loader.getPlugin(name)?.healthy).toBe(true);
      expect(loader.getPlugin(name)?.error).toBeUndefined();
    }
    expect([...healthLines(errors), ...healthLines(warns)]).toEqual([]);
  });
});
