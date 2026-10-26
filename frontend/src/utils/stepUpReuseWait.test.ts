/**
 * Owner ruling E444: how long the step-up dialog waits after the Identity
 * provider reused a recent sign-in. Pinned: the wait runs to the reused
 * sign-in's `auth_time` plus the reuse window when the refusal carries it;
 * to the whole stated window when only that is known; to a cautious window
 * that is SAID to be cautious when neither is; and always within its bounds.
 */
import { describe, expect, test } from 'vitest';
import {
  CONSERVATIVE_REUSE_WINDOW_SECONDS,
  EDGE_MARGIN_SECONDS,
  MAX_REUSE_WAIT_SECONDS,
  MIN_REUSE_WAIT_SECONDS,
  reuseWait,
} from './stepUpReuseWait';

const NOW = Date.UTC(2026, 9, 23, 10, 30, 0);
const nowSeconds = NOW / 1000;

describe('reuseWait', () => {
  test('neither figure known: the cautious window from now, said to be cautious', () => {
    expect(reuseWait({ now: NOW })).toEqual({ seconds: CONSERVATIVE_REUSE_WINDOW_SECONDS, source: 'conservative' });
    expect(reuseWait({ authTime: null, reuseWindowSeconds: null, now: NOW }).source).toBe('conservative');
    // The cautious window covers the about-30 s reuse the owner met (E444).
    expect(CONSERVATIVE_REUSE_WINDOW_SECONDS).toBeGreaterThan(30);
  });

  test('only the window known: the whole window from now', () => {
    expect(reuseWait({ reuseWindowSeconds: 60, now: NOW })).toEqual({ seconds: 60, source: 'window' });
  });

  test('auth_time and window known: until auth_time plus the window, and a small margin past the edge', () => {
    expect(reuseWait({ authTime: nowSeconds - 20, reuseWindowSeconds: 30, now: NOW }))
      .toEqual({ seconds: 30 - 20 + EDGE_MARGIN_SECONDS, source: 'auth_time' });
  });

  test('only auth_time known: the cautious window, counted from auth_time', () => {
    expect(reuseWait({ authTime: nowSeconds - 10, now: NOW }))
      .toEqual({ seconds: CONSERVATIVE_REUSE_WINDOW_SECONDS - 10 + EDGE_MARGIN_SECONDS, source: 'auth_time' });
  });

  test('a wait is never shorter than the floor, so a retry cannot fire straight back into the reuse', () => {
    expect(reuseWait({ authTime: nowSeconds - 3600, reuseWindowSeconds: 30, now: NOW }).seconds).toBe(MIN_REUSE_WAIT_SECONDS);
  });

  test('nor longer than the ceiling', () => {
    expect(reuseWait({ reuseWindowSeconds: MAX_REUSE_WAIT_SECONDS, now: NOW }).seconds).toBe(MAX_REUSE_WAIT_SECONDS);
    expect(reuseWait({ authTime: nowSeconds, reuseWindowSeconds: MAX_REUSE_WAIT_SECONDS, now: NOW }).seconds).toBe(MAX_REUSE_WAIT_SECONDS);
  });

  test('figures that say nothing usable are not used', () => {
    // A window outside what a provider policy may hold, zero, negative or not a number.
    for (const reuseWindowSeconds of [0, -5, MAX_REUSE_WAIT_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reuseWait({ reuseWindowSeconds, now: NOW })).toEqual({ seconds: CONSERVATIVE_REUSE_WINDOW_SECONDS, source: 'conservative' });
    }
    // An auth_time in the future.
    expect(reuseWait({ authTime: nowSeconds + 60, reuseWindowSeconds: 30, now: NOW })).toEqual({ seconds: 30, source: 'window' });
  });

  test('whole seconds only', () => {
    const wait = reuseWait({ authTime: nowSeconds - 20.4, reuseWindowSeconds: 30, now: NOW });
    expect(Number.isInteger(wait.seconds)).toBe(true);
    expect(wait.seconds).toBe(12);
  });
});
