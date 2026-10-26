/**
 * Card bedf50cc (plugin availability and settings, stage 1; owner ruling
 * E380): the pure half of host-stored plugin settings. The closed type set and
 * the schema limits a plugin is refused for at load (C3, C4), every value
 * bound at write, the secret value-shape guard (C6), and the resolution order
 * with locks. No database: the live suite (pluginAvailabilityLive) measures the
 * same rules through the production routers on stored rows.
 */
import {
  PLUGIN_SETTING_TYPES, PLUGIN_SETTINGS_LIMITS, isValidPluginSettingsSchema, pluginSettingValueFits,
  resolveEffectiveSettings, staleLockedKeys, staleSettingKeys, validateLockedKeys, validateSettingsValues,
  PluginSettingsError, backendOnlyValuesKept, type PluginSettingDeclaration,
} from '../services/PluginSettingsSchema';
import { availabilityResolvesOn, availabilityUserControlled, PLUGIN_AVAILABILITY_STATES } from '../services/PluginSettingsService';
import { validatePluginContract, PLUGIN_CONTRACT_REFUSALS, pluginLoadRefusalReason } from '../services/PluginHostContract';

const schema: PluginSettingDeclaration[] = [
  { key: 'language', label: 'Language', type: 'enum', scope: 'account_overridable', default: 'en',
    options: [{ value: 'en', label: 'English' }, { value: 'de', label: 'German' }, { value: 'pl', label: 'Polish' }] },
  { key: 'topics', label: 'Topics', type: 'multi_enum', scope: 'account', default: [],
    options: [{ value: 'tech', label: 'Technology' }, { value: 'sport', label: 'Sport' }] },
  { key: 'short-version', label: 'Short version', type: 'boolean', scope: 'account', default: false },
  { key: 'max-items', label: 'Items', type: 'integer', scope: 'account_overridable', min: 1, max: 50, default: 10 },
  { key: 'ratio', label: 'Ratio', type: 'number', scope: 'deployment', min: 0, max: 1, default: 0.5 },
  { key: 'notes', label: 'Notes', type: 'text', scope: 'account', max_length: 20 },
  { key: 'headline', label: 'Headline', type: 'string', scope: 'account', max_length: 10 },
  { key: 'generation-endpoint', label: 'Generator', type: 'string', scope: 'deployment', deliver: 'backend', default: 'https://generator.invalid/v1' },
  { key: 'feed-token', label: 'Feed credential', type: 'secret', scope: 'deployment' },
  { key: 'token-sort', label: 'Sort', type: 'string', scope: 'account' },
  { key: 'callback-url', label: 'Callback', type: 'string', scope: 'account', deliver: 'backend' },
];

const refused = (run: () => unknown): { code: string; status: number; field?: string } => {
  try { run(); } catch (err) {
    if (err instanceof PluginSettingsError) return { code: err.code, status: err.status, field: err.field };
    throw err;
  }
  return { code: 'ACCEPTED', status: 200 };
};

describe('plugin settings schema at load (card bedf50cc, C3 and C4)', () => {
  it('accepts the closed type set and an absent schema', () => {
    expect([...PLUGIN_SETTING_TYPES]).toEqual(['boolean', 'string', 'text', 'integer', 'number', 'enum', 'multi_enum', 'secret']);
    expect(isValidPluginSettingsSchema(undefined)).toBe(true);
    expect(isValidPluginSettingsSchema([])).toBe(true);
    expect(isValidPluginSettingsSchema(schema)).toBe(true);
  });
  const one = (patch: Record<string, unknown>) => [{ key: 'item', label: 'Item', type: 'string', scope: 'account', ...patch }];
  it.each([
    ['a type outside the closed set', one({ type: 'json' })],
    ['a JSON Schema object instead of a type', one({ type: { type: 'string' } })],
    ['a key outside the plugin-name syntax', one({ key: 'Item_Key' })],
    ['an unknown field', one({ pattern: '.*' })],
    ['a label over 80 characters', one({ label: 'x'.repeat(81) })],
    ['a help text over 400 characters', one({ help: 'x'.repeat(401) })],
    ['an unknown scope', one({ scope: 'group' })],
    ['an unknown delivery', one({ deliver: 'frame' })],
    ['an enum without options', one({ type: 'enum' })],
    ['options on a string', one({ options: [{ value: 'a', label: 'A' }] })],
    ['more than 64 options', one({ type: 'enum', options: Array.from({ length: 65 }, (_, i) => ({ value: 'v' + i, label: 'V' })) })],
    ['a duplicate option value', one({ type: 'enum', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] })],
    ['min on a string', one({ min: 1 })],
    ['min above max', one({ type: 'integer', min: 5, max: 1 })],
    ['a fractional integer bound', one({ type: 'integer', max: 1.5 })],
    ['max_length on an integer', one({ type: 'integer', max_length: 3 })],
    ['max_length over 4 KiB', one({ max_length: 4097 })],
    ['a default outside its type', one({ type: 'integer', default: 'ten' })],
    ['a default outside its bounds', one({ type: 'integer', min: 1, max: 5, default: 9 })],
    ['a credential-shaped default', one({ default: 'rh_dev_abcdefgh.ijklmnop' })],
    ['a secret with a default', one({ type: 'secret', scope: 'deployment', default: 'x' })],
    ['a secret an Account sets', one({ type: 'secret', scope: 'account' })],
    ['a duplicate key', [...one({}), ...one({})]],
    ['more than 64 settings', Array.from({ length: 65 }, (_, i) => ({ key: 'item-' + i, label: 'Item', type: 'boolean', scope: 'account' }))],
    ['a non-array schema', { item: { type: 'string' } }],
  ])('refuses %s', (_name, candidate) => {
    expect(isValidPluginSettingsSchema(candidate)).toBe(false);
  });
  it('refuses the installation with its own reason code when the schema is invalid', () => {
    expect(PLUGIN_CONTRACT_REFUSALS).toContain('PLUGIN_SETTINGS_SCHEMA_INVALID');
    expect(PLUGIN_CONTRACT_REFUSALS).toContain('PLUGIN_ASSERTION_KEY_SHARED');
    const manifest: any = { schema_version: 'rh.plugin/1', name: 'sample-plugin', version: '1.0.0', description: 'fixture',
      docker: { image: 'fixture:1', ports: {} }, api: { base_path: '/plugins/sample-plugin', internal_port: 8080, health: '/health' },
      relayhall: { api_version: 1, trust: 'installed', capabilities: [] }, ui: { enabled: true, settings_schema: one({ type: 'json' }) } };
    let caught: unknown;
    try { validatePluginContract(manifest, { name: 'sample-plugin', source: '.', enabled: true }); } catch (err) { caught = err; }
    expect(pluginLoadRefusalReason(caught)).toBe('PLUGIN_SETTINGS_SCHEMA_INVALID');
    manifest.ui.settings_schema = schema;
    expect(() => validatePluginContract(manifest, { name: 'sample-plugin', source: '.', enabled: true })).not.toThrow();
  });
});

describe('plugin settings values at every bound (card bedf50cc, C4)', () => {
  const declared = (key: string) => schema.find(entry => entry.key === key)!;
  it.each([
    ['max-items', 1, true], ['max-items', 50, true], ['max-items', 0, false], ['max-items', 51, false], ['max-items', 2.5, false],
    ['max-items', '10', false],
    ['ratio', 0, true], ['ratio', 1, true], ['ratio', -0.01, false], ['ratio', 1.01, false],
    ['language', 'de', true], ['language', 'fr', false], ['language', ['de'], false],
    ['topics', ['tech', 'sport'], true], ['topics', ['tech', 'tech'], false], ['topics', ['politics'], false], ['topics', 'tech', false],
    ['short-version', true, true], ['short-version', 'true', false],
    ['headline', 'x'.repeat(10), true], ['headline', 'x'.repeat(11), false], ['headline', 'two\nlines', false],
    ['notes', 'line one\nline two', true], ['notes', 'bell\u0007', false], ['notes', 'x'.repeat(21), false],
    ['feed-token', 'anything', false],
  ])('%s = %j fits: %s', (key, value, fits) => {
    expect(pluginSettingValueFits(declared(key), value)).toBe(fits);
  });
  it('refuses a document over 16 KiB, deeper than 8 levels or with a string over 4 KiB, rather than truncating', () => {
    expect(PLUGIN_SETTINGS_LIMITS).toMatchObject({ documentBytes: 16384, depth: 8, stringBytes: 4096, settings: 64, options: 64 });
    expect(refused(() => validateSettingsValues(schema, { notes: 'x'.repeat(4000), headline: 'y'.repeat(4000),
      'token-sort': 'z'.repeat(4000), topics: Array(10).fill('w'.repeat(500)) }, 'account'))).toMatchObject({ status: 413, code: 'PLUGIN_SETTINGS_TOO_LARGE' });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 9; i++) deep = [deep];
    expect(refused(() => validateSettingsValues(schema, { topics: deep }, 'account'))).toMatchObject({ code: 'PLUGIN_SETTINGS_TOO_DEEP' });
    expect(refused(() => validateSettingsValues(schema, { notes: 'x'.repeat(4097) }, 'account'))).toMatchObject({ code: 'PLUGIN_SETTINGS_STRING_TOO_LONG' });
    expect(refused(() => validateSettingsValues(schema, [], 'account'))).toMatchObject({ code: 'PLUGIN_SETTINGS_INVALID' });
  });
  it('refuses unknown keys, wrong-scope keys and secret keys at write, for either writer', () => {
    expect(refused(() => validateSettingsValues(schema, { colour: 'red' }, 'account'))).toEqual({ status: 400, code: 'PLUGIN_SETTINGS_KEY_UNKNOWN', field: 'colour' });
    expect(refused(() => validateSettingsValues(schema, { ratio: 0.2 }, 'account'))).toEqual({ status: 400, code: 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE', field: 'ratio' });
    expect(refused(() => validateSettingsValues(schema, { topics: ['tech'] }, 'deployment'))).toEqual({ status: 400, code: 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE', field: 'topics' });
    expect(refused(() => validateSettingsValues(schema, { 'feed-token': 'x' }, 'deployment'))).toEqual({ status: 400, code: 'PLUGIN_SETTINGS_SECRET_NOT_STORED', field: 'feed-token' });
    expect(refused(() => validateSettingsValues(schema, { language: 'de' }, 'account', ['language']))).toEqual({ status: 409, code: 'PLUGIN_SETTINGS_KEY_LOCKED', field: 'language' });
    expect(validateSettingsValues(schema, { language: 'de', 'max-items': 3 }, 'deployment')).toEqual({ language: 'de', 'max-items': 3 });
  });
  it('the secret value-shape guard: a token-sort key is accepted, an rh_ value is refused (C6)', () => {
    expect(validateSettingsValues(schema, { 'token-sort': 'newest' }, 'account')).toEqual({ 'token-sort': 'newest' });
    for (const value of ['rh_live_abcdefgh.ijklmnopqrst', 'Bearer abc.def', 'ghp_abcdefghijklmnop']) {
      expect(refused(() => validateSettingsValues(schema, { 'token-sort': value }, 'account'))).toEqual({ status: 400, code: 'PLUGIN_SETTINGS_VALUE_SECRET', field: 'token-sort' });
      expect(refused(() => validateSettingsValues(schema, { 'generation-endpoint': value }, 'deployment'))).toMatchObject({ code: 'PLUGIN_SETTINGS_VALUE_SECRET' });
    }
  });
  it('null names a key on the Account\'s own write only, after every key check (N13)', () => {
    expect(validateSettingsValues(schema, { 'callback-url': null, notes: 'x' }, 'account')).toEqual({ 'callback-url': null, notes: 'x' });
    expect(refused(() => validateSettingsValues(schema, { colour: null }, 'account'))).toMatchObject({ code: 'PLUGIN_SETTINGS_KEY_UNKNOWN' });
    expect(refused(() => validateSettingsValues(schema, { ratio: null }, 'account'))).toMatchObject({ code: 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE' });
    expect(refused(() => validateSettingsValues(schema, { 'feed-token': null }, 'account'))).toMatchObject({ code: 'PLUGIN_SETTINGS_SECRET_NOT_STORED' });
    expect(refused(() => validateSettingsValues(schema, { language: null }, 'account', ['language']))).toMatchObject({ status: 409, code: 'PLUGIN_SETTINGS_KEY_LOCKED' });
    expect(refused(() => validateSettingsValues(schema, { ratio: null }, 'deployment'))).toMatchObject({ code: 'PLUGIN_SETTINGS_VALUE_INVALID', field: 'ratio' });
  });
  it('the Account\'s own write keeps a stored deliver: backend value it does not name, and nothing else (N13)', () => {
    const stored = { 'callback-url': 'https://own.invalid/hook', notes: 'kept?', language: 'de' };
    expect(backendOnlyValuesKept(schema, stored, new Set(['notes']))).toEqual({ 'callback-url': 'https://own.invalid/hook' });
    expect(backendOnlyValuesKept(schema, stored, new Set(['callback-url']))).toEqual({});
    // A value the current schema no longer accepts is not carried over.
    expect(backendOnlyValuesKept(schema, { 'callback-url': 42 }, new Set())).toEqual({});
    // A deployment-scoped backend key has no Account value to keep.
    expect(backendOnlyValuesKept(schema, { 'generation-endpoint': 'https://x.invalid' }, new Set())).toEqual({});
  });
  it('a lock list names unique account_overridable keys only', () => {
    expect(validateLockedKeys(schema, ['max-items', 'language'])).toEqual(['language', 'max-items']);
    expect(refused(() => validateLockedKeys(schema, ['ratio']))).toMatchObject({ code: 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE' });
    expect(refused(() => validateLockedKeys(schema, ['nope']))).toMatchObject({ code: 'PLUGIN_SETTINGS_KEY_UNKNOWN' });
    expect(refused(() => validateLockedKeys(schema, ['language', 'language']))).toMatchObject({ code: 'PLUGIN_SETTINGS_INVALID' });
  });
});

describe('plugin settings resolution with locks (card bedf50cc, design section 5)', () => {
  const deployment = { values: { language: 'pl', 'max-items': 20, ratio: 0.25, 'generation-endpoint': 'https://other.invalid/v2' }, locked: [] as string[] };
  const own = { language: 'de', 'max-items': 5, topics: ['tech'] };
  it('takes the Account value, then the deployment value, then the default', () => {
    const resolved = resolveEffectiveSettings(schema, { deployment, account: { values: own } }, { includeBackend: true });
    expect(resolved.values).toMatchObject({ language: 'de', 'max-items': 5, topics: ['tech'], ratio: 0.25, 'short-version': false,
      notes: null, 'generation-endpoint': 'https://other.invalid/v2' });
    expect(resolved.sources).toMatchObject({ language: { source: 'account', locked: false }, ratio: { source: 'deployment', locked: false },
      'short-version': { source: 'default', locked: false } });
    expect(resolved.values).not.toHaveProperty('feed-token');
  });
  it('a locked key ignores the Account value, and unlocking restores it', () => {
    const locked = resolveEffectiveSettings(schema, { deployment: { ...deployment, locked: ['language'] }, account: { values: own } }, { includeBackend: true });
    expect(locked.values.language).toBe('pl');
    expect(locked.sources.language).toEqual({ source: 'deployment', locked: true });
    expect(locked.values['max-items']).toBe(5);
    const unlocked = resolveEffectiveSettings(schema, { deployment, account: { values: own } }, { includeBackend: true });
    expect(unlocked.values.language).toBe('de');
    expect(unlocked.sources.language).toEqual({ source: 'account', locked: false });
  });
  it('a locked key with no deployment value answers the default, still locked', () => {
    const resolved = resolveEffectiveSettings(schema, { deployment: { values: {}, locked: ['max-items'] }, account: { values: own } }, { includeBackend: true });
    expect(resolved.values['max-items']).toBe(10);
    expect(resolved.sources['max-items']).toEqual({ source: 'default', locked: true });
  });
  it('leaves deliver: backend keys out of the frame view entirely', () => {
    const frame = resolveEffectiveSettings(schema, { deployment, account: { values: own } }, { includeBackend: false });
    expect(frame.values).not.toHaveProperty('generation-endpoint');
    expect(frame.sources).not.toHaveProperty('generation-endpoint');
  });
  it('ignores a stored value the current schema no longer accepts and reports it stale, rewriting nothing', () => {
    const stored = { language: 'fr', retired: true, ratio: 0.9, 'max-items': 7 };
    const resolved = resolveEffectiveSettings(schema, { deployment: null, account: { values: stored } }, { includeBackend: true });
    expect(resolved.values).toMatchObject({ language: 'en', ratio: 0.5, 'max-items': 7 });
    expect(staleSettingKeys(schema, 'account', stored)).toEqual(['language', 'ratio', 'retired']);
    expect(stored).toEqual({ language: 'fr', retired: true, ratio: 0.9, 'max-items': 7 });
    expect(staleLockedKeys(schema, ['language', 'ratio', 'gone'])).toEqual(['gone', 'ratio']);
  });
});

describe('plugin availability states (card bedf50cc, C1)', () => {
  it('resolves each state with the Account choice', () => {
    expect([...PLUGIN_AVAILABILITY_STATES]).toEqual(['required', 'default_on', 'available', 'disabled']);
    const table = PLUGIN_AVAILABILITY_STATES.map(state => [state, availabilityUserControlled(state),
      availabilityResolvesOn(state, null), availabilityResolvesOn(state, true), availabilityResolvesOn(state, false)]);
    expect(table).toEqual([
      ['required', false, true, true, true],
      ['default_on', true, true, true, false],
      ['available', true, false, true, false],
      ['disabled', false, false, false, false],
    ]);
  });
});
