import React, { useState } from 'react';
import { SlidersHorizontal, Check, Loader2 } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { useRelayHallConfig } from '../contexts/RelayHallConfigContext';
import { LoginSessions } from '../components/access/LoginSessions';
import {
  BUILT_IN_THEMES,
  REDUCED_MOTION_LABELS,
  REDUCED_MOTION_VALUES,
  THEME_LABELS,
  THEME_PREFERENCE_VALUES,
  ThemePreference,
  ReducedMotionPreference,
  motionIsReduced,
} from '../utils/theme';
import './PreferencesPage.css';

/**
 * The user config page (RH-DESIGN.6 §5.1, owner ruling: these controls live
 * HERE and not in the main GUI chrome). One principal's own presentation
 * settings; nothing on this page can affect anybody else's deployment or
 * anybody else's account.
 *
 * "Use the deployment default" is a real option, not an absence: it stores
 * NULL and hands the choice back to whatever the deployment sets in
 * Appearance (RH-UI.4). It is offered first because it is the state a
 * principal who has never visited this page is already in.
 */
const THEME_DESCRIPTIONS: Record<ThemePreference, string> = {
  'relay-dark': 'Slate surfaces, teal accent. The default.',
  'relay-light': 'The same ledger on paper, for bright rooms.',
  'high-contrast': 'Black ground, solid borders, the brightest inks.',
  system: 'Follow the light or dark setting of your operating system.',
};

const DEPLOYMENT_DEFAULT = 'deployment-default';

export const PreferencesPage: React.FC = () => {
  const { preferences, resolvedTheme, loading, updatePreferences } = useTheme();
  const { config } = useRelayHallConfig();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const commit = async (
    field: string,
    patch: { theme?: ThemePreference | null; reducedMotion?: ReducedMotionPreference }
  ) => {
    setError(null);
    setSaved(false);
    setSaving(field);
    try {
      await updatePreferences(patch);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that preference');
    } finally {
      setSaving(null);
    }
  };

  const selectedTheme: string = preferences.theme ?? DEPLOYMENT_DEFAULT;
  const motionReduced = motionIsReduced(preferences.reducedMotion);

  return (
    <div className="preferences-page">
      <header className="preferences-header">
        <div className="preferences-title">
          <SlidersHorizontal size={20} aria-hidden="true" />
          <h1>Preferences</h1>
        </div>
        <p className="preferences-intro">
          How RelayHall looks for you. These settings apply to your account on this
          deployment and to nobody else.
        </p>
      </header>

      {error && (
        <div className="preferences-error" role="alert">
          {error}
        </div>
      )}

      <section className="preferences-section" aria-labelledby="preferences-theme-heading">
        <h2 id="preferences-theme-heading" className="preferences-section-title">Theme</h2>
        <p className="preferences-section-note">
          Currently showing <strong>{THEME_LABELS[resolvedTheme]}</strong>.
        </p>

        <fieldset className="preferences-fieldset" disabled={loading || saving !== null}>
          <legend className="preferences-legend">Choose a theme</legend>

          <label className="preferences-option" key={DEPLOYMENT_DEFAULT}>
            <input
              type="radio"
              name="theme"
              value={DEPLOYMENT_DEFAULT}
              checked={selectedTheme === DEPLOYMENT_DEFAULT}
              onChange={() => commit('theme', { theme: null })}
            />
            <span className="preferences-option-body">
              <span className="preferences-option-label">Use the deployment default</span>
              <span className="preferences-option-note">
                Follow whatever theme this deployment is set to.
              </span>
            </span>
          </label>

          {THEME_PREFERENCE_VALUES.map((theme) => (
            <label className="preferences-option" key={theme}>
              <input
                type="radio"
                name="theme"
                value={theme}
                checked={selectedTheme === theme}
                onChange={() => commit('theme', { theme })}
              />
              <span className="preferences-option-body">
                <span className="preferences-option-label">{THEME_LABELS[theme]}</span>
                <span className="preferences-option-note">{THEME_DESCRIPTIONS[theme]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {/* Live previews. `data-theme` sits on the TILE and nowhere wider: an
            island scoped one element too high pulls its own caption inside,
            and the caption is page chrome that must resolve against the page's
            Theme. Found by visual QA — the high-contrast caption rendered at
            1.28:1 on the light page. Enforced by check-theme-parity.py, which
            requires every themed island in TSX to be a declared preview scope. */}
        <ul className="preferences-swatches" aria-hidden="true">
          {BUILT_IN_THEMES.map((theme) => (
            <li key={theme} className="preferences-swatch">
              <span className="preferences-swatch-surface" data-theme={theme}>
                <span className="preferences-swatch-text">Aa</span>
                <span className="preferences-swatch-fill">Save</span>
              </span>
              <span className="preferences-swatch-name">{THEME_LABELS[theme]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="preferences-section" aria-labelledby="preferences-motion-heading">
        <h2 id="preferences-motion-heading" className="preferences-section-title">Motion</h2>
        <p className="preferences-section-note">
          Motion is currently <strong>{motionReduced ? 'reduced' : 'on'}</strong>.
        </p>

        <fieldset className="preferences-fieldset" disabled={loading || saving !== null}>
          <legend className="preferences-legend">Animations and transitions</legend>
          {REDUCED_MOTION_VALUES.map((value) => (
            <label className="preferences-option" key={value}>
              <input
                type="radio"
                name="reducedMotion"
                value={value}
                checked={preferences.reducedMotion === value}
                onChange={() => commit('reducedMotion', { reducedMotion: value })}
              />
              <span className="preferences-option-body">
                <span className="preferences-option-label">{REDUCED_MOTION_LABELS[value]}</span>
                <span className="preferences-option-note">
                  {value === 'system'
                    ? 'Use your operating system setting. The default.'
                    : value === 'reduce'
                      ? 'Cut animations and transitions everywhere, whatever your system says.'
                      : 'Keep animations even if your system asks to reduce them.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      {config.auth.sessions && (
        <section className="preferences-section" aria-labelledby="preferences-sessions-heading">
          <h2 id="preferences-sessions-heading" className="preferences-section-title">Login sessions</h2>
          <p className="preferences-section-note">
            Where your account is currently signed in. Ending a session signs
            that browser out immediately.
          </p>
          <LoginSessions />
        </section>
      )}

      <p className="preferences-status" role="status">
        {saving !== null && (
          <>
            <Loader2 size={16} className="preferences-spinner" aria-hidden="true" />
            Saving…
          </>
        )}
        {saving === null && saved && (
          <>
            <Check size={16} aria-hidden="true" />
            Saved.
          </>
        )}
      </p>
    </div>
  );
};
