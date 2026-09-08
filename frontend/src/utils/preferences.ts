/**
 * Client for the principal's own preferences (RH-UI.2).
 *
 * There is no identifier in either call because the API has nowhere to put
 * one: the server derives the principal from the session. Keep it that way.
 */
import { authenticatedFetch } from './auth';
import {
  PrincipalPreferences,
  DEFAULT_PREFERENCES,
  isThemePreference,
  isReducedMotionPreference,
} from './theme';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/** Narrow an untrusted payload; anything unexpected reads as "no preference". */
export function toPreferences(payload: unknown): PrincipalPreferences {
  if (typeof payload !== 'object' || payload === null) return { ...DEFAULT_PREFERENCES };
  const source = payload as Record<string, unknown>;
  return {
    theme: isThemePreference(source.theme) ? source.theme : null,
    reducedMotion: isReducedMotionPreference(source.reducedMotion)
      ? source.reducedMotion
      : 'system',
  };
}

export async function fetchPreferences(): Promise<PrincipalPreferences> {
  const response = await authenticatedFetch(`${API_BASE_URL}/preferences`);
  if (!response.ok) throw new Error('Failed to load preferences');
  const body = await response.json();
  return toPreferences(body?.data);
}

export async function savePreferences(
  patch: Partial<PrincipalPreferences>
): Promise<PrincipalPreferences> {
  const response = await authenticatedFetch(`${API_BASE_URL}/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to save preferences');
  }
  return toPreferences(body?.data);
}
