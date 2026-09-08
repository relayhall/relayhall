import { describe, expect, test } from 'vitest';
import { makeIdempotencyKey, safeHost, safeResourceSummary } from './resources';

describe('safe resource summaries', () => {
  test('URLs reduce to host only — no path, query, fragment or user-info', () => {
    expect(safeHost('https://app.example.com/deep/path?token=secret#frag')).toBe('app.example.com');
    expect(safeHost('https://user:pass@app.example.com/x')).toBe('app.example.com');
    expect(safeHost('ssh://git@git.example.com:2222/org/repo.git')).toBe('git.example.com:2222');
    expect(safeHost('git@git.example.com:org/repo.git')).toBe('git.example.com');
    expect(safeHost('')).toBe('');
  });

  test('workspace summaries show the path; URL kinds show the host', () => {
    expect(safeResourceSummary({ kind: 'workspace', details: { path: '/srv/build/demo', purpose: 'build' } }))
      .toBe('/srv/build/demo');
    expect(safeResourceSummary({
      kind: 'environment',
      details: { url: 'https://demo.example.com/admin?key=1', stage: 'staging' },
    })).toBe('demo.example.com');
  });
});

describe('idempotency keys', () => {
  test('are unique and within the contract length bounds (16..128)', () => {
    const a = makeIdempotencyKey();
    const b = makeIdempotencyKey();
    expect(a).not.toBe(b);
    for (const key of [a, b]) {
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(key.length).toBeLessThanOrEqual(128);
    }
  });
});
