import fs from 'fs';
import path from 'path';
import { buildOpenApiSpec } from '../openapi/spec';

describe('personality management authorization contract', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../routes/personalities.ts'), 'utf8');
  const authSource = fs.readFileSync(path.resolve(__dirname, '../middleware/auth.ts'), 'utf8');

  test('every personality mutation is protected by management authority', () => {
    for (const route of ["router.post('/'", "router.patch('/:id'", "router.delete('/:id'"]) {
      const start = source.indexOf(route);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(source.slice(start, start + 260)).toContain('requireManageAuthority(req, res)');
    }
  });

  test('OpenAPI matches the runtime split between scoped Bearer keys and the legacy header key', () => {
    const spec: any = buildOpenApiSpec();
    expect(spec.components.securitySchemes.bearer).toEqual(expect.objectContaining({
      type: 'http',
      scheme: 'bearer',
      description: expect.stringContaining('scoped rh_'),
    }));
    expect(spec.components.securitySchemes.apiKey).toEqual(expect.objectContaining({
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
      description: expect.stringContaining('Legacy deployment-wide'),
    }));
    expect(spec.security).toEqual(expect.arrayContaining([{ bearer: [] }, { apiKey: [] }]));
    expect(authSource).toContain("authHeader.startsWith('Bearer rh_')");
    expect(authSource).toContain("req.headers['x-api-key']");
  });

  // Structural absence pin (2026-08-09 owner ruling: board-native personalities
  // only). The repository-sync surface must stay gone — route, service walker,
  // env var, OpenAPI entry and scope rule; a stray call fails closed to root.
  test('the removed repository-sync surface stays removed', () => {
    const serviceSource = fs.readFileSync(path.resolve(__dirname, '../services/PersonalityService.ts'), 'utf8');
    const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    const scopeSource = fs.readFileSync(path.resolve(__dirname, '../utils/scopeMap.ts'), 'utf8');

    expect(source).not.toContain("router.post('/sync'");
    expect(serviceSource).not.toContain('syncFromRepo');
    expect(serviceSource).not.toContain('AGENCY_AGENTS');
    expect(serverSource).not.toContain('syncFromRepo');
    expect(scopeSource).not.toMatch(/personalities\\\/sync\$\/, scope/);

    const spec: any = buildOpenApiSpec();
    expect(spec.paths['/personalities/sync']).toBeUndefined();
  });
});
