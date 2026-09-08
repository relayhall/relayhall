import React from 'react';
import { Loader2, Settings } from 'lucide-react';
import { Navigate, NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { useMyPrincipal } from '../hooks/usePrincipals';
import {
  SettingsNavAudience,
  firstVisibleSettingsPath,
  visibleSettingsGroups,
} from '../config/settingsNavigation';
import { SETTINGS_ROUTE_ALIASES, settingsAliasTarget } from '../config/settingsRouteAliases';
import { RequestStatus } from '../components/RequestStatus';
import './SettingsPage.css';

/**
 * THE ONE SETTINGS DESTINATION.
 *
 * Card `d0f030a9` (RH-UI.SETTINGS.2), contract `8dbc0b81`. One sidebar entry,
 * one shell, one stable left navigation in three groups — Preferences, Access
 * administration, Deployment. The information architecture itself is
 * `config/settingsNavigation`; this file renders it and nothing more.
 *
 * ── WHAT DECIDES WHAT A PERSON SEES ──
 *
 * The server. `GET /principals/me` answers `settingsSurfaces`, computed by
 * `AccessSurfaceService.armDecision` — literally the function the request path
 * calls before admitting a read on that surface. The shell holds no predicate
 * of its own, because the previous shell's `scopes.includes('root')` had
 * already drifted: a non-root Account placed at Administrative `use` may READ
 * the Appearance families, and the tab was hidden from it anyway.
 *
 * An entry this session may not see is NOT RENDERED (SETGOV `83defda6`). Not
 * disabled, not greyed, not present-with-a-refusal: a disabled control still
 * discloses that the deployment has the thing, which is the disclosure the
 * arm's 404 concealment exists to prevent.
 */

/** The audience question, asked once and answered by the server (`useMyPrincipal`). */
function useSettingsAudience(): { audience: SettingsNavAudience; loading: boolean; resolved: boolean; failed: boolean; reload: () => void } {
  const { me, scopes, settingsSurfaces, loading, failed, reload } = useMyPrincipal();
  // The pre-SETGOV predicate, kept for exactly one job: the fallback when the
  // board did not answer `settingsSurfaces`. It is never the primary rule.
  const canManage = Array.isArray(scopes)
    ? scopes.includes('root')
    : me?.role === 'admin' || me?.role === 'orchestrator';
  return {
    audience: { surfaces: settingsSurfaces, canManage },
    loading,
    failed,
    reload,
    resolved: Boolean(me) || canManage,
  };
}

/**
 * Authority-aware `/settings` landing. It lands on the FIRST entry this
 * session can see rather than on a hardcoded page, so a deployment that grants
 * one Account exactly one surface lands it there instead of bouncing it off a
 * page it may not read.
 */
export const SettingsIndexRedirect: React.FC = () => {
  const audience = useOutletContext<SettingsNavAudience | undefined>();
  if (!audience) return null;
  const first = firstVisibleSettingsPath(audience);
  if (!first) return null;
  return <Navigate to={first} replace />;
};

/**
 * A moved route, resolving to its new home WITH the query string and the
 * fragment it was given. `replace` so the Back button returns to wherever the
 * person came from and not to the alias, which would bounce them forward
 * again — the browser-history semantics the contract names.
 */
export const SettingsRouteAlias: React.FC<{ alias: (typeof SETTINGS_ROUTE_ALIASES)[number] }> = ({ alias }) => {
  const location = useLocation();
  return <Navigate to={settingsAliasTarget(alias, location)} replace />;
};

export const SettingsPage: React.FC = () => {
  const { audience, loading, resolved, failed, reload } = useSettingsAudience();
  const sections = visibleSettingsGroups(audience);

  if (loading) {
    return (
      <div className="settings-state" role="status">
        <Loader2 className="settings-spin" aria-hidden="true" /> Loading settings…
      </div>
    );
  }

  if (failed) {
    return (
      <div className="settings-page">
        <header className="settings-header"><Settings aria-hidden="true" /><h1>Settings</h1></header>
        <RequestStatus loading={false} label="Loading settings…" error="Settings could not be loaded. Please try again." onRetry={reload} />
      </div>
    );
  }

  // An identity with no principal row, and no root authority either: there is
  // nothing here for it. The refusal says so without naming a single surface.
  if (!resolved || sections.length === 0) {
    return (
      <div className="settings-page">
        <header className="settings-header">
          <Settings aria-hidden="true" />
          <h1>Settings</h1>
        </header>
        <div className="settings-error" role="alert">
          This identity has no settings to administer.
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <header className="settings-header">
        <Settings aria-hidden="true" />
        <div>
          <h1>Settings</h1>
          <p>Your preferences, and the administration this identity is authorised for.</p>
        </div>
      </header>

      <div className="settings-body">
        {/* A landmark of its own, named: a screen reader user tabbing into the
            shell is told which navigation this is, and the sidebar's "Main
            navigation" landmark keeps its own name. `aria-current="page"` on
            the active entry is NavLink's default and is what announces the
            position — the active class is decoration on top of it. */}
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ group, items }) => (
            <div className="settings-nav-group" key={group.id}>
              <h2 className="settings-nav-heading" id={`settings-group-${group.id}`}>{group.label}</h2>
              <ul className="settings-nav-list" aria-labelledby={`settings-group-${group.id}`}>
                {items.map(({ id, path, label, description, icon: Icon }) => (
                  <li key={id}>
                    <NavLink
                      to={path}
                      className={({ isActive }) => (isActive ? 'settings-nav-link settings-nav-link--active' : 'settings-nav-link')}
                    >
                      <Icon size={16} aria-hidden="true" className="settings-nav-icon" />
                      <span className="settings-nav-text">
                        <span className="settings-nav-label">{label}</span>
                        <span className="settings-nav-description">{description}</span>
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="settings-content">
          {/* ROUND-1 REVIEW P1, ROUND-2 REVIEW P1. The navigation was filtered
              and the outlet was not, so a direct visit to a concealed child —
              a bookmark, a typed URL, a link from somewhere else — still
              MOUNTED that page behind an absent link. The first repair filtered
              HERE, by comparing `location.pathname` to each entry's path; that
              was a second matcher beside React Router's, and `/settings/access/`
              and `/settings/ACCESS` both route to the child while equalling no
              entry path, so both walked straight through it.

              The shell no longer decides it. Each child route's own element is
              `SettingsEntryGuard` (`config/settingsRoutes`), which runs because
              the ROUTER matched that child and guards exactly the entry that
              route belongs to — so every spelling the router accepts is a
              spelling the guard sees, with nothing left to keep in agreement.
              What crosses this seam now is the AUDIENCE, and only that: one
              server answer, computed once, handed to whichever child mounted. */}
          <Outlet context={audience} />
        </div>
      </div>
    </div>
  );
};
