/**
 * The OTLP/HTTP decoders (card `dac2ca71`, slice 1).
 *
 * Four properties, each against something the decoder did not produce:
 *
 *   REAL PRODUCERS — every committed capture, from Claude Code (protobuf and
 *   JSON) and from the OpenTelemetry Python SDK (protobuf), decodes.
 *
 *   ONE SHAPE FOR BOTH ENCODINGS — each JSON capture is re-encoded as protobuf
 *   by the test's OWN writer (`encodeOtlpJsonAsProtobuf`) and both decoders must
 *   produce the same records and the same count.
 *
 *   THE RAW COUNT IS THE DECODER'S, AND IT IS COMPLETE — `attributeEntries`
 *   equals an independent walk of the JSON that counts every KeyValue at every
 *   level. Duplicates, keyless entries, nested kvlists, exemplars, metadata and
 *   entries past the retention ceiling all count (round-3 finding M1-R3: a
 *   duplicate key was overwritten without being counted).
 *
 *   NOTHING INEXACT IS PASSED ON — a JSON integer beyond 2^53 has already been
 *   rounded by JSON.parse, so it arrives as UNREPRESENTABLE, never as a number.
 */
import {
  decodeOtlpJson, decodeOtlpProtobuf, OtlpDecodeError, OTLP_MAX_RECORDS, OTLP_MAX_RETAINED_ATTRIBUTES,
  type OtlpDecodedExport,
} from '../utils/otlp/otlpDecode';
import {
  countJsonAttributeEntries, encodeOtlpJsonAsProtobuf, jsonLogsExport, loadOtlpFixtures, s, i,
} from './support/otlpFixtures';

const fixtures = loadOtlpFixtures();

/** Records with attribute ids removed: ids are traversal-order counters, not content. */
function normalized(decoded: OtlpDecodedExport): unknown {
  const strip = (value: unknown): unknown => {
    if (value instanceof Map) {
      return [...value.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, strip(v)]);
    }
    if (typeof value === 'bigint') return `${value}n`;
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'id').map(([k, v]) => [k, strip(v)]));
    }
    return value;
  };
  return strip(decoded.items);
}

describe('real producer captures decode', () => {
  it('covers two producers and both encodings', () => {
    expect(new Set(fixtures.map((f) => f.producer))).toEqual(new Set(['claude-code', 'otel-python-sdk']));
    expect(new Set(fixtures.map((f) => f.contentType))).toEqual(new Set(['application/x-protobuf', 'application/json']));
    expect(new Set(fixtures.map((f) => f.signal))).toEqual(new Set(['traces', 'logs', 'metrics']));
  });

  it.each(fixtures.map((f) => [f.name, f] as const))('%s decodes to at least one record', (_name, fixture) => {
    const decoded = fixture.json
      ? decodeOtlpJson(fixture.signal, fixture.json)
      : decodeOtlpProtobuf(fixture.signal, fixture.body);
    expect(decoded.items.length).toBeGreaterThan(0);
    expect(decoded.attributeEntries).toBeGreaterThan(0);
    for (const item of decoded.items) expect(item.signal).toBe(fixture.signal);
  });
});

describe('one decoded shape for both encodings', () => {
  const jsonFixtures = fixtures.filter((f) => f.json);
  it('has JSON captures to compare', () => expect(jsonFixtures.length).toBeGreaterThan(0));

  it.each(jsonFixtures.map((f) => [f.name, f] as const))('%s: protobuf and JSON decode identically', (_name, fixture) => {
    const fromJson = decodeOtlpJson(fixture.signal, fixture.json);
    const fromProtobuf = decodeOtlpProtobuf(fixture.signal, encodeOtlpJsonAsProtobuf(fixture.signal, fixture.json));
    expect(normalized(fromProtobuf)).toEqual(normalized(fromJson));
    expect(fromProtobuf.attributeEntries).toBe(fromJson.attributeEntries);
  });
});

describe('the raw attribute count is the decoder\'s, and complete', () => {
  it.each(fixtures.filter((f) => f.json).map((f) => [f.name, f] as const))(
    '%s: equals an independent walk of the JSON', (_name, fixture) => {
      expect(decodeOtlpJson(fixture.signal, fixture.json).attributeEntries).toBe(countJsonAttributeEntries(fixture.json));
    });

  it('counts BOTH entries of a duplicated key and keeps only the last (M1-R3)', () => {
    const body = jsonLogsExport([
      { key: 'duplicate', value: s('first') },
      { key: 'duplicate', value: s('second') },
    ]);
    for (const decoded of [
      decodeOtlpJson('logs', body),
      decodeOtlpProtobuf('logs', encodeOtlpJsonAsProtobuf('logs', body)),
    ]) {
      expect(decoded.attributeEntries).toBe(countJsonAttributeEntries(body));
      const kept = decoded.items[0].attributes.get('duplicate');
      expect(kept?.value).toEqual({ kind: 'string', value: 'second' });
      // The first entry's id is gone: it can never be counted as carried.
      expect(decoded.items[0].attributes.size).toBe(1);
    }
  });

  it('counts keyless entries, nested kvlist entries and arrays of kvlists', () => {
    const body = jsonLogsExport([
      { value: s('no key at all') },
      { key: '', value: s('empty key') },
      { key: 'nested', value: { kvlistValue: { values: [{ key: 'a', value: s('x') }, { key: 'a', value: s('y') }] } } },
      { key: 'array', value: { arrayValue: { values: [{ kvlistValue: { values: [{ key: 'b', value: i(1) }] } }] } } },
    ]);
    const decoded = decodeOtlpJson('logs', body);
    expect(decoded.attributeEntries).toBe(countJsonAttributeEntries(body));
    expect(decoded.attributeEntries).toBe(1 /* service.name */ + 4 + 2 + 1);
    expect([...decoded.items[0].attributes.keys()].sort()).toEqual(['array', 'nested']);
    expect(decodeOtlpProtobuf('logs', encodeOtlpJsonAsProtobuf('logs', body)).attributeEntries).toBe(decoded.attributeEntries);
  });

  it('counts entries past the retention ceiling without retaining them', () => {
    const many = Array.from({ length: OTLP_MAX_RETAINED_ATTRIBUTES + 7 }, (_, n) => ({ key: `k${n}`, value: i(n) }));
    const decoded = decodeOtlpJson('logs', jsonLogsExport(many));
    expect(decoded.items[0].attributes.size).toBe(OTLP_MAX_RETAINED_ATTRIBUTES);
    expect(decoded.attributeEntries).toBe(1 + OTLP_MAX_RETAINED_ATTRIBUTES + 7);
  });

  it('counts a log BODY\'s kvlist entries, and keeps nothing of the body', () => {
    const body = jsonLogsExport([{ key: 'event.name', value: s('api_request') }]);
    body.resourceLogs[0].scopeLogs[0].logRecords[0].body = {
      kvlistValue: { values: [{ key: 'prompt', value: s('a secret prompt') }, { key: 'path', value: s('/etc/shadow') }] },
    };
    const decoded = decodeOtlpJson('logs', body);
    expect(decoded.attributeEntries).toBe(countJsonAttributeEntries(body));
    expect(JSON.stringify(normalized(decoded))).not.toMatch(/secret prompt|shadow/);
  });
});

describe('numbers are passed on exactly, or marked unrepresentable', () => {
  it('keeps a decimal-string int64 exactly, including beyond 2^53', () => {
    const decoded = decodeOtlpJson('logs', jsonLogsExport([{ key: 'big', value: i('9007199254740993') }]));
    expect(decoded.items[0].attributes.get('big')?.value).toEqual({ kind: 'int', value: 9007199254740993n });
  });

  it('marks a JSON NUMBER int64 beyond 2^53 unrepresentable (JSON.parse already rounded it)', () => {
    const decoded = decodeOtlpJson('logs', jsonLogsExport([{ key: 'big', value: { intValue: 2 ** 53 + 2 } }]));
    expect(decoded.items[0].attributes.get('big')?.value).toEqual({ kind: 'int', value: null });
  });

  it('keeps the exact double the wire carried, in both encodings', () => {
    for (const value of [0.1234567890123, 1.23456789015, 1e-11, 1e-20, 0.08976100000000001]) {
      const body = jsonLogsExport([{ key: 'v', value: { doubleValue: value } }]);
      const fromJson = decodeOtlpJson('logs', body).items[0].attributes.get('v')?.value;
      const fromProtobuf = decodeOtlpProtobuf('logs', encodeOtlpJsonAsProtobuf('logs', body)).items[0].attributes.get('v')?.value;
      expect(fromJson).toEqual({ kind: 'double', value });
      expect(fromProtobuf).toEqual({ kind: 'double', value });
    }
  });

  it('keeps nanosecond timestamps exactly', () => {
    const decoded = decodeOtlpJson('logs', jsonLogsExport([], { timeUnixNano: '1792414286321680123' }));
    expect((decoded.items[0] as { timeNs: bigint }).timeNs).toBe(1792414286321680123n);
  });
});

describe('malformed exports are refused as such', () => {
  it('refuses truncated protobuf', () => {
    const body = encodeOtlpJsonAsProtobuf('logs', jsonLogsExport([{ key: 'k', value: s('v') }]));
    expect(() => decodeOtlpProtobuf('logs', body.subarray(0, body.length - 3))).toThrow(OtlpDecodeError);
  });

  it('refuses bytes that are not the message', () => {
    expect(() => decodeOtlpProtobuf('traces', Buffer.from('this is not protobuf at all, it is prose'))).toThrow(OtlpDecodeError);
  });

  it('refuses a JSON export whose structure is wrong', () => {
    expect(() => decodeOtlpJson('logs', { resourceLogs: 'nope' })).toThrow(OtlpDecodeError);
    expect(() => decodeOtlpJson('logs', [])).toThrow(OtlpDecodeError);
  });

  it('refuses values nested too deeply', () => {
    let value: any = s('leaf');
    for (let n = 0; n < 12; n += 1) value = { arrayValue: { values: [value] } };
    expect(() => decodeOtlpJson('logs', jsonLogsExport([{ key: 'deep', value }]))).toThrow(OtlpDecodeError);
  });

  it(`refuses more than ${OTLP_MAX_RECORDS} records with its own code`, () => {
    const body = jsonLogsExport([]);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    body.resourceLogs[0].scopeLogs[0].logRecords = Array.from({ length: OTLP_MAX_RECORDS + 1 }, () => record);
    try {
      decodeOtlpJson('logs', body);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(OtlpDecodeError);
      expect((err as OtlpDecodeError).code).toBe('OTLP_TOO_MANY_RECORDS');
    }
  });

  it('accepts an empty export as zero records', () => {
    expect(decodeOtlpProtobuf('traces', Buffer.alloc(0)).items).toHaveLength(0);
    expect(decodeOtlpJson('metrics', {}).items).toHaveLength(0);
  });
});
