import { authenticatedFetch } from '../utils/auth';
import type { BuiltInTheme } from '../utils/theme';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export type AssetKind = 'logo' | 'favicon' | 'mark';

export const APPEARANCE_LINK_KINDS = ['support', 'contact', 'privacy', 'status', 'custom'] as const;
export type AppearanceLinkKind = typeof APPEARANCE_LINK_KINDS[number];
export interface AppearanceLink { kind: AppearanceLinkKind; label: string; url: string }
export interface AppearanceInfo {
  displayName: string | null;
  description: string;
  links: AppearanceLink[];
  teamMarkdown: string;
}

export function parseAppearanceInfo(value: unknown): AppearanceInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Deployment information is unavailable');
  }
  const item = value as Record<string, unknown>;
  if (
    (item.displayName !== null && typeof item.displayName !== 'string') ||
    typeof item.description !== 'string' ||
    typeof item.teamMarkdown !== 'string' ||
    !Array.isArray(item.links) ||
    item.links.some((link) => !link || typeof link !== 'object' || Array.isArray(link) ||
      typeof (link as Record<string, unknown>).kind !== 'string' ||
      !APPEARANCE_LINK_KINDS.includes((link as Record<string, unknown>).kind as AppearanceLinkKind) ||
      typeof (link as Record<string, unknown>).label !== 'string' ||
      typeof (link as Record<string, unknown>).url !== 'string')
  ) {
    throw new Error('Deployment information is unavailable');
  }
  return {
    displayName: item.displayName as string | null,
    description: item.description,
    teamMarkdown: item.teamMarkdown,
    links: item.links as AppearanceLink[],
  };
}
export interface AppearanceOverrides {
  displayName: string | null;
  loginTitle: string | null;
  loginSubtitle: string | null;
  defaultTheme: BuiltInTheme | null;
  accentColor: string | null;
  description: string | null;
  links: AppearanceLink[];
  teamMarkdown: string | null;
}
export interface EffectiveAppearance extends Omit<AppearanceOverrides, 'displayName' | 'loginTitle' | 'loginSubtitle' | 'defaultTheme' | 'accentColor' | 'description' | 'teamMarkdown'> {
  displayName: string;
  loginTitle: string;
  loginSubtitle: string;
  defaultTheme: BuiltInTheme;
  accentColor: string;
  description: string;
  teamMarkdown: string;
}
export interface AppearanceAsset {
  id: string;
  kind: AssetKind;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  url: string;
}
export interface AppearanceView {
  overrides: AppearanceOverrides;
  effective: EffectiveAppearance;
  assets: Partial<Record<AssetKind, AppearanceAsset>>;
  updatedAt: string | null;
}
export interface AppearanceVersion {
  id: string;
  versionNo: number;
  snapshot: AppearanceOverrides;
  assetRefs: Partial<Record<AssetKind, string>>;
  reason: 'save' | 'revert' | 'reset';
  createdAt: string;
  createdBy: string | null;
}

async function bodyOrError(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.message || data.error || `Appearance request failed (${response.status})`);
  }
  return data.data;
}

export async function loadAppearance(): Promise<AppearanceView> {
  return bodyOrError(await authenticatedFetch(`${API_BASE}/appearance`));
}

export async function loadAppearanceInfo(signal?: AbortSignal): Promise<AppearanceInfo> {
  return parseAppearanceInfo(await bodyOrError(await authenticatedFetch(`${API_BASE}/appearance/info`, {
    cache: 'no-store',
    signal,
  })));
}

export async function saveAppearance(overrides: AppearanceOverrides): Promise<AppearanceView> {
  const result = await bodyOrError(await authenticatedFetch(`${API_BASE}/appearance`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides),
  }));
  return result.appearance;
}

export async function resetAppearance(): Promise<AppearanceView> {
  const result = await bodyOrError(await authenticatedFetch(`${API_BASE}/appearance/reset`, { method: 'POST' }));
  return result.appearance;
}

export async function listAppearanceVersions(): Promise<AppearanceVersion[]> {
  return bodyOrError(await authenticatedFetch(`${API_BASE}/appearance/versions`));
}

export async function revertAppearance(versionNo: number): Promise<AppearanceView> {
  const result = await bodyOrError(await authenticatedFetch(
    `${API_BASE}/appearance/versions/${versionNo}/revert`, { method: 'POST' }
  ));
  return result.appearance;
}

export async function uploadAppearanceAsset(kind: AssetKind, file: File): Promise<AppearanceAsset> {
  const form = new FormData();
  form.append('asset', file);
  return bodyOrError(await authenticatedFetch(`${API_BASE}/appearance/assets/${kind}`, {
    method: 'POST', body: form,
  }));
}
