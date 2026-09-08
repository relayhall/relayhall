// @vitest-environment jsdom
/**
 * Regression suite for defect `ce58eb66` (owner ruling `037bb84c` R6: fixed,
 * not waived).
 *
 * A7 live QA reloaded the Map often enough to race the app shell's plugin
 * poll, and every killed request landed in the console as
 * `Error fetching plugins: TypeError: Failed to fetch`. That is traffic noise,
 * not a defect, but it trips the console-clean QA gate that A8 has to pass
 * honestly — so the fetch now recognises the aborts it caused itself.
 *
 * The half of this suite that matters most is the negative one: a genuine
 * failure must still be logged and still raise the error state. Swallowing an
 * abort quietly is a fix; swallowing everything quietly is the same defect
 * wearing a badge.
 */
import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { PluginProvider, usePlugins } from './PluginContext';
import { resetDocumentLifecycleForTest } from '../utils/fetchAbort';
import { authenticatedFetch } from '../utils/auth';

vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(),
  auth: { getToken: () => 'test-token', clearToken: () => {} },
}));

const mockFetch = vi.mocked(authenticatedFetch);

/** Silences one console method and hands back the spy, correctly typed. */
function silence(method: 'error' | 'log') {
  return vi.spyOn(console, method).mockImplementation(() => {});
}

let errorSpy: ReturnType<typeof silence>;
let logSpy: ReturnType<typeof silence>;

/** A plugins response the provider accepts, with no plugins in it. */
function emptyResponse() {
  return { ok: true, status: 200, json: async () => ({ plugins: [] }) } as unknown as Response;
}

/** Hands the test the live context value so it can call `refresh` directly. */
let captured: ReturnType<typeof usePlugins> | null = null;
function Probe() {
  const value = usePlugins();
  captured = value;
  return <span data-testid="probe">{value.error ? `error:${value.error.message}` : 'clean'}</span>;
}

function renderProvider() {
  return render(
    <PluginProvider>
      <Probe />
    </PluginProvider>
  );
}

beforeEach(() => {
  resetDocumentLifecycleForTest();
  captured = null;
  mockFetch.mockReset();
  errorSpy = silence('error');
  logSpy = silence('log');
});

afterEach(() => {
  resetDocumentLifecycleForTest();
  cleanup();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

// The predicate's own unit tests moved to utils/fetchAbort.test.ts when it
// was lifted out for task 91c23edc (absorbed into A8 by ruling de70a6dd R8).
// What stays here is the PROVIDER behaviour those units cannot show.

describe('PluginProvider fetch failures', () => {
  test('a genuine network failure is still logged and still raises the error state', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('probe')).toHaveTextContent('error:Failed to fetch');
    });
    expect(errorSpy).toHaveBeenCalledWith('Error fetching plugins:', expect.any(TypeError));
  });

  test('a non-ok response is still logged and still raises the error state', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('probe')).toHaveTextContent('error:Failed to fetch plugins: 503');
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  test('a REFUSAL is not a failure: nothing logged, no error state, an empty list (85014317)', async () => {
    // The registry is behind an administrator scope, so every non-admin Account
    // is refused here — correctly. Logging that filled every ordinary beta
    // user's console with red on every page load, which is exactly the noise
    // that makes a real error unfindable in a bug report.
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as unknown as Response);

    renderProvider();

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe')).toHaveTextContent('clean');
    expect(captured?.plugins).toEqual([]);
    expect(captured?.loading).toBe(false);
  });

  test('401 is treated the same way, because an expired session is not a defect either', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
    renderProvider();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('a refusal is asked ONCE, not retried as if it were a startup race', async () => {
    // The card counted three or more identical refusals per navigation. The
    // extra ones came from the "we got zero plugins, the loader may still be
    // warming up, ask again in 3s" pass — which is right for an empty 200 and
    // wrong for a refusal, because that zero is a decision about this session.
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as unknown as Response);
      renderProvider();
      await act(async () => { await Promise.resolve(); });
      const afterInitial = mockFetch.mock.calls.length;

      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(mockFetch.mock.calls.length).toBe(afterInitial);
    } finally {
      vi.useRealTimers();
    }
  });

  test('CONTROL: an empty 200 IS still retried, so the skip is about refusals only', async () => {
    // Without this, the test above is satisfied by deleting the retry outright,
    // which would reintroduce the startup race it exists for.
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(emptyResponse());
      renderProvider();
      await act(async () => { await Promise.resolve(); });
      const afterInitial = mockFetch.mock.calls.length;

      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(mockFetch.mock.calls.length).toBeGreaterThan(afterInitial);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an AbortError is swallowed: nothing logged, no error state', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    );

    renderProvider();

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe')).toHaveTextContent('clean');
  });

  test('a request killed after we aborted its signal is swallowed even as a bare TypeError', async () => {
    // The observed shape: the provider's own controller was aborted, and the
    // browser reports the dead request as `TypeError: Failed to fetch`.
    let capturedSignal: AbortSignal | undefined;
    let rejectFetch: (err: unknown) => void = () => {};
    mockFetch.mockImplementation((_url, options) => {
      capturedSignal = (options as RequestInit | undefined)?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
    });

    const { unmount } = renderProvider();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    unmount();
    expect(capturedSignal?.aborted).toBe(true);

    await act(async () => {
      rejectFetch(new TypeError('Failed to fetch'));
      await Promise.resolve();
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('a request killed while the document unloads is swallowed', async () => {
    let rejectFetch: (err: unknown) => void = () => {};
    mockFetch.mockImplementation(
      () => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; })
    );

    renderProvider();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      rejectFetch(new TypeError('Failed to fetch'));
      await Promise.resolve();
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe')).toHaveTextContent('clean');
  });

  test('the unloading flag cannot latch on: a completed response clears it', async () => {
    // Defence against a `pagehide` that is never followed by a `pageshow`. If
    // the flag stuck, every later failure would be swallowed and the error
    // state would never surface again for the life of the page.
    mockFetch.mockResolvedValue(emptyResponse());
    renderProvider();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });

    // A response lands after the pagehide, proving the document is alive.
    await act(async () => {
      await captured!.refresh();
    });

    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => {
      await captured!.refresh();
    });

    expect(errorSpy).toHaveBeenCalledWith('Error fetching plugins:', expect.any(TypeError));
  });

  test('a page restored from bfcache logs real failures again', async () => {
    let rejectFetch: (err: unknown) => void = () => {};
    mockFetch.mockImplementation(
      () => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; })
    );

    renderProvider();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    // Hidden, then restored: the unloading flag must not latch on.
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pageshow'));
      rejectFetch(new TypeError('Failed to fetch'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('Error fetching plugins:', expect.any(TypeError));
    });
  });
});

describe('PluginProvider lifecycle', () => {
  test('unmounting aborts the in-flight plugins request', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url, options) => {
      capturedSignal = (options as RequestInit | undefined)?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderProvider();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  test('refresh never lets a click event reach the AbortSignal parameter', async () => {
    mockFetch.mockResolvedValue(emptyResponse());

    renderProvider();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    mockFetch.mockClear();

    // Exactly how a future `onClick={refresh}` would call it.
    const clickEvent = { type: 'click', nativeEvent: {}, preventDefault: () => {} };
    await act(async () => {
      await (captured!.refresh as unknown as (arg: unknown) => Promise<void>)(clickEvent);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const options = mockFetch.mock.calls[0][1] as RequestInit | undefined;
    expect(options?.signal).toBeUndefined();
  });
});
