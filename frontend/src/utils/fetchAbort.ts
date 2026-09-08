/**
 * Is this failed fetch one we walked away from, rather than one that failed?
 *
 * Lifted out of `PluginContext` for task `91c23edc`, absorbed into A8 by owner
 * ruling `de70a6dd` R8. The shell plugin poll was one instance of a pattern the
 * A/B live QA found on thirteen more page-level fetches: reload or navigation
 * churn kills in-flight requests and every one of them reached the console as
 * an error, which made A8's "consoles clean" criterion impossible to assert
 * honestly.
 *
 * Two shapes reach those catch blocks and neither is a defect. A request we
 * abort ourselves rejects with an `AbortError`. A document torn down by a
 * reload has its in-flight requests killed by the browser, which reports a bare
 * `TypeError: Failed to fetch` — the same shape a real network failure has. The
 * error cannot classify itself, so the flag that tells the truth is our own
 * record of the teardown.
 */

let unloading = false;

if (typeof window !== 'undefined') {
  // One listener pair for the whole app rather than one per consumer.
  // `pagehide` also fires on bfcache entry, and `pageshow` is how a restored
  // page says it is live again.
  window.addEventListener('pagehide', () => { unloading = true; });
  window.addEventListener('pageshow', () => { unloading = false; });
}

/**
 * A response we actually read proves the document is alive, whatever `pagehide`
 * claimed. Without this an unmatched `pagehide` would latch the flag on and
 * silence every genuine failure for the rest of the page's life — a worse
 * defect than the console noise this module exists to remove.
 */
export function markDocumentAlive(): void {
  unloading = false;
}

/** Test seam: the flag is module state, so a suite needs a way to reset it. */
export function resetDocumentLifecycleForTest(): void {
  unloading = false;
}

export function isIntentionalAbort(err: unknown, signal?: AbortSignal): boolean {
  if (unloading) return true;
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}
