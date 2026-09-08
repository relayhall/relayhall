import type { BuiltInTheme } from '../utils/theme';

export interface FeaturesConfig { taskBoard: boolean; projects: boolean; skills: boolean; auditLog: boolean }
/**
 * SS-W1 presence block. Whether this deployment offers per-Account login
 * sessions — and nothing else about identity. SS-W2 extends it with the SSO
 * presence fields (design d95136d7 §3.2).
 */
export interface SsoPresenceConfig {
  enabled: boolean;
  /** The label on the login button. NEVER the issuer, and never an endpoint. */
  displayName: string | null;
}
export interface AuthConfig {
  sessions: boolean;
  sso: SsoPresenceConfig;
  /**
   * Owner ruling 60307311 §1.1: this deployment has no administrator Account
   * yet, so the login page offers to create one. A BOOLEAN and nothing else —
   * no handle, no count, no role.
   */
  firstRun: boolean;
}
export interface RelayHallPublicConfig {
  displayName: string;
  loginTitle: string;
  loginSubtitle: string;
  defaultTheme: BuiltInTheme;
  /** Explicit deployment accent override; null means the Theme's own accent rules. */
  accentColor: string | null;
  assets: { logo: string | null; favicon: string | null; mark: string | null };
  features: FeaturesConfig;
  auth: AuthConfig;
}

export const DEFAULT_CONFIG: RelayHallPublicConfig = {
  displayName: 'RelayHall',
  loginTitle: 'Welcome to RelayHall',
  loginSubtitle: 'Your governed work hub',
  defaultTheme: 'relay-dark',
  accentColor: null,
  assets: { logo: null, favicon: null, mark: null },
  features: { taskBoard: true, projects: true, skills: true, auditLog: true },
  // Fail CLOSED on the presence block: a deployment whose /config could not
  // be read is treated as offering no login sessions, so the login page falls
  // back to the break-glass form rather than to a door that is not there.
  auth: { sessions: false, sso: { enabled: false, displayName: null }, firstRun: false },
};

function isPublicConfig(value: unknown): value is RelayHallPublicConfig {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.displayName === 'string' && typeof item.loginTitle === 'string' &&
    typeof item.loginSubtitle === 'string' && typeof item.defaultTheme === 'string' &&
    (item.accentColor === null || typeof item.accentColor === 'string') &&
    Boolean(item.assets) && Boolean(item.features);
}

export async function fetchConfig(): Promise<RelayHallPublicConfig> {
  try {
    const apiBase = import.meta.env.VITE_API_BASE_URL || '/api';
    const response = await fetch(`${apiBase}/config`, { cache: 'no-store' });
    if (!response.ok) return DEFAULT_CONFIG;
    const config = await response.json();
    if (!isPublicConfig(config)) return DEFAULT_CONFIG;
    // Normalise the presence block rather than trusting its shape: a backend
    // older than SS-W1 omits it entirely, and `auth.sessions` is read on
    // every render of the login page.
    const auth = (config as {
      auth?: { sessions?: unknown; firstRun?: unknown; sso?: { enabled?: unknown; displayName?: unknown } };
    }).auth;
    // Each presence field fails closed on its own. A backend older than SS-W2
    // omits the sso block entirely, and "no SSO button" is survivable in a way
    // that "no login page" is not, so this never throws on a missing field.
    return {
      ...config,
      auth: {
        sessions: auth?.sessions === true,
        sso: {
          enabled: auth?.sso?.enabled === true,
          displayName: typeof auth?.sso?.displayName === 'string' ? auth.sso.displayName : null,
        },
        // Fails closed on its own, like each field beside it: anything but a
        // literal `true` withholds the step. A backend older than this wave
        // omits the field, and no first-run step is the survivable answer.
        firstRun: auth?.firstRun === true,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
