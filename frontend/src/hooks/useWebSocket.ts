import { useEffect, useRef, useCallback, useState } from 'react';
import { auth } from '../utils/auth';

type MessageHandler = (data: any) => void;

interface WebSocketManager {
  subscribe: (type: string, handler: MessageHandler) => () => void;
  connected: boolean;
  send: (data: any) => void;
}

// Singleton WebSocket connection shared across all components
let globalWs: WebSocket | null = null;
let globalConnected = false;
let globalListeners = new Map<string, Set<MessageHandler>>();
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let connectionListeners = new Set<(connected: boolean) => void>();
let refCount = 0;

function getWsUrl(): string {
  // WebSocket endpoint is at {API_BASE}/ws
  // Uses the same API base URL as REST calls for correct reverse proxy routing
  const apiBase = (import.meta as any).env?.VITE_API_BASE_URL || '/api';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const token = auth.getToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${host}${apiBase}/ws${tokenParam}`;
}

function notifyConnection(connected: boolean) {
  globalConnected = connected;
  connectionListeners.forEach(fn => fn(connected));
}

function dispatch(type: string, data: any) {
  const handlers = globalListeners.get(type);
  if (handlers) {
    handlers.forEach(fn => {
      try { fn(data); } catch (e) { console.error('WS handler error:', e); }
    });
  }
}

function connect() {
  if (globalWs && (globalWs.readyState === WebSocket.OPEN || globalWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = getWsUrl();

  try {
    const ws = new WebSocket(url);
    globalWs = ws;

    ws.onopen = () => {
      console.log('[useWebSocket] Connected');
      reconnectAttempts = 0;
      notifyConnection(true);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type) {
          dispatch(message.type, message);
        }
      } catch (e) {
        console.error('[useWebSocket] Parse error:', e);
      }
    };

    ws.onerror = () => {
      notifyConnection(false);
    };

    ws.onclose = () => {
      console.log('[useWebSocket] Disconnected');
      globalWs = null;
      notifyConnection(false);

      if (refCount > 0) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectTimeout = setTimeout(() => {
          reconnectAttempts++;
          connect();
        }, delay);
      }
    };
  } catch {
    console.error('[useWebSocket] Connection failed');
    reconnectTimeout = setTimeout(connect, 5000);
  }
}

function disconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (globalWs) {
    globalWs.close();
    globalWs = null;
  }
  notifyConnection(false);
}

/**
 * Shared WebSocket hook. All components share one connection.
 * Subscribe to specific message types by name.
 */
export function useWebSocket(): WebSocketManager {
  const [connected, setConnected] = useState(globalConnected);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    refCount++;

    // Track connection state
    const connListener = (c: boolean) => {
      if (mountedRef.current) setConnected(c);
    };
    connectionListeners.add(connListener);

    // Start connection if first consumer
    if (refCount === 1) {
      connect();
    } else if (globalConnected) {
      setConnected(true);
    }

    return () => {
      mountedRef.current = false;
      connectionListeners.delete(connListener);
      refCount--;
      if (refCount === 0) {
        disconnect();
      }
    };
  }, []);

  const subscribe = useCallback((type: string, handler: MessageHandler) => {
    if (!globalListeners.has(type)) {
      globalListeners.set(type, new Set());
    }
    globalListeners.get(type)!.add(handler);

    return () => {
      const handlers = globalListeners.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          globalListeners.delete(type);
        }
      }
    };
  }, []);

  const send = useCallback((data: any) => {
    if (globalWs && globalWs.readyState === WebSocket.OPEN) {
      globalWs.send(JSON.stringify(data));
    }
  }, []);

  return { subscribe, connected, send };
}
