import { memo, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import './App.css';
import { Sidebar } from './components/Sidebar';
import { useWebSocket } from './hooks/useWebSocket';
import { DashboardPage } from './pages/DashboardPage';
import { TasksPage } from './pages/TasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TaskCreatePage } from './pages/TaskCreatePage';
import { ProjectsPage } from './pages/ProjectsPage';
import { CharterPage } from './pages/CharterPage';
import { PhasesPage } from './pages/PhasesPage';
import { AuditPage } from './pages/AuditPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatsPage } from './pages/StatsPage';
import { SkillsPage } from './pages/SkillsPage';
import { BlueprintsPage } from './pages/BlueprintsPage';
import { ToolsPage } from './pages/ToolsPage';
import { PersonalitiesPage } from './pages/PersonalitiesPage';
import { PersonalityDetailPage } from './pages/PersonalityDetailPage';
import { PrincipalsPage } from './pages/PrincipalsPage';
import { ReportsPage } from './pages/ReportsPage';
import { ReportDetailPage } from './pages/ReportDetailPage';
import { LoginPage } from './pages/LoginPage';
import { BreakGlassBanner } from './components/BreakGlassBanner';
import { PreferencesPage } from './pages/PreferencesPage';
import { AppearancePage } from './pages/AppearancePage';
import { SettingsPage } from './pages/SettingsPage';
import { GrantsPage } from './pages/GrantsPage';
import { AccessManagerPage } from './pages/AccessManagerPage';
import { MyConnectionsPage } from './pages/MyConnectionsPage';
import { AboutPage } from './pages/AboutPage';
import { OAuthConsentPage } from './pages/OAuthConsentPage';
import { ToastProvider } from './contexts/ToastContext';
import { RelayHallConfigProvider, useRelayHallConfig } from './contexts/RelayHallConfigContext';
import { PluginProvider, usePlugins } from './contexts/PluginContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { PluginFrame } from './components/PluginFrame';
import { auth } from './utils/auth';
import { SettingsIndexRedirect, SettingsRouteAlias } from './pages/SettingsPage';
import { SETTINGS_ROUTE_ALIASES } from './config/settingsRouteAliases';
import { settingsChildRoutes } from './config/settingsRoutes';
import type { SettingsNavEntryId } from './config/settingsNavigation';
import type { ReactNode } from 'react';

/**
 * THE PAGE BEHIND EACH SETTINGS ENTRY — the only per-entry thing App.tsx still
 * says about the settings space.
 *
 * ROUND-2 REVIEW P1. The mount path and the concealment guard are NOT here:
 * `settingsChildRoutes` generates one guarded `<Route>` per navigation entry,
 * so a child cannot be mounted that the navigation does not name and a child
 * cannot be mounted unguarded — there is no syntax for it. What remains is
 * this map, and its `Record` over the entry-id union means a missing page or a
 * page for a removed entry does not compile.
 */
const SETTINGS_PAGES: Record<SettingsNavEntryId, ReactNode> = {
  preferences: <PreferencesPage />,
  connections: <MyConnectionsPage />,
  // The Access manager (AZ-S4, design 4d961e37 A17.9): approvals, warrants,
  // inventory, reveals, remediation. Deep links land here (?approval=...) and
  // carry no authority — the login wall and the per-act step-up still gate
  // every decision.
  'access-manager': <AccessManagerPage />,
  'access-grants': <GrantsPage />,
  identities: <PrincipalsPage />,
  appearance: <AppearancePage />,
};

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(auth.isAuthenticated());

  // ef35d960: an SSO return carries only the httpOnly cookie, which no code on
  // this side can see. When the app boots signed out it asks once whether a
  // live login session exists; a 200 arms the marker and flips straight to
  // the board, a 401 leaves the login page exactly as it was. Deliberately not a render gate: first
  // paint stays synchronous, and the one-round-trip flash on an SSO return is
  // the cost of never blocking a genuinely signed-out visitor's login page.
  useEffect(() => {
    if (isAuthenticated) return;
    let cancelled = false;
    void auth.ensureSessionMarker().then((live) => {
      if (live && !cancelled) setIsAuthenticated(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only probe
  }, []);

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
  };

  // Wrap everything with RelayHallConfigProvider.
  // ThemeProvider sits INSIDE it and OUTSIDE the authentication branch: the
  // login page is themed too, and a principal who set relay-light should not
  // meet a dark login screen on their next visit (RH-DESIGN.6 §5.5).
  return (
    <RelayHallConfigProvider>
      <ConfiguredApp authenticated={isAuthenticated} onLoginSuccess={handleLoginSuccess} />
    </RelayHallConfigProvider>
  );
}

function ConfiguredApp({ authenticated, onLoginSuccess }: {
  authenticated: boolean;
  onLoginSuccess: () => void;
}) {
  const { config } = useRelayHallConfig();
  return (
    <ThemeProvider
      authenticated={authenticated}
      deploymentTheme={config.defaultTheme}
      deploymentFavicon={config.assets.favicon}
    >
      {!authenticated ? <LoginPage onLoginSuccess={onLoginSuccess} /> : <AuthenticatedApp />}
    </ThemeProvider>
  );
}

function AuthenticatedApp() {
  const { config } = useRelayHallConfig();
  const { connected: wsConnected } = useWebSocket();
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
  }));

  const basename = import.meta.env.BASE_URL || '/dashboard/';

  return (
    <Router basename={basename}>
      <QueryClientProvider client={queryClient}>
      <PluginProvider>
      <ToastProvider>
      <div className="app-container">
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <Sidebar connected={wsConnected} />

        <div className="app">
          {/* Above the routed content and outside it: the announcement is
              about the SESSION, not about whatever page it is on. */}
          <BreakGlassBanner />
          <main id="main-content" className="main-content">
            <RouteTransition>
              <MemoizedAppRoutes config={config} />
            </RouteTransition>
          </main>

        </div>
      </div>
      </ToastProvider>
      </PluginProvider>
      </QueryClientProvider>
    </Router>
  );
}

/**
 * CSS-only route transition — re-triggers fadeIn on path change
 */
function RouteTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <div className="route-transition" key={location.pathname}>
      {children}
    </div>
  );
}

/**
 * App routes component that includes both static and plugin routes
 */
function AppRoutes({ config }: { config: ReturnType<typeof useRelayHallConfig>['config'] }) {
  const { pluginRoutes, loading: pluginsLoading } = usePlugins();
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  return (
    <Routes>
      {/* Core routes */}
      <Route path="/" element={<DashboardPage />} />
      {config.features.taskBoard && <Route path="/tasks" element={<TasksPage />} />}
      {/* Create mode registers BEFORE the :taskId matcher (986be411 §7, E6). */}
      {config.features.taskBoard && <Route path="/tasks/new" element={<TaskCreatePage />} />}
      {config.features.taskBoard && <Route path="/tasks/:taskId" element={<TaskDetailPage />} />}
      {config.features.projects && <Route path="/projects" element={<ProjectsPage />} />}
      {config.features.projects && <Route path="/projects/:id/charter" element={<CharterPage />} />}
      {config.features.projects && <Route path="/projects/:id/phases" element={<PhasesPage />} />}
      <Route path="/sessions" element={<SessionsPage />} />
      {config.features.auditLog && <Route path="/audit" element={<AuditPage />} />}
      <Route path="/reports" element={<ReportsPage />} />
      <Route path="/reports/:id" element={<ReportDetailPage />} />
      {config.features.skills && <Route path="/skills" element={<SkillsPage />} />}
      <Route path="/blueprints" element={<BlueprintsPage />} />
      <Route path="/tools" element={<ToolsPage />} />
      <Route path="/personalities" element={<PersonalitiesPage />} />
      <Route path="/personalities/:id" element={<PersonalityDetailPage />} />
      <Route path="/stats" element={<StatsPage />} />
      <Route path="/about" element={<AboutPage />} />
      {/* RH-P3.C6 — where a person decides an OAuth 2.1 authorization. The
          board's /oauth/authorize sends the browser here; signing in first is
          the app's own gate, and the request survives it because the URL
          does. */}
      <Route path="/oauth/consent" element={<OAuthConsentPage />} />
      {/* RH-UI.SETTINGS.2 (card d0f030a9, contract 8dbc0b81) — ONE Settings
          shell. Every account-facing and administration surface is a child of
          it, and `config/settingsNavigation` is the single place their order,
          grouping and Access-surface key are written down.

          THE CHILD PATHS ARE UNCHANGED except for Preferences, which moves in
          from `/preferences`. Keeping `access`, `access-manager`, `principals`,
          `appearance` and `connections` exactly where they were means every
          published deep link — `?approval=…` above all — resolves without a
          hop, and the alias table below is the short list of what actually
          moved rather than a rewrite of the whole space.

          THE CHILDREN ARE GENERATED (round-2 review P1). `settingsChildRoutes`
          mounts one guarded route per navigation entry, so "every mounted child
          is a navigation entry" and "every child is concealment-guarded" are
          facts about the code rather than things a census has to keep checking.
          `settingsRouteCensus.test.ts` still reads THIS FILE, and now asserts
          the generated form and the exhaustive page map instead of comparing
          two hand-kept lists. */}
      <Route path="/settings" element={<SettingsPage />}>
        <Route index element={<SettingsIndexRedirect />} />
        {settingsChildRoutes((entry) => SETTINGS_PAGES[entry.id])}
      </Route>

      {/* The compatibility aliases, from `config/settingsRouteAliases`. Each
          replaces itself in history and carries the query string and the
          fragment across. The bare, string-target navigations these replaced
          dropped both, which silently emptied an approval deep link. */}
      {SETTINGS_ROUTE_ALIASES.map((alias) => (
        <Route key={alias.from} path={alias.from} element={<SettingsRouteAlias alias={alias} />} />
      ))}

      {/* Plugin routes - dynamically registered */}
      {!pluginsLoading && pluginRoutes.map(route => (
        <Route
          key={`${route.pluginName}-${route.path}`}
          path={`${route.path}/*`}
          element={
            <PluginFrame
              pluginName={route.pluginName}
              proxyPath={route.proxy_to}
              apiBase={API_BASE}
            />
          }
        />
      ))}
    </Routes>
  );
}

const MemoizedAppRoutes = memo(AppRoutes);

export default App;
