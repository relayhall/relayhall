import { IncomingMessage, Server } from 'http';
import { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { acceptPrincipalKey, AuthRequest, REST_TRANSPORT_STAMP } from '../middleware/auth';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { authorizationService, AuthorizationActor, DelegationActorLink } from './AuthorizationService';
import { requiredScopeFor } from '../utils/scopeMap';
import { feedEventService } from './FeedEventService';
import { stableJson } from '../utils/stableJson';
import {
  parseWakeClientFrame, parseWakeProtocol, WAKE_ACK_MAX_BYTES, WAKE_ACK_QUEUE_LIMIT,
  type WakeClientFrame, type WakeProtocol,
} from '../utils/connectorWakeProtocol';
// Types only: the socket layer never loads the wake dispatcher itself.
import type { ConnectorWakeService, WakeAttachResult } from './ConnectorWakeService';

interface SocketIdentity {
  actor: AuthorizationActor;
  principalId: string;
  handle: string;
  credentialId: string | null;
  delegationLinks: DelegationActorLink[] | null;
}

/** Client frames naming no wake this socket can settle or report on, before the socket closes. */
const MAX_UNMATCHED_ACKS = 16;

/**
 * A latency optimization over GET /events, never the dashboard broadcast bus.
 *
 * A socket opened with `?wake=1` or `?wake=2` becomes a Connector WAKE
 * endpoint (card 6dea3cca, see ConnectorWakeService) only once the dispatcher
 * has registered it (attach() returned enabled, and the client was told
 * `wake.status` enabled). From then on it may receive `wake` frames and may
 * send back `wake.ack` and, on protocol 2 only, `wake.outcome` (universal
 * harness connector design, owner ruling E462, section 6.7). Every other
 * socket, including a wake socket that was refused or is still being
 * registered, stays receive-only: any client frame closes it with 1008. On an
 * enabled wake socket anything but a well-formed frame of its protocol still
 * closes it with 1008.
 *
 * Each client frame costs a credential re-derivation, so the work is bounded
 * per socket: one frame is processed at a time, in arrival order; at most
 * WAKE_ACK_QUEUE_LIMIT are held; nothing is processed or handed to the
 * dispatcher once the socket has closed; and MAX_UNMATCHED_ACKS caps how many
 * that settle or record nothing are processed before the socket closes.
 */
export class ConnectorNotificationService {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: WAKE_ACK_MAX_BYTES, perMessageDeflate: false });
  private readonly connections = new Map<WebSocket, string>();
  private pending = 0;
  private stopped = false;
  private readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    private readonly server: Server,
    private readonly intervalMs = 1000,
    private readonly wake: ConnectorWakeService | null = null,
  ) {
    this.upgrade = (request, socket, head) => { void this.accept(request, socket, head); };
    server.on('upgrade', this.upgrade);
  }

  private refuse(socket: Duplex, status: number): void {
    if (!socket.destroyed) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      // Bound a peer that never consumes the HTTP refusal.
      const timer = setTimeout(() => socket.destroy(), 1000);
      timer.unref();
    }
  }

  /** Fresh request per check: expired delegation/scopes can never survive on a cached actor. */
  private async authorize(authorization: string): Promise<SocketIdentity | null> {
    const request = { method: 'GET', headers: { authorization } } as AuthRequest;
    const outcome = await acceptPrincipalKey(request, authorization, '/events', REST_TRANSPORT_STAMP);
    if (outcome.kind !== 'ok' || !request.principal) return null;
    const actor = actorFromRequest(request);
    if (!authorizationService.authorizeRoute(actor, requiredScopeFor('GET', '/events')).allowed) return null;
    return {
      actor,
      principalId: request.principal.id,
      handle: request.principal.handle,
      credentialId: request.credentialId ?? null,
      delegationLinks: request.delegationLinks ?? null,
    };
  }

  private async accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url: URL;
    try { url = new URL(request.url ?? '', 'http://relayhall.invalid'); } catch { return; }
    if (url.pathname !== '/events/ws') return;
    // Credentials belong only in Authorization. Reject unknown/duplicate query inputs,
    // including token, rather than creating an accidental URL-credential contract.
    // `wake=1` or `wake=2` (and only those values) opts the socket into
    // Connector wakes, naming the protocol.
    const keys = [...url.searchParams.keys()];
    const cursor = url.searchParams.get('cursor') ?? '0';
    const wakeValues = url.searchParams.getAll('wake');
    const wakeProtocol: WakeProtocol | null = wakeValues.length === 1 ? parseWakeProtocol(wakeValues[0]) : null;
    if (request.method !== 'GET' || keys.some(key => key !== 'cursor' && key !== 'wake')
      || url.searchParams.getAll('cursor').length > 1 || wakeValues.length > 1
      || (wakeValues.length === 1 && wakeProtocol === null)
      || !/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9223372036854775807n) {
      this.refuse(socket, 400); return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer rh_')) { this.refuse(socket, 401); return; }
    if (this.stopped || this.connections.size + this.pending >= 128 || this.pending >= 16) {
      this.refuse(socket, 503); return;
    }
    this.pending++;
    const deadline = setTimeout(() => socket.destroy(), 10000);
    deadline.unref();
    try {
      const identity = await this.authorize(authorization);
      if (socket.destroyed) return;
      if (!identity) { this.refuse(socket, 401); return; }
      if (this.stopped || [...this.connections.values()].filter(id => id === identity.principalId).length >= 4) {
        this.refuse(socket, 503); return;
      }
      this.wss.handleUpgrade(request, socket, head, ws => {
        this.connections.set(ws, identity.principalId);
        this.stream(ws, authorization, cursor, wakeProtocol ? identity.principalId : null, wakeProtocol ?? 1);
      });
    } catch {
      // No exception/request logging: upgrade input includes a credential.
      this.refuse(socket, 503);
    } finally {
      this.pending--;
      clearTimeout(deadline);
    }
  }

  private stream(
    ws: WebSocket, authorization: string, initialCursor: string, wakePrincipalId: string | null, protocol: WakeProtocol,
  ): void {
    let cursor = initialCursor;
    let busy = false;
    let closed = false;
    // Set only when the dispatcher has REGISTERED this socket (attach() returned
    // enabled). The `wake=` opt-in alone never lets a client send a frame.
    let wakeEnabled = false;
    let unmatchedAcks = 0;
    // acks[0] is the client frame being processed; the rest wait behind it.
    const acks: WakeClientFrame[] = [];
    let draining = false;
    const live = (): boolean => !closed && ws.readyState === WebSocket.OPEN;
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      acks.length = 0;
      clearInterval(timer);
      ws.close(code, reason);
      const deadline = setTimeout(() => ws.terminate(), 1000);
      deadline.unref();
    };
    const tick = async (): Promise<void> => {
      if (busy || closed || ws.readyState !== WebSocket.OPEN) return;
      busy = true;
      try {
        if (ws.bufferedAmount > 262144) { close(1013, 'Reconnect from your saved cursor'); return; }
        const identity = await this.authorize(authorization);
        if (!identity) { close(1008, 'Authorization expired or refused'); return; }
        // The canonical feed applies CURRENT object grants, delegation and tombstone
        // rules. Never subscribe this socket to dashboard broadcast() or raw DB rows.
        const authoritySnapshot = stableJson(identity.actor);
        const page = await feedEventService.listSince(identity.actor, cursor, 200);
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        // Recheck credential/delegation liveness after the asynchronous feed read.
        const currentIdentity = await this.authorize(authorization);
        if (!currentIdentity || stableJson(currentIdentity.actor) !== authoritySnapshot) {
          close(1008, 'Authorization changed; reconnect'); return;
        }
        const message = JSON.stringify({ type: 'events', events: page.events, nextCursor: page.nextCursor });
        if (Buffer.byteLength(message) > 262144 || ws.bufferedAmount > 262144) {
          close(1013, 'Use GET /events to resume'); return;
        }
        // Advance only after enqueue succeeds. Consumers persist nextCursor only
        // after processing the frame; disconnects may redeliver, never acknowledge.
        ws.send(message, error => { if (error) close(1011, 'Reconnect from your saved cursor'); });
        cursor = page.nextCursor;
      } catch {
        close(1011, 'Feed unavailable; use polling');
      } finally { busy = false; }
    };
    const acknowledge = async (frame: WakeClientFrame): Promise<void> => {
      try {
        // The frame is attributed to the CURRENT credential, re-derived
        // exactly as every batch is; a revoked one settles nothing.
        const identity = await this.authorize(authorization);
        // Nothing is handed to the dispatcher once the socket has closed.
        if (!live()) return;
        if (!identity || identity.principalId !== wakePrincipalId) { close(1008, 'Authorization expired or refused'); return; }
        const ackIdentity = {
          principalId: identity.principalId,
          handle: identity.handle,
          credentialId: identity.credentialId,
          delegationLinks: identity.delegationLinks,
          actor: identity.actor,
        };
        // Protocol 1 hands over exactly what it always did; protocol 2 also
        // names the socket, which is where the wake's outcome must come from.
        const settled = frame.type === 'wake.outcome'
          ? await this.wake!.recordOutcome(ackIdentity, frame.report, ws)
          : protocol === 2
            ? await this.wake!.acknowledge(ackIdentity, frame.ack, { socket: ws })
            : await this.wake!.acknowledge(ackIdentity, frame.ack);
        if (!settled && ++unmatchedAcks > MAX_UNMATCHED_ACKS) close(1008, 'Too many unmatched acknowledgements');
      } catch {
        close(1011, 'Acknowledgement failed; use polling');
      }
    };
    // One acknowledgement at a time, in arrival order, so the unmatched cap
    // bounds the re-authorizations a socket can cause.
    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (live() && acks.length > 0) {
          await acknowledge(acks[0]);
          acks.shift();
        }
      } finally {
        draining = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, this.intervalMs);
    timer.unref();
    ws.on('message', (data, isBinary) => {
      if (!live()) return;
      if (!wakeEnabled || !this.wake) { close(1008, 'This stream is receive-only'); return; }
      const ack = isBinary ? null : parseWakeClientFrame(data.toString(), protocol);
      if (!ack) {
        close(1008, protocol === 2 ? 'Only wake.ack and wake.outcome frames are accepted' : 'Only wake.ack frames are accepted');
        return;
      }
      if (acks.length >= WAKE_ACK_QUEUE_LIMIT) { close(1008, 'Too many acknowledgements waiting'); return; }
      acks.push(ack);
      void drain();
    });
    ws.on('error', () => close(1011, 'Connection failed'));
    ws.on('close', () => {
      closed = true;
      acks.length = 0;
      clearInterval(timer);
      this.connections.delete(ws);
      if (wakePrincipalId) this.wake?.detach(ws, wakePrincipalId);
    });
    if (wakePrincipalId) void this.enableWake(ws, wakePrincipalId, protocol, () => { wakeEnabled = true; });
    void tick();
  }

  /**
   * Register the wake endpoint and tell the Connector whether it will be woken.
   * `onEnabled` runs only for a socket the dispatcher registered and that is
   * still open, in the same turn as the registration: before this socket can
   * receive a wake, let alone answer one.
   */
  private async enableWake(ws: WebSocket, principalId: string, protocol: WakeProtocol, onEnabled: () => void): Promise<void> {
    let status: WakeAttachResult;
    try {
      // Protocol 1 registers exactly as it always did.
      status = !this.wake ? { enabled: false, reason: 'WAKE_UNAVAILABLE' }
        : protocol === 2 ? await this.wake.attach(ws, principalId, 2) : await this.wake.attach(ws, principalId);
    } catch {
      status = { enabled: false, reason: 'WAKE_UNAVAILABLE' };
    }
    if (ws.readyState !== WebSocket.OPEN) {
      if (status.enabled) this.wake?.detach(ws, principalId);
      return;
    }
    if (status.enabled) onEnabled();
    ws.send(JSON.stringify(status.enabled
      ? { type: 'wake.status', enabled: true }
      : { type: 'wake.status', enabled: false, reason: status.reason }), () => undefined);
  }

  shutdown(): void {
    this.stopped = true;
    this.server.removeListener('upgrade', this.upgrade);
    for (const ws of this.connections.keys()) ws.terminate();
    this.connections.clear();
    this.wss.close();
  }
}
