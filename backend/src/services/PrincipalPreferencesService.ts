/**
 * Per-principal presentation preferences (RH-DESIGN.6 §5.1, task 07113036).
 *
 * THE WHOLE SECURITY MODEL OF THIS SERVICE IS ITS SIGNATURE. Every method
 * takes `principalId` as its first argument and there is no method that takes
 * a row id, a handle, or a filter. The route derives that argument from the
 * authenticated session and from nowhere else, so a caller has no vocabulary
 * for naming another identity's preferences (review S-F11). Keep it that way:
 * the moment a "get by id" lands here, the IDOR the table's shape prevents
 * becomes reachable again.
 *
 * The Theme value space is imported from the plugin theme service rather than
 * re-typed, so the backend has ONE list. `system` is added here because it is
 * a resolution directive, not a Theme with a token table (A16).
 */
import { pool } from '../db/connection';
import { BUILT_IN_THEMES } from './pluginTheme';

/** `theme` value space: the Themes plus the `system` resolution directive. */
export const THEME_PREFERENCE_VALUES = [...BUILT_IN_THEMES, 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCE_VALUES)[number];

/**
 * Tri-state, not a boolean: §5.1 asks for "system-default, overridable", and a
 * boolean cannot distinguish "follow my operating system" from "force motion
 * on" — different answers for anyone whose OS setting is wrong for this one
 * application.
 */
export const REDUCED_MOTION_VALUES = ['system', 'reduce', 'no-preference'] as const;
export type ReducedMotionPreference = (typeof REDUCED_MOTION_VALUES)[number];

export interface PrincipalPreferences {
  /** null = no preference; the chain falls through to the deployment default. */
  theme: ThemePreference | null;
  reducedMotion: ReducedMotionPreference;
}

/** What a principal with no stored row has. Absence is a real answer. */
export const DEFAULT_PREFERENCES: PrincipalPreferences = {
  theme: null,
  reducedMotion: 'system',
};

export class PreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreferencesValidationError';
  }
}

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCE_VALUES as readonly string[]).includes(value);
}

function isReducedMotionPreference(value: unknown): value is ReducedMotionPreference {
  return typeof value === 'string' && (REDUCED_MOTION_VALUES as readonly string[]).includes(value);
}

/**
 * A submitted patch. Both fields are optional; `theme: null` is a MEANINGFUL
 * value ("clear my preference") and is distinguished from the field being
 * absent ("leave it alone"), because those are different requests.
 */
export interface PreferencesPatch {
  theme?: ThemePreference | null;
  reducedMotion?: ReducedMotionPreference;
}

/**
 * Validate an untrusted body into a patch. Rejects rather than coerces: a
 * silently-corrected Theme name is a preference the principal did not choose,
 * and the CHECK constraint would reject it anyway — better a named 400.
 */
export function parsePreferencesPatch(body: unknown): PreferencesPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PreferencesValidationError('Body must be an object');
  }
  const source = body as Record<string, unknown>;
  const patch: PreferencesPatch = {};

  if ('theme' in source) {
    const value = source.theme;
    if (value === null) {
      patch.theme = null;
    } else if (isThemePreference(value)) {
      patch.theme = value;
    } else {
      throw new PreferencesValidationError(
        `theme must be null or one of: ${THEME_PREFERENCE_VALUES.join(', ')}`);
    }
  }

  if ('reducedMotion' in source) {
    if (!isReducedMotionPreference(source.reducedMotion)) {
      throw new PreferencesValidationError(
        `reducedMotion must be one of: ${REDUCED_MOTION_VALUES.join(', ')}`);
    }
    patch.reducedMotion = source.reducedMotion;
  }

  if (Object.keys(patch).length === 0) {
    throw new PreferencesValidationError('Provide theme, reducedMotion, or both');
  }
  return patch;
}

interface PreferencesRow {
  theme: string | null;
  reduced_motion: string;
}

/**
 * Map a stored row defensively. A value outside the current space (an old
 * Theme left behind by a downgrade, say) reads as "no preference" rather than
 * as itself: the engine would fall back anyway, and returning a name no
 * surface can render only produces a control stuck on an invisible option.
 */
function toPreferences(row: PreferencesRow | undefined): PrincipalPreferences {
  if (!row) return { ...DEFAULT_PREFERENCES };
  return {
    theme: isThemePreference(row.theme) ? row.theme : null,
    reducedMotion: isReducedMotionPreference(row.reduced_motion) ? row.reduced_motion : 'system',
  };
}

export class PrincipalPreferencesService {
  /** The authenticated principal's own preferences; defaults when unset. */
  async get(principalId: string): Promise<PrincipalPreferences> {
    const result = await pool.query<PreferencesRow>(
      'SELECT theme, reduced_motion FROM principal_preferences WHERE principal_id = $1',
      [principalId]
    );
    return toPreferences(result.rows[0]);
  }

  /**
   * Upsert the authenticated principal's own preferences.
   *
   * COALESCE on the EXCLUDED side would make `theme: null` unable to clear a
   * stored Theme, so the statement passes an explicit "did the caller mention
   * this field" flag per column and the update chooses between the new value
   * and the existing one. Absence and null stay distinguishable all the way
   * into SQL.
   */
  async save(principalId: string, patch: PreferencesPatch): Promise<PrincipalPreferences> {
    const themeGiven = 'theme' in patch;
    const motionGiven = 'reducedMotion' in patch;
    const result = await pool.query<PreferencesRow>(
      `INSERT INTO principal_preferences (principal_id, theme, reduced_motion)
            VALUES ($1, $2, COALESCE($4, 'system'))
       ON CONFLICT (principal_id) DO UPDATE
              SET theme = CASE WHEN $3 THEN EXCLUDED.theme ELSE principal_preferences.theme END,
                  reduced_motion = CASE WHEN $5 THEN EXCLUDED.reduced_motion
                                        ELSE principal_preferences.reduced_motion END,
                  updated_at = now()
         RETURNING theme, reduced_motion`,
      [
        principalId,
        themeGiven ? patch.theme ?? null : null,
        themeGiven,
        motionGiven ? patch.reducedMotion : null,
        motionGiven,
      ]
    );
    return toPreferences(result.rows[0]);
  }
}

export const principalPreferencesService = new PrincipalPreferencesService();
