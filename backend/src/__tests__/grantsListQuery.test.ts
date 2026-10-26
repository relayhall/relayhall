/**
 * grantsListQuery.test.ts — card ff410dc4 (owner ruling E407 item 1).
 *
 * The parser and the statement builder of the paged grants list, without a
 * database: every parameter is additive (none of them = the legacy unbounded
 * read in creation order), a malformed value is refused by name, a cursor is
 * bound to the sort it was issued for, and every filter is a WHERE term of the
 * ONE statement, ahead of its LIMIT. The real-PostgreSQL behaviour is
 * `grantsListLive.test.ts` (npm run test:grants-list).
 */
import {
  buildGrantPageStatement, decodeGrantCursor, encodeGrantCursor, parseGrantListQuery,
  GRANT_PAGE_DEFAULT_LIMIT, GRANT_PAGE_MAX_LIMIT,
  GRANT_CURSOR_MAX_LENGTH, GRANT_SORT_KEY_MAX_CHARS, GRANT_TIMESTAMP_KEY_MAX_CHARS,
} from '../services/GrantListService';

const UUID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

/** The error a call throws (fails when it throws nothing). */
function refusal(act: () => unknown): Record<string, unknown> {
  try { act(); } catch (e) { return e as Record<string, unknown>; }
  throw new Error('expected a refusal');
}

describe('parseGrantListQuery', () => {
  it('with no parameter is the legacy unbounded read in creation order', () => {
    expect(parseGrantListQuery({})).toMatchObject({ limit: null, sort: 'created', made: 'all', expiry: 'any', target: 'any' });
  });
  it('a limit or a cursor makes it a page, newest first by default', () => {
    expect(parseGrantListQuery({ limit: '25' })).toMatchObject({ limit: 25, sort: '-created' });
    const cursor = encodeGrantCursor('-created', '2026-10-20 10:00:00.123456+00', UUID);
    expect(parseGrantListQuery({ cursor })).toMatchObject({ limit: GRANT_PAGE_DEFAULT_LIMIT, sort: '-created', cursor });
  });
  it.each([
    ['limit', '0'], ['limit', String(GRANT_PAGE_MAX_LIMIT + 1)], ['limit', '1.5'], ['limit', '-1'],
    ['made', 'person'], ['sort', 'title'], ['expiry', 'soon'], ['target', 'gone'], ['verb', 'own'],
    ['resourceType', 'widget'], ['granteeId', 'abc'], ['q', 'x'.repeat(201)], ['cursor', 'gc1.bm9wZQ'], ['cursor', 'nope'],
  ])('refuses %s=%s by name', (key, value) => {
    expect(refusal(() => parseGrantListQuery({ [key]: value }))).toMatchObject({ status: 400, code: 'INVALID_QUERY_VALUE', field: key });
  });
  it('accepts every documented value', () => {
    for (const made of ['hand', 'system', 'unknown', 'all']) expect(parseGrantListQuery({ made }).made).toBe(made);
    for (const expiry of ['any', 'none', 'live', 'expired', 'expiring']) expect(parseGrantListQuery({ expiry }).expiry).toBe(expiry);
    for (const target of ['any', 'live', 'archived', 'missing', 'wildcard']) expect(parseGrantListQuery({ target }).target).toBe(target);
    for (const sort of ['-created', 'created', 'grantee', '-grantee', 'resource', '-resource', 'verb', '-verb', 'expires', '-expires']) {
      expect(parseGrantListQuery({ sort, limit: '5' }).sort).toBe(sort);
    }
  });
  it('a blank search is no search', () => {
    expect(parseGrantListQuery({ q: '   ' }).q).toBeUndefined();
  });
});

describe('cursors', () => {
  it('round-trip the sort key and id', () => {
    const cursor = encodeGrantCursor('grantee', 'ada', UUID);
    expect(decodeGrantCursor(cursor, 'grantee')).toEqual({ key: 'ada', id: UUID });
  });
  it('are bound to the sort they were issued for', () => {
    const cursor = encodeGrantCursor('grantee', 'ada', UUID);
    expect(refusal(() => decodeGrantCursor(cursor, '-created'))).toMatchObject({ code: 'INVALID_QUERY_VALUE' });
    expect(refusal(() => parseGrantListQuery({ cursor, sort: 'verb' }))).toMatchObject({ field: 'cursor' });
  });
});

// Round-1 review of card ff410dc4: a 500-character Task title gave a
// 750-character cursor that the decoder's fixed 600-character cap refused, so
// Load more stopped under sort=resource. The class: the cap must come from the
// largest key the server can ISSUE, per sort, never from a guessed constant.
describe('cursor size: every cursor the server can issue is accepted, and nothing larger', () => {
  const TEXT_SORTS = ['grantee', '-grantee', 'resource', '-resource', 'verb', '-verb'] as const;
  const TIME_SORTS = ['created', '-created', 'expires', '-expires'] as const;
  const at = (unit: string, n: number) => {
    const out: string[] = [];
    while (out.length < n) out.push(...Array.from(unit));
    return out.slice(0, n).join('');
  };
  // The widest keys per character the database can hold: a control character
  // is a six-byte JSON escape, an astral character four UTF-8 bytes (two
  // UTF-16 units but ONE character, as PostgreSQL's left() counts it), a CJK
  // character three, and a quote or backslash a two-byte escape.
  const widest: Record<string, string> = {
    control: at('\u0001', GRANT_SORT_KEY_MAX_CHARS),
    astral: at('\u{1F600}', GRANT_SORT_KEY_MAX_CHARS),
    cjk: at('東', GRANT_SORT_KEY_MAX_CHARS),
    mixed: at('ż東\u{1F600}"\\\u0007a', GRANT_SORT_KEY_MAX_CHARS),
  };

  it.each(TEXT_SORTS)('%s: the widest key at the bound fits and round-trips through the parser', (sort) => {
    for (const [name, key] of Object.entries(widest)) {
      expect([name, Array.from(key).length]).toEqual([name, GRANT_SORT_KEY_MAX_CHARS]);
      const cursor = encodeGrantCursor(sort, key, UUID);
      expect([name, cursor.length <= GRANT_CURSOR_MAX_LENGTH]).toEqual([name, true]);
      expect(decodeGrantCursor(cursor, sort)).toEqual({ key, id: UUID });
      expect(parseGrantListQuery({ sort, cursor }).cursor).toBe(cursor);
    }
  });

  it('the round-1 case: a 500-character multibyte title under both resource sorts is a cursor the list accepts', () => {
    const key = `task:${at('Zażółć gęślą jaźń 東京 ', 500)}`;
    for (const sort of ['resource', '-resource'] as const) {
      const cursor = encodeGrantCursor(sort, key, UUID);
      expect(cursor.length).toBeGreaterThan(600);
      expect(decodeGrantCursor(cursor, sort).key).toBe(key);
    }
  });

  it.each(TEXT_SORTS)('%s: a key one character past the bound is refused by name', (sort) => {
    const cursor = encodeGrantCursor(sort, 'a'.repeat(GRANT_SORT_KEY_MAX_CHARS + 1), UUID);
    expect(cursor.length).toBeLessThanOrEqual(GRANT_CURSOR_MAX_LENGTH);
    expect(refusal(() => decodeGrantCursor(cursor, sort))).toMatchObject({ status: 400, code: 'INVALID_QUERY_VALUE', field: 'cursor' });
    expect(refusal(() => parseGrantListQuery({ sort, cursor }))).toMatchObject({ field: 'cursor' });
  });

  it.each(TIME_SORTS)('%s: every timestamp key the database writes fits; a longer one is refused by name', (sort) => {
    for (const key of ['2026-10-20 10:00:00.123456+00', '2026-10-20 10:00:00+05:30', 'infinity', '294276-12-31 23:59:59.999999+00']) {
      expect(decodeGrantCursor(encodeGrantCursor(sort, key, UUID), sort).key).toBe(key);
    }
    const cursor = encodeGrantCursor(sort, '1'.repeat(GRANT_TIMESTAMP_KEY_MAX_CHARS + 1), UUID);
    expect(refusal(() => decodeGrantCursor(cursor, sort))).toMatchObject({ status: 400, code: 'INVALID_QUERY_VALUE', field: 'cursor' });
  });

  it('a cursor longer than the longest the server can issue is refused before it is decoded', () => {
    const cursor = `gc1.${'A'.repeat(GRANT_CURSOR_MAX_LENGTH - 3)}`;
    expect(cursor.length).toBe(GRANT_CURSOR_MAX_LENGTH + 1);
    expect(refusal(() => decodeGrantCursor(cursor, 'resource'))).toMatchObject({ status: 400, code: 'INVALID_QUERY_VALUE', field: 'cursor' });
  });

  it('the cap is the widest issued cursor plus the envelope, not a guess', () => {
    // The widest issuable cursor: the longest sort name, a control-character
    // key at the bound, and an id. The cap must hold it with room for the
    // envelope, and must not be more than one envelope larger than it.
    const widestCursor = encodeGrantCursor('-resource', widest.control, UUID).length;
    expect(widestCursor).toBeLessThanOrEqual(GRANT_CURSOR_MAX_LENGTH);
    expect(GRANT_CURSOR_MAX_LENGTH - widestCursor).toBeLessThan(Math.ceil(128 / 3) * 4 + 4);
  });

  it.each(TEXT_SORTS)('%s: the statement cuts its text key to the bound in ORDER BY, the keyset term and the issued key', (sort) => {
    const cut = `left(`;
    const { sql } = buildGrantPageStatement(parseGrantListQuery({ sort, cursor: encodeGrantCursor(sort, 'k', UUID) }));
    const bound = `, ${GRANT_SORT_KEY_MAX_CHARS})`;
    // The page's own ORDER BY is the statement's last (the audit lookups have theirs).
    const order = sql.slice(sql.lastIndexOf('ORDER BY'));
    expect(order.startsWith(`ORDER BY ${cut}`)).toBe(true);
    expect(order).toContain(`${bound} ${sort.startsWith('-') ? 'DESC' : 'ASC'}, c.id`);
    expect(sql).toMatch(new RegExp(`SELECT c\\.\\*, \\(left\\(.*, ${GRANT_SORT_KEY_MAX_CHARS}\\)\\)::text AS sort_key`));
    expect(sql).toMatch(new RegExp(`WHERE \\(left\\(.*, ${GRANT_SORT_KEY_MAX_CHARS}\\), c\\.id\\) [<>] \\(\\$1::text, \\$2::uuid\\)`));
  });
});

describe('buildGrantPageStatement', () => {
  it('puts every filter in the WHERE clause of the one statement, before the LIMIT', () => {
    const { sql, params } = buildGrantPageStatement(parseGrantListQuery({
      limit: '10', made: 'hand', granteeId: UUID, resourceType: 'task', verb: 'write', expiry: 'expiring', target: 'archived', q: 'a%b_c',
    }));
    const where = sql.indexOf('WHERE c.made_class');
    expect(where).toBeGreaterThan(0);
    expect(sql.indexOf('LIMIT', where)).toBeGreaterThan(where);
    for (const term of ['c.made_class =', 'c.grantee_id =', 'c.resource_type =', 'c.verb =', 'c.expires_at > NOW()', 'c.target_state =', 'LIKE']) {
      expect(sql.slice(where)).toContain(term);
    }
    // LIKE metacharacters in the search are escaped, so `%` and `_` match literally.
    expect(params).toContain('%a\\%b\\_c%');
    // One row past the page answers hasMore without a second read.
    expect(params[params.length - 1]).toBe(11);
  });
  it('the keyset term follows the sort direction and the id breaks ties', () => {
    const desc = buildGrantPageStatement(parseGrantListQuery({ cursor: encodeGrantCursor('-created', 'k', UUID) }));
    expect(desc.sql).toMatch(/\(c\.created_at, c\.id\) < \(\$1::timestamptz, \$2::uuid\)/);
    expect(desc.sql).toMatch(/ORDER BY c\.created_at DESC, c\.id DESC/);
    const asc = buildGrantPageStatement(parseGrantListQuery({ cursor: encodeGrantCursor('grantee', 'k', UUID), sort: 'grantee' }));
    expect(asc.sql).toMatch(/c\.id\) > \(\$1::text, \$2::uuid\)/);
    expect(asc.sql).toMatch(/c\.id ASC/);
  });
  it('the legacy read has no LIMIT', () => {
    expect(buildGrantPageStatement(parseGrantListQuery({})).sql).not.toMatch(/LIMIT \$/);
  });
  it('classifies origin from the grants columns and the audit ledger only', () => {
    const { sql } = buildGrantPageStatement(parseGrantListQuery({}));
    for (const marker of ['g.provenance', "g.origin <> 'manual'", 'g.approval_id', "'task.creator_access'", "'task.sponsor_access'",
      "'report.creator_access'", "'report.sponsor_access'", "'project.creator_access'", "a.action = 'grant.create'",
      "(a.metadata->'automatic') = 'true'::jsonb", "a.metadata->>'grantId' = g.id::text", "ELSE 'unknown'"]) {
      expect(sql).toContain(marker);
    }
  });
});
