// @vitest-environment jsdom
/**
 * The shared navigation-teardown predicate (`91c23edc`, absorbed into A8 by
 * owner ruling `de70a6dd` R8; originally proved out under `ce58eb66`).
 *
 * These tests moved here with the predicate itself. The half that matters is
 * the negative one: a genuine failure must still be reported. Swallowing an
 * abort quietly is a fix; swallowing everything quietly is the same defect
 * wearing a badge, and now it would be wearing it on fourteen call sites.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  isIntentionalAbort,
  markDocumentAlive,
  resetDocumentLifecycleForTest,
} from './fetchAbort';

beforeEach(resetDocumentLifecycleForTest);
afterEach(resetDocumentLifecycleForTest);

describe('what counts as our own abort', () => {
  test('an AbortError, by name', () => {
    const err = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(isIntentionalAbort(err)).toBe(true);
  });

  test('a request whose own signal we aborted, whatever shape the error has', () => {
    // The reload case: the browser reports a bare TypeError indistinguishable
    // from a real network failure, so the signal is what tells the truth.
    const controller = new AbortController();
    controller.abort();
    expect(isIntentionalAbort(new TypeError('Failed to fetch'), controller.signal)).toBe(true);
  });

  test('any failure that arrives while the document is unloading', () => {
    window.dispatchEvent(new Event('pagehide'));
    expect(isIntentionalAbort(new TypeError('Failed to fetch'))).toBe(true);
  });
});

describe('what must still be reported', () => {
  test('a live network failure is NOT an intentional abort', () => {
    const controller = new AbortController();
    expect(isIntentionalAbort(new TypeError('Failed to fetch'), controller.signal)).toBe(false);
  });

  test('a non-ok response turned into an Error is NOT an intentional abort', () => {
    expect(isIntentionalAbort(new Error('Failed to fetch plugins: 500'))).toBe(false);
  });

  test('a plain rejection with no signal and no teardown is NOT an intentional abort', () => {
    expect(isIntentionalAbort(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('the unloading flag cannot latch on', () => {
  test('pageshow clears it, so a bfcache restore reports failures again', () => {
    window.dispatchEvent(new Event('pagehide'));
    expect(isIntentionalAbort(new TypeError('Failed to fetch'))).toBe(true);
    window.dispatchEvent(new Event('pageshow'));
    expect(isIntentionalAbort(new TypeError('Failed to fetch'))).toBe(false);
  });

  test('reading a response clears it, because that proves the document is alive', () => {
    // Defence against a `pagehide` with no matching `pageshow`. If the flag
    // stuck, every later failure across all fourteen call sites would be
    // swallowed for the rest of the page's life.
    window.dispatchEvent(new Event('pagehide'));
    expect(isIntentionalAbort(new TypeError('Failed to fetch'))).toBe(true);
    markDocumentAlive();
    expect(isIntentionalAbort(new TypeError('Failed to fetch'))).toBe(false);
  });
});
