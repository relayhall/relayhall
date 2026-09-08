/**
 * The Tier-0 HOSTILE SURFACE control (RH-TW1a, repairing review `bfac1dd5`
 * findings F1, F2 and F5).
 *
 * F5 was that the previous marker control stuffed only a handful of fields, so
 * it stayed green while the rest of the surface leaked — it failed to detect
 * F1 and F2, which were found by hand. The repair is not "add the fields the
 * reviewer named": it is to stop maintaining the list by hand at all.
 *
 * The hostile envelope below is generated from `TELEMETRY_HOSTILE_SURFACE`,
 * and a COMPLETENESS assertion cross-checks that table against the validator's
 * OWN allowlist sets — the producer of the frozen surface. Adding a field to
 * the validator without giving it a hostile value here reddens this suite. The
 * control can therefore no longer silently fall behind the surface it guards.
 */
import {
  applyTelemetryPolicy,
  TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX,
  TELEMETRY_ATTRIBUTE_DEFAULT_RE,
} from '../services/TelemetryPolicyEngine';
import {
  TELEMETRY_REPORTER_STRING_FIELDS,
  TELEMETRY_VALIDATOR_FIELD_SETS,
  validateTelemetryEnvelope,
} from '../utils/telemetryEnvelopeValidator';
import {
  resetTelemetryPepperCache,
  TELEMETRY_PSEUDONYM_DOMAINS,
  TELEMETRY_PSEUDONYM_PREFIX,
  telemetryPseudonym,
} from '../utils/telemetryPepper';

const OBSERVED_AT = new Date('2026-09-03T12:00:00.000Z');
const PEPPER_A = Buffer.alloc(32, 3).toString('base64');
const PEPPER_B = Buffer.alloc(32, 9).toString('base64');

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

/**
 * Every reporter-reachable field, the hostile value placed in it, and what
 * Tier 0 must do with it.
 *
 * `disposition`:
 *  - `refused`   — the VALIDATOR must reject the envelope outright.
 *  - `dropped`   — accepted by the validator, absent from the stored record.
 *  - `pseudonym` — accepted, present only as an `rhp_` pseudonym.
 *  - `retained`  — legitimately kept verbatim; the value is NOT a marker, and
 *                  the reason it is safe is stated.
 */
interface SurfaceCase {
  field: string;
  value: unknown;
  disposition: 'refused' | 'dropped' | 'pseudonym' | 'retained';
  why?: string;
}

/**
 * The hostile value used for every `refused`/`dropped`/`pseudonym` case is a
 * unique marker containing the field name, so a leak names its own source.
 */
const marker = (field: string) => `MARKER${field.replace(/[^A-Za-z]/g, '')}`;

export const TELEMETRY_HOSTILE_SURFACE: SurfaceCase[] = [
  // ── identity (§4.1 advisory) ───────────────────────────────────────────
  { field: 'identity.user_id', value: `${marker('identityuser')}@example.com`, disposition: 'pseudonym' },
  { field: 'identity.tenant_id', value: marker('identitytenant'), disposition: 'dropped', why: '§6.2 Tier-1 structure; TS-5 ships no Tier 1' },
  { field: 'identity.project_id', value: marker('identityproject'), disposition: 'dropped', why: '§6.2 Tier-1 structure' },
  { field: 'identity.workspace_id', value: marker('identityworkspace'), disposition: 'dropped', why: '§6.2 Tier-1 structure' },

  // ── source ─────────────────────────────────────────────────────────────
  { field: 'source.instance_id', value: marker('sourceinstance'), disposition: 'pseudonym' },
  // F1: this held `RawPromptWithoutSpaces` and survived.
  { field: 'source.adapter_version', value: marker('sourceadapterversion'), disposition: 'refused', why: 'F1: a version class, not a free string' },
  { field: 'source.mechanism', value: marker('sourcemechanism'), disposition: 'refused', why: 'closed vocabulary' },
  { field: 'source.support_level', value: marker('sourcesupport'), disposition: 'refused', why: 'closed vocabulary' },
  { field: 'source.last_verified', value: marker('sourceverified'), disposition: 'refused', why: 'a date' },
  { field: 'source.raw_ref', value: marker('sourcerawref'), disposition: 'refused', why: '§6.5.1 receiver-assigned' },

  // ── correlation ────────────────────────────────────────────────────────
  { field: 'correlation.trace_id', value: marker('correlationtrace'), disposition: 'refused', why: 'W3C hex' },
  { field: 'correlation.span_id', value: marker('correlationspan'), disposition: 'refused', why: 'W3C hex' },
  { field: 'correlation.parent_span_id', value: marker('correlationparent'), disposition: 'refused', why: 'W3C hex' },
  // F1: `CustomerSSN123456789` in an opaque id field. Now pseudonymized.
  { field: 'correlation.conversation_id', value: marker('correlationconversation'), disposition: 'pseudonym' },
  { field: 'correlation.session_id', value: marker('correlationsession'), disposition: 'pseudonym' },
  { field: 'correlation.attempt_id', value: marker('correlationattempt'), disposition: 'pseudonym' },
  // R2-F1: these WERE retained raw on a false necessity claim. Both feeds can
  // pseudonymize under one domain and pepper, so equality survives and the raw
  // identifier is never stored.
  { field: 'correlation.request_id', value: marker('correlationrequest'), disposition: 'pseudonym' },
  { field: 'correlation.tool_call_id', value: marker('correlationtoolcall'), disposition: 'pseudonym' },

  // ── model ──────────────────────────────────────────────────────────────
  { field: 'model.provider', value: `${marker('modelprovider')}@example.com`, disposition: 'refused', why: 'F1: a model name class admits no address at all — stronger than pseudonymizing it' },
  { field: 'model.requested', value: 'claude-opus-5', disposition: 'retained', why: 'a model name; §6.1 keeps the model' },
  { field: 'model.resolved', value: 'claude-opus-5-20260501', disposition: 'retained', why: 'a model name' },
  { field: 'model.operation', value: marker('modeloperation'), disposition: 'refused', why: 'closed vocabulary' },

  // ── outcome (F2 lives here) ────────────────────────────────────────────
  { field: 'outcome.status', value: marker('outcomestatus'), disposition: 'refused', why: 'closed vocabulary' },
  { field: 'outcome.error_type', value: marker('outcomeerrortype'), disposition: 'retained', why: 'a class-name-shaped marker IS a legal exception type; the smuggling case is covered separately below' },
  { field: 'outcome.finish_reasons', value: [marker('outcomefinish')], disposition: 'refused', why: 'F1: closed vocabulary, was an open string' },

  // ── the free-form residual fields, represented rather than omitted ─────
  // R2-F4: these are inventoried in TELEMETRY_REPORTER_STRING_FIELDS but were
  // missing from the table, so the "complete surface" claim excluded exactly
  // the fields whose residual the candidate admits to.
  { field: 'source.product', value: 'claude-code', disposition: 'retained', why: 'RESIDUAL: a product key, closed by the descriptor allowlist at candidate B, not by shape' },
  { field: 'source.adapter', value: 'otlp', disposition: 'retained', why: 'RESIDUAL: an adapter key, bounded and space-free' },
  { field: 'usage.cost.amount', value: '0.01', disposition: 'retained', why: 'a decimal string; the class admits digits and one dot only' },
  { field: 'outcome.error_fingerprint', value: 'a'.repeat(64), disposition: 'refused', why: 'R3-F1: the fingerprint is withdrawn at TW1a - a declared 6.1 narrowing' },
  { field: 'outcome.error_frames', value: ['at f (a.ts:1:1)'], disposition: 'refused', why: 'R3-F1: the receiver-computed path is withdrawn with the fingerprint' },

  // ── top level ──────────────────────────────────────────────────────────
  { field: 'event_id', value: 'evt-0001', disposition: 'retained', why: '§4.3 identity; bounded opaque id' },
  { field: 'stream_generation', value: 'gen-1', disposition: 'retained', why: '§4.3 identity' },
  { field: 'phase', value: marker('phase'), disposition: 'refused', why: 'closed vocabulary' },

  // ── attributes (§4.5 deny by default) ──────────────────────────────────
  { field: 'attributes', value: { 'gen_ai.prompt': marker('attributes') }, disposition: 'dropped', why: 'denied by default' },

  // ── cost ───────────────────────────────────────────────────────────────
  { field: 'usage.cost.currency', value: marker('usagecostcurrency'), disposition: 'refused', why: 'ISO 4217' },
  { field: 'usage.cost.basis', value: 'reconciled', disposition: 'refused', why: '§4.7 receipts are the only path' },
];

function base(): Record<string, any> {
  return {
    schema_version: 'rh.ai.telemetry/1.0',
    event_id: 'evt-0001',
    kind: 'model_call',
    source: { product: 'claude-code', adapter: 'otlp' },
  };
}

function place(envelope: Record<string, any>, field: string, value: unknown): void {
  const parts = field.split('.');
  let node = envelope;
  for (const part of parts.slice(0, -1)) {
    node[part] = node[part] ?? {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Fields that are reporter-reachable but carry NO string channel, each with the
 * reason it needs no hostile value. R2-F4: the previous version skipped whole
 * nested blocks inline, which is how `content` — an entire allowlist — escaped
 * the completeness check and a mutation to it stayed green.
 */
const NON_STRING_EXCLUSIONS: Readonly<Record<string, string>> = {
  'schema_version': 'checked by its own version grammar; a foreign family is refused',
  'kind': 'closed vocabulary, covered by the freeze suite',
  'observed_at': 'receiver clock; a reporter value is overwritten',
  'occurred_at': 'RFC3339 only',
  'source_sequence': 'numeric or its decimal string',
  'usage.input_tokens': 'numeric', 'usage.output_tokens': 'numeric',
  'usage.cached_read_tokens': 'numeric', 'usage.cached_write_tokens': 'numeric',
  'usage.reasoning_tokens': 'numeric', 'usage.tool_tokens': 'numeric',
  'usage.requests': 'numeric', 'usage.cost': 'a block, flattened to its own leaves',
  'timing.duration_ms': 'numeric', 'timing.queue_ms': 'numeric',
  'timing.time_to_first_token_ms': 'numeric', 'timing.inter_token_ms': 'numeric',
  'context.max_tokens': 'numeric', 'context.used_tokens': 'numeric',
  'context.utilization': 'numeric', 'context.compaction_count': 'numeric',
  'content.policy_tier': 'numeric and forced to 0 by the engine',
  'content.prompt_ref': 'receiver-assigned; a reporter value is refused',
  'content.response_ref': 'receiver-assigned; a reporter value is refused',
  'content.tool_input_ref': 'receiver-assigned; a reporter value is refused',
  'content.tool_output_ref': 'receiver-assigned; a reporter value is refused',
  'content.redactions': 'receiver-written; never read from the reporter',
  'source': 'a block', 'identity': 'a block', 'correlation': 'a block',
  'model': 'a block', 'usage': 'a block', 'timing': 'a block',
  'outcome': 'a block', 'context': 'a block', 'content': 'a block',
};

/** Every leaf the validator admits, flattened from the exported sets. */
function flattenValidatorSurface(): string[] {
  const sets = TELEMETRY_VALIDATOR_FIELD_SETS;
  const leaves: string[] = [];
  const add = (prefix: string, keys: Iterable<string>) => {
    for (const key of keys) leaves.push(prefix ? `${prefix}.${key}` : key);
  };
  add('', sets.topLevel());
  add('source', sets.source());
  add('identity', sets.identity());
  add('correlation', sets.correlation());
  add('model', sets.model());
  add('usage', sets.usage());
  add('usage.cost', sets.cost());
  add('outcome', sets.outcome());
  add('timing', sets.timing());
  add('context', sets.context());
  add('content', sets.content());   // R2-F4: this set was never checked at all
  return leaves;
}

describe('the hostile surface is COMPLETE (F5, repaired for R2-F4)', () => {
  it('every leaf of every exported validator set is covered or explicitly excluded', () => {
    const covered = new Set(TELEMETRY_HOSTILE_SURFACE.map((c) => c.field));
    const missing = flattenValidatorSurface()
      .filter((field) => !covered.has(field) && !(field in NON_STRING_EXCLUSIONS));
    expect(missing).toEqual([]);
  });

  it('covers everything the validator\'s own reporter-string inventory names', () => {
    const covered = new Set(TELEMETRY_HOSTILE_SURFACE.map((c) => c.field));
    const missing = TELEMETRY_REPORTER_STRING_FIELDS.filter((f) => !covered.has(f));
    expect(missing).toEqual([]);
  });

  it('excludes nothing that is not actually excluded on purpose', () => {
    // An exclusion for a field the validator no longer admits is stale, and a
    // stale exclusion is how a real field gets silently waved through later.
    const leaves = new Set(flattenValidatorSurface());
    expect(Object.keys(NON_STRING_EXCLUSIONS).filter((f) => !leaves.has(f))).toEqual([]);
  });

  it('the completeness check REDDENS for a new field in ANY set, content included', () => {
    // R2-F4: the reviewer added `new_reporter_string` to the content allowlist
    // and the check still returned []. The mutation is now run against every
    // set through the same flattening the assertion above uses.
    const covered = new Set(TELEMETRY_HOSTILE_SURFACE.map((c) => c.field));
    const detect = (): string[] => flattenValidatorSurface()
      .filter((field) => !covered.has(field) && !(field in NON_STRING_EXCLUSIONS));
    expect(detect()).toEqual([]);
    for (const [name, getter] of Object.entries(TELEMETRY_VALIDATOR_FIELD_SETS)) {
      const set = getter() as Set<string>;
      set.add('new_reporter_string');
      try {
        expect(`${name}:${detect().length > 0}`).toBe(`${name}:true`);
      } finally {
        set.delete('new_reporter_string');
      }
    }
    expect(detect()).toEqual([]);
  });

  it('is not vacuous — it carries cases of every disposition', () => {
    const kinds = new Set(TELEMETRY_HOSTILE_SURFACE.map((c) => c.disposition));
    expect([...kinds].sort()).toEqual(['dropped', 'pseudonym', 'refused', 'retained']);
    expect(TELEMETRY_HOSTILE_SURFACE.length).toBeGreaterThan(30);
  });
});

describe('every hostile field behaves as its disposition says', () => {
  for (const testCase of TELEMETRY_HOSTILE_SURFACE) {
    it(`${testCase.field} → ${testCase.disposition}`, () => {
      const envelope = base();
      place(envelope, testCase.field, testCase.value);
      const validation = validateTelemetryEnvelope(envelope);

      if (testCase.disposition === 'refused') {
        expect(validation.ok).toBe(false);
        return;
      }
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;

      const result = applyTelemetryPolicy(0, validation.envelope, { observedAt: OBSERVED_AT });
      const stored = JSON.stringify(result.record);
      const raw = typeof testCase.value === 'string' ? testCase.value : JSON.stringify(testCase.value);

      if (testCase.disposition === 'retained') {
        expect(stored).toContain(String(testCase.value));
      } else {
        // dropped or pseudonym: the RAW value must be nowhere in the record.
        expect(`${testCase.field}:${stored.includes(raw)}`).toBe(`${testCase.field}:false`);
        if (testCase.disposition === 'pseudonym') {
          expect(stored).toMatch(new RegExp(TELEMETRY_PSEUDONYM_PREFIX));
        }
      }
    });
  }
});

describe('the whole surface at once — the sink-anchored negative control', () => {
  it('leaks no marker when every accepted hostile value is sent together', () => {
    const envelope = base();
    const expectedAbsent: string[] = [];
    for (const c of TELEMETRY_HOSTILE_SURFACE) {
      if (c.disposition === 'refused' || c.disposition === 'retained') continue;
      place(envelope, c.field, c.value);
      expectedAbsent.push(typeof c.value === 'string' ? c.value : JSON.stringify(c.value));
    }
    const validation = validateTelemetryEnvelope(envelope);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const stored = JSON.stringify(applyTelemetryPolicy(0, validation.envelope, { observedAt: OBSERVED_AT }).record);
    for (const value of expectedAbsent) {
      expect(`${value}:${stored.includes(value)}`).toBe(`${value}:false`);
    }
    expect(expectedAbsent.length).toBeGreaterThan(8);
  });

  it('the search CAN find a marker (positive arm — the control is not vacuous)', () => {
    const envelope = base();
    place(envelope, 'attributes', { 'vendor.thing': 'MARKERallowed' });
    const validation = validateTelemetryEnvelope(envelope);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const stored = JSON.stringify(applyTelemetryPolicy(0, validation.envelope, {
      observedAt: OBSERVED_AT,
      attributeAllowlist: new Map([['vendor.thing', TELEMETRY_ATTRIBUTE_DEFAULT_RE]]),
    }).record);
    expect(stored).toContain('MARKERallowed');
  });
});

describe('F1 — the embedded-address control on a RETAINED field', () => {
  it('pseudonymizes an address hiding in a field that legitimately admits @', () => {
    // After R2-F1 withdrew the raw correlation ids, `event_id` is the retained
    // field whose class still admits '@' — so it is where an address can still
    // reach storage, and the belt-and-braces EMAIL guard is what stops it.
    const envelope = base();
    envelope.event_id = 'MARKERembedded@example.com';
    const validation = validateTelemetryEnvelope(envelope);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const result = applyTelemetryPolicy(0, validation.envelope, { observedAt: OBSERVED_AT });
    expect(JSON.stringify(result.record)).not.toContain('MARKERembedded@example.com');
    expect(result.record.event_id).toBe(
      telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.emailAddress, 'MARKERembedded@example.com'));
    expect(result.counts.identifiersPseudonymized).toBeGreaterThan(0);
  });
});

describe('F1 — a certified attribute profile governs the VALUE, not only the key', () => {
  it('refuses a hostile value under an allowlisted key', () => {
    const envelope = base();
    place(envelope, 'attributes', { safe_named_key: 'CommandArgumentSecret123 --token=abc' });
    const validation = validateTelemetryEnvelope(envelope);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const result = applyTelemetryPolicy(0, validation.envelope, {
      observedAt: OBSERVED_AT,
      attributeAllowlist: new Map([['safe_named_key', TELEMETRY_ATTRIBUTE_DEFAULT_RE]]),
    });
    expect(result.record.attributes.safe_named_key).toBeUndefined();
    expect(result.counts.attributesDropped).toBe(1);
  });

  it('admits a value that satisfies the class the profile certified', () => {
    const envelope = base();
    place(envelope, 'attributes', { safe_named_key: 'v1.2.3' });
    const validation = validateTelemetryEnvelope(envelope);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const result = applyTelemetryPolicy(0, validation.envelope, {
      observedAt: OBSERVED_AT,
      attributeAllowlist: new Map([['safe_named_key', TELEMETRY_ATTRIBUTE_DEFAULT_RE]]),
    });
    expect(result.record.attributes.safe_named_key).toBe('v1.2.3');
  });
});

describe('R3-F2 — an opaque id CONTAINING an address is not treated as one', () => {
  const of = (userId: string) => {
    const envelope = base();
    place(envelope, 'identity', { user_id: userId });
    const v = validateTelemetryEnvelope(envelope);
    if (!v.ok) throw new Error('fixture rejected');
    return applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT })
      .record.attributes[`${TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX}user_id`];
  };

  it('keeps the four straddling ids DISTINCT (the exact round-3 collision)', () => {
    // All four collapsed to one pseudonym under the unanchored predicate.
    const values = [
      'acct:Member@example.com:A',
      'acct:Member@example.com:a',
      'acct:member@example.com:A',
      'acct:member@example.com:a',
    ];
    expect(new Set(values.map(of)).size).toBe(values.length);
  });

  it('still folds a value that IS an address', () => {
    expect(of('  Operator@Example.COM ')).toBe(of('operator@example.com'));
  });

  it('never stores the address a straddling id contains', () => {
    const envelope = base();
    place(envelope, 'identity', { user_id: 'acct:Member@example.com:A' });
    const v = validateTelemetryEnvelope(envelope);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(JSON.stringify(applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT }).record))
      .not.toContain('Member@example.com');
  });

  it('applies the same rule to a RETAINED field, not just identity', () => {
    // Swept, not fixed at the cited coordinate: retainString folded a whole
    // opaque value because it contained an address.
    const of2 = (eventId: string) => {
      const envelope = base();
      envelope.event_id = eventId;
      const v = validateTelemetryEnvelope(envelope);
      if (!v.ok) throw new Error('fixture rejected');
      return applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT }).record.event_id;
    };
    expect(of2('id.Member@example.com.A')).not.toBe(of2('id.member@example.com.a'));
  });
});

describe('R2-F3 — pseudonym domains, case and Unicode form', () => {
  it('a user identifier can never collide with a session reference', () => {
    const colliding = 'probe|same-id';
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier, colliding))
      .not.toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.sessionRef, colliding));
  });

  it('every governed domain separates from every other for the same value', () => {
    const domains = Object.values(TELEMETRY_PSEUDONYM_DOMAINS);
    expect(new Set(domains.map((d) => telemetryPseudonym(d, 'same-value'))).size).toBe(domains.length);
  });

  it('no value can imitate another domain (length-prefixed HMAC input)', () => {
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.sessionRef, 'x'))
      .not.toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.humanIdentifier,
        `${TELEMETRY_PSEUDONYM_DOMAINS.sessionRef}|x`));
  });

  it('an opaque human identifier keeps its CASE — through the real surface', () => {
    // R2-F3: `humanIdentifier` was documented as covering member ids AND was
    // case-folded, so MemberABC and memberabc still merged. Asserted here
    // through applyTelemetryPolicy, not only at the helper, because the helper
    // was already "right" while the surface was not.
    const of = (userId: string) => {
      const envelope = base();
      place(envelope, 'identity', { user_id: userId });
      const v = validateTelemetryEnvelope(envelope);
      if (!v.ok) throw new Error('fixture rejected');
      return applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT })
        .record.attributes[`${TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX}user_id`];
    };
    expect(of('MemberABC')).not.toBe(of('memberabc'));
    // …and full-width vs ASCII are likewise two identifiers, not one.
    expect(of('MemberＡ')).not.toBe(of('MemberA'));
  });

  it('an ADDRESS still folds, because its contract says it may', () => {
    const of = (userId: string) => {
      const envelope = base();
      place(envelope, 'identity', { user_id: userId });
      const v = validateTelemetryEnvelope(envelope);
      if (!v.ok) throw new Error('fixture rejected');
      return applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT })
        .record.attributes[`${TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX}user_id`];
    };
    expect(of('  Operator@Example.COM ')).toBe(of('operator@example.com'));
  });

  it('opaque domains do not NFKC-normalize', () => {
    expect(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.sessionRef, 'Ａ'))
      .not.toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.sessionRef, 'A'));
  });

  it('refuses an ungoverned domain', () => {
    expect(() => telemetryPseudonym('rh.telemetry.pseudonym.invented/1' as never, 'x'))
      .toThrow(/not a governed pseudonym domain/);
  });
});

describe('R3-F1 — the error fingerprint is WITHDRAWN ENTIRELY (§6.1 narrowing)', () => {
  it('refuses a reporter-supplied fingerprint, naming the narrowing', () => {
    const envelope = base();
    place(envelope, 'outcome', { status: 'error', error_fingerprint: 'a'.repeat(64) });
    const result = validateTelemetryEnvelope(envelope);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('outcome.error_fingerprint');
    expect(result.message).toMatch(/narrowing/i);
  });

  it('refuses error_frames — the receiver-computed path is gone too', () => {
    const envelope = base();
    place(envelope, 'outcome', { status: 'error', error_type: 'TypeError', error_frames: ['at f (a.ts:1:1)'] });
    const result = validateTelemetryEnvelope(envelope);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('outcome.error_frames');
  });

  it('stores NO fingerprint for a legal error envelope', () => {
    // Round 3's BLOCKER was that identifier-shaped message text still reached
    // the digest through a frame's function or basename slot: "syntax cannot
    // establish semantic provenance". There is now no digest to reach.
    const envelope = base();
    place(envelope, 'outcome', { status: 'error', error_type: 'TypeError' });
    const v = validateTelemetryEnvelope(envelope);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const result = applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT });
    expect(result.record.outcome.error_fingerprint).toBeUndefined();
    expect(JSON.stringify(result.record)).not.toContain('fingerprint');
    // error_type — a validated class name — is still Tier-0 metadata.
    expect(result.record.outcome.error_type).toBe('TypeError');
  });

  it('the mechanism is GONE from the modules, not merely unused', () => {
    // A dormant code path is a future caller's foot-gun. The absence IS the fix.
    const engine = require('../services/TelemetryPolicyEngine');
    expect(Object.keys(engine)).not.toContain('telemetryErrorFingerprint');
    const pepper = require('../utils/telemetryPepper');
    expect(Object.keys(pepper.TELEMETRY_PSEUDONYM_DOMAINS)).not.toContain('errorFingerprint');
  });
});

describe('R2-F1 — the last raw correlation channel is withdrawn', () => {
  it('pseudonymizes request_id and tool_call_id, each in its own domain', () => {
    const envelope = base();
    place(envelope, 'correlation', { request_id: 'CustomerSSN123456789', tool_call_id: 'CustomerSSN123456789' });
    const v = validateTelemetryEnvelope(envelope);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const result = applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT });
    // The reviewer's exact repeated attack value must not survive.
    expect(JSON.stringify(result.record)).not.toContain('CustomerSSN123456789');
    expect(result.record.correlation.request_id).toBe(
      telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.reconciliationId, 'claude-code|CustomerSSN123456789'));
    // Same input, two fields, two domains — they must not collide.
    expect(result.record.correlation.request_id).not.toBe(result.record.correlation.tool_call_id);
  });

  it('preserves the equality reconciliation depends on', () => {
    // The premise of the withdrawal: two feeds pseudonymizing the same id under
    // the same domain and pepper still match, so §9.1 still works.
    const a = telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.reconciliationId, 'claude-code|req-1');
    const b = telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.reconciliationId, 'claude-code|req-1');
    expect(a).toBe(b);
    expect(a).not.toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.reconciliationId, 'claude-code|req-2'));
  });

  it('keeps the W3C trace triple raw, because hex cannot carry content', () => {
    const envelope = base();
    place(envelope, 'correlation', { trace_id: 'abcdef0123456789' });
    const v = validateTelemetryEnvelope(envelope);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(applyTelemetryPolicy(0, v.envelope, { observedAt: OBSERVED_AT }).record.correlation.trace_id)
      .toBe('abcdef0123456789');
  });
});

describe('the advisory identity rule still holds after the repairs', () => {
  it('pseudonymizes user_id and drops the Tier-1 labels', () => {
    const envelope = base();
    place(envelope, 'identity', {
      user_id: 'operator@example.com', tenant_id: 't', project_id: 'p', workspace_id: 'w',
    });
    const validation = validateTelemetryEnvelope(envelope);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const result = applyTelemetryPolicy(0, validation.envelope, { observedAt: OBSERVED_AT });
    expect(result.record.attributes[`${TELEMETRY_ADVISORY_ATTRIBUTE_PREFIX}user_id`])
      .toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.emailAddress, 'operator@example.com'));
    expect(result.counts.structuralLabelsDropped).toBe(3);
  });
});
