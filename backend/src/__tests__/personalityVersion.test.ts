import { PERSONALITY_SNAPSHOT_FIELDS, projectPersonalityVersion } from '../utils/personalityVersion';

const row = {
  id: '00000000-0000-4000-8000-000000000051', slug: 'review-profile', name: 'Review Profile',
  description: null, category: '', color: null, content: '  # Mission\n雪\n${literal}\n',
  source_file: null, is_custom: true, source: 'managed',
  retired_at: null, retired_reason: null, retired_in_favor_of: null,
  created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
};
const snapshot = () => Object.fromEntries(PERSONALITY_SNAPSHOT_FIELDS.map(key => [key, row[key]]));
const versioned = (version = 3) => ({ ...row, current_version: version, resolved_version: version,
  version_parent_id: row.id, version_snapshot: snapshot() });

describe('immutable current Personality projection (schema-independent)', () => {
  test('snapshot field set includes every persisted content/provenance field exactly', () => {
    expect([...PERSONALITY_SNAPSHOT_FIELDS].sort()).toEqual(['category','color','content','description','is_custom','name','slug','source','source_file']);
    expect(Object.isFrozen(PERSONALITY_SNAPSHOT_FIELDS)).toBe(true);
  });
  test('actual immutable numeric version preserves bytes/nulls and strips internal aliases', () => {
    expect(projectPersonalityVersion(versioned(), true)).toEqual({ ...row, version: 3 });
  });
  test.each([undefined, null, 0, -1, 1.5, '3', NaN, Infinity, 2147483648])('does not invent a version for %s', invalid => {
    expect(() => projectPersonalityVersion({ ...versioned(), current_version: invalid, resolved_version: invalid }, true)).toThrow('unavailable or inconsistent');
  });
  test.each([1, 2147483647])('admits actual integer boundary %s', value => {
    expect(projectPersonalityVersion(versioned(value), true).version).toBe(value);
  });
  test('rejects missing snapshot row rather than concealing existing parent as absent', () => {
    expect(() => projectPersonalityVersion({ ...versioned(), resolved_version: null, version_parent_id: null, version_snapshot: null }, true)).toThrow('unavailable');
  });
  test('rejects a different parent snapshot', () => {
    expect(() => projectPersonalityVersion({ ...versioned(), version_parent_id: 'another-parent' }, true)).toThrow('inconsistent');
  });
  test('rejects a stale pointer/snapshot pairing', () => {
    expect(() => projectPersonalityVersion({ ...versioned(), resolved_version: 2 }, true)).toThrow('inconsistent');
  });
  test.each(PERSONALITY_SNAPSHOT_FIELDS)('rejects current/snapshot drift in %s', field => {
    const changed = { ...snapshot(), [field]: field === 'is_custom' ? false : 'changed' };
    expect(() => projectPersonalityVersion({ ...versioned(), version_snapshot: changed }, true)).toThrow('inconsistent');
  });
  test('refuses a missing nullable field instead of treating omission as null', () => {
    const value = snapshot(); delete value.description;
    expect(() => projectPersonalityVersion({ ...versioned(), version_snapshot: value }, true)).toThrow('inconsistent');
  });
  test('refuses unrecognized snapshot fields', () => {
    expect(() => projectPersonalityVersion({ ...versioned(), version_snapshot: { ...snapshot(), extra: 'x' } }, true)).toThrow('inconsistent');
  });
  test('summary projects version identity without requiring/loading content', () => {
    expect(projectPersonalityVersion({ id: row.id, name: row.name, current_version: 3, resolved_version: 3, version_parent_id: row.id }, false))
      .toEqual({ id: row.id, name: row.name, version: 3 });
  });
  test('retirement metadata does not rewrite the immutable snapshot', () => {
    const value = { ...versioned(), retired_at: '2026-09-07T00:00:00Z', retired_reason: 'consolidated' };
    expect(projectPersonalityVersion(value, true)).toMatchObject({ version: 3, retired_reason: 'consolidated', content: row.content });
  });
});

const mockClientQuery = jest.fn();
const mockPoolQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };
const events: string[] = [];
let mockCurrentVersion = 3;
jest.mock('../db/connection', () => ({ pool: { query: (...args: any[]) => mockPoolQuery(...args), connect: async () => mockClient } }));
jest.mock('../services/FeedEventService', () => ({ feedEventService: { emit: jest.fn() } }));
import { personalityService } from '../services/PersonalityService';
import { feedEventService } from '../services/FeedEventService';
const emit = feedEventService.emit as jest.Mock;

beforeEach(() => {
  events.length = 0; mockCurrentVersion = 3; jest.clearAllMocks(); mockClientQuery.mockReset(); mockPoolQuery.mockReset(); emit.mockReset();
  mockClientQuery.mockImplementation(async (sql: string) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) { events.push(text); return { rows: [] }; }
    if (text.startsWith('SELECT')) { events.push('version-read'); return { rows: [versioned(mockCurrentVersion)] }; }
    if (text.startsWith('INSERT')) mockCurrentVersion = 1;
    events.push('write'); return { rows: [{ id: row.id }] };
  });
  emit.mockImplementation(async (client: unknown) => { expect(client).toBe(mockClient); events.push('feed'); });
});

describe('Personality writer current-version transaction boundary (mocked DB)', () => {
  test.each(['create', 'update'] as const)('%s checks immutable projection before same-client feed and COMMIT', async act => {
    const result = act === 'create' ? await personalityService.create({ slug: row.slug, name: row.name })
      : await personalityService.update(row.id, { content: row.content });
    expect(result).toEqual({ ...row, version: act === 'create' ? 1 : 3 });
    expect(events).toEqual(['BEGIN','write','version-read','feed','COMMIT']);
    expect(mockPoolQuery).not.toHaveBeenCalled(); expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].payload).toEqual({});
  });
  test('create refuses a valid but non-initial version and rolls back', async () => {
    const ordinary = mockClientQuery.getMockImplementation()!;
    mockClientQuery.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.trim().startsWith('SELECT')) { events.push('version-read'); return {rows:[versioned(3)]}; }
      return ordinary(sql, values);
    });
    await expect(personalityService.create({slug:row.slug,name:row.name})).rejects.toThrow('initial immutable version');
    expect(events).toEqual(['BEGIN','write','version-read','ROLLBACK']); expect(emit).not.toHaveBeenCalled();
  });
  test('create schema/invariant refusal rolls back and emits no feed', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      const text=sql.trim(); events.push(text.startsWith('SELECT')?'version-read':text.startsWith('INSERT')?'write':text);
      return { rows: text.startsWith('INSERT') ? [{id:row.id}] : text.startsWith('SELECT') ? [{...row}] : [] };
    });
    await expect(personalityService.create({slug:row.slug,name:row.name})).rejects.toThrow('unavailable');
    expect(events).toEqual(['BEGIN','write','version-read','ROLLBACK']); expect(emit).not.toHaveBeenCalled();
  });
  test('feed failure rolls back after version read; no commit escapes', async () => {
    emit.mockImplementation(async () => { events.push('feed'); throw new Error('injected feed failure'); });
    await expect(personalityService.update(row.id,{name:row.name})).rejects.toThrow('injected feed failure');
    expect(events).toEqual(['BEGIN','write','version-read','feed','ROLLBACK']); expect(mockRelease).toHaveBeenCalledTimes(1);
  });
  test.each(['create','update'] as const)('%s absence/conflict leaves no snapshot read or feed', async act => {
    mockClientQuery.mockImplementation(async (sql: string) => { events.push(sql.trim().startsWith('INSERT')||sql.trim().startsWith('UPDATE')?'write':sql.trim()); return { rows:[] }; });
    const result=act==='create'?await personalityService.create({slug:row.slug,name:row.name}):await personalityService.update(row.id,{name:row.name});
    expect(result).toBeNull(); expect(events).toEqual(['BEGIN','write','COMMIT']); expect(emit).not.toHaveBeenCalled();
  });
  test('read by UUID or slug returns actual current version without a write', async () => {
    mockPoolQuery.mockResolvedValue({rows:[versioned(4)]});
    expect((await personalityService.getById(row.id))?.version).toBe(4);
    expect((await personalityService.getBySlug(row.slug))?.version).toBe(4);
    expect(mockPoolQuery.mock.calls.map(call=>call[1])).toEqual([[row.id],[row.slug]]);
    expect(mockClientQuery).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  });
  test('list SQL excludes content and still rejects missing current version', async () => {
    mockPoolQuery.mockResolvedValue({rows:[{id:row.id,name:row.name,current_version:3,resolved_version:3,version_parent_id:row.id}]});
    expect(await personalityService.list()).toEqual([{id:row.id,name:row.name,version:3}]);
    const sql=mockPoolQuery.mock.calls[0][0];expect(sql).not.toMatch(/snapshot|p\.content|p\.\*/);expect(sql).toContain('p.retired_at IS NULL');
    mockPoolQuery.mockResolvedValue({rows:[{id:row.id,name:row.name}]});
    await expect(personalityService.list()).rejects.toThrow('unavailable');
  });
  test('no-field update performs only the current read', async () => {
    mockPoolQuery.mockResolvedValue({rows:[versioned()]}); expect((await personalityService.update(row.id,{}))?.version).toBe(3);
    expect(mockClientQuery).not.toHaveBeenCalled();expect(emit).not.toHaveBeenCalled();
  });
});