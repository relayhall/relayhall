import express from 'express';
import { AddressInfo } from 'net';
import router from '../routes/toolCatalogue';
import { MCP_TOOLS, toolEffect } from '../mcp/registry';
import { requiredScopeFor } from '../utils/scopeMap';
import { routeTransportClassFor } from '../utils/transportMap';

test('catalogue exactly projects real MCP declarations without handlers or capability grants', async () => {
  const app = express(); app.use('/tool-catalogue', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tool-catalogue`;
  try {
  const raw = await fetch(url);
  expect(raw.status).toBe(200);
  const response = { headers: { 'cache-control': raw.headers.get('cache-control') }, body: await raw.json() as { tools: Array<Record<string, unknown>> } };
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body.tools).toEqual(MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, plane: t.plane, effect: toolEffect(t), requiredScope: t.scope ?? null })));
  expect(response.body.tools.length).toBeGreaterThan(0);
  expect(Object.keys(response.body.tools[0]).sort()).toEqual(['description', 'effect', 'inputSchema', 'name', 'plane', 'requiredScope']);
  expect((await fetch(url, { method: 'POST' })).status).toBe(404);
  expect((await fetch(url + '/arbitrary')).status).toBe(404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('metadata is authenticated reference only; mutations and descendant paths remain fail-closed', () => {
  expect(requiredScopeFor('GET', '/tool-catalogue')).toBe('authenticated');
  expect(requiredScopeFor('POST', '/tool-catalogue')).toBe('root');
  expect(requiredScopeFor('GET', '/tool-catalogue/arbitrary')).toBe('root');
  expect(routeTransportClassFor('/tool-catalogue')).toBe('any');
  expect(routeTransportClassFor('/tool-catalogue/arbitrary')).toBe('any');
  expect(routeTransportClassFor('/tool-catalogue-other')).toBeUndefined();
});
