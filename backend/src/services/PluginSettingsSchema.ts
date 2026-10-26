/**
 * Plugin settings declared by the plugin (card bedf50cc, stage 1 of the plugin
 * availability and settings design ratified by owner ruling E380, choices C3,
 * C4 and C6). Pure functions only: no database, no request.
 *
 * A `rh.plugin/1` manifest MAY declare `ui.settings_schema`, at most 64
 * settings. The host validates the schema when the plugin loads (a bad schema
 * refuses the installation), validates every value at write against the
 * CURRENT schema, and resolves the effective value per Account:
 *
 *   1. the Account's own value, for an `account` key, or an
 *      `account_overridable` key that is not locked;
 *   2. the administrators' deployment value, for a `deployment` or
 *      `account_overridable` key;
 *   3. the schema default.
 *
 * A stored value the current schema no longer accepts (an undeclared key, a
 * key whose scope no longer admits that layer, or a value that no longer fits
 * its type) is ignored and the next layer answers; it is reported as stale and
 * never rewritten here.
 *
 * Secrets (C6): the host stores none. A `secret` setting only describes a value
 * the plugin keeps in its own installer configuration; every value written for
 * one is refused, and a credential-shaped value is refused in every key.
 */
import { credentialValueShaped } from '../utils/blueprintDocument';

export const PLUGIN_SETTING_TYPES = ['boolean', 'string', 'text', 'integer', 'number', 'enum', 'multi_enum', 'secret'] as const;
export type PluginSettingType = (typeof PLUGIN_SETTING_TYPES)[number];
export const PLUGIN_SETTING_SCOPES = ['deployment', 'account', 'account_overridable'] as const;
export type PluginSettingScope = (typeof PLUGIN_SETTING_SCOPES)[number];
export const PLUGIN_SETTING_DELIVERIES = ['frame_and_backend', 'backend'] as const;
export type PluginSettingDelivery = (typeof PLUGIN_SETTING_DELIVERIES)[number];

/** C4: refuse rather than truncate. */
export const PLUGIN_SETTINGS_LIMITS = Object.freeze({
  settings: 64,
  options: 64,
  labelLength: 80,
  helpLength: 400,
  optionValueLength: 128,
  documentBytes: 16 * 1024,
  depth: 8,
  stringBytes: 4 * 1024,
});

export interface PluginSettingOption { value: string; label: string }
export interface PluginSettingDeclaration {
  key: string;
  label: string;
  help?: string;
  type: PluginSettingType;
  options?: PluginSettingOption[];
  min?: number;
  max?: number;
  max_length?: number;
  default?: unknown;
  scope: PluginSettingScope;
  deliver?: PluginSettingDelivery;
}

/** The plugin-name syntax (`PluginHostContract` NAME). */
const KEY = /^[a-z][a-z0-9-]{1,63}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const DECLARATION_FIELDS = new Set(['key', 'label', 'help', 'type', 'options', 'min', 'max', 'max_length', 'default', 'scope', 'deliver']);

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function label(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
}
const has = (object: Record<string, unknown>, field: string) => Object.prototype.hasOwnProperty.call(object, field);

/** One declared setting's delivery (absent = `frame_and_backend`). */
export function settingDelivery(declaration: PluginSettingDeclaration): PluginSettingDelivery {
  return declaration.deliver ?? 'frame_and_backend';
}

/**
 * Whether one value fits one declared setting (type and bounds). The secret
 * value-shape guard is separate (`credentialValueShaped`): a value can fit its
 * type and still be refused for its shape.
 */
export function pluginSettingValueFits(declaration: PluginSettingDeclaration, value: unknown): boolean {
  switch (declaration.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'string':
    case 'text': {
      if (typeof value !== 'string') return false;
      if ((declaration.type === 'string' ? CONTROL : TEXT_CONTROL).test(value)) return false;
      if (Buffer.byteLength(value, 'utf8') > PLUGIN_SETTINGS_LIMITS.stringBytes) return false;
      return declaration.max_length === undefined || value.length <= declaration.max_length;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (declaration.type === 'integer' && !Number.isSafeInteger(value)) return false;
      if (declaration.min !== undefined && value < declaration.min) return false;
      return declaration.max === undefined || value <= declaration.max;
    }
    case 'enum': return typeof value === 'string' && (declaration.options ?? []).some(option => option.value === value);
    case 'multi_enum': {
      if (!Array.isArray(value) || value.length > PLUGIN_SETTINGS_LIMITS.options) return false;
      if (new Set(value).size !== value.length) return false;
      return value.every(entry => typeof entry === 'string' && (declaration.options ?? []).some(option => option.value === entry));
    }
    case 'secret': return false;
    default: return false;
  }
}

function validDeclaration(entry: unknown): entry is PluginSettingDeclaration {
  if (!plainObject(entry)) return false;
  if (Object.keys(entry).some(field => !DECLARATION_FIELDS.has(field))) return false;
  if (typeof entry.key !== 'string' || !KEY.test(entry.key)) return false;
  if (!label(entry.label, PLUGIN_SETTINGS_LIMITS.labelLength)) return false;
  if (has(entry, 'help') && !label(entry.help, PLUGIN_SETTINGS_LIMITS.helpLength)) return false;
  if (!PLUGIN_SETTING_TYPES.includes(entry.type as PluginSettingType)) return false;
  if (!PLUGIN_SETTING_SCOPES.includes(entry.scope as PluginSettingScope)) return false;
  if (has(entry, 'deliver') && !PLUGIN_SETTING_DELIVERIES.includes(entry.deliver as PluginSettingDelivery)) return false;
  const type = entry.type as PluginSettingType;
  const choices = type === 'enum' || type === 'multi_enum';
  if (choices !== has(entry, 'options')) return false;
  if (choices) {
    const options = entry.options;
    if (!Array.isArray(options) || options.length === 0 || options.length > PLUGIN_SETTINGS_LIMITS.options) return false;
    const values = new Set<string>();
    for (const option of options) {
      if (!plainObject(option) || Object.keys(option).some(field => field !== 'value' && field !== 'label')) return false;
      if (!label(option.value, PLUGIN_SETTINGS_LIMITS.optionValueLength) || !label(option.label, PLUGIN_SETTINGS_LIMITS.labelLength)) return false;
      if (values.has(option.value as string)) return false;
      values.add(option.value as string);
    }
  }
  const numeric = type === 'integer' || type === 'number';
  for (const bound of ['min', 'max'] as const) {
    if (!has(entry, bound)) continue;
    if (!numeric) return false;
    const value = entry[bound];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (type === 'integer' && !Number.isSafeInteger(value)) return false;
  }
  if (has(entry, 'min') && has(entry, 'max') && (entry.min as number) > (entry.max as number)) return false;
  if (has(entry, 'max_length')) {
    if (type !== 'string' && type !== 'text') return false;
    const max = entry.max_length;
    if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > PLUGIN_SETTINGS_LIMITS.stringBytes) return false;
  }
  if (type === 'secret') {
    // C6: a description of a value the plugin's installer holds; the host
    // stores nothing for it, so it has no default, no bounds and no owner but
    // the deployment.
    if (entry.scope !== 'deployment' || has(entry, 'default')) return false;
  }
  if (has(entry, 'default')) {
    if (!pluginSettingValueFits(entry as unknown as PluginSettingDeclaration, entry.default)) return false;
    if (credentialValueShaped(entry.default)) return false;
  }
  return true;
}

/**
 * Whether a manifest's `ui.settings_schema` is valid (C3, C4). Absent is
 * valid: a plugin without it has no host settings and loads as before.
 */
export function isValidPluginSettingsSchema(schema: unknown): boolean {
  if (schema === undefined) return true;
  if (!Array.isArray(schema) || schema.length > PLUGIN_SETTINGS_LIMITS.settings) return false;
  const keys = new Set<string>();
  for (const entry of schema) {
    if (!validDeclaration(entry)) return false;
    if (keys.has(entry.key)) return false;
    keys.add(entry.key);
  }
  return true;
}

/** A refused settings write: a fixed code, a status and the offending key (a key, never a value). */
export class PluginSettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
    this.name = 'PluginSettingsError';
  }
}

function depthOf(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (plainObject(value)) return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  return 0;
}
function longestStringBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) return Math.max(0, ...value.map(longestStringBytes));
  if (plainObject(value)) return Math.max(0, ...Object.keys(value).map(key => Buffer.byteLength(key, 'utf8')),
    ...Object.values(value).map(longestStringBytes));
  return 0;
}

/** C4: the document limits, checked before any key (refusal, never truncation). */
export function assertSettingsDocumentLimits(values: unknown, field = 'values'): Record<string, unknown> {
  if (!plainObject(values)) throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_INVALID', 'values must be a JSON object', field);
  if (Buffer.byteLength(JSON.stringify(values), 'utf8') > PLUGIN_SETTINGS_LIMITS.documentBytes) {
    throw new PluginSettingsError(413, 'PLUGIN_SETTINGS_TOO_LARGE', `A settings document is at most ${PLUGIN_SETTINGS_LIMITS.documentBytes} bytes`, field);
  }
  if (depthOf(values) > PLUGIN_SETTINGS_LIMITS.depth) {
    throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_TOO_DEEP', `A settings document nests at most ${PLUGIN_SETTINGS_LIMITS.depth} levels`, field);
  }
  if (longestStringBytes(values) > PLUGIN_SETTINGS_LIMITS.stringBytes) {
    throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_STRING_TOO_LONG', `A settings string is at most ${PLUGIN_SETTINGS_LIMITS.stringBytes} bytes`, field);
  }
  return values;
}

export type SettingsWriter = 'account' | 'deployment';

/** Which scopes a writer's layer may hold. */
function layerAdmits(writer: SettingsWriter, scope: PluginSettingScope): boolean {
  return writer === 'account' ? scope === 'account' || scope === 'account_overridable'
    : scope === 'deployment' || scope === 'account_overridable';
}

/**
 * Validate one layer's submitted values against the current schema: the
 * document limits, unknown keys, wrong-scope keys, `secret` keys, locked keys
 * (an Account writer only), the type and bounds of each value, and the
 * credential value shape. Throws the first refusal; returns the values.
 */
export function validateSettingsValues(schema: PluginSettingDeclaration[], input: unknown, writer: SettingsWriter,
  locked: readonly string[] = []): Record<string, unknown> {
  const values = assertSettingsDocumentLimits(input);
  const declared = new Map(schema.map(entry => [entry.key, entry]));
  for (const [key, value] of Object.entries(values)) {
    const declaration = declared.get(key);
    if (!declaration) throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_KEY_UNKNOWN', 'The plugin declares no such setting', key);
    if (declaration.type === 'secret') {
      throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_SECRET_NOT_STORED',
        "This setting is configured by the plugin's installer; the host stores no value for it", key);
    }
    if (!layerAdmits(writer, declaration.scope)) {
      throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE',
        writer === 'account' ? 'This setting is set by the administrators only' : 'This setting is set by each Account only', key);
    }
    if (writer === 'account' && locked.includes(key)) {
      throw new PluginSettingsError(409, 'PLUGIN_SETTINGS_KEY_LOCKED', 'This setting is set by your administrator', key);
    }
    // N13: on the Account's own write, null names a key to remove the
    // Account's own value for it (the only way to clear a `deliver: backend`
    // value, which the Account's read never shows). It passed every key check
    // above; nothing is stored for it.
    if (writer === 'account' && value === null) continue;
    if (credentialValueShaped(value)) {
      throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_VALUE_SECRET', 'A value shaped like a credential is never stored', key);
    }
    if (!pluginSettingValueFits(declaration, value)) {
      throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_VALUE_INVALID', 'The value does not fit the declared type or bounds', key);
    }
  }
  return values;
}

/** Validate an administrator lock list: unique `account_overridable` keys of the current schema. */
export function validateLockedKeys(schema: PluginSettingDeclaration[], input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > PLUGIN_SETTINGS_LIMITS.settings) {
    throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_INVALID', 'lockedKeys must be an array of setting keys', 'lockedKeys');
  }
  const declared = new Map(schema.map(entry => [entry.key, entry]));
  const seen = new Set<string>();
  for (const key of input) {
    const declaration = typeof key === 'string' ? declared.get(key) : undefined;
    if (!declaration) throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_KEY_UNKNOWN', 'The plugin declares no such setting', 'lockedKeys');
    if (declaration.scope !== 'account_overridable') {
      throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_KEY_WRONG_SCOPE', 'Only an account_overridable setting can be locked', key);
    }
    if (seen.has(key)) throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_INVALID', 'A key is locked at most once', key);
    seen.add(key);
  }
  return [...seen].sort();
}

/** Whether a stored value of this layer is still usable under the current schema. */
function storedUsable(declaration: PluginSettingDeclaration | undefined, layer: SettingsWriter, value: unknown): boolean {
  return !!declaration && declaration.type !== 'secret' && layerAdmits(layer, declaration.scope)
    && pluginSettingValueFits(declaration, value) && !credentialValueShaped(value);
}

/** The keys of one stored layer document that the current schema no longer accepts. */
export function staleSettingKeys(schema: PluginSettingDeclaration[], layer: SettingsWriter, stored: Record<string, unknown>): string[] {
  const declared = new Map(schema.map(entry => [entry.key, entry]));
  return Object.entries(stored ?? {}).filter(([key, value]) => !storedUsable(declared.get(key), layer, value))
    .map(([key]) => key).sort();
}

/**
 * N13: the values the Account's own replacement write keeps without being
 * sent. The Account's own read (`GET /plugin-host/:name/settings`) never shows
 * the value of a `deliver: backend` key, so a form built from that read cannot
 * send it back. A stored Account value of such a key that the request does not
 * NAME is therefore kept, while the current schema still accepts it; a request
 * that names the key replaces it (validated like every value) or, with null,
 * removes it. Every other key is replaced as before: omitting it clears it.
 */
export function backendOnlyValuesKept(schema: PluginSettingDeclaration[], stored: Record<string, unknown>,
  named: ReadonlySet<string>): Record<string, unknown> {
  const declared = new Map(schema.map(entry => [entry.key, entry]));
  return Object.fromEntries(Object.entries(stored ?? {}).filter(([key, value]) => {
    const declaration = declared.get(key);
    return !named.has(key) && !!declaration && settingDelivery(declaration) === 'backend'
      && storedUsable(declaration, 'account', value);
  }));
}

/** Locked keys that no longer name an `account_overridable` setting. */
export function staleLockedKeys(schema: PluginSettingDeclaration[], locked: readonly string[]): string[] {
  const declared = new Map(schema.map(entry => [entry.key, entry]));
  return locked.filter(key => declared.get(key)?.scope !== 'account_overridable').sort();
}

export type SettingSource = 'account' | 'deployment' | 'default';
export interface EffectiveSettings {
  /** Effective values; `null` for a setting with no value at any layer. */
  values: Record<string, unknown>;
  /** Per key: where the value came from, and whether the administrators locked it. */
  sources: Record<string, { source: SettingSource; locked: boolean }>;
}

export interface StoredLayers {
  deployment: { values: Record<string, unknown>; locked: readonly string[] } | null;
  account: { values: Record<string, unknown> } | null;
}

/**
 * Resolve every non-secret declared setting for one Account (first match
 * wins: the Account's own unlocked value, the deployment value, the default).
 * `includeBackend` false leaves `deliver: backend` keys out entirely (the
 * bridge); the user settings route asks for their sources only.
 */
export function resolveEffectiveSettings(schema: PluginSettingDeclaration[], layers: StoredLayers,
  options: { includeBackend: boolean }): EffectiveSettings {
  const values: Record<string, unknown> = {};
  const sources: Record<string, { source: SettingSource; locked: boolean }> = {};
  const locked = new Set(layers.deployment?.locked ?? []);
  for (const declaration of schema) {
    if (declaration.type === 'secret') continue;
    if (!options.includeBackend && settingDelivery(declaration) === 'backend') continue;
    const key = declaration.key;
    const isLocked = declaration.scope === 'account_overridable' && locked.has(key);
    const own = layers.account?.values ?? {};
    const shared = layers.deployment?.values ?? {};
    if ((declaration.scope === 'account' || (declaration.scope === 'account_overridable' && !isLocked))
        && has(own, key) && storedUsable(declaration, 'account', own[key])) {
      values[key] = own[key]; sources[key] = { source: 'account', locked: false };
    } else if ((declaration.scope === 'deployment' || declaration.scope === 'account_overridable')
        && has(shared, key) && storedUsable(declaration, 'deployment', shared[key])) {
      values[key] = shared[key]; sources[key] = { source: 'deployment', locked: isLocked };
    } else {
      values[key] = declaration.default === undefined ? null : declaration.default;
      sources[key] = { source: 'default', locked: isLocked };
    }
  }
  return { values, sources };
}

/** The schema as the host renders it for a person: `deliver: backend` defaults are withheld. */
export function publicSchema(schema: PluginSettingDeclaration[]): PluginSettingDeclaration[] {
  return schema.map(entry => {
    const copy: PluginSettingDeclaration = { ...entry, deliver: settingDelivery(entry) };
    if (settingDelivery(entry) === 'backend') delete copy.default;
    return copy;
  });
}
