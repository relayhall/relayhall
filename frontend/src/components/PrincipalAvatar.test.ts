/**
 * Identity colour assignment (card 60558599).
 *
 * The first two attempts at this shipped without a test and both produced
 * near-identical colours for different identities — a hash mod 360, then the
 * same hash times the golden angle. The property that actually matters is not
 * "spread out" but "never nearly-the-same": two identities must read as
 * clearly different or as plainly identical, because almost-identical implies
 * a distinction that is not there.
 */
import { describe, expect, it } from 'vitest';

import { hueForHandle, PRINCIPAL_HUES } from './PrincipalAvatar';

/** The identities actually seeded by migration 062, plus a spawn principal. */
const REAL_HANDLES = [
  'dashboard_user',
  'system',
  'service_account',
  'journal_publisher',
  'reports_reader',
  'hermes_task_agent',
  'clawbeat_qa',
  'clawbeat_reviewer',
  'hermes_qa',
  'hermes_qa_reviewer',
  'agent:hermes:4b801e59',
];

const MIN_SEPARATION_DEGREES = 30;

describe('PRINCIPAL_HUES palette', () => {
  it('keeps every pair of distinct hues visually apart', () => {
    for (let i = 0; i < PRINCIPAL_HUES.length; i++) {
      for (let j = i + 1; j < PRINCIPAL_HUES.length; j++) {
        const raw = Math.abs(PRINCIPAL_HUES[i] - PRINCIPAL_HUES[j]);
        const separation = Math.min(raw, 360 - raw); // hue is circular
        expect(separation).toBeGreaterThanOrEqual(MIN_SEPARATION_DEGREES);
      }
    }
  });
});

describe('hueForHandle', () => {
  it('is deterministic', () => {
    for (const handle of REAL_HANDLES) {
      expect(hueForHandle(handle)).toBe(hueForHandle(handle));
    }
  });

  it('only ever returns a palette hue', () => {
    for (const handle of [...REAL_HANDLES, '', 'a', 'x'.repeat(200), 'agent:openclaw:00000000']) {
      expect(PRINCIPAL_HUES).toContain(hueForHandle(handle));
    }
  });

  it('never produces two nearly-identical colours — the failure mode that matters', () => {
    // Distinct handles either share a hue exactly or differ by a full palette
    // step. This is the assertion both previous implementations would fail.
    for (let i = 0; i < REAL_HANDLES.length; i++) {
      for (let j = i + 1; j < REAL_HANDLES.length; j++) {
        const a = hueForHandle(REAL_HANDLES[i]);
        const b = hueForHandle(REAL_HANDLES[j]);
        if (a === b) continue;
        const raw = Math.abs(a - b);
        const separation = Math.min(raw, 360 - raw);
        expect(separation).toBeGreaterThanOrEqual(MIN_SEPARATION_DEGREES);
      }
    }
  });

  it('spreads the real handles across most of the palette', () => {
    // Not a distribution guarantee (collisions are legitimate), just a guard
    // against a hash that collapses everything onto one or two entries.
    const distinct = new Set(REAL_HANDLES.map(hueForHandle));
    expect(distinct.size).toBeGreaterThanOrEqual(6);
  });
});
