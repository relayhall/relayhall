/**
 * The Tier-0 policy engine (RH-TW1a; design 7d5c0cdc §6.1, sitting TS-5,
 * owner decision D9).
 *
 * The central test here is the NEGATIVE CONTROL: an envelope is stuffed with
 * a distinct marker string in every field a reporter can reach, the record is
 * serialized after redaction, and the whole serialization is searched for
 * every marker. It is sink-anchored — it asks the OUTPUT what survived rather
 * than asking the engine what it thinks it dropped — and it fails for any
 * field added later that nobody remembered to redact, which a field-by-field
 * assertion would not.
 *
 * Its own control: `markerSurvives` is proven able to FIND a marker (the
 * positive arm), so the negative control cannot pass vacuously.
 */
import {
  applyTelemetryPolicy,
  TELEMETRY_TIER0_POLICY_VERSION,
  TelemetryPolicyError,
} from '../services/TelemetryPolicyEngine';
import {
  resetTelemetryPepperCache, telemetryPseudonym,
  TELEMETRY_PSEUDONYM_DOMAINS, TELEMETRY_PSEUDONYM_PREFIX,
} from '../utils/telemetryPepper';
import type { TelemetryEnvelope } from '../types/TelemetryEnvelope';

const PEPPER_A = Buffer.alloc(32, 3).toString('base64');
const PEPPER_B = Buffer.alloc(32, 9).toString('base64');
const OBSERVED_AT = new Date('2026-09-03T12:00:00.000Z');

function setPeppers(active: 'a' | 'b' = 'a') {
  process.env.RELAYHALL_TELEMETRY_PEPPERS = JSON.stringify({ a: PEPPER_A, b: PEPPER_B });
  process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER = active;
  resetTelemetryPepperCache();
}

beforeEach(() => setPeppers('a'));
afterAll(() => {
  delete process.env.RELAYHALL_TELEMETRY_PEPPERS;
  delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
  resetTelemetryPepperCache();
});

function envelope(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: 'evt-1',
    kind: 'model_call',
    source: { product: 'claude-code', adapter: 'otlp' },
    ...overrides,
  } as TelemetryEnvelope;
}

describe('tier refusal is FALSIFIABLE, not a comment (TS-5, D9)', () => {
  it('refuses Tier 1 by throwing, naming the ruling', () => {
    expect(() => applyTelemetryPolicy(1, envelope(), { observedAt: OBSERVED_AT }))
      .toThrow(TelemetryPolicyError);
    try {
      applyTelemetryPolicy(1, envelope(), { observedAt: OBSERVED_AT });
    } catch (err) {
      expect((err as TelemetryPolicyError).code).toBe('TELEMETRY_TIER_UNAVAILABLE');
      expect((err as Error).message).toContain('TS-5');
    }
  });

  it('refuses Tier 2 by throwing', () => {
    expect(() => applyTelemetryPolicy(2, envelope(), { observedAt: OBSERVED_AT }))
      .toThrow(/Tier 2/);
  });

  it('accepts Tier 0', () => {
    const result = applyTelemetryPolicy(0, envelope(), { observedAt: OBSERVED_AT });
    expect(result.record.content.policy_tier).toBe(0);
    expect(result.policyVersion).toBe(TELEMETRY_TIER0_POLICY_VERSION);
  });
});

/**
 * The deny-by-default marker control that used to live here is SUPERSEDED by
 * `telemetryTier0HostileSurface.test.ts`. Review `bfac1dd5` finding F5 was
 * that a hand-maintained marker list falls behind the surface it guards — it
 * stayed green while F1 and F2 leaked. The replacement generates its envelope
 * from the frozen field inventory and cross-checks that inventory against the
 * validator's own allowlist sets, so a new field cannot be added without
 * gaining a hostile value. Keeping a second hand-written list here would
 * reintroduce the defect.
 */

describe('the opaque session grouping key (§10.1, TW1c)', () => {
  it('is a pseudonym, stable per source conversation, and differs across products', () => {
    const a = applyTelemetryPolicy(0, envelope({ correlation: { conversation_id: 'conv-1' } }), { observedAt: OBSERVED_AT });
    const again = applyTelemetryPolicy(0, envelope({ correlation: { conversation_id: 'conv-1' } }), { observedAt: OBSERVED_AT });
    const other = applyTelemetryPolicy(0, envelope({
      source: { product: 'gemini-cli', adapter: 'otlp' },
      correlation: { conversation_id: 'conv-1' },
    }), { observedAt: OBSERVED_AT });
    expect(a.sessionRef).toBe(again.sessionRef);
    expect(a.sessionRef).not.toBe(other.sessionRef);
    expect(a.sessionRef).not.toContain('conv-1');
    expect(a.sessionRef!.startsWith(TELEMETRY_PSEUDONYM_PREFIX)).toBe(true);
  });

  it('is null when the source names no conversation', () => {
    expect(applyTelemetryPolicy(0, envelope(), { observedAt: OBSERVED_AT }).sessionRef).toBeNull();
  });
});

describe('two clocks (§4.4)', () => {
  it('sets observed_at from the RECEIVER and never from the reporter', () => {
    const result = applyTelemetryPolicy(0, envelope({
      observed_at: '1999-01-01T00:00:00Z',
      occurred_at: '2026-09-03T09:59:00Z',
    }), { observedAt: OBSERVED_AT });
    expect(result.record.observed_at).toBe(OBSERVED_AT.toISOString());
    // The source clock is preserved verbatim — never silently corrected.
    expect(result.record.occurred_at).toBe('2026-09-03T09:59:00Z');
  });
});

describe('pseudonymization (§6.1) and pepper rotation', () => {
  it('is deterministic under one pepper and different under another', () => {
    const under_a = telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, 'operator@example.com');
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, 'operator@example.com')).toBe(under_a);
    setPeppers('b');
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, 'operator@example.com')).not.toBe(under_a);
  });

  it('folds an ADDRESS so one person is one pseudonym', () => {
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.emailAddress, '  Operator@Example.COM '))
      .toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.emailAddress, 'operator@example.com'));
  });

  it('does NOT fold an opaque human identifier (review 696bff8c, R2-F3)', () => {
    // `MemberABC` and `memberabc` may be two different provider accounts, and
    // folding them merged two people. The address contract does not extend to
    // every human identifier, which is why the domains are now separate.
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, 'MemberABC'))
      .not.toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, 'memberabc'));
  });

  it('separates two different identifiers', () => {
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, 'a@example.com')).not.toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, 'b@example.com'));
  });

  it('exposes NO reversal (owner decision D4 — no custody store, no reversal act)', () => {
    // The absence is the control: a `reverse` export appearing here would be a
    // scope violation, not a feature.
    const pepperModule = require('../utils/telemetryPepper');
    for (const name of Object.keys(pepperModule)) {
      expect(name.toLowerCase()).not.toMatch(/reverse|reveal|unmask|lookup/);
    }
  });
});

describe('the error fingerprint is WITHDRAWN at TW1a (§6.1 narrowing)', () => {
  it('exports no fingerprint helper at all', () => {
    // Rounds 1, 2 and 3 each rejected a different mechanism for the same
    // requirement. The fourth answer is that TW1a computes none: §6.1 presumes
    // a trusted capture path and F11 means the board has none. The absence is
    // the fix, so the control is that the export is gone.
    const engine = require('../services/TelemetryPolicyEngine');
    expect(Object.keys(engine)).not.toContain('telemetryErrorFingerprint');
    expect(Object.keys(engine)).not.toContain('TELEMETRY_MAX_STACK_FRAMES');
  });
});
