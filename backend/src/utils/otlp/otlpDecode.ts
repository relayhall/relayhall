/**
 * otlpDecode — ONE decoded shape for an OTLP/HTTP export, from either encoding
 * (RH-TW1b slice 1, card `dac2ca71`; TELEMETRY-DESIGN `7d5c0cdc` §3.1 item 1).
 *
 * Two decoders, protobuf and JSON, produce the same `OtlpDecodedExport`, so
 * the translators and the ingest pipeline downstream never learn which
 * encoding a producer chose. The protobuf decoder is a hand-written wire
 * reader over the stable OTLP v1 field numbers (opentelemetry-proto
 * `collector/{trace,logs,metrics}/v1`): it needs no generated code, no vendored
 * `.proto` files and no new dependency, and unknown fields are skipped by wire
 * type, which is what forward compatibility asks of a receiver.
 *
 * WHAT IS KEPT. Only what some translation can carry: attribute values, ids,
 * timestamps, enums and numeric measurements. Span names, status messages,
 * log bodies, event names of span events other than their attributes, and
 * trace states are READ PAST and never kept — the receiver cannot leak what it
 * never held (design §6.1: no prompts, responses, paths, arguments or raw
 * exception messages).
 *
 * THE RAW ATTRIBUTE COUNT IS THE DECODER'S (the second terminating shape of
 * evidence `aec6ab9f` §14). Every `KeyValue` the decoder walks past — at every
 * level, inside nested kvlists, exemplars, metadata, span events and links,
 * keyless or duplicated, retained or past the ceiling — increments ONE counter,
 * `attributeEntries`. Retained entries get a unique `id`; a duplicate key in
 * one container keeps only the LAST entry's id, so the earlier entry can never
 * be "carried" and therefore falls out of the subtraction
 * `dropped = attributeEntries - carried` without anyone deciding, per key and
 * per location, whether it was consumed. The census is removed from the
 * assertion path: nothing here reconciles, it only counts.
 *
 * NUMBERS ARE NEVER RENDERED. An int64 stays a `bigint`, a double stays the
 * `number` the wire carried; a JSON integer outside the safe range has already
 * been rounded by `JSON.parse`, so it is marked UNREPRESENTABLE (`null`) rather
 * than passed on as if it were exact.
 */

export type OtlpSignal = 'traces' | 'logs' | 'metrics';
export const OTLP_SIGNALS: readonly OtlpSignal[] = ['traces', 'logs', 'metrics'];

/** Records (spans, log records, data points) one export may carry. */
export const OTLP_MAX_RECORDS = 1000;
/** Attribute entries RETAINED per container; entries past it are still counted. */
export const OTLP_MAX_RETAINED_ATTRIBUTES = 256;
/** AnyValue nesting the decoder will walk; deeper is a malformed export. */
export const OTLP_MAX_VALUE_DEPTH = 8;
/** Longest attribute string retained; longer strings are kept as `oversize`. */
export const OTLP_MAX_STRING_BYTES = 4096;

export type OtlpValue =
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  /** `null` = the producer's integer could not be represented exactly. */
  | { kind: 'int'; value: bigint | null }
  | { kind: 'double'; value: number }
  | { kind: 'array'; values: OtlpValue[] }
  /** A nested map. Never carried; its entries are counted. */
  | { kind: 'kvlist' }
  | { kind: 'bytes' }
  /** A string longer than `OTLP_MAX_STRING_BYTES`, deliberately not held. */
  | { kind: 'oversize' }
  | { kind: 'empty' };

export interface OtlpAttribute {
  /** Unique within one decoded export. The unit of the carried/dropped count. */
  readonly id: number;
  readonly value: OtlpValue;
}
export type OtlpAttributes = ReadonlyMap<string, OtlpAttribute>;

export interface OtlpResource { readonly attributes: OtlpAttributes }
export interface OtlpScope {
  readonly name: string | null;
  readonly version: string | null;
  readonly attributes: OtlpAttributes;
}

interface OtlpItemBase {
  readonly resource: OtlpResource;
  readonly scope: OtlpScope;
  readonly attributes: OtlpAttributes;
}

export interface OtlpSpanEvent {
  readonly timeNs: bigint | null;
  readonly attributes: OtlpAttributes;
}

export interface OtlpSpanItem extends OtlpItemBase {
  readonly signal: 'traces';
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
  readonly kind: number;
  readonly startNs: bigint | null;
  readonly endNs: bigint | null;
  /** 0 unset, 1 ok, 2 error — any other number is the producer's and is not mapped. */
  readonly statusCode: number;
  readonly events: readonly OtlpSpanEvent[];
}

export interface OtlpLogItem extends OtlpItemBase {
  readonly signal: 'logs';
  readonly timeNs: bigint | null;
  readonly observedNs: bigint | null;
  readonly severityNumber: number;
  readonly traceId: string | null;
  readonly spanId: string | null;
}

export type OtlpNumber = { kind: 'double'; value: number } | { kind: 'int'; value: bigint | null };
export type OtlpMetricShape = 'gauge' | 'sum' | 'histogram' | 'exponential_histogram' | 'summary' | 'none';

export interface OtlpMetricItem extends OtlpItemBase {
  readonly signal: 'metrics';
  readonly metricName: string;
  readonly unit: string | null;
  readonly shape: OtlpMetricShape;
  /** 0 unspecified, 1 delta, 2 cumulative. Gauges and summaries carry 0. */
  readonly temporality: number;
  readonly monotonic: boolean;
  readonly startNs: bigint | null;
  readonly timeNs: bigint | null;
  /** Gauge and sum points. */
  readonly number: OtlpNumber | null;
  /** Histogram, exponential-histogram and summary points. */
  readonly aggregate: { count: bigint | null; sum: number | null } | null;
}

export type OtlpItem = OtlpSpanItem | OtlpLogItem | OtlpMetricItem;

export interface OtlpDecodedExport {
  readonly signal: OtlpSignal;
  readonly items: readonly OtlpItem[];
  /**
   * EVERY attribute entry the decoder saw, at every level, before any
   * deduplication or ceiling. The minuend of the dropped count.
   */
  readonly attributeEntries: number;
}

export type OtlpDecodeErrorCode = 'OTLP_UNDECODABLE' | 'OTLP_TOO_MANY_RECORDS';

export class OtlpDecodeError extends Error {
  constructor(public readonly code: OtlpDecodeErrorCode, message: string) {
    super(message);
    this.name = 'OtlpDecodeError';
  }
}

const undecodable = (message: string): OtlpDecodeError => new OtlpDecodeError('OTLP_UNDECODABLE', message);

/** Per-export state shared by both decoders: the counter and the record bound. */
class DecodeState {
  attributeEntries = 0;
  records = 0;
  constructor(readonly signal: OtlpSignal) {}

  /** Count one KeyValue; returns its id. */
  entry(): number {
    this.attributeEntries += 1;
    return this.attributeEntries;
  }

  record(): void {
    this.records += 1;
    if (this.records > OTLP_MAX_RECORDS) {
      throw new OtlpDecodeError('OTLP_TOO_MANY_RECORDS',
        `an OTLP export may carry at most ${OTLP_MAX_RECORDS} records; split the batch`);
    }
  }
}

/** Collects one container's attributes: last entry for a key wins, keyless never kept. */
class AttributeCollector {
  private readonly map = new Map<string, OtlpAttribute>();
  constructor(private readonly state: DecodeState) {}

  add(key: string | null, value: OtlpValue): void {
    const id = this.state.entry();
    if (key === null || key.length === 0) return;
    if (!this.map.has(key) && this.map.size >= OTLP_MAX_RETAINED_ATTRIBUTES) return;
    this.map.set(key, { id, value });
  }

  done(): OtlpAttributes { return this.map; }
}

const EMPTY_ATTRIBUTES: OtlpAttributes = new Map();

// ═════════════════════════════ protobuf ═════════════════════════════════════

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

class Reader {
  pos: number;
  constructor(private readonly buf: Uint8Array, start = 0, readonly end = buf.length) {
    this.pos = start;
  }

  more(): boolean { return this.pos < this.end; }

  private need(n: number): void {
    if (this.pos + n > this.end) throw undecodable('truncated protobuf message');
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i += 1) {
      this.need(1);
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, result);
      shift += 7n;
    }
    throw undecodable('malformed varint');
  }

  /** A varint that must fit a JS number (tags, lengths, enums, booleans). */
  small(): number {
    const value = this.varint();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw undecodable('varint out of range');
    return Number(value);
  }

  tag(): { field: number; wire: number } {
    const key = this.small();
    return { field: Math.floor(key / 8), wire: key & 7 };
  }

  fixed64(): bigint {
    this.need(8);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getBigUint64(0, true);
  }

  double(): number {
    this.need(8);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  fixed32(): number {
    this.need(4);
    this.pos += 4;
    return 0;
  }

  /** The bounds of a length-delimited field; the caller reads or skips them. */
  len(): { start: number; end: number } {
    const length = this.small();
    this.need(length);
    const start = this.pos;
    this.pos += length;
    return { start, end: start + length };
  }

  sub(): Reader {
    const { start, end } = this.len();
    return new Reader(this.buf, start, end);
  }

  bytes(): Uint8Array {
    const { start, end } = this.len();
    return this.buf.subarray(start, end);
  }

  string(): string {
    const { start, end } = this.len();
    return Buffer.from(this.buf.buffer, this.buf.byteOffset + start, end - start).toString('utf8');
  }

  /** A string that is not held when it is longer than the retention ceiling. */
  boundedString(): string | null {
    const { start, end } = this.len();
    if (end - start > OTLP_MAX_STRING_BYTES) return null;
    return Buffer.from(this.buf.buffer, this.buf.byteOffset + start, end - start).toString('utf8');
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT: this.varint(); return;
      case WIRE_FIXED64: this.need(8); this.pos += 8; return;
      case WIRE_LEN: this.len(); return;
      case WIRE_FIXED32: this.need(4); this.pos += 4; return;
      default: throw undecodable(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function expectWire(actual: number, expected: number): void {
  if (actual !== expected) throw undecodable('protobuf field has an unexpected wire type');
}

function hexId(bytes: Uint8Array, width: number): string | null {
  if (bytes.length !== width) return null;
  if (bytes.every((b) => b === 0)) return null;
  return Buffer.from(bytes).toString('hex');
}

/** AnyValue (common.proto). Walks nested kvlists so their entries are counted. */
function pbAnyValue(reader: Reader, state: DecodeState, depth: number): OtlpValue {
  if (depth > OTLP_MAX_VALUE_DEPTH) throw undecodable('attribute value nested too deeply');
  let value: OtlpValue = { kind: 'empty' };
  while (reader.more()) {
    const { field, wire } = reader.tag();
    switch (field) {
      case 1: {
        expectWire(wire, WIRE_LEN);
        const text = reader.boundedString();
        value = text === null ? { kind: 'oversize' } : { kind: 'string', value: text };
        break;
      }
      case 2: expectWire(wire, WIRE_VARINT); value = { kind: 'bool', value: reader.varint() !== 0n }; break;
      case 3: expectWire(wire, WIRE_VARINT); value = { kind: 'int', value: BigInt.asIntN(64, reader.varint()) }; break;
      case 4: expectWire(wire, WIRE_FIXED64); value = { kind: 'double', value: reader.double() }; break;
      case 5: {
        expectWire(wire, WIRE_LEN);
        const array = reader.sub();
        const values: OtlpValue[] = [];
        while (array.more()) {
          const inner = array.tag();
          if (inner.field === 1) {
            expectWire(inner.wire, WIRE_LEN);
            values.push(pbAnyValue(array.sub(), state, depth + 1));
          } else array.skip(inner.wire);
        }
        value = { kind: 'array', values };
        break;
      }
      case 6: {
        expectWire(wire, WIRE_LEN);
        const list = reader.sub();
        const nested = new AttributeCollector(state);
        while (list.more()) {
          const inner = list.tag();
          if (inner.field === 1) {
            expectWire(inner.wire, WIRE_LEN);
            pbKeyValue(list.sub(), state, nested, depth + 1);
          } else list.skip(inner.wire);
        }
        value = { kind: 'kvlist' };
        break;
      }
      case 7: expectWire(wire, WIRE_LEN); reader.len(); value = { kind: 'bytes' }; break;
      default: reader.skip(wire);
    }
  }
  return value;
}

function pbKeyValue(reader: Reader, state: DecodeState, into: AttributeCollector, depth = 0): void {
  let key: string | null = null;
  let value: OtlpValue = { kind: 'empty' };
  while (reader.more()) {
    const { field, wire } = reader.tag();
    if (field === 1) { expectWire(wire, WIRE_LEN); key = reader.boundedString(); }
    else if (field === 2) { expectWire(wire, WIRE_LEN); value = pbAnyValue(reader.sub(), state, depth + 1); }
    else reader.skip(wire);
  }
  into.add(key, value);
}

/** Read one repeated-KeyValue field occurrence into a collector. */
function pbAttributeField(reader: Reader, wire: number, state: DecodeState, into: AttributeCollector): void {
  expectWire(wire, WIRE_LEN);
  pbKeyValue(reader.sub(), state, into);
}

function pbResource(reader: Reader, state: DecodeState): OtlpResource {
  const attributes = new AttributeCollector(state);
  while (reader.more()) {
    const { field, wire } = reader.tag();
    if (field === 1) pbAttributeField(reader, wire, state, attributes);
    else reader.skip(wire);
  }
  return { attributes: attributes.done() };
}

function pbScope(reader: Reader, state: DecodeState): OtlpScope {
  const attributes = new AttributeCollector(state);
  let name: string | null = null;
  let version: string | null = null;
  while (reader.more()) {
    const { field, wire } = reader.tag();
    if (field === 1) { expectWire(wire, WIRE_LEN); name = reader.boundedString() || null; }
    else if (field === 2) { expectWire(wire, WIRE_LEN); version = reader.boundedString() || null; }
    else if (field === 3) pbAttributeField(reader, wire, state, attributes);
    else reader.skip(wire);
  }
  return { name, version, attributes: attributes.done() };
}

const EMPTY_RESOURCE: OtlpResource = { attributes: EMPTY_ATTRIBUTES };
const EMPTY_SCOPE: OtlpScope = { name: null, version: null, attributes: EMPTY_ATTRIBUTES };

/**
 * Walk `Resource{X}` → `Scope{X}` → items, where the resource is field 1, the
 * scope container is field 2, and inside it the scope is field 1 and the items
 * field 2 — the same layout for all three signals.
 */
function pbWalk<T>(
  body: Uint8Array,
  state: DecodeState,
  item: (reader: Reader, resource: OtlpResource, scope: OtlpScope, out: T[]) => void,
): T[] {
  const out: T[] = [];
  const root = new Reader(body);
  while (root.more()) {
    const top = root.tag();
    if (top.field !== 1) { root.skip(top.wire); continue; }
    expectWire(top.wire, WIRE_LEN);
    const resourceBlock = root.sub();
    // The resource may legally follow its scope blocks on the wire, so the
    // scope blocks are collected first and walked once the resource is known.
    let resource = EMPTY_RESOURCE;
    const scopeBlocks: Reader[] = [];
    while (resourceBlock.more()) {
      const { field, wire } = resourceBlock.tag();
      if (field === 1) { expectWire(wire, WIRE_LEN); resource = pbResource(resourceBlock.sub(), state); }
      else if (field === 2) { expectWire(wire, WIRE_LEN); scopeBlocks.push(resourceBlock.sub()); }
      else resourceBlock.skip(wire);
    }
    for (const scopeBlock of scopeBlocks) {
      let scope = EMPTY_SCOPE;
      const itemBlocks: Reader[] = [];
      while (scopeBlock.more()) {
        const { field, wire } = scopeBlock.tag();
        if (field === 1) { expectWire(wire, WIRE_LEN); scope = pbScope(scopeBlock.sub(), state); }
        else if (field === 2) { expectWire(wire, WIRE_LEN); itemBlocks.push(scopeBlock.sub()); }
        else scopeBlock.skip(wire);
      }
      for (const block of itemBlocks) item(block, resource, scope, out);
    }
  }
  return out;
}

function pbSpan(reader: Reader, resource: OtlpResource, scope: OtlpScope, state: DecodeState): OtlpSpanItem {
  state.record();
  const attributes = new AttributeCollector(state);
  const events: OtlpSpanEvent[] = [];
  let traceId: string | null = null;
  let spanId: string | null = null;
  let parentSpanId: string | null = null;
  let kind = 0;
  let startNs: bigint | null = null;
  let endNs: bigint | null = null;
  let statusCode = 0;
  while (reader.more()) {
    const { field, wire } = reader.tag();
    switch (field) {
      case 1: expectWire(wire, WIRE_LEN); traceId = hexId(reader.bytes(), 16); break;
      case 2: expectWire(wire, WIRE_LEN); spanId = hexId(reader.bytes(), 8); break;
      case 4: expectWire(wire, WIRE_LEN); parentSpanId = hexId(reader.bytes(), 8); break;
      case 6: expectWire(wire, WIRE_VARINT); kind = reader.small(); break;
      case 7: expectWire(wire, WIRE_FIXED64); startNs = reader.fixed64(); break;
      case 8: expectWire(wire, WIRE_FIXED64); endNs = reader.fixed64(); break;
      case 9: pbAttributeField(reader, wire, state, attributes); break;
      case 11: {
        expectWire(wire, WIRE_LEN);
        const event = reader.sub();
        const eventAttributes = new AttributeCollector(state);
        let timeNs: bigint | null = null;
        while (event.more()) {
          const inner = event.tag();
          if (inner.field === 1) { expectWire(inner.wire, WIRE_FIXED64); timeNs = event.fixed64(); }
          else if (inner.field === 3) pbAttributeField(event, inner.wire, state, eventAttributes);
          else event.skip(inner.wire);
        }
        events.push({ timeNs, attributes: eventAttributes.done() });
        break;
      }
      case 13: {
        // Links are never carried; their attributes are counted.
        expectWire(wire, WIRE_LEN);
        const link = reader.sub();
        const linkAttributes = new AttributeCollector(state);
        while (link.more()) {
          const inner = link.tag();
          if (inner.field === 4) pbAttributeField(link, inner.wire, state, linkAttributes);
          else link.skip(inner.wire);
        }
        break;
      }
      case 15: {
        expectWire(wire, WIRE_LEN);
        const status = reader.sub();
        while (status.more()) {
          const inner = status.tag();
          if (inner.field === 3) { expectWire(inner.wire, WIRE_VARINT); statusCode = status.small(); }
          else status.skip(inner.wire);
        }
        break;
      }
      default: reader.skip(wire);
    }
  }
  return {
    signal: 'traces', resource, scope, attributes: attributes.done(),
    traceId, spanId, parentSpanId, kind, startNs, endNs, statusCode, events,
  };
}

function pbLog(reader: Reader, resource: OtlpResource, scope: OtlpScope, state: DecodeState): OtlpLogItem {
  state.record();
  const attributes = new AttributeCollector(state);
  let timeNs: bigint | null = null;
  let observedNs: bigint | null = null;
  let severityNumber = 0;
  let traceId: string | null = null;
  let spanId: string | null = null;
  while (reader.more()) {
    const { field, wire } = reader.tag();
    switch (field) {
      case 1: expectWire(wire, WIRE_FIXED64); timeNs = reader.fixed64(); break;
      case 11: expectWire(wire, WIRE_FIXED64); observedNs = reader.fixed64(); break;
      case 2: expectWire(wire, WIRE_VARINT); severityNumber = reader.small(); break;
      // The BODY is walked so a kvlist body's entries are counted, and then
      // discarded: a log body is content (§6.1) and no translation reads it.
      case 5: {
        expectWire(wire, WIRE_LEN);
        pbAnyValue(reader.sub(), state, 1);
        break;
      }
      case 6: pbAttributeField(reader, wire, state, attributes); break;
      case 9: expectWire(wire, WIRE_LEN); traceId = hexId(reader.bytes(), 16); break;
      case 10: expectWire(wire, WIRE_LEN); spanId = hexId(reader.bytes(), 8); break;
      default: reader.skip(wire);
    }
  }
  return {
    signal: 'logs', resource, scope, attributes: attributes.done(),
    timeNs, observedNs, severityNumber, traceId, spanId,
  };
}

/** Exemplars carry `filtered_attributes` (field 7); counted, never carried. */
function pbExemplar(reader: Reader, state: DecodeState): void {
  const attributes = new AttributeCollector(state);
  while (reader.more()) {
    const { field, wire } = reader.tag();
    if (field === 7) pbAttributeField(reader, wire, state, attributes);
    else reader.skip(wire);
  }
}

interface PointLayout {
  attributes: number;
  exemplars: number;
  start: number;
  time: number;
  /** Number points: as_double=4, as_int=6 (sfixed64). */
  number?: { double: number; int: number };
  /** Aggregate points: count (fixed64) and sum (double). */
  aggregate?: { count: number; sum: number };
}

const NUMBER_POINT: PointLayout = { attributes: 7, exemplars: 5, start: 2, time: 3, number: { double: 4, int: 6 } };
const HISTOGRAM_POINT: PointLayout = { attributes: 9, exemplars: 8, start: 2, time: 3, aggregate: { count: 4, sum: 5 } };
const EXPONENTIAL_POINT: PointLayout = { attributes: 1, exemplars: 11, start: 2, time: 3, aggregate: { count: 4, sum: 5 } };
const SUMMARY_POINT: PointLayout = { attributes: 7, exemplars: -1, start: 2, time: 3, aggregate: { count: 4, sum: 5 } };

function pbPoint(
  reader: Reader, layout: PointLayout, state: DecodeState,
): Pick<OtlpMetricItem, 'attributes' | 'startNs' | 'timeNs' | 'number' | 'aggregate'> {
  state.record();
  const attributes = new AttributeCollector(state);
  let startNs: bigint | null = null;
  let timeNs: bigint | null = null;
  let number: OtlpNumber | null = null;
  let count: bigint | null = null;
  let sum: number | null = null;
  while (reader.more()) {
    const { field, wire } = reader.tag();
    if (field === layout.attributes) pbAttributeField(reader, wire, state, attributes);
    else if (field === layout.exemplars) { expectWire(wire, WIRE_LEN); pbExemplar(reader.sub(), state); }
    else if (field === layout.start) { expectWire(wire, WIRE_FIXED64); startNs = reader.fixed64(); }
    else if (field === layout.time) { expectWire(wire, WIRE_FIXED64); timeNs = reader.fixed64(); }
    else if (layout.number && field === layout.number.double) {
      expectWire(wire, WIRE_FIXED64); number = { kind: 'double', value: reader.double() };
    } else if (layout.number && field === layout.number.int) {
      expectWire(wire, WIRE_FIXED64); number = { kind: 'int', value: BigInt.asIntN(64, reader.fixed64()) };
    } else if (layout.aggregate && field === layout.aggregate.count) {
      expectWire(wire, WIRE_FIXED64); count = reader.fixed64();
    } else if (layout.aggregate && field === layout.aggregate.sum) {
      expectWire(wire, WIRE_FIXED64); sum = reader.double();
    } else reader.skip(wire);
  }
  return {
    attributes: attributes.done(), startNs, timeNs, number,
    aggregate: layout.aggregate ? { count, sum } : null,
  };
}

function pbMetric(reader: Reader, resource: OtlpResource, scope: OtlpScope, state: DecodeState, out: OtlpMetricItem[]): void {
  let metricName = '';
  let unit: string | null = null;
  const pointBlocks: Array<{ shape: OtlpMetricShape; reader: Reader }> = [];
  let temporality = 0;
  let monotonic = false;
  while (reader.more()) {
    const { field, wire } = reader.tag();
    if (field === 1) { expectWire(wire, WIRE_LEN); metricName = reader.boundedString() ?? ''; continue; }
    if (field === 3) { expectWire(wire, WIRE_LEN); unit = reader.boundedString() || null; continue; }
    if (field === 12) {
      // Metric.metadata: KeyValues, counted and never carried.
      pbAttributeField(reader, wire, state, new AttributeCollector(state));
      continue;
    }
    const shape: OtlpMetricShape | null = field === 5 ? 'gauge' : field === 7 ? 'sum' : field === 9 ? 'histogram'
      : field === 10 ? 'exponential_histogram' : field === 11 ? 'summary' : null;
    if (!shape) { reader.skip(wire); continue; }
    expectWire(wire, WIRE_LEN);
    const data = reader.sub();
    while (data.more()) {
      const inner = data.tag();
      if (inner.field === 1) { expectWire(inner.wire, WIRE_LEN); pointBlocks.push({ shape, reader: data.sub() }); }
      else if (inner.field === 2 && shape !== 'gauge' && shape !== 'summary') {
        expectWire(inner.wire, WIRE_VARINT); temporality = data.small();
      } else if (inner.field === 3 && shape === 'sum') {
        expectWire(inner.wire, WIRE_VARINT); monotonic = data.varint() !== 0n;
      } else data.skip(inner.wire);
    }
  }
  for (const block of pointBlocks) {
    const layout = block.shape === 'gauge' || block.shape === 'sum' ? NUMBER_POINT
      : block.shape === 'histogram' ? HISTOGRAM_POINT
        : block.shape === 'exponential_histogram' ? EXPONENTIAL_POINT : SUMMARY_POINT;
    const point = pbPoint(block.reader, layout, state);
    out.push({
      signal: 'metrics', resource, scope, metricName, unit, shape: block.shape,
      temporality, monotonic, ...point,
    });
  }
}

/** Decode an OTLP/HTTP protobuf body for one signal. */
export function decodeOtlpProtobuf(signal: OtlpSignal, body: Uint8Array): OtlpDecodedExport {
  const state = new DecodeState(signal);
  let items: OtlpItem[];
  if (signal === 'traces') {
    items = pbWalk<OtlpSpanItem>(body, state, (r, res, sc, out) => { out.push(pbSpan(r, res, sc, state)); });
  } else if (signal === 'logs') {
    items = pbWalk<OtlpLogItem>(body, state, (r, res, sc, out) => { out.push(pbLog(r, res, sc, state)); });
  } else {
    items = pbWalk<OtlpMetricItem>(body, state, (r, res, sc, out) => { pbMetric(r, res, sc, state, out); });
  }
  return { signal, items, attributeEntries: state.attributeEntries };
}

// ═══════════════════════════════ JSON ═══════════════════════════════════════
//
// OTLP/JSON (opentelemetry-proto docs/specification.md, "JSON Protobuf
// Encoding"): lowerCamelCase keys, trace and span ids as HEX strings, 64-bit
// integers as decimal strings (a JSON number is tolerated when it is exact),
// enums as integers, unknown keys ignored.

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw undecodable(`${where} must be an array`);
  return value;
}

function object(value: unknown, where: string): Json | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw undecodable(`${where} must be an object`);
  return value;
}

/** A 64-bit integer: decimal string exactly, or a JSON number only when exact. */
function jsonInt64(value: unknown, where: string, signed: boolean): bigint | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (!(signed ? /^-?\d{1,20}$/ : /^\d{1,20}$/).test(value)) throw undecodable(`${where} must be a decimal integer`);
    const parsed = BigInt(value);
    return signed ? BigInt.asIntN(64, parsed) === parsed ? parsed : null
      : BigInt.asUintN(64, parsed) === parsed ? parsed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw undecodable(`${where} must be an integer`);
    // JSON.parse has already rounded anything beyond 2^53: say so, never pass it on.
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  throw undecodable(`${where} must be an integer`);
}

function jsonTime(value: unknown, where: string): bigint | null {
  const parsed = jsonInt64(value, where, false);
  return parsed === undefined ? null : parsed;
}

function jsonEnum(value: unknown, where: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw undecodable(`${where} must be an integer enum`);
  return value;
}

function jsonDouble(value: unknown, where: string): number {
  if (typeof value === 'number') return value;
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw undecodable(`${where} must be a number`);
}

function jsonHexId(value: unknown, width: number, where: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw undecodable(`${where} must be a hex string`);
  if (!new RegExp(`^[0-9a-fA-F]{${width * 2}}$`).test(value)) return null;
  const hex = value.toLowerCase();
  return /^0+$/.test(hex) ? null : hex;
}

function jsonString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw undecodable(`${where} must be a string`);
  // proto3: an empty string IS an absent one, in either encoding.
  if (value.length === 0) return null;
  return Buffer.byteLength(value, 'utf8') > OTLP_MAX_STRING_BYTES ? null : value;
}

function jsonAnyValue(value: unknown, state: DecodeState, depth: number): OtlpValue {
  if (depth > OTLP_MAX_VALUE_DEPTH) throw undecodable('attribute value nested too deeply');
  const any = object(value, 'AnyValue');
  if (!any) return { kind: 'empty' };
  if ('stringValue' in any) {
    if (typeof any.stringValue !== 'string') throw undecodable('stringValue must be a string');
    return Buffer.byteLength(any.stringValue, 'utf8') > OTLP_MAX_STRING_BYTES
      ? { kind: 'oversize' } : { kind: 'string', value: any.stringValue };
  }
  if ('boolValue' in any) {
    if (typeof any.boolValue !== 'boolean') throw undecodable('boolValue must be a boolean');
    return { kind: 'bool', value: any.boolValue };
  }
  if ('intValue' in any) return { kind: 'int', value: jsonInt64(any.intValue, 'intValue', true) ?? null };
  if ('doubleValue' in any) return { kind: 'double', value: jsonDouble(any.doubleValue, 'doubleValue') };
  if ('arrayValue' in any) {
    const array = object(any.arrayValue, 'arrayValue');
    return { kind: 'array', values: list(array?.values, 'arrayValue.values').map((v) => jsonAnyValue(v, state, depth + 1)) };
  }
  if ('kvlistValue' in any) {
    const kvlist = object(any.kvlistValue, 'kvlistValue');
    jsonAttributes(kvlist?.values, state, depth + 1);
    return { kind: 'kvlist' };
  }
  if ('bytesValue' in any) return { kind: 'bytes' };
  return { kind: 'empty' };
}

function jsonAttributes(value: unknown, state: DecodeState, depth = 0): OtlpAttributes {
  const collector = new AttributeCollector(state);
  for (const entry of list(value, 'attributes')) {
    if (!isObject(entry)) throw undecodable('an attribute must be an object');
    const key = typeof entry.key === 'string' && Buffer.byteLength(entry.key, 'utf8') <= OTLP_MAX_STRING_BYTES
      ? entry.key : null;
    collector.add(key, jsonAnyValue(entry.value, state, depth + 1));
  }
  return collector.done();
}

function jsonResource(value: unknown, state: DecodeState): OtlpResource {
  const resource = object(value, 'resource');
  return { attributes: resource ? jsonAttributes(resource.attributes, state) : EMPTY_ATTRIBUTES };
}

function jsonScope(value: unknown, state: DecodeState): OtlpScope {
  const scope = object(value, 'scope');
  if (!scope) return EMPTY_SCOPE;
  return {
    name: jsonString(scope.name, 'scope.name'),
    version: jsonString(scope.version, 'scope.version'),
    attributes: jsonAttributes(scope.attributes, state),
  };
}

const JSON_KEYS: Record<OtlpSignal, { resource: string; scope: string; items: string }> = {
  traces: { resource: 'resourceSpans', scope: 'scopeSpans', items: 'spans' },
  logs: { resource: 'resourceLogs', scope: 'scopeLogs', items: 'logRecords' },
  metrics: { resource: 'resourceMetrics', scope: 'scopeMetrics', items: 'metrics' },
};

function jsonSpan(span: Json, resource: OtlpResource, scope: OtlpScope, state: DecodeState): OtlpSpanItem {
  state.record();
  const attributes = jsonAttributes(span.attributes, state);
  const events = list(span.events, 'events').map((raw) => {
    const event = object(raw, 'event') ?? {};
    return { timeNs: jsonTime(event.timeUnixNano, 'event.timeUnixNano'), attributes: jsonAttributes(event.attributes, state) };
  });
  for (const raw of list(span.links, 'links')) jsonAttributes((object(raw, 'link') ?? {}).attributes, state);
  const status = object(span.status, 'status');
  return {
    signal: 'traces', resource, scope, attributes,
    traceId: jsonHexId(span.traceId, 16, 'traceId'),
    spanId: jsonHexId(span.spanId, 8, 'spanId'),
    parentSpanId: jsonHexId(span.parentSpanId, 8, 'parentSpanId'),
    kind: jsonEnum(span.kind, 'kind'),
    startNs: jsonTime(span.startTimeUnixNano, 'startTimeUnixNano'),
    endNs: jsonTime(span.endTimeUnixNano, 'endTimeUnixNano'),
    statusCode: status ? jsonEnum(status.code, 'status.code') : 0,
    events,
  };
}

function jsonLog(log: Json, resource: OtlpResource, scope: OtlpScope, state: DecodeState): OtlpLogItem {
  state.record();
  // Walked for the count; discarded as content.
  if (log.body !== undefined && log.body !== null) jsonAnyValue(log.body, state, 1);
  return {
    signal: 'logs', resource, scope,
    attributes: jsonAttributes(log.attributes, state),
    timeNs: jsonTime(log.timeUnixNano, 'timeUnixNano'),
    observedNs: jsonTime(log.observedTimeUnixNano, 'observedTimeUnixNano'),
    severityNumber: jsonEnum(log.severityNumber, 'severityNumber'),
    traceId: jsonHexId(log.traceId, 16, 'traceId'),
    spanId: jsonHexId(log.spanId, 8, 'spanId'),
  };
}

const JSON_SHAPES: Array<[string, OtlpMetricShape]> = [
  ['gauge', 'gauge'], ['sum', 'sum'], ['histogram', 'histogram'],
  ['exponentialHistogram', 'exponential_histogram'], ['summary', 'summary'],
];

function jsonMetric(metric: Json, resource: OtlpResource, scope: OtlpScope, state: DecodeState, out: OtlpMetricItem[]): void {
  const metricName = jsonString(metric.name, 'metric.name') ?? '';
  const unit = jsonString(metric.unit, 'metric.unit');
  jsonAttributes(metric.metadata, state);
  for (const [key, shape] of JSON_SHAPES) {
    const data = object(metric[key], `metric.${key}`);
    if (!data) continue;
    const temporality = shape === 'gauge' || shape === 'summary' ? 0 : jsonEnum(data.aggregationTemporality, 'aggregationTemporality');
    const monotonic = shape === 'sum' && data.isMonotonic === true;
    for (const raw of list(data.dataPoints, 'dataPoints')) {
      const point = object(raw, 'dataPoint') ?? {};
      state.record();
      const attributes = jsonAttributes(point.attributes, state);
      for (const exemplar of list(point.exemplars, 'exemplars')) {
        jsonAttributes((object(exemplar, 'exemplar') ?? {}).filteredAttributes, state);
      }
      let number: OtlpNumber | null = null;
      let aggregate: OtlpMetricItem['aggregate'] = null;
      if (shape === 'gauge' || shape === 'sum') {
        if (point.asDouble !== undefined && point.asDouble !== null) number = { kind: 'double', value: jsonDouble(point.asDouble, 'asDouble') };
        else if (point.asInt !== undefined && point.asInt !== null) number = { kind: 'int', value: jsonInt64(point.asInt, 'asInt', true) ?? null };
      } else {
        const count = jsonInt64(point.count, 'count', false);
        aggregate = {
          count: count === undefined ? null : count,
          sum: point.sum === undefined || point.sum === null ? null : jsonDouble(point.sum, 'sum'),
        };
      }
      out.push({
        signal: 'metrics', resource, scope, attributes, metricName, unit, shape, temporality, monotonic,
        startNs: jsonTime(point.startTimeUnixNano, 'startTimeUnixNano'),
        timeNs: jsonTime(point.timeUnixNano, 'timeUnixNano'),
        number, aggregate,
      });
    }
  }
}

/** Decode an OTLP/HTTP JSON body (already parsed) for one signal. */
export function decodeOtlpJson(signal: OtlpSignal, body: unknown): OtlpDecodedExport {
  const root = object(body, 'export request');
  if (!root) throw undecodable('an OTLP/JSON export must be a JSON object');
  const state = new DecodeState(signal);
  const keys = JSON_KEYS[signal];
  const items: OtlpItem[] = [];
  for (const rawResource of list(root[keys.resource], keys.resource)) {
    const resourceBlock = object(rawResource, keys.resource) ?? {};
    const resource = jsonResource(resourceBlock.resource, state);
    for (const rawScope of list(resourceBlock[keys.scope], keys.scope)) {
      const scopeBlock = object(rawScope, keys.scope) ?? {};
      const scope = jsonScope(scopeBlock.scope, state);
      for (const rawItem of list(scopeBlock[keys.items], keys.items)) {
        const item = object(rawItem, keys.items) ?? {};
        if (signal === 'traces') items.push(jsonSpan(item, resource, scope, state));
        else if (signal === 'logs') items.push(jsonLog(item, resource, scope, state));
        else jsonMetric(item, resource, scope, state, items as OtlpMetricItem[]);
      }
    }
  }
  return { signal, items, attributeEntries: state.attributeEntries };
}

export type OtlpDecodeResult =
  | { ok: true; decoded: OtlpDecodedExport }
  | { ok: false; code: OtlpDecodeErrorCode };

/**
 * Decode, answering a body the receiver cannot read as a CODE rather than an
 * exception, so the route chooses its answer from a fixed table and no caught
 * value ever reaches a response. Anything other than a decode refusal still
 * throws: it is a fault, not an answer.
 */
export function tryDecodeOtlp(signal: OtlpSignal, encoding: 'protobuf' | 'json', body: unknown): OtlpDecodeResult {
  try {
    return {
      ok: true,
      decoded: encoding === 'protobuf'
        ? decodeOtlpProtobuf(signal, Buffer.isBuffer(body) ? body : Buffer.alloc(0))
        : decodeOtlpJson(signal, body ?? {}),
    };
  } catch (err) {
    if (err instanceof OtlpDecodeError) return { ok: false, code: err.code };
    throw err;
  }
}
