/**
 * OTLP replay fixtures and two INDEPENDENT oracles for the OTLP receiver
 * suites (card `dac2ca71`).
 *
 * THE FIXTURES are real exports captured from two different producers and
 * committed under `__tests__/fixtures/otlp/`:
 *
 *   claude-code-protobuf/  Claude Code 2.1.246, OTLP/HTTP protobuf
 *   claude-code-json/      Claude Code 2.1.246, OTLP/HTTP JSON
 *   otel-python-protobuf/  the OpenTelemetry Python SDK 1.27.0, protobuf:
 *                          GenAI-semconv and OpenInference spans, a GenAI
 *                          token histogram, one log record
 *
 * Each is the producer's request body byte-for-byte, except that identifying
 * values (addresses, account and organization ids, session/request/tool ids)
 * were replaced by synthetic values of the SAME BYTE LENGTH before commit, so
 * every protobuf length prefix is still the producer's own. The `sha256` field
 * is over the committed body.
 *
 * THE ORACLES do not call the code under test:
 *   - `encodeOtlpJsonAsProtobuf` re-encodes an OTLP/JSON body as protobuf with
 *     its own writer, so the protobuf decoder can be compared with the JSON
 *     decoder on the SAME message;
 *   - `countJsonAttributeEntries` counts KeyValue entries by walking the JSON,
 *     so the decoder's reported count is checked against an outside number.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { OtlpSignal } from '../../utils/otlp/otlpDecode';

export interface OtlpFixture {
  name: string;
  producer: string;
  producerVersion: string;
  signal: OtlpSignal;
  contentType: 'application/x-protobuf' | 'application/json';
  sha256: string;
  body: Buffer;
  /** The parsed body, for JSON fixtures. */
  json: any | null;
}

export const OTLP_FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'otlp');

export function loadOtlpFixtures(): OtlpFixture[] {
  const out: OtlpFixture[] = [];
  for (const dir of fs.readdirSync(OTLP_FIXTURE_ROOT).sort()) {
    for (const file of fs.readdirSync(path.join(OTLP_FIXTURE_ROOT, dir)).sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(OTLP_FIXTURE_ROOT, dir, file), 'utf8'));
      const body = raw.bodyBase64 !== undefined ? Buffer.from(raw.bodyBase64, 'base64') : Buffer.from(raw.bodyText, 'utf8');
      const digest = crypto.createHash('sha256').update(body).digest('hex');
      if (digest !== raw.sha256) throw new Error(`fixture ${dir}/${file} does not match its recorded sha256`);
      out.push({
        name: `${dir}/${file}`,
        producer: raw.producer,
        producerVersion: raw.producerVersion,
        signal: raw.signal,
        contentType: raw.contentType,
        sha256: raw.sha256,
        body,
        json: raw.contentType === 'application/json' ? JSON.parse(body.toString('utf8')) : null,
      });
    }
  }
  return out;
}

// ─────────────────────────── the counting oracle ────────────────────────────

const ATTRIBUTE_ARRAYS = new Set(['attributes', 'filteredAttributes', 'metadata']);

/** Every KeyValue in an OTLP/JSON body, at every level, keyless and duplicate included. */
export function countJsonAttributeEntries(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + countJsonAttributeEntries(item), 0);
  if (typeof node !== 'object' || node === null) return 0;
  let count = 0;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (ATTRIBUTE_ARRAYS.has(key) && Array.isArray(value)) count += value.length;
    if (key === 'kvlistValue' && typeof value === 'object' && value !== null
      && Array.isArray((value as { values?: unknown[] }).values)) {
      count += (value as { values: unknown[] }).values.length;
    }
    count += countJsonAttributeEntries(value);
  }
  return count;
}

// ─────────────────────────── the encoding oracle ────────────────────────────

function varint(value: bigint): Buffer {
  let v = BigInt.asUintN(64, value);
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}
const key = (field: number, wire: number): Buffer => varint(BigInt(field * 8 + wire));
const len = (field: number, payload: Buffer): Buffer => Buffer.concat([key(field, 2), varint(BigInt(payload.length)), payload]);
const str = (field: number, text: string): Buffer => len(field, Buffer.from(text, 'utf8'));
const vint = (field: number, value: bigint | number): Buffer => Buffer.concat([key(field, 0), varint(BigInt(value))]);
function fixed64(field: number, value: bigint | string | number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
  return Buffer.concat([key(field, 1), out]);
}
function double(field: number, value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeDoubleLE(value);
  return Buffer.concat([key(field, 1), out]);
}
const cat = (parts: Array<Buffer | null | undefined | false>): Buffer =>
  Buffer.concat(parts.filter((part): part is Buffer => Buffer.isBuffer(part)));
const each = <T>(items: T[] | undefined, fn: (item: T) => Buffer): Buffer => cat((items ?? []).map(fn));

function anyValue(value: any): Buffer {
  if (!value) return Buffer.alloc(0);
  if ('stringValue' in value) return str(1, value.stringValue);
  if ('boolValue' in value) return vint(2, value.boolValue ? 1 : 0);
  if ('intValue' in value) return vint(3, BigInt(value.intValue));
  if ('doubleValue' in value) return double(4, Number(value.doubleValue));
  if ('arrayValue' in value) return len(5, each(value.arrayValue.values, (v) => len(1, anyValue(v))));
  if ('kvlistValue' in value) return len(6, each(value.kvlistValue.values, (kv) => len(1, keyValue(kv))));
  if ('bytesValue' in value) return len(7, Buffer.from(value.bytesValue, 'base64'));
  return Buffer.alloc(0);
}
function keyValue(kv: any): Buffer { return cat([str(1, kv.key ?? ''), len(2, anyValue(kv.value))]); }
const attrs = (field: number, list: any[] | undefined): Buffer => each(list, (kv) => len(field, keyValue(kv)));
const hex = (field: number, id: string | undefined): Buffer | null => (id ? len(field, Buffer.from(id, 'hex')) : null);

function scope(s: any): Buffer {
  return cat([s?.name ? str(1, s.name) : null, s?.version ? str(2, s.version) : null, attrs(3, s?.attributes)]);
}
function span(s: any): Buffer {
  return cat([
    hex(1, s.traceId), hex(2, s.spanId), hex(4, s.parentSpanId), s.name ? str(5, s.name) : null,
    s.kind ? vint(6, s.kind) : null,
    s.startTimeUnixNano ? fixed64(7, s.startTimeUnixNano) : null,
    s.endTimeUnixNano ? fixed64(8, s.endTimeUnixNano) : null,
    attrs(9, s.attributes),
    each(s.events, (e: any) => len(11, cat([e.timeUnixNano ? fixed64(1, e.timeUnixNano) : null, e.name ? str(2, e.name) : null, attrs(3, e.attributes)]))),
    each(s.links, (l: any) => len(13, cat([hex(1, l.traceId), hex(2, l.spanId), attrs(4, l.attributes)]))),
    s.status ? len(15, cat([s.status.message ? str(2, s.status.message) : null, s.status.code ? vint(3, s.status.code) : null])) : null,
  ]);
}
function log(l: any): Buffer {
  return cat([
    l.timeUnixNano ? fixed64(1, l.timeUnixNano) : null,
    l.severityNumber ? vint(2, l.severityNumber) : null,
    l.severityText ? str(3, l.severityText) : null,
    l.body ? len(5, anyValue(l.body)) : null,
    attrs(6, l.attributes),
    hex(9, l.traceId), hex(10, l.spanId),
    l.observedTimeUnixNano ? fixed64(11, l.observedTimeUnixNano) : null,
  ]);
}
function numberPoint(p: any): Buffer {
  return cat([
    p.startTimeUnixNano ? fixed64(2, p.startTimeUnixNano) : null,
    p.timeUnixNano ? fixed64(3, p.timeUnixNano) : null,
    p.asDouble !== undefined ? double(4, p.asDouble) : null,
    p.asInt !== undefined ? fixed64(6, BigInt.asUintN(64, BigInt(p.asInt))) : null,
    attrs(7, p.attributes),
  ]);
}
function histogramPoint(p: any): Buffer {
  return cat([
    p.startTimeUnixNano ? fixed64(2, p.startTimeUnixNano) : null,
    p.timeUnixNano ? fixed64(3, p.timeUnixNano) : null,
    p.count !== undefined ? fixed64(4, p.count) : null,
    p.sum !== undefined ? double(5, p.sum) : null,
    attrs(9, p.attributes),
  ]);
}
function metric(m: any): Buffer {
  const parts: Array<Buffer | null> = [m.name ? str(1, m.name) : null, m.description ? str(2, m.description) : null, m.unit ? str(3, m.unit) : null];
  if (m.gauge) parts.push(len(5, each(m.gauge.dataPoints, (p) => len(1, numberPoint(p)))));
  if (m.sum) {
    parts.push(len(7, cat([
      each(m.sum.dataPoints, (p) => len(1, numberPoint(p))),
      m.sum.aggregationTemporality ? vint(2, m.sum.aggregationTemporality) : null,
      m.sum.isMonotonic ? vint(3, 1) : null,
    ])));
  }
  if (m.histogram) {
    parts.push(len(9, cat([
      each(m.histogram.dataPoints, (p) => len(1, histogramPoint(p))),
      m.histogram.aggregationTemporality ? vint(2, m.histogram.aggregationTemporality) : null,
    ])));
  }
  parts.push(attrs(12, m.metadata));
  return cat(parts);
}

const LAYOUT: Record<OtlpSignal, { resource: string; scope: string; items: string; item: (x: any) => Buffer }> = {
  traces: { resource: 'resourceSpans', scope: 'scopeSpans', items: 'spans', item: span },
  logs: { resource: 'resourceLogs', scope: 'scopeLogs', items: 'logRecords', item: log },
  metrics: { resource: 'resourceMetrics', scope: 'scopeMetrics', items: 'metrics', item: metric },
};

/** An OTLP/JSON export body re-encoded as the protobuf the same producer would have sent. */
export function encodeOtlpJsonAsProtobuf(signal: OtlpSignal, body: any): Buffer {
  const layout = LAYOUT[signal];
  return each(body[layout.resource], (r: any) => len(1, cat([
    r.resource ? len(1, attrs(1, r.resource.attributes)) : null,
    each(r[layout.scope], (s: any) => len(2, cat([
      s.scope ? len(1, scope(s.scope)) : null,
      each(s[layout.items], (item: any) => len(2, layout.item(item))),
    ]))),
  ])));
}

/** A minimal one-record OTLP/JSON logs export, for hand-built cases. */
export function jsonLogsExport(
  attributes: Array<{ key?: string; value?: unknown }>,
  options: { serviceName?: string; timeUnixNano?: string; resourceAttributes?: Array<{ key: string; value: unknown }> } = {},
): any {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: options.serviceName ?? 'claude-code' } },
          ...(options.resourceAttributes ?? []),
        ],
      },
      scopeLogs: [{
        scope: { name: 'com.anthropic.claude_code.events', version: '2.1.246' },
        logRecords: [{
          timeUnixNano: options.timeUnixNano ?? '1792414286321000000',
          body: { stringValue: 'claude_code.api_request' },
          attributes,
        }],
      }],
    }],
  };
}

/** A minimal one-span OTLP/JSON traces export. */
export function jsonTracesExport(span: Record<string, unknown>, serviceName = 'genai-sample'): any {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: 'sample.genai', version: '1.0.0' },
        spans: [{
          traceId: '5b8efff798038103d269b633813fc60c',
          spanId: 'eee19b7ec3c1b174',
          name: 'chat sample-model',
          kind: 3,
          startTimeUnixNano: '1792414283201000000',
          endTimeUnixNano: '1792414286321680100',
          ...span,
        }],
      }],
    }],
  };
}

export const s = (value: string) => ({ stringValue: value });
export const i = (value: number | string) => ({ intValue: value });
export const d = (value: number) => ({ doubleValue: value });
