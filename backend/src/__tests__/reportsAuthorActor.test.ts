/**
 * reportsAuthorActor.test.ts — reports hardening item 4 (task c655d243):
 * author_actor_id is recorded from the authenticated identity (req.userId)
 * on POST; the client `author` field stays but is exposed as
 * author_unverified; body attempts to set author_actor_id are rejected.
 */
import express, { Request } from 'express';

jest.mock('../services/ReportManager', () => {
  const actual = jest.requireActual('../services/ReportManager');
  return {
    ...actual,
    reportManager: {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
});

jest.mock('../services/WebhookService', () => ({
  webhookService: { emitEvent: jest.fn() },
}));

import reportsRoutes from '../routes/reports';
import { reportManager } from '../services/ReportManager';

const manager = reportManager as jest.Mocked<typeof reportManager>;
const { ReportManager } = jest.requireActual('../services/ReportManager');

const RID = '11111111-1111-4111-8111-111111111111';

async function withServer(userId: string | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => { (req as Request & { userId?: string }).userId = userId; next(); });
  app.use('/reports', reportsRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
}

describe('author_actor_id provenance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.create.mockResolvedValue({ id: RID } as never);
    manager.update.mockResolvedValue({ id: RID } as never);
  });

  it('POST records the authenticated identity as author_actor_id', async () => {
    await withServer('service_account', async base => {
      const res = await fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C', author: 'friendly-label' }),
      });
      expect(res.status).toBe(201);
      expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({
        author: 'friendly-label',
        author_actor_id: 'service_account',
      }));
    });
  });

  it('POST rejects author_actor_id supplied in the body with 400', async () => {
    await withServer('service_account', async base => {
      const res = await fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C', author_actor_id: 'dashboard_user' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('AUTHOR_ACTOR_ID_FORBIDDEN');
      expect(manager.create).not.toHaveBeenCalled();
    });
  });

  it('PATCH rejects author_actor_id supplied in the body with 400', async () => {
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author_actor_id: 'service_account' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('AUTHOR_ACTOR_ID_FORBIDDEN');
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  it('PATCH strips the response-only author_unverified alias but keeps author editable', async () => {
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: 'new-label', author_unverified: 'sneaky' }),
      });
      expect(res.status).toBe(200);
      const call = manager.update.mock.calls[0][1] as Record<string, unknown>;
      expect(call.author).toBe('new-label');
      expect('author_unverified' in call).toBe(false);
    });
  });
});

describe('ReportManager author_actor_id persistence', () => {
  function fakePool() {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      connect: jest.fn(async function () {
        const self = this as { query: (t: string, p?: unknown[]) => Promise<unknown> };
        return { query: (t: string, p?: unknown[]) => self.query(t, p), release: () => undefined };
      }),
      query: jest.fn(async (text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> => {
        queries.push({ text, params: params ?? [] });
        if (/INSERT INTO reports/i.test(text)) return { rows: [{ id: RID, project_id: null, author_actor_id: 'service_account' }], rowCount: 1 };
        if (/UPDATE reports SET/i.test(text)) return { rows: [{ project_id: null, author_actor_id: null }], rowCount: 1 };
        if (/FROM reports r/i.test(text)) {
          return {
            rows: [{ id: RID, title: 't', content: 'c', author: 'label', author_actor_id: 'service_account' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('INSERT persists author (unverified) and author_actor_id as separate columns', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).create({
      title: 'T', content: 'C', author: 'label', author_actor_id: 'service_account',
    });
    const insert = pool.queries.find(q => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.text).toContain('author_actor_id');
    expect(insert.params).toEqual(expect.arrayContaining(['label', 'service_account']));
  });

  it('mapped rows expose author, author_unverified alias, and author_actor_id', async () => {
    const pool = fakePool();
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author).toBe('label');
    expect(report!.author_unverified).toBe('label');
    expect(report!.author_actor_id).toBe('service_account');
  });

  it('ReportManager.update has no author_actor_id pathway', async () => {
    const pool = fakePool();
    pool.query.mockImplementation(async (text: string, params?: unknown[]) => {
      pool.queries.push({ text, params: params ?? [] });
      if (/FROM reports r/i.test(text)) return { rows: [{ id: RID, author: 'label' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await new ReportManager(pool as never).update(RID, { author_actor_id: 'evil' } as never);
    const update = pool.queries.find(q => /UPDATE reports SET/i.test(q.text))!;
    // The pinned property is the WRITE pathway: no SET of author_actor_id.
    // The RETURNING clause READS the column for RH-P3.C1 feed metadata,
    // which is disclosure of a value the caller could not change here.
    expect(update.text.split('WHERE')[0]).not.toContain('author_actor_id');
    expect(update.text).not.toMatch(/SET[^]*author_actor_id\s*=/i);
  });
});

/**
 * ── CARD 91599cd2: THE BOARD RENDERED THE UNVERIFIED HALF ────────────────────
 *
 * `author` is a free-form label the caller supplies, recorded unverified, and
 * confirmed spoofable in the same session; when the caller omits it the column
 * defaults to the literal string `system`, so on a fresh install every Report
 * a person filed read "By system". The value the server HAD resolved from the
 * authenticated identity was never rendered anywhere.
 */
describe('the verified attribution', () => {
  /** Every attributed row now carries the canonical author column, because
   * that is the column the read resolves (review `99ba9444` B1). */
  const PRINCIPAL = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  function readerPool(row: Record<string, unknown>) {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      connect: jest.fn(),
      query: jest.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        if (/FROM reports r/i.test(text)) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('renders the DISPLAY NAME of the identity author_actor_id names', async () => {
    const pool = readerPool({
      id: RID, title: 't', content: 'c', author: 'system',
      author_actor_id: 'ada', author_principal_id: PRINCIPAL,
      author_actor_display_name: 'Ada Lovelace',
    });
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBe('Ada Lovelace');
    // The unverified label is still carried, and still says what it said.
    expect(report!.author_unverified).toBe('system');
  });

  it('falls back to the HANDLE when the identity carries no display name', async () => {
    const pool = readerPool({
      id: RID, title: 't', content: 'c', author: 'label',
      author_actor_id: 'ada', author_principal_id: PRINCIPAL,
      author_actor_display_name: null, author_actor_handle: 'ada',
    });
    const report = await new ReportManager(pool as never).getById(RID);
    // Still the verified identity - a handle is a name, and it is the one the
    // server resolved.
    expect(report!.author_actor_name).toBe('ada');
  });

  it('is NULL exactly when there is no verified author, so a surface need decide nothing', async () => {
    const pool = readerPool({ id: RID, title: 't', content: 'c', author: 'nim', author_actor_id: null });
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBeNull();
    expect(report!.author_actor_id).toBeNull();
  });

  it('BOTH read queries join the identity, so the list and the detail agree', async () => {
    // The list card and the detail header render the same field. A join on
    // only one of them would have fixed the page the defect was reported on
    // and left the other reading "system".
    const point = readerPool({ id: RID, title: 't', content: 'c', author_actor_id: 'ada' });
    await new ReportManager(point as never).getById(RID);
    const list = readerPool({ id: RID, title: 't', content: 'c', author_actor_id: 'ada' });
    await new ReportManager(list as never).list({});
    for (const pool of [point, list]) {
      const read = pool.queries.find((q) => /FROM reports r/i.test(q.text) && !/COUNT\(\*\)/i.test(q.text))!;
      // Review `99ba9444` B1: ONE join, on the canonical author column, on
      // both queries. The two arms that used to match the untagged
      // `author_actor_id` are gone — there is no precedence left to state,
      // which is the point: no order of arbitration between two colliding
      // encodings is correct.
      expect(read.text).toContain('LEFT JOIN principals ap ON ap.id = r.author_principal_id');
      expect(read.text).not.toContain('ap.handle = r.author_actor_id');
      expect(read.text).not.toContain('api.id::text = lower(r.author_actor_id)');
      expect(read.text).toContain('AS author_actor_display_name');
      expect(read.text).toContain('AS author_actor_handle');
    }
  });

  it('the unverified label DEFAULTS to the authenticated identity, never to the literal system', async () => {
    const pool = {
      queries: [] as Array<{ text: string; params: unknown[] }>,
      connect: jest.fn(async function () {
        const self = this as { query: (t: string, p?: unknown[]) => Promise<unknown> };
        return { query: (t: string, p?: unknown[]) => self.query(t, p), release: () => undefined };
      }),
      query: jest.fn(async (text: string, params?: unknown[]) => {
        (pool.queries as Array<{ text: string; params: unknown[] }>).push({ text, params: params ?? [] });
        if (/INSERT INTO reports/i.test(text)) return { rows: [{ id: RID, project_id: null, author_actor_id: 'ada' }], rowCount: 1 };
        if (/FROM reports r/i.test(text)) return { rows: [{ id: RID, title: 't', content: 'c' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    await new ReportManager(pool as never).create({
      title: 'T', content: 'C', author_actor_id: 'ada',
    });
    const insert = pool.queries.find((q) => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.params).toContain('ada');
    expect(insert.params).not.toContain('system');
  });
});

/**
 * ── REVIEW 302a338f B1 AND B3: the two writers, and what the reader must
 *    resolve ───────────────────────────────────────────────────────────────
 *
 * `author_actor_id` is documented as the authenticated HANDLE, and the REST
 * writer stores one. `TaskElementService.createReport` - the task-finish and
 * auto-promotion writer - stores the principal UUID instead. A reader that
 * joined on the handle alone resolved nothing for every Report that writer
 * created, and the page then printed the raw UUID as if it were a name.
 *
 * And neither writer recorded `author_principal_id`, which is the column the
 * shared Report predicate reads as OWNER and CREATOR - so the author of a
 * private Report did not own it.
 */
describe('both author_actor_id spellings, and the owner column', () => {
  const UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  function readerPool(row: Record<string, unknown>) {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      connect: jest.fn(),
      query: jest.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        if (/FROM reports r/i.test(text)) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('resolves a UUID-shaped author_actor_id to a NAME, never to the raw id', async () => {
    // What the uuid arm of the join produces for the task-finish writer.
    const pool = readerPool({
      id: RID, title: 't', content: 'c', author: 'ada',
      author_actor_id: UUID, author_principal_id: UUID,
      author_actor_display_name: 'Ada Lovelace', author_actor_handle: 'ada',
    });
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBe('Ada Lovelace');
    expect(report!.author_actor_name).not.toBe(UUID);
  });

  it('falls back to the RESOLVED HANDLE before it falls back to the stored id', async () => {
    const pool = readerPool({
      id: RID, title: 't', content: 'c',
      author_actor_id: UUID, author_principal_id: UUID,
      author_actor_display_name: null, author_actor_handle: 'ada',
    });
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBe('ada');
  });

  it('is UNATTRIBUTED when the canonical author names nobody, never the raw value', async () => {
    // Review `99ba9444` B1 replaced the old "print the stored value" fallback.
    // That value is the untagged provenance string, and printing it as a name
    // is how one principal's id was rendered as another's identity.
    const pool = readerPool({
      id: RID, title: 't', content: 'c',
      author_actor_id: UUID, author_principal_id: UUID,
      author_actor_display_name: null, author_actor_handle: null,
    });
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBe('Unattributed');
    expect(report!.author_actor_name).not.toBe(UUID);
    // The provenance itself is still carried, unchanged.
    expect(report!.author_actor_id).toBe(UUID);
  });

  it('a historical row with provenance and NO canonical author FAILS CLOSED', async () => {
    // The rows migration 063 left NULL. Resolving them out of `author_actor_id`
    // is exactly the guess the repair refuses to make.
    const pool = readerPool({
      id: RID, title: 't', content: 'c',
      author_actor_id: 'ada', author_principal_id: null,
      author_actor_display_name: null, author_actor_handle: null,
    });
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBe('Unattributed');
    expect(report!.author_actor_id).toBe('ada');
  });

  it('create records author_principal_id — the OWNER column the predicate reads', async () => {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      connect: jest.fn(async function () {
        const self = this as { query: (t: string, p?: unknown[]) => Promise<unknown> };
        return { query: (t: string, p?: unknown[]) => self.query(t, p), release: () => undefined };
      }),
      query: jest.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        if (/INSERT INTO reports/i.test(text)) return { rows: [{ id: RID, project_id: null, author_actor_id: 'ada' }], rowCount: 1 };
        if (/FROM reports r/i.test(text)) return { rows: [{ id: RID, title: 't', content: 'c' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    await new ReportManager(pool as never).create({
      title: 'T', content: 'C', author_actor_id: 'ada', author_principal_id: UUID,
    });
    const insert = queries.find((q) => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.text).toContain('author_principal_id');
    expect(insert.params).toContain(UUID);
  });

  it('the task-finish writer records it too, from the acting principal', () => {
    // A source assertion, because that writer runs inside a transaction this
    // suite does not drive. The COORDINATE is the INSERT column list and the
    // parameter it binds; a writer that dropped either would fail here.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'TaskElementService.ts'), 'utf8');
    const insert = source.slice(source.indexOf('INSERT INTO reports ('));
    expect(insert.slice(0, 400)).toContain('author_principal_id');
    expect(insert.slice(0, 900)).toContain('actor.principalId, actor.principalId');
  });

  it('the visibility rows the dashboard counts are the DEFAULT list population', async () => {
    // Review 302a338f: the count read every non-tombstoned Report while the
    // default list also excludes archived ones, so the two could disagree.
    const pool = readerPool({ id: RID });
    await new ReportManager(pool as never).listVisibilityRows();
    const read = pool.queries[0].text;
    expect(read).toContain('deleted_at IS NULL');
    expect(read).toContain("status = 'active'");
  });
});

/**
 * -- REVIEW `99ba9444` B1: NEITHER SPELLING ARBITRATES ------------------------
 *
 * `author_actor_id` is NOT TAGGED WITH ITS ENCODING. The REST writer stores
 * the authenticated HANDLE while also storing the canonical principal UUID in
 * `author_principal_id`; the task-finish writer stores the UUID in both. And
 * `validateNewHandle` admits a UUID-shaped handle - the pattern is
 * `^[a-z0-9][a-z0-9_.-]{1,63}$` and a canonical lowercase UUID satisfies it -
 * so principal A's HANDLE can equal principal B's ID.
 *
 * Let A create a Report through `POST /reports`. The row carries
 * `author_actor_id = A.handle = B.id` and `author_principal_id = A.id`. Both
 * join arms match. Handle-first named A, and got the task-finish direction
 * wrong; id-first named B, and got THIS direction wrong. There is no third
 * order: consistency with another ambiguous resolver is not correctness.
 *
 * So the read no longer touches that column. It resolves
 * `reports.author_principal_id` - the canonical authority column that
 * `AuthorizationRepository.sqlResource('report')` already reads as this
 * Report's owner and creator, written by BOTH current writers - and a row
 * without one is UNATTRIBUTED rather than a guess.
 *
 * WHAT THIS FILE CAN AND CANNOT MEASURE. A mocked pool hands back a row that
 * is ALREADY joined, so it cannot observe which principal PostgreSQL would
 * have chosen - the flaw the round-3 verdict named in the control it replaces.
 * The assertions here are therefore about the QUERY (there is one join, on a
 * primary key, so no arbitration is possible) and about `mapRow`. The
 * two-principal mirror collision itself is measured over a REAL PostgreSQL,
 * through the production router, in `listPointParity.test.ts`.
 */
describe('neither spelling arbitrates: the canonical column decides', () => {
  const COLLIDING = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const A_ID = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  function readerPool(row: Record<string, unknown>) {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      connect: jest.fn(),
      query: jest.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        if (/FROM reports r/i.test(text)) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('the handle validator really admits a UUID-shaped handle (the premise)', () => {
    // The premise is READ from the shipped validator, not asserted about it.
    // If handles were ever narrowed to exclude this shape, this control should
    // be the thing that notices, rather than quietly guarding nothing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { validateNewHandle } = require('../utils/credentialAuthority');
    expect(validateNewHandle(COLLIDING)).toEqual({ ok: true, handle: COLLIDING });
  });

  it('neither read query can match the ambiguous column at all', async () => {
    const seen: string[] = [];
    const pool = {
      connect: jest.fn(),
      query: jest.fn(async (text: string) => {
        seen.push(text);
        return { rows: [{ id: RID, title: 't', content: 'c' }], rowCount: 1 };
      }),
    };
    const manager = new ReportManager(pool as never);
    await manager.getById(RID);
    await manager.list({});
    const reads = seen.filter((text) => /FROM reports r/i.test(text) && !/COUNT\(\*\)/i.test(text));
    expect(reads.length).toBe(2);
    for (const text of reads) {
      expect(text).toContain('LEFT JOIN principals ap ON ap.id = r.author_principal_id');
      // The ambiguity is not re-ordered, it is REMOVED. No arm of either read
      // compares a principal against `author_actor_id` in any spelling.
      expect(text).not.toMatch(/principals\s+\w+\s+ON[^\n]*author_actor_id/i);
      expect(text).not.toContain('lower(r.author_actor_id)');
      expect(text).not.toContain('COALESCE(api.');
      expect(text).not.toContain('COALESCE(ap.');
    }
  });

  it('the mirror row resolves to the principal the canonical column names', async () => {
    // The REST direction: A wrote it, and `author_actor_id` happens to spell
    // B's id. The join fed this row from `author_principal_id = A.id`.
    const pool = readerPool({
      id: RID, title: 't', content: 'c',
      author_actor_id: COLLIDING, author_principal_id: A_ID,
      author_actor_display_name: 'Ada (by canonical column)', author_actor_handle: COLLIDING,
    });
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBe('Ada (by canonical column)');
  });

  it('the feed owner is that same column, so the two consumers cannot disagree', () => {
    // The outside anchor. The whole defect was two consumers of one untagged
    // column disagreeing about a row; the fix is that neither consumer reads
    // it. Read from the shipped source rather than restated here.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'ReportManager.ts'), 'utf8');
    expect(source).toContain('return row?.author_principal_id ?? null;');
    expect(source).not.toContain('this.resolveOwnerPrincipalUuid(client, result.rows[0]?.author_actor_id)');
    const tes = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'TaskElementService.ts'), 'utf8');
    expect(tes).not.toMatch(/resolveOwnerPrincipalUuid\([^)]*author_actor_id/);
  });
});

/**
 * -- ROUND 1 FINDING P1: AN ERASURE HAS TO ERASE THE ATTRIBUTION -------------
 *
 * `TaskElementService.redact(..., {mode: 'author-erasure'})` is root-only and
 * ordered for `personal-data` or `owner-order`. It cleared the stream entry's
 * canonical author, and on an auto-promoted Report it cleared the provenance
 * string and the unverified label — and left `author_principal_id` standing.
 * That was harmless only while nothing read that column. Moving the verified
 * attribution and the feed owner ONTO it made an erased Report render under
 * the erased author's name again, and made the redaction's own feed event
 * announce the identity it had just erased.
 *
 * Two halves, and both are asserted here because either alone leaves the
 * regression reachable:
 *  - the WRITE clears the canonical column, destroys it under the same HMAC
 *    fingerprint, and emits no owner;
 *  - the READ refuses to attribute a row that carries only half the pair,
 *    which is the shape rows erased BEFORE this repair still carry.
 */
describe('author-erasure erases the attribution, at the write and at the read', () => {
  const REPORT = 'c0ffee00-0000-4000-8000-00000000c0fe';
  const ENTRY = 'e0000000-0000-4000-8000-0000000000e1';
  const TASK = 'ta000000-0000-4000-8000-0000000000a1'.replace('ta', 'aa');
  const AUTHOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  /** The transaction client the redaction runs on, recording every statement
   * and answering the four reads it makes. */
  function redactionClient() {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const client = {
      query: jest.fn(async (text: string, params?: unknown[]) => {
        statements.push({ text, params: params ?? [] });
        if (/FROM task_stream_entries WHERE id/i.test(text)) {
          return {
            rows: [{
              id: ENTRY, task_id: TASK, content: 'body', report_id: REPORT, auto_promoted: true,
              author_principal_id: AUTHOR, author_handle: 'ada', author_role: 'user',
              redacted_at: null,
            }],
            rowCount: 1,
          };
        }
        if (/FROM reports WHERE id/i.test(text)) {
          return {
            rows: [{
              id: REPORT, content: 'body', summary: 's', author: 'Ada',
              author_actor_id: 'ada', author_principal_id: AUTHOR, project_id: null,
            }],
            rowCount: 1,
          };
        }
        if (/UPDATE reports SET/i.test(text)) {
          // What PostgreSQL returns is the POST-update row, so the emitted
          // owner is whatever the UPDATE just wrote.
          const principalParam = (params ?? [])[6];
          return { rows: [{ project_id: null, author_principal_id: principalParam ?? null }], rowCount: 1 };
        }
        if (/UPDATE task_stream_entries/i.test(text)) {
          return { rows: [{ id: ENTRY, task_id: TASK }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    return { client, statements };
  }

  const runErasure = async () => {
    process.env.TASK_STREAM_REDACTION_HMAC_KEY = process.env.TASK_STREAM_REDACTION_HMAC_KEY || 'erasure-control-key';
    const { taskElementService } = require('../services/TaskElementService');
    const { client, statements } = redactionClient();
    const pool = { connect: async () => client, query: jest.fn(async () => ({ rows: [] })) };
    (taskElementService as any).pool = pool;
    await taskElementService.redact(
      TASK, ENTRY,
      { mode: 'author-erasure', reason: 'personal-data' },
      { principalId: AUTHOR, root: true } as never,
    );
    return statements;
  };

  it('clears the CANONICAL author column, not only the provenance string', async () => {
    const statements = await runErasure();
    const update = statements.find((s) => /UPDATE reports SET/i.test(s.text))!;
    expect(update.text).toContain('author_principal_id = $7');
    // $6 is author_actor_id, $7 is author_principal_id: both NULL.
    expect(update.params[5]).toBeNull();
    expect(update.params[6]).toBeNull();
    // And the unverified label is the erasure marker, as before.
    expect(update.params[4]).toBe('[erased]');
  });

  it('emits NO owner for the erased Report', async () => {
    const statements = await runErasure();
    const emit = statements.find((s) => /INSERT INTO feed_events/i.test(s.text))!;
    expect(emit.params).not.toContain(AUTHOR);
  });

  it('destroys the canonical author under the SAME fingerprint', async () => {
    // The HMAC fingerprint is the audit record of what an erasure destroyed.
    // A column cleared but not fingerprinted is an erasure that cannot be
    // proven, so the value goes into `destroyed` with the rest.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'TaskElementService.ts'), 'utf8');
    expect(source).toContain('destroyed.push(`${reportActor || \'\'}|${reportAuthor || \'\'}|${row.author_principal_id || \'\'}`);');
  });

  it('a HALF-ERASED row — the shape erased before this repair — is Unattributed', async () => {
    // The read half. Every writer records both columns or neither, so a row
    // with a live canonical author beside a NULL provenance string is not a
    // half-known author: it is a row an erasure has been through.
    const pool = {
      connect: jest.fn(),
      query: jest.fn(async (text: string) => {
        if (/FROM reports r/i.test(text)) {
          return {
            rows: [{
              id: RID, title: 't', content: 'c', author: '[erased]',
              author_actor_id: null, author_principal_id: AUTHOR,
              author_actor_display_name: 'Ada Lovelace', author_actor_handle: 'ada',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author_actor_name).toBe('Unattributed');
    expect(report!.author_actor_name).not.toBe('Ada Lovelace');
  });
});
