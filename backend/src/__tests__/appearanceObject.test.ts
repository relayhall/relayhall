import { readFileSync } from 'fs';
import { join } from 'path';

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    connect: async () => ({ query: (...args: any[]) => mockClientQuery(...args), release: mockRelease }),
  },
}));

import {
  AppearanceService,
  AppearanceValidationError,
  contrastRatio,
  parseAppearanceOverrides,
} from '../services/AppearanceService';
import { requiredScopeFor } from '../utils/scopeMap';

const ROW = {
  display_name: 'A Hall',
  login_title: null,
  login_subtitle: null,
  default_theme: 'relay-light',
  accent_color: null,
  description: null,
  links: [],
  team_markdown: null,
  updated_at: '2026-08-12T12:00:00.000Z',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockRelease.mockReset();
});

describe('Appearance parser', () => {
  it('canonicalizes inputs and keeps the theme enum closed', () => {
    expect(parseAppearanceOverrides({
      displayName: '  A Hall  ',
      defaultTheme: 'relay-light',
      accentColor: '#36c',
      links: [{ label: 'Docs', url: 'https://example.test/docs' }],
    })).toMatchObject({
      displayName: 'A Hall',
      defaultTheme: 'relay-light',
      accentColor: '#3366cc',
      links: [{ kind: 'custom', label: 'Docs', url: 'https://example.test/docs' }],
    });
    expect(() => parseAppearanceOverrides({ defaultTheme: 'system' }))
      .toThrow(AppearanceValidationError);
  });

  it('rejects unknown fields and non-http links', () => {
    expect(() => parseAppearanceOverrides({ primaryColor: '#ffffff' }))
      .toThrow(/Unknown appearance field/);
    expect(() => parseAppearanceOverrides({ links: [{ label: 'x', url: 'javascript:alert(1)' }] }))
      .toThrow(/http\(s\)/);
    expect(() => parseAppearanceOverrides({ links: [{ kind: 'billing', label: 'x', url: 'https://example.test' }] }))
      .toThrow(/kind must be one of/);
  });

  it('keeps link kinds closed and maps legacy missing kinds to custom', () => {
    expect(parseAppearanceOverrides({
      links: [
        { kind: 'support', label: 'Support', url: 'https://support.example.test' },
        { label: 'Legacy', url: 'https://legacy.example.test' },
      ],
    }).links).toEqual([
      { kind: 'support', label: 'Support', url: 'https://support.example.test/' },
      { kind: 'custom', label: 'Legacy', url: 'https://legacy.example.test/' },
    ]);
  });

  it('reports and enforces 3:1 accent contrast on both theme surfaces', () => {
    expect(contrastRatio('#ffffff', '#f7f9fb')).toBeLessThan(3);
    expect(() => parseAppearanceOverrides({ accentColor: '#ffffff' }))
      .toThrow(/3\.00:1 is required/);
    expect(parseAppearanceOverrides({ accentColor: '#0066ff' }).accentColor).toBe('#0066ff');
  });

  it('enforces the 68b1e12f floor: an accent with no 4.5:1 label ink is rejected', () => {
    // #797979 clears 3:1 on both surfaces but sits in the ink dead band:
    // neither white nor slate-900 label ink reaches 4.5:1 on it.
    expect(contrastRatio('#797979', '#ffffff')).toBeLessThan(4.5);
    expect(contrastRatio('#797979', '#0f1216')).toBeLessThan(4.5);
    expect(() => parseAppearanceOverrides({ accentColor: '#797979' }))
      .toThrow(/no 4\.50:1 label ink/);
    // A dark accent keeps its white ink and passes the floor.
    expect(parseAppearanceOverrides({ accentColor: '#0066ff' }).accentColor).toBe('#0066ff');
  });
});

describe('Appearance service', () => {
  it('imports the legacy display name once and never overwrites an existing row', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM appearances/i.test(sql)) return { rows: [] };
      if (/INSERT INTO appearance_versions/i.test(sql)) return { rows: [{
        id: 'import-version', version_no: 1, snapshot: { displayName: 'Legacy Hall' },
        asset_refs: {}, reason: 'save', created_at: '', created_by: null,
      }] };
      return { rows: [] };
    });
    await expect(new AppearanceService().importLegacyDisplayName('Legacy Hall')).resolves.toBe(true);
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO appearances/i.test(sql))).toBe(true);

    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) =>
      /SELECT id FROM appearances/i.test(sql) ? { rows: [{ id: 'existing' }] } : { rows: [] });
    await expect(new AppearanceService().importLegacyDisplayName('Ignored')).resolves.toBe(false);
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO appearances/i.test(sql))).toBe(false);
  });

  it('falls back field-by-field and publishes active asset references only', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [ROW] })
      .mockResolvedValueOnce({ rows: [{
        id: 'asset-1', kind: 'logo', bytes: Buffer.from([1]), mime: 'image/png',
        width: 1, height: 1, byte_size: 1, sha256: 'a'.repeat(64), active: true,
        uploaded_by: null, created_at: '2026-08-12T12:00:00.000Z',
      }] });
    const result = await new AppearanceService().get();
    expect(result.effective.displayName).toBe('A Hall');
    expect(result.effective.loginTitle).toBe('Welcome to RelayHall');
    expect(result.assets.logo?.url).toContain('/logo/' + 'a'.repeat(64));
    expect(result.assets.logo).not.toHaveProperty('bytes');
  });

  it('saves object and version in one transaction', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/INSERT INTO appearance_versions/i.test(sql)) return { rows: [{
        id: 'version-1', version_no: 1, snapshot: {}, asset_refs: {}, reason: 'save',
        created_at: '2026-08-12T12:00:00.000Z', created_by: null,
      }] };
      return { rows: [] };
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [ROW] })
      .mockResolvedValueOnce({ rows: [] });
    await new AppearanceService().save({ displayName: 'A Hall' }, null);
    const statements = mockClientQuery.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements[0]).toBe('BEGIN');
    expect(statements.some((sql) => /INSERT INTO appearances/i.test(sql))).toBe(true);
    expect(statements.some((sql) => /INSERT INTO appearance_versions/i.test(sql))).toBe(true);
    expect(statements[statements.length - 1]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('revert appends instead of mutating history and restores exact asset refs', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM appearance_versions/i.test(sql)) return { rows: [{
        id: 'old', version_no: 3, snapshot: { displayName: 'Old' },
        asset_refs: { logo: 'asset-old' }, reason: 'save', created_at: '', created_by: null,
      }] };
      if (/UPDATE appearance_assets SET active = TRUE/i.test(sql)) return { rows: [{ id: 'asset-old' }] };
      if (/INSERT INTO appearance_versions/i.test(sql)) return { rows: [{
        id: 'new', version_no: 4, snapshot: { displayName: 'Old' },
        asset_refs: { logo: 'asset-old' }, reason: 'revert', created_at: '', created_by: null,
      }] };
      return { rows: [] };
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await new AppearanceService().revert(3, null);
    expect(result.version).toMatchObject({ versionNo: 4, reason: 'revert' });
    expect(mockClientQuery.mock.calls.some(([sql]) => /DELETE FROM appearance_versions/i.test(sql))).toBe(false);
    expect(mockClientQuery.mock.calls).toContainEqual(expect.arrayContaining([
      expect.stringMatching(/active = TRUE/), ['asset-old', 'logo'],
    ]));
  });
});

describe('Appearance scope boundary', () => {
  it('allows authenticated object/info reads and keeps every other route root-only', () => {
    expect(requiredScopeFor('GET', '/appearance')).toBe('authenticated');
    expect(requiredScopeFor('GET', '/appearance/info')).toBe('authenticated');
    expect(requiredScopeFor('PUT', '/appearance')).toBe('root');
    expect(requiredScopeFor('GET', '/appearance/versions')).toBe('root');
    expect(requiredScopeFor('POST', '/appearance/assets/logo')).toBe('root');
    expect(requiredScopeFor('GET', '/appearance/asset-versions/x')).toBe('root');
  });

  it('keeps the authenticated info DTO configured-only, typed and non-cacheable on every outcome', () => {
    const source = readFileSync(join(__dirname, '../routes/appearanceAdmin.ts'), 'utf8');
    const start = source.indexOf("router.get('/info'");
    const end = source.indexOf("router.put('/'", start);
    const route = source.slice(start, end);
    expect(route.indexOf("res.setHeader('Cache-Control', 'no-store')"))
      .toBeLessThan(route.indexOf('try {'));
    expect(route).toContain('displayName: appearance.overrides.displayName');
    expect(route).toContain('links: appearance.effective.links');
  });
});
