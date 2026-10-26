import { authenticatedFetch } from './auth';

/**
 * Plugin availability and host-stored plugin settings (card bedf50cc; owner
 * ruling E380). The board decides everything: these calls carry no authority,
 * and every write is checked again on the server (the Account's own session
 * for its own writes, an administrator session and a step-up for the
 * administrators' writes). Every PUT sends If-Match with the revision last
 * read (0 before the first write) and a fresh Idempotency-Key.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export type PluginAvailabilityState = 'required' | 'default_on' | 'available' | 'disabled';
export type PluginSettingType = 'boolean' | 'string' | 'text' | 'integer' | 'number' | 'enum' | 'multi_enum' | 'secret';
export type PluginSettingScope = 'deployment' | 'account' | 'account_overridable';

export interface PluginSettingDeclaration {
  key: string;
  label: string;
  help?: string;
  type: PluginSettingType;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  max_length?: number;
  default?: unknown;
  scope: PluginSettingScope;
  deliver?: 'frame_and_backend' | 'backend';
}

export interface SettingSource { source: 'account' | 'deployment' | 'default'; locked: boolean }

export interface PluginChoice {
  name: string;
  label: string;
  state: Exclude<PluginAvailabilityState, 'disabled'>;
  enabled: boolean;
  userControlled: boolean;
  revision: number;
}

export interface OwnPluginSettings {
  name: string;
  label: string;
  revision: number;
  schema: PluginSettingDeclaration[];
  values: Record<string, unknown>;
  sources: Record<string, SettingSource>;
  stale: string[];
}

export interface AdministeredPlugin {
  name: string;
  label: string;
  description: string;
  state: PluginAvailabilityState;
  revision: number;
  settings: number;
}

export interface DeploymentPluginSettings {
  name: string;
  revision: number;
  schema: PluginSettingDeclaration[];
  values: Record<string, unknown>;
  lockedKeys: string[];
  stale: { keys: string[]; lockedKeys: string[]; accountRows: number };
}

/** A refused call keeps the server's code: the codes are what a person acts on. */
export class PluginSettingsRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly field?: string) {
    super(message);
    this.name = 'PluginSettingsRequestError';
  }
}

function retryKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `plugin-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function answer<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PluginSettingsRequestError(response.status, data.code, data.message || data.error || `Request failed (${response.status})`, data.field);
  }
  return data as T;
}

function write(path: string, method: 'PUT' | 'POST', body: unknown, revision?: number): Promise<Response> {
  return authenticatedFetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': retryKey(),
      ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
    },
    body: JSON.stringify(body),
  });
}

const encoded = (name: string) => encodeURIComponent(name);

export async function fetchPluginChoices(): Promise<PluginChoice[]> {
  return (await answer<{ plugins: PluginChoice[] }>(await authenticatedFetch(`${API_BASE}/plugin-host/choices`))).plugins ?? [];
}
export async function savePluginChoice(name: string, enabled: boolean, revision: number): Promise<{ enabled: boolean; revision: number }> {
  return answer(await write(`/plugin-host/${encoded(name)}/choice`, 'PUT', { enabled }, revision));
}
export async function fetchOwnPluginSettings(name: string): Promise<OwnPluginSettings> {
  return answer(await authenticatedFetch(`${API_BASE}/plugin-host/${encoded(name)}/settings`));
}
export async function saveOwnPluginSettings(name: string, values: Record<string, unknown>, revision: number): Promise<{ revision: number }> {
  return answer(await write(`/plugin-host/${encoded(name)}/settings/account`, 'PUT', { values }, revision));
}
export async function fetchAdministeredPlugins(): Promise<AdministeredPlugin[]> {
  return (await answer<{ plugins: AdministeredPlugin[] }>(await authenticatedFetch(`${API_BASE}/plugin-admin`))).plugins ?? [];
}
export async function savePluginPolicy(name: string, body: { availability: PluginAvailabilityState; clearChoices: boolean; stepUpToken: string },
  revision: number): Promise<{ revision: number; clearedChoices: number }> {
  return answer(await write(`/plugin-admin/${encoded(name)}/policy`, 'PUT', body, revision));
}
export async function fetchDeploymentPluginSettings(name: string): Promise<DeploymentPluginSettings> {
  return answer(await authenticatedFetch(`${API_BASE}/plugin-admin/${encoded(name)}/settings`));
}
export async function saveDeploymentPluginSettings(name: string,
  body: { values: Record<string, unknown>; lockedKeys: string[]; stepUpToken: string }, revision: number): Promise<{ revision: number }> {
  return answer(await write(`/plugin-admin/${encoded(name)}/settings`, 'PUT', body, revision));
}
export async function cleanUpPluginSettings(name: string, stepUpToken: string): Promise<{ rowsChanged: number; keysRemoved: string[] }> {
  return answer(await write(`/plugin-admin/${encoded(name)}/settings/cleanup`, 'POST', { stepUpToken }));
}

/** The step-up binding of every administrator write (`plugin.admin`, the plugin name). */
export const PLUGIN_ADMIN_STEP_UP_ACTION = 'plugin.admin';

export const AVAILABILITY_LABELS: Record<PluginAvailabilityState, string> = {
  required: 'Required for everyone',
  default_on: 'On unless a person turns it off',
  available: 'Off unless a person turns it on',
  disabled: 'Disabled for everyone',
};
