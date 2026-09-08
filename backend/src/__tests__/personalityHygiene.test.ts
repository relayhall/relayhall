// personalityHygiene.test.ts — task c8f4dd95 (personality registry hygiene)
//
// Covers:
//   * SAFE RETIRE: retireDuplicate() repoints every task AND session that
//     references the loser to the canonical winner — across ALL statuses,
//     including archived — then soft-deletes the loser (retired_at set, row
//     preserved). Idempotent when loser is absent / already retired.
//   * DOCTOR no longer errors on names: list() excludes retired rows, so the
//     duplicate-personality-name check (re-implemented here over the live listing)
//     finds one live personality per name.
//
// The repository-sync provenance tests that used to live here were removed with
// the sync surface itself (2026-08-09 owner ruling: board-native personalities
// only) — personalitySyncRemoval.test.ts pins the absence structurally.
//
// Uses an in-memory SQL-dispatching mock of the pg pool, matching the pattern in
// dependencyIntegrity.test.ts. No real database is touched.

// ---- in-memory store ------------------------------------------------------
interface ATRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  content: string | null;
  source_file: string | null;
  is_custom: boolean;
  source: string;
  retired_at: string | null;
  retired_reason: string | null;
  retired_in_favor_of: string | null;
}
interface RefRow { id: string; personality_id: string | null; status: string }

let personalities: ATRow[] = [];
let tasks: RefRow[] = [];
let sessions: RefRow[] = [];
let idSeq = 0;

function newRow(partial: Partial<ATRow>): ATRow {
  return {
    id: `id-${++idSeq}`,
    slug: '',
    name: '',
    description: null,
    category: null,
    color: null,
    content: null,
    source_file: null,
    is_custom: false,
    source: 'legacy-db',
    retired_at: null,
    retired_reason: null,
    retired_in_favor_of: null,
    ...partial,
  };
}

// ---- SQL dispatcher -------------------------------------------------------
function dispatch(sql: any, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
  const text = (typeof sql === 'string' ? sql : sql?.text || '').trim();
  const ok = (rows: any[] = []) => Promise.resolve({ rows, rowCount: rows.length });

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return ok();

  // list()  — SELECT ... FROM personalities [WHERE ...] ORDER BY category, name
  if (text.startsWith('SELECT p.id, p.slug, p.name, p.description, p.category, p.color, p.is_custom, p.source, p.retired_at,')) {
    let rows = personalities.slice();
    if (/retired_at IS NULL/.test(text)) rows = rows.filter(r => r.retired_at === null);
    // optional category filter is the last positional param
    if (/category = \$/.test(text)) {
      const cat = params[params.length - 1];
      rows = rows.filter(r => r.category === cat);
    }
    return ok(rows.map(r => ({
      id: r.id, slug: r.slug, name: r.name, description: r.description,
      category: r.category, color: r.color, is_custom: r.is_custom,
      source: r.source, retired_at: r.retired_at,
      current_version: 1, resolved_version: 1, version_parent_id: r.id,
    })));
  }

  // retireDuplicate lookups
  if (text.startsWith('SELECT id, retired_at FROM personalities WHERE slug')) {
    const r = personalities.find(a => a.slug === params[0]);
    return ok(r ? [{ id: r.id, retired_at: r.retired_at }] : []);
  }
  if (text.startsWith('SELECT id FROM personalities WHERE slug')) {
    const r = personalities.find(a => a.slug === params[0]);
    return ok(r ? [{ id: r.id }] : []);
  }

  // repoints
  if (text.startsWith('UPDATE tasks SET personality_id')) {
    const [winnerId, loserId] = params;
    let n = 0;
    for (const t of tasks) if (t.personality_id === loserId) { t.personality_id = winnerId; n++; }
    return Promise.resolve({ rows: [], rowCount: n });
  }
  if (text.startsWith('UPDATE sessions SET personality_id')) {
    const [winnerId, loserId] = params;
    let n = 0;
    for (const s of sessions) if (s.personality_id === loserId) { s.personality_id = winnerId; n++; }
    return Promise.resolve({ rows: [], rowCount: n });
  }

  // soft-delete
  if (text.startsWith('UPDATE personalities')) {
    const [loserId, reason, winnerId] = params;
    const r = personalities.find(a => a.id === loserId);
    if (r) { r.retired_at = '2026-07-04T00:00:00.000Z'; r.retired_reason = reason; r.retired_in_favor_of = winnerId; }
    return Promise.resolve({ rows: [], rowCount: r ? 1 : 0 });
  }

  if (text.startsWith('SELECT DISTINCT category')) {
    const cats = Array.from(new Set(personalities.filter(r => r.retired_at === null && r.category).map(r => r.category)));
    return ok(cats.map(c => ({ category: c })));
  }

  // RH-P3.C1 feed emission rides the retire transaction.
  if (/pg_advisory_xact_lock/i.test(text)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/INSERT INTO feed_events/i.test(text)) return Promise.resolve({ rows: [], rowCount: 1 });
  throw new Error('unhandled SQL in test: ' + text.slice(0, 80));
}

const mockClient = { query: (s: any, p?: any[]) => dispatch(s, p), release: jest.fn() };
jest.mock('../db/connection', () => ({
  pool: {
    query: (s: any, p?: any[]) => dispatch(s, p),
    connect: jest.fn(() => Promise.resolve(mockClient)),
  },
}));

import { personalityService } from '../services/PersonalityService';

/** Re-implementation of relayhall doctor's duplicate-personality-name check. */
function duplicateNameErrors(rows: Array<{ name: string }>): string[] {
  const byName = new Map<string, number>();
  for (const r of rows) {
    const k = (r.name || '').trim().toLowerCase();
    if (k) byName.set(k, (byName.get(k) || 0) + 1);
  }
  return [...byName.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

beforeEach(() => {
  personalities = [];
  tasks = [];
  sessions = [];
  idSeq = 0;
});

describe('safe retire of duplicate personalities', () => {
  function seedDuplicates() {
    const winnerW = newRow({ slug: 'engineering-openclaw-plugin-dev', name: 'OpenClaw Plugin Developer', category: 'engineering', source: 'git' });
    const loserW = newRow({ slug: 'openclaw-plugin-dev', name: 'OpenClaw Plugin Developer', category: 'engineering', source: 'legacy-db' });
    const winnerT = newRow({ slug: 'engineering-technical-writer', name: 'Technical Writer', category: 'engineering', source: 'git' });
    const loserT = newRow({ slug: 'support-technical-writer', name: 'Technical Writer', category: 'support', source: 'git' });
    personalities.push(winnerW, loserW, winnerT, loserT);
    // Loser refs across statuses: archived task on openclaw loser, live todo + a session on TW loser.
    tasks.push({ id: 'task-archived', personality_id: loserW.id, status: 'archived' });
    tasks.push({ id: 'task-todo', personality_id: loserT.id, status: 'todo' });
    sessions.push({ id: 'sess-1', personality_id: loserT.id, status: 'ended' });
    return { winnerW, loserW, winnerT, loserT };
  }

  test('repoints task+session refs (incl. archived) and soft-deletes loser', async () => {
    const { winnerW, loserW, winnerT, loserT } = seedDuplicates();

    const r1 = await personalityService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev');
    expect(r1).toMatchObject({ tasksRepointed: 1, sessionsRepointed: 0 });
    const r2 = await personalityService.retireDuplicate('support-technical-writer', 'engineering-technical-writer');
    expect(r2).toMatchObject({ tasksRepointed: 1, sessionsRepointed: 1 });

    // Archived task now points at the winner (no personality lost).
    expect(tasks.find(t => t.id === 'task-archived')!.personality_id).toBe(winnerW.id);
    expect(tasks.find(t => t.id === 'task-todo')!.personality_id).toBe(winnerT.id);
    expect(sessions.find(s => s.id === 'sess-1')!.personality_id).toBe(winnerT.id);

    // Losers soft-deleted, rows preserved and annotated; winners untouched.
    expect(loserW.retired_at).not.toBeNull();
    expect(loserW.retired_in_favor_of).toBe(winnerW.id);
    expect(loserT.retired_at).not.toBeNull();
    expect(loserT.retired_in_favor_of).toBe(winnerT.id);
    expect(winnerW.retired_at).toBeNull();
    expect(winnerT.retired_at).toBeNull();
    // No hard delete.
    expect(personalities.filter(r => r.retired_at !== null).length).toBe(2);
  });

  test('retireDuplicate is idempotent / safe when absent or already retired', async () => {
    seedDuplicates();
    await personalityService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev');
    // second call is a no-op (already retired)
    expect(await personalityService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev')).toBeNull();
    // unknown loser
    expect(await personalityService.retireDuplicate('does-not-exist', 'engineering-technical-writer')).toBeNull();
    // missing winner
    expect(await personalityService.retireDuplicate('support-technical-writer', 'no-such-winner')).toBeNull();
  });

  test('doctor duplicate-name check has zero errors after retire (list excludes retired)', async () => {
    seedDuplicates();

    const before = await personalityService.list();
    expect(duplicateNameErrors(before).sort()).toEqual(['openclaw plugin developer', 'technical writer']);

    await personalityService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev');
    await personalityService.retireDuplicate('support-technical-writer', 'engineering-technical-writer');

    const after = await personalityService.list();
    expect(duplicateNameErrors(after)).toEqual([]);
    // Retired rows still resolvable via includeRetired for historical display.
    const withRetired = await personalityService.list(undefined, true);
    expect(withRetired.length).toBe(before.length);
    expect(after.length).toBe(before.length - 2);
  });
});
