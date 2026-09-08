/**
 * Minimal status bridge for orb-compatible plugins.
 *
 * Core no longer observes harness sessions or model state (strategy F11).
 * The bridge therefore forwards only dashboard WebSocket connectivity and an
 * explicit idle baseline. Rich presence belongs to push-based presence frames
 * in the later plugin/reporting phase.
 */

export interface OrbStatusPayload {
  ts: number;
  connected: boolean;
  source: 'ws' | 'poll';
  main: { state: string; detail?: string };
  agents: Array<{
    key: string;
    label: string;
    state: 'running' | 'idle' | 'completed';
    kind?: 'subagent' | 'session' | 'cron';
    startedAt?: number;
  }>;
  harnesses: Record<string, { busy: boolean; activeSessions?: number; label?: string }>;
}

type Listener = () => void;

class OrbStatusBus {
  private connected = false;
  private listeners = new Set<Listener>();

  setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.listeners.forEach(listener => listener());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  compose(): OrbStatusPayload {
    return {
      ts: Date.now(),
      connected: this.connected,
      source: this.connected ? 'ws' : 'poll',
      main: { state: 'idle' },
      agents: [],
      harnesses: {},
    };
  }
}

export const orbStatusBus = new OrbStatusBus();

/**
 * Forward orb-status into an orb iframe: reply to the ready handshake and
 * throttle subsequent connectivity updates. Posts are pinned to this origin.
 */
export function attachOrbStatusForwarder(iframe: HTMLIFrameElement): () => void {
  let timer: number | null = null;
  let disposed = false;

  const post = () => {
    if (disposed || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(
        { type: 'orb-status', v: 2, payload: orbStatusBus.compose() },
        window.location.origin,
      );
    } catch { /* iframe navigated away */ }
  };

  const schedule = () => {
    if (timer != null) return;
    timer = window.setTimeout(() => { timer = null; post(); }, 500);
  };

  const onReady = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (event.data && typeof event.data === 'object' && event.data.type === 'orb-ready') {
      post();
    }
  };

  window.addEventListener('message', onReady);
  const unsubscribe = orbStatusBus.subscribe(schedule);
  post();

  return () => {
    disposed = true;
    window.removeEventListener('message', onReady);
    unsubscribe();
    if (timer != null) window.clearTimeout(timer);
  };
}
