import type { PluginManifest, PluginConfig, PluginProxyRule } from './PluginLoader';
import { RELAYHALL_VERSION } from '../version';
import { isValidPluginSettingsSchema } from './PluginSettingsSchema';
export const PLUGIN_SCHEMA = 'rh.plugin/1';
/**
 * Every reason this contract refuses an installation, as a closed set of fixed,
 * secret-free codes. The loader logs the code, never the refusal text, so an
 * operator can tell a version refusal from an allow-path or shape refusal.
 */
export const PLUGIN_CONTRACT_REFUSALS = [
  'PLUGIN_NAME_INVALID', 'PLUGIN_NAMESPACE_EMPTY', 'PLUGIN_MIN_VERSION_MALFORMED',
  'PLUGIN_HOST_VERSION_UNAVAILABLE', 'PLUGIN_MIN_VERSION_UNSATISFIED', 'PLUGIN_NAME_MISMATCH',
  'PLUGIN_ACCESS_DEFAULT_INVALID', 'PLUGIN_SCHEMA_UNSUPPORTED', 'PLUGIN_HEALTH_PATH_INVALID',
  'PLUGIN_BASE_PATH_INVALID', 'PLUGIN_HOST_API_UNSUPPORTED', 'PLUGIN_PORT_INVALID',
  'PLUGIN_BRIDGE_CAPABILITY_UNSUPPORTED', 'PLUGIN_UI_ROUTE_INVALID', 'PLUGIN_UI_ROUTE_DUPLICATE',
  'PLUGIN_SIDEBAR_WIDGET_INVALID', 'PLUGIN_ALLOW_MATCH_INVALID', 'PLUGIN_ALLOW_RULE_DUPLICATE',
  'PLUGIN_ALLOW_RULE_MALFORMED', 'PLUGIN_ALLOW_PATH_NOT_CANONICAL', 'PLUGIN_ALLOW_CAPABILITY_INVALID',
  'PLUGIN_WRITE_CAPABILITY_REQUIRED', 'PLUGIN_SETTINGS_INVALID', 'PLUGIN_SETTINGS_ENTRY_INVALID',
  'PLUGIN_SETTINGS_ALIAS_OVERLAP', 'PLUGIN_SETTINGS_RULE_MISSING', 'PLUGIN_ASSERTION_KEY_INVALID',
  // Card bedf50cc (E380): a declared settings schema outside the closed type
  // set or its limits (C3, C4), and an installation whose assertion key is
  // the same as another installation's, by variable name or by value.
  'PLUGIN_SETTINGS_SCHEMA_INVALID', 'PLUGIN_ASSERTION_KEY_SHARED',
] as const;
export type PluginContractRefusal = (typeof PLUGIN_CONTRACT_REFUSALS)[number];
/** The code logged for a load failure that is not a contract refusal. */
export const PLUGIN_LOAD_UNCLASSIFIED = 'PLUGIN_LOAD_UNCLASSIFIED';
/** A contract refusal. Its reason and message are developer-authored literals in this file. */
export class PluginContractError extends Error {
  readonly reason: PluginContractRefusal;
  constructor(reason: PluginContractRefusal, message: string) {
    super(message);
    this.name = 'PluginContractError';
    this.reason = reason;
  }
}
function refuse(reason: PluginContractRefusal, message: string): PluginContractError {
  return new PluginContractError(reason, message);
}
/**
 * The fixed reason code for a caught load failure. Only a PluginContractError's
 * own data property is read (a getter is never invoked); it is used as a lookup
 * key and the stored constant from PLUGIN_CONTRACT_REFUSALS is returned.
 * Anything else answers PLUGIN_LOAD_UNCLASSIFIED. It never throws.
 */
export function pluginLoadRefusalReason(caught: unknown): PluginContractRefusal | typeof PLUGIN_LOAD_UNCLASSIFIED {
  try {
    if (!(caught instanceof PluginContractError)) return PLUGIN_LOAD_UNCLASSIFIED;
    const descriptor = Object.getOwnPropertyDescriptor(caught, 'reason');
    if (!descriptor || !('value' in descriptor)) return PLUGIN_LOAD_UNCLASSIFIED;
    return PLUGIN_CONTRACT_REFUSALS.find(code => code === descriptor.value) ?? PLUGIN_LOAD_UNCLASSIFIED;
  } catch {
    return PLUGIN_LOAD_UNCLASSIFIED;
  }
}
export const PLUGIN_CAPABILITIES = ['telemetry.sessions', 'usage.quotas'] as const;
const NAME = /^[a-z][a-z0-9-]{1,63}$/;
const SAFE_PATH = /^\/(?!\/)[a-zA-Z0-9/_-]*$/;
export function isSafePluginPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && SAFE_PATH.test(value);
}
/** Compile the installation namespace, including the legacy prefix alias. */
export function pluginPublicBasePath(name: string): string {
  if (!NAME.test(name)) throw refuse('PLUGIN_NAME_INVALID', 'Invalid plugin installation name');
  const shortName = name.replace(/^claw-/, '');
  if (!shortName) throw refuse('PLUGIN_NAMESPACE_EMPTY', 'Empty plugin public namespace');
  return '/plugins/' + shortName;
}
// Exact-pinned direct dependency (it ships no types): SemVer 2.0.0 precedence,
// so a prerelease sorts below its stable release, numeric identifiers compare
// as numbers and build metadata never changes the order.
const semver: { valid(value: string): string | null; gte(version: string, minimum: string): boolean } = require('semver');
/** Longest `relayhall.min_version` an installation may declare. */
const MAX_MIN_VERSION_LENGTH = 160;
/** A strict SemVer string: no `v` prefix, no surrounding space, no loose forms. */
function strictSemver(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && /^[0-9]/.test(value) &&
    value.trim() === value && semver.valid(value) !== null;
}
/**
 * Refuse an installation whose declared minimum host version is malformed or
 * newer than `hostVersion`. The host version is the release identity the
 * backend reports (RELAYHALL_VERSION), never the package.json base version.
 */
export function validatePluginMinimumVersion(minimum: unknown, hostVersion: unknown): void {
  if (!strictSemver(minimum, MAX_MIN_VERSION_LENGTH)) throw refuse('PLUGIN_MIN_VERSION_MALFORMED', 'Invalid plugin minimum host version');
  if (!strictSemver(hostVersion, 256)) throw refuse('PLUGIN_HOST_VERSION_UNAVAILABLE', 'Plugin host version unavailable');
  if (!semver.gte(hostVersion, minimum)) throw refuse('PLUGIN_MIN_VERSION_UNSATISFIED', 'Plugin requires a newer host version');
}
export function isPluginV1(manifest: PluginManifest | null | undefined): boolean { return manifest?.schema_version === PLUGIN_SCHEMA; }
/** The only capability a deployment default (`access.default`) may give. */
export const PLUGIN_DEFAULT_CAPABILITY = 'view';
/** A default is absent, `[]` or exactly `["view"]`; anything else refuses the installation at load. */
function isValidAccessDefault(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 1 && value.every(entry => entry === PLUGIN_DEFAULT_CAPABILITY);
}
export function validatePluginContract(manifest: PluginManifest, config: PluginConfig): void {
  if (!NAME.test(manifest.name) || manifest.name !== config.name) throw refuse('PLUGIN_NAME_MISMATCH', 'Plugin name must match installation');
  const access = config.access as Record<string, unknown> | undefined;
  if (access && typeof access === 'object' && Object.prototype.hasOwnProperty.call(access, 'default') &&
      !isValidAccessDefault(access.default)) throw refuse('PLUGIN_ACCESS_DEFAULT_INVALID', 'Invalid plugin access default');
  if (manifest.schema_version !== undefined && !isPluginV1(manifest)) throw refuse('PLUGIN_SCHEMA_UNSUPPORTED', 'Unsupported plugin schema');
  if (!isSafePluginPath(manifest.api?.health)) throw refuse('PLUGIN_HEALTH_PATH_INVALID', 'Invalid plugin health path');
  if (manifest.api?.base_path !== pluginPublicBasePath(manifest.name)) throw refuse('PLUGIN_BASE_PATH_INVALID', 'Invalid plugin base path');
  if (!isPluginV1(manifest)) return;
  if (manifest.relayhall?.api_version !== 1 || manifest.relayhall.trust !== 'installed') throw refuse('PLUGIN_HOST_API_UNSUPPORTED', 'Unsupported plugin host API or trust');
  if (manifest.relayhall.min_version !== undefined) validatePluginMinimumVersion(manifest.relayhall.min_version, RELAYHALL_VERSION);
  if (!Number.isInteger(manifest.api.internal_port) || manifest.api.internal_port < 1 || manifest.api.internal_port > 65535) throw refuse('PLUGIN_PORT_INVALID', 'Invalid plugin port');
  if ((manifest.relayhall.capabilities ?? []).some(c => !PLUGIN_CAPABILITIES.includes(c as any))) throw refuse('PLUGIN_BRIDGE_CAPABILITY_UNSUPPORTED', 'Unsupported bridge capability');
  for (const route of manifest.ui?.routes ?? []) {
    if (!isSafePluginPath(route.path) || route.path === '/' || !isSafePluginPath(route.proxy_to)) throw refuse('PLUGIN_UI_ROUTE_INVALID', 'Invalid UI route');
  }
  const paths = (manifest.ui?.routes ?? []).map(r => r.path.replace(/\/+$/, ''));
  if (new Set(paths).size !== paths.length) throw refuse('PLUGIN_UI_ROUTE_DUPLICATE', 'Duplicate UI route');
  const widget = manifest.ui?.sidebar_widget;
  if (widget && (!isSafePluginPath(widget.path) || !Number.isInteger(widget.height) || widget.height < 48 || widget.height > 240)) throw refuse('PLUGIN_SIDEBAR_WIDGET_INVALID', 'Invalid sidebar widget');
  // Owner ruling E438(1): `grow` is an opt-in boolean (absent = false). It lets
  // the host size the widget to the content height its frame reports, up to the
  // host ceiling; the declared height above stays bounded for every widget.
  if (widget && widget.grow !== undefined && typeof widget.grow !== 'boolean') throw refuse('PLUGIN_SIDEBAR_WIDGET_INVALID', 'Invalid sidebar widget');
  // Owner ruling E458: `frame` is an opt-in with exactly one accepted value,
  // `section` (absent = the boxed block). It asks the dashboard to draw the
  // widget as a sidebar section instead; it does not change the declared
  // height bound, the frame's sandbox or what the widget may call.
  if (widget && widget.frame !== undefined && widget.frame !== 'section') throw refuse('PLUGIN_SIDEBAR_WIDGET_INVALID', 'Invalid sidebar widget');
  const rules = new Set<string>();
  for (const rule of manifest.api.allow ?? []) {
    if (rule.match !== undefined && !['exact','prefix'].includes(rule.match)) throw refuse('PLUGIN_ALLOW_MATCH_INVALID', 'Invalid allow match');
    for (const method of rule.methods ?? []) {
      const key = method + ':' + rule.path + ':' + (rule.match ?? 'prefix');
      if (rules.has(key)) throw refuse('PLUGIN_ALLOW_RULE_DUPLICATE', 'Ambiguous duplicate allow rule');
      rules.add(key);
    }
    if (!isSafePluginPath(rule.path) || !Array.isArray(rule.methods) || !rule.methods.length ||
        rule.methods.some(m => !['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(m))) throw refuse('PLUGIN_ALLOW_RULE_MALFORMED', 'Invalid proxy allow rule');
    // A trailing slash makes prefix boundaries miss their descendants and
    // fall through to a broader rule. Refuse instead of changing its meaning.
    if (rule.path !== '/' && rule.path.endsWith('/')) throw refuse('PLUGIN_ALLOW_PATH_NOT_CANONICAL', 'Proxy allow paths must be canonical (no trailing slash)');
    if (rule.capability && !NAME.test(rule.capability)) throw refuse('PLUGIN_ALLOW_CAPABILITY_INVALID', 'Invalid domain capability');
    if (rule.methods.some(m => !['GET','HEAD'].includes(m)) && (!rule.capability || rule.capability === 'view')) throw refuse('PLUGIN_WRITE_CAPABILITY_REQUIRED', 'Writes need an explicit domain capability');
  }
  const settings = manifest.ui?.settings;
  if (settings !== undefined && (!Array.isArray(settings) || settings.length > 20)) throw refuse('PLUGIN_SETTINGS_INVALID', 'Invalid plugin settings');
  const settingIds = new Set<string>();
  for (const entry of settings ?? []) {
    if (!entry || typeof entry.id !== 'string' || !NAME.test(entry.id) || settingIds.has(entry.id) ||
        typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80 || /[\x00-\x1f\x7f]/.test(entry.label) ||
        !['personal', 'deployment'].includes(entry.scope) || !isSafePluginPath(entry.path) ||
        typeof entry.capability !== 'string' || !NAME.test(entry.capability) || (entry.scope === 'deployment' && entry.capability === 'view')) throw refuse('PLUGIN_SETTINGS_ENTRY_INVALID', 'Invalid plugin settings entry');
    // Settings paths are direct plugin-internal endpoints. UI aliases rewrite
    // requests before proxy authorization, so never accept an aliased entry.
    if ((manifest.ui?.routes ?? []).some(route => {
      const prefix = route.path.replace(/\/+$/, '');
      return entry.path === prefix || entry.path.startsWith(prefix + '/');
    })) throw refuse('PLUGIN_SETTINGS_ALIAS_OVERLAP', 'Plugin settings cannot overlap a UI route alias');
    settingIds.add(entry.id);
    const rule = matchingPluginRule((manifest.api.allow ?? []) as PluginProxyRule[], 'GET', entry.path);
    if (!rule || rule.capability !== entry.capability) throw refuse('PLUGIN_SETTINGS_RULE_MISSING', 'Plugin settings require a matching protected GET rule');
  }
  // Card bedf50cc (E380): host-stored settings are declared, never inferred.
  // A schema outside the closed type set or its limits refuses the plugin.
  if (!isValidPluginSettingsSchema(manifest.ui?.settings_schema)) throw refuse('PLUGIN_SETTINGS_SCHEMA_INVALID', 'Invalid plugin settings schema');
  if (config.access?.assertion_key_env && !/^[A-Z][A-Z0-9_]{2,127}$/.test(config.access.assertion_key_env)) throw refuse('PLUGIN_ASSERTION_KEY_INVALID', 'Invalid assertion key reference');
}
/** The refusal for an installation that shares its assertion key with another (card bedf50cc, E380 N16). */
export function pluginAssertionKeyShared(): PluginContractError {
  return refuse('PLUGIN_ASSERTION_KEY_SHARED', 'Plugin assertion key shared with another installation');
}
/** Whether the installation's own per-Account list names this capability for this Account. */
export function pluginAccountHasExplicitGrant(config: PluginConfig, accountId: string | null, capability: string): boolean {
  return !!accountId && Array.isArray(config.access?.accounts?.[accountId]) &&
    config.access!.accounts![accountId].includes(capability);
}
/** Whether the deployment default gives every Account view. Re-checked at use, so a
 * value that never passed load validation grants nothing. */
function pluginDefaultGrantsView(config: PluginConfig): boolean {
  const value = config.access?.default;
  return Array.isArray(value) && value.length === 1 && value[0] === PLUGIN_DEFAULT_CAPABILITY;
}
/** Read access: the explicit per-Account list, or the deployment default for `view`
 * only. A write path never consults this; it uses pluginAccountHasExplicitGrant. */
export function pluginAccountCan(config: PluginConfig, accountId: string | null, capability = 'view'): boolean {
  if (!accountId) return false;
  if (pluginAccountHasExplicitGrant(config, accountId, capability)) return true;
  return capability === PLUGIN_DEFAULT_CAPABILITY && pluginDefaultGrantsView(config);
}
export function matchingPluginRule(rules: PluginProxyRule[], method: string, path: string): PluginProxyRule | undefined {
  // Overlapping rules must never make a broad view grant authorize a narrow write.
  return rules.filter(r => r.methods.includes(method.toUpperCase()) &&
    (r.match === 'exact' ? path === r.path : r.path === '/' || path === r.path || path.startsWith(r.path + '/')))
    .sort((a,b) => b.path.length - a.path.length || (a.match === 'exact' ? -1 : 1))[0];
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Whether this Account can use any effective write allow rule through the host proxy.
 * This is registry description, never an authorization result: the proxy checks
 * its current scopes, Account and selected rule again on every request.
 */
export function pluginCanWriteThroughProxy(config: PluginConfig, accountId: string | null,
  scopes: readonly string[], rules: PluginProxyRule[]): boolean {
  if (!accountId || (!scopes.includes('services:write') && !scopes.includes('root'))) return false;
  for (const rule of rules) {
    // A write is described from the explicit per-Account list only: the
    // deployment default never makes an Account write-capable.
    if (!rule.capability || rule.capability === 'view' ||
        !pluginAccountHasExplicitGrant(config, accountId, rule.capability)) continue;
    for (const method of WRITE_METHODS) {
      if (!rule.methods.includes(method)) continue;
      // The rule's own path witnesses an exact rule. For a prefix rule, a
      // fresh immediate child also witnesses its unshadowed descendants.
      // At most one immediate child segment per competing rule can shadow it,
      // so rules.length + 1 candidates suffice; matchingPluginRule remains
      // the single authority for longest-path/exact precedence.
      const witnesses = [rule.path];
      if (rule.match === 'prefix') {
        const base = rule.path === '/' ? '/' : rule.path + '/';
        for (let i = 0; i <= rules.length; i++) {
          const child = base + i.toString(36);
          if (!rules.some(other => other !== rule &&
              other.methods.includes(method) && other.path.startsWith(child) &&
              (other.path.length === child.length || other.path[child.length] === '/'))) {
            witnesses.push(child);
            break;
          }
        }
      }
      if (witnesses.some(path => matchingPluginRule(rules, method, path) === rule)) return true;
    }
  }
  return false;
}

/**
 * Whether one settings entry is read-only for this caller: true unless a POST,
 * PUT, PATCH or DELETE request to the entry's own path selects (the proxy's
 * longest-path and exact-match precedence, matchingPluginRule) a rule with a
 * non-view capability that the Account holds in its explicit per-Account entry,
 * and the caller carries services:write or root. A write rule that reaches only
 * a descendant or a sibling of the path does not make the entry writable, and
 * the deployment view default never does. Registry description only: the proxy
 * checks the current scope, Account, selected rule and grant on every request.
 */
export function pluginSettingReadOnly(config: PluginConfig, accountId: string | null,
  scopes: readonly string[], rules: PluginProxyRule[], path: string): boolean {
  if (!accountId || (!scopes.includes('services:write') && !scopes.includes('root'))) return true;
  for (const method of WRITE_METHODS) {
    const rule = matchingPluginRule(rules, method, path);
    if (!rule || !rule.capability || rule.capability === PLUGIN_DEFAULT_CAPABILITY) continue;
    if (pluginAccountHasExplicitGrant(config, accountId, rule.capability)) return false;
  }
  return true;
}
