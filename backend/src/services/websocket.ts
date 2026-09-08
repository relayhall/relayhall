import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { verifyActiveDashboardToken } from '../utils/dashboardToken';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { readCookie } from '../utils/cookies';
import { isFlagOn, FLAG_SESSIONS } from '../utils/featureFlags';
import { SESSION_COOKIE_NAME, loginSessionService } from './LoginSessionService';
import { principalService } from './PrincipalService';

/**
 * SS-W1: authenticate the upgrade from the login-session cookie.
 *
 * The stream URL carries `?token=` read from localStorage, which a session
 * user does not have — so every Account that signed in the new way got an
 * unauthenticated upgrade and no live updates at all. An upgrade request is
 * same-origin and carries cookies, so the same predicate the REST ingress
 * uses works here unchanged: live row, un-idled, unrevoked, active principal.
 */
async function sessionAuthenticatesUpgrade(cookieHeader: string | undefined): Promise<boolean> {
  if (!isFlagOn(FLAG_SESSIONS)) return false;
  const sessionToken = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!sessionToken) return false;
  try {
    const session = await loginSessionService.resolve(sessionToken);
    if (!session) return false;
    const principal = await principalService.getPrincipalById(session.principalId);
    return Boolean(principal && principal.status === 'active');
  } catch {
    return false;
  }
}

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(server: Server, path: string = '/ws') {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle the upgrade manually so each service owns exactly one path
    server.on('upgrade', async (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      if (url.pathname !== path) return; // Let other upgrade handlers claim other paths

      const token = url.searchParams.get('token');
      let authenticated = false;
      if (token) {
        try {
          await verifyActiveDashboardToken(token);
          authenticated = true;
        } catch {
          authenticated = false;
        }
      }
      if (!authenticated) {
        authenticated = await sessionAuthenticatesUpgrade(request.headers.cookie);
      }
      if (!authenticated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    console.log(`🔌 WebSocket server initialized on ${path}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket) {
    console.log('📡 Client connected');
    this.clients.add(ws);

    // Send initial connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: Date.now()
    }));

    // Heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000); // Every 30 seconds

    // Handle pong responses
    ws.on('pong', () => {
      // Client is alive
    });

    // Handle messages from client
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, message);
      } catch (error) {
        logCaughtFailure('[WebSocket] client message parse failed', error);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log('📡 Client disconnected');
      this.clients.delete(ws);
      clearInterval(heartbeatInterval);
    });

    // Handle errors
    ws.on('error', (error: Error) => {
      logCaughtFailure('[WebSocket] connection failed', error);
      this.clients.delete(ws);
    });
  }

  private handleClientMessage(ws: WebSocket, message: any) {
    // Handle client requests
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  public broadcast(data: any) {
    const message = JSON.stringify(data);
    let successCount = 0;
    let failCount = 0;

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          successCount++;
        } catch (error) {
          logCaughtFailure('[WebSocket] client send failed', error);
          failCount++;
        }
      } else {
        // Remove dead clients
        this.clients.delete(client);
      }
    });

    // Log only if there are clients
    if (successCount > 0 || failCount > 0) {
      console.log(`📤 Broadcast: ${successCount} sent, ${failCount} failed, ${this.clients.size} total clients`);
    }
  }

  /**
   * Get the number of connected clients
   */
  public getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all connections and shut down the server
   */
  public shutdown() {
    console.log('🔌 Shutting down WebSocket server...');
    this.clients.forEach((client) => {
      client.close();
    });
    this.wss.close();
  }
}
