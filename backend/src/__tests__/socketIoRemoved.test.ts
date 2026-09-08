import fs from 'fs';
import path from 'path';

/**
 * Socket.IO was mounted on the raw http.Server, so it intercepted /socket.io/
 * before Express routing and authMiddleware never ran on it: the handshake was
 * reachable unauthenticated while every /api route correctly returned 401. It
 * had no producers (no io.emit anywhere), no importers of the exported `io`,
 * and no client — socket.io-client was tree-shaken out of the shipped bundle.
 * It was removed rather than gated. These assertions keep it gone.
 */
describe('Socket.IO surface is removed', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');

  test('server.ts constructs no Socket.IO server', () => {
    expect(serverSource).not.toContain('socket.io');
    expect(serverSource).not.toContain('SocketIOServer');
    expect(serverSource).not.toMatch(/io\.on\(/);
  });

  test('server.ts no longer exports an io instance', () => {
    expect(serverSource).toContain('export { app, server };');
    expect(serverSource).not.toMatch(/export \{[^}]*\bio\b[^}]*\}/);
  });

  test.each([
    ['backend', '../../package.json', 'socket.io'],
    ['frontend', '../../../frontend/package.json', 'socket.io-client'],
  ])('%s package.json does not depend on %s', (_label, rel, dep) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(dep);
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain(dep);
  });

  test('the authenticated /ws upgrade handler still authenticates', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../services/websocket.ts'), 'utf8');
    expect(ws).toContain("server.on('upgrade'");
    // Now the status-checking verifier: a disabled identity kept streaming the
    // whole board on its existing token because this handler only proved the
    // signature. P15's requirement is that the upgrade authenticates at all,
    // which a strictly stronger check still satisfies.
    expect(ws).toContain('verifyActiveDashboardToken(token)');
    expect(ws).toContain('401 Unauthorized');
  });
});
