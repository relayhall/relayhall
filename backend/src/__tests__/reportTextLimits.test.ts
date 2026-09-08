import express from 'express';
import type { AddressInfo } from 'net';
import { checkBody, validateBody } from '../middleware/validate';
import { isStringTooLongError } from '../utils/apiErrors';
import { ReportManager, REPORT_TEXT_LIMITS } from '../services/ReportManager';

/**
 * Regression cover for the bare-500 reported on 2026-07-26: an over-length
 * `summary` reached Postgres and surfaced as a raw
 * "value too long for type character varying(500)" with HTTP 500.
 */

// Mirrors the schema in routes/reports.ts.
const reportSchema = {
  title: { type: 'string' as const, maxLen: REPORT_TEXT_LIMITS.title },
  summary: { type: 'string' as const, maxLen: REPORT_TEXT_LIMITS.summary },
  author: { type: 'string' as const, maxLen: REPORT_TEXT_LIMITS.author },
};

describe('report body length validation', () => {
  it('accepts fields at exactly the column limit', () => {
    const body = {
      title: 'a'.repeat(REPORT_TEXT_LIMITS.title),
      summary: 'b'.repeat(REPORT_TEXT_LIMITS.summary),
      author: 'c'.repeat(REPORT_TEXT_LIMITS.author),
    };
    expect(checkBody(body, reportSchema, { allowUnknown: true })).toEqual([]);
  });

  it('rejects an over-length summary naming the field and the limit', () => {
    const errors = checkBody(
      { summary: 'x'.repeat(REPORT_TEXT_LIMITS.summary + 1) },
      reportSchema,
      { allowUnknown: true },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('summary');
    expect(errors[0].problem).toContain(String(REPORT_TEXT_LIMITS.summary));
  });

  it('rejects over-length title and author too', () => {
    const errors = checkBody(
      {
        title: 'x'.repeat(REPORT_TEXT_LIMITS.title + 1),
        author: 'y'.repeat(REPORT_TEXT_LIMITS.author + 1),
      },
      reportSchema,
      { allowUnknown: true },
    );
    expect(errors.map(e => e.field).sort()).toEqual(['author', 'title']);
  });

  it('passes through the other report fields it does not govern', () => {
    const body = {
      title: 'ok',
      content: 'x'.repeat(50_000),
      tags: ['a'],
      project_id: 'p',
      task_ids: ['t'],
      visibility: 'default',
      pinned: true,
    };
    expect(checkBody(body, reportSchema, { allowUnknown: true })).toEqual([]);
  });
});

describe('generated summary fits the column', () => {
  // generateSummary is private; exercised through the instance as the route does.
  const generate = (content: string): string =>
    (new ReportManager({ query: jest.fn() } as never) as unknown as
      { generateSummary(c: string): string }).generateSummary(content);

  it('never exceeds the summary column even when the ellipsis is appended', () => {
    // No spaces at all: the old code took substring(0, 500) and appended '...'
    // for a 503-character summary that the insert rejected.
    const summary = generate('a'.repeat(2000));
    expect(summary.length).toBeLessThanOrEqual(REPORT_TEXT_LIMITS.summary);
    expect(summary.endsWith('...')).toBe(true);
  });

  it('stays within the limit across word-boundary positions', () => {
    // Sweep the boundary so neither branch of the word-trim can overflow.
    for (let pad = 380; pad <= 520; pad++) {
      const content = `${'a'.repeat(pad)} ${'b'.repeat(2000)}`;
      expect(generate(content).length).toBeLessThanOrEqual(REPORT_TEXT_LIMITS.summary);
    }
  });

  it('leaves short content untouched and un-ellipsised', () => {
    expect(generate('a short report body')).toBe('a short report body');
  });
});

describe('over-length report body over real HTTP', () => {
  // Mounts the same middleware the reports router uses on a throwaway express
  // app, so the status code and envelope are exercised end to end rather than
  // asserted from the validator in isolation.
  let server: ReturnType<express.Express['listen']>;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post('/reports', validateBody(reportSchema, { allowUnknown: true }), (_req, res) => {
      res.status(201).json({ success: true });
    });
    await new Promise<void>(resolve => { server = app.listen(0, resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reports`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  });

  it('answers 400 VALIDATION_FAILED naming summary, not 500', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'ok',
        content: 'body',
        summary: 'x'.repeat(REPORT_TEXT_LIMITS.summary + 1),
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as {
      success: boolean; code: string; message: string;
      details: Array<{ field: string; problem: string }>;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.map(d => d.field)).toEqual(['summary']);
    expect(body.details[0].problem).toContain(String(REPORT_TEXT_LIMITS.summary));
    // The raw Postgres message must never reach the client.
    expect(JSON.stringify(body)).not.toContain('character varying');
  });

  it('still accepts a valid report body', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ok', content: 'body', summary: 'short' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('isStringTooLongError', () => {
  it('matches the Postgres string_data_right_truncation code', () => {
    expect(isStringTooLongError(Object.assign(new Error('value too long'), { code: '22001' }))).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isStringTooLongError(new Error('boom'))).toBe(false);
    expect(isStringTooLongError(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isStringTooLongError(null)).toBe(false);
    expect(isStringTooLongError(undefined)).toBe(false);
  });
});
