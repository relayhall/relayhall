import fs from 'fs';
import path from 'path';
import { AppearanceView, BUILT_IN_APPEARANCE } from '../services/AppearanceService';
import { isFlagOn, FLAG_SESSIONS } from '../utils/featureFlags';

export interface FeaturesConfig {
  taskBoard: boolean;
  projects: boolean;
  skills: boolean;
  auditLog: boolean;
}
export interface PathsConfig { dataDir: string; mediaDir: string }
export interface ServicesConfig { taskApiUrl: string }
export interface DeploymentConfig { domain: string; port: number; useHttps: boolean; corsOrigin: string }
export interface PluginsConfig {
  configFile: string;
  enabled: boolean;
  healthCheckIntervalMs: number;
}
export interface RelayHallConfig {
  features: FeaturesConfig;
  paths: PathsConfig;
  services: ServicesConfig;
  deployment: DeploymentConfig;
  plugins: PluginsConfig;
}

const DEFAULT_CONFIG: RelayHallConfig = {
  features: { taskBoard: true, projects: true, skills: true, auditLog: true },
  paths: { dataDir: '/data', mediaDir: '/data/media' },
  services: { taskApiUrl: 'http://localhost:3001/api' },
  deployment: { domain: 'localhost', port: 8082, useHttps: false, corsOrigin: 'http://localhost:8082' },
  plugins: { configFile: './relayhall.plugins.json', enabled: true, healthCheckIntervalMs: 60000 },
};

let legacyAppearanceDisplayName: string | null = null;

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (sourceValue === undefined) continue;
    if (typeof sourceValue === 'object' && !Array.isArray(sourceValue) && sourceValue !== null &&
        typeof targetValue === 'object' && !Array.isArray(targetValue) && targetValue !== null) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue as any;
    }
  }
  return result;
}

function loadConfig(): RelayHallConfig {
  const configPath = process.env.RELAYHALL_CONFIG || './relayhall.config.json';
  try {
    const resolvedPath = path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(resolvedPath)) {
      console.log(`ℹ️  Config file not found at ${resolvedPath}, using defaults`);
      return DEFAULT_CONFIG;
    }
    const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as Record<string, unknown>;
    // UI.4 retires file-backed branding. The only compatibility bridge is a
    // one-time import of the old sidebarTitle into Appearance.displayName.
    const branding = raw.branding;
    if (branding && typeof branding === 'object' && !Array.isArray(branding)) {
      const sidebarTitle = (branding as Record<string, unknown>).sidebarTitle;
      if (typeof sidebarTitle === 'string' && sidebarTitle.trim()) {
        legacyAppearanceDisplayName = sidebarTitle.trim().slice(0, 100);
      }
    }
    // Closed operational config: legacy bot/branding keys are not merged back
    // into the runtime object and can never reappear through GET /config.
    const operational = { ...raw };
    delete operational.bot;
    delete operational.branding;
    console.log(`✅ Loaded RelayHall config from ${resolvedPath}`);
    return deepMerge(DEFAULT_CONFIG, operational as Partial<RelayHallConfig>);
  } catch (error) {
    console.error('[config] load failed; using built-in operational defaults');
    return DEFAULT_CONFIG;
  }
}

/** Consumed once after migrations; a populated Appearance row always wins. */
export function getLegacyAppearanceDisplayName(): string | null {
  return legacyAppearanceDisplayName;
}

/** Exact unauthenticated allowlist. No deployment-info or historical fields. */
/**
 * The SSO half of the presence block (design d95136d7 3.2, RH-P5.SSO.W2).
 *
 * PRESENCE ONLY, and the type is the guarantee: there is no field here for an
 * issuer, a client id or an endpoint, so a future edit that wanted to leak one
 * would have to widen this interface in a diff a reviewer reads.
 */
export interface SsoPresence {
  enabled: boolean;
  /** The label on the login button. Never the issuer. */
  displayName: string | null;
}

export function getPublicConfig(
  config: RelayHallConfig,
  appearance?: AppearanceView,
  sso?: SsoPresence,
  firstRun?: boolean,
) {
  const effective = appearance?.effective ?? BUILT_IN_APPEARANCE;
  return {
    displayName: effective.displayName,
    loginTitle: effective.loginTitle,
    loginSubtitle: effective.loginSubtitle,
    defaultTheme: effective.defaultTheme,
    // Only an explicit deployment override is served: the frontend injects this
    // value as a root inline style that outranks every [data-theme] binding, so
    // serving the built-in default here would clobber the per-theme accents
    // (relay-light teal-700, high-contrast teal-300) with the dark default.
    accentColor: appearance?.overrides.accentColor ?? null,
    assets: {
      logo: appearance?.assets.logo?.url ?? null,
      favicon: appearance?.assets.favicon?.url ?? null,
      mark: appearance?.assets.mark?.url ?? null,
    },
    features: config.features,
    // SS-W1 presence block. The login page has to know whether this
    // deployment offers per-Account login sessions before anyone has
    // authenticated, and it must learn NOTHING else: no handle, no Account
    // list, no identity-provider detail. SS-W2 extends this same block with
    // the SSO presence fields (design d95136d7 §3.2).
    auth: {
      sessions: isFlagOn(FLAG_SESSIONS),
      // SS-W2. An unauthenticated caller learns that this deployment
      // federates and what to call the button - which they learn anyway the
      // moment they click it - and NOTHING else.
      sso: {
        enabled: sso?.enabled ?? false,
        displayName: sso?.displayName ?? null,
      },
      // FIRST-RUN (owner ruling 60307311 §1.1). The login page has to know
      // whether this deployment still has no administrator Account, because
      // that is the one state in which it offers to create one. A BOOLEAN and
      // nothing else: an unauthenticated caller learns that this deployment
      // has not been set up yet — which it learns anyway from the step being
      // on the page — and no handle, no Account count, no role.
      //
      // The default is `false`, so every arm that could not establish the
      // state (an unreadable substrate, an older caller passing three
      // arguments) withholds the step rather than advertising one it cannot
      // stand behind.
      firstRun: firstRun ?? false,
    },
  };
}

export const relayhallConfig = loadConfig();
