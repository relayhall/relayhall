import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/auth', () => ({
  auth: { getToken: vi.fn() },
}));

import { auth } from '../utils/auth';
import { useWebSocket } from './useWebSocket';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static attemptedUrls: string[] = [];
  static failConstruction = false;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = FakeWebSocket.CLOSED; });

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.attemptedUrls.push(this.url);
    if (FakeWebSocket.failConstruction) {
      throw new Error(`Hostile browser exception includes ${this.url}`);
    }
    FakeWebSocket.instances.push(this);
  }
}

function restoreGlobal(name: 'window' | 'WebSocket', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function Harness() {
  useWebSocket();
  return null;
}

let renderer: ReactTestRenderer | undefined;
let consoleSpies: Array<{ mock: { calls: unknown[][] }; mockRestore: () => void }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeWebSocket.instances = [];
  FakeWebSocket.attemptedUrls = [];
  FakeWebSocket.failConstruction = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'https:', host: 'board.example.test' } },
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket,
  });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = undefined;
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  consoleSpies.forEach(spy => spy.mockRestore());
  restoreGlobal('window', originalWindow);
  restoreGlobal('WebSocket', originalWebSocket);
});

describe('useWebSocket connection logging', () => {
  const bearer = [
    'jwt-header',
    'jwt-payload',
    'jwt-signature',
    'hostile&next=https://attacker.invalid/?q=token',
  ].join('.');
  const expectedUrl = `wss://board.example.test/api/ws?token=${encodeURIComponent(bearer)}`;

  function expectNoDisclosure() {
    const logged = consoleSpies.flatMap(spy => spy.mock.calls.flat()).map(value => String(value)).join('\n');
    expect(logged).not.toContain(bearer);
    expect(logged).not.toContain(encodeURIComponent(bearer));
    expect(logged).not.toContain(expectedUrl);
    expect(logged).not.toContain('board.example.test/api/ws');
  }

  it('never discloses the bearer token or constructed URL across reconnects', () => {
    vi.mocked(auth.getToken).mockReturnValue(bearer);

    act(() => { renderer = create(<Harness />); });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe(expectedUrl);

    act(() => { FakeWebSocket.instances[0].onclose?.({} as CloseEvent); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe(expectedUrl);

    expectNoDisclosure();
  });

  it('keeps browser-thrown URL details out of failed connection retries', () => {
    vi.mocked(auth.getToken).mockReturnValue(bearer);
    FakeWebSocket.failConstruction = true;

    act(() => { renderer = create(<Harness />); });
    act(() => { vi.advanceTimersByTime(5000); });

    expect(FakeWebSocket.attemptedUrls).toEqual([expectedUrl, expectedUrl]);
    expectNoDisclosure();
  });
});
