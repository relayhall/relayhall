import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, LogOut, ChevronDown, Puzzle, Settings } from 'lucide-react';
import { getSidebarGroups, NavGroupMeta, NavItem } from '../config/navigation';
import './Sidebar.css';
import { usePlugins } from '../contexts/PluginContext';
import { auth } from '../utils/auth';
import { orbStatusBus, attachOrbStatusForwarder } from '../utils/orbStatus';
import { StatusOrb } from './StatusOrb';
import { Wordmark } from './Wordmark';
import { DynamicIcon } from '../utils/icons';
import { PluginNavItem } from '../types/plugin';
import { useBrowserSession } from '../utils/browserSession';
import { useMyPrincipal } from '../hooks/usePrincipals';

interface SidebarProps {
  connected: boolean;
}

const MOBILE_SIDEBAR_QUERY = '(max-width: 1279px)';

/**
 * P1.3 (F11): the observation-fed sidebar surfaces left with the observer
 * stack — usage-limit bars, harness runtime cards, the live agent-session
 * list, and workspace file browsing were all fed by board-side scraping of
 * harness state. The sidebar is now navigation plus the status orb; live
 * agent presence returns when reporter plugins feed it (docs/observability.md).
 */
export function Sidebar({ connected }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_SIDEBAR_QUERY).matches
      : false
  ));
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  const { plugins, pluginSidebarItems, loading: pluginsLoading } = usePlugins();
  const { me } = useMyPrincipal();

  const pluginItems = [...pluginSidebarItems];

  // Keep the orb-status bus (also the nim-orb plugin payload) aware of the
  // websocket connection state — the only live signal the sidebar owns now.
  useEffect(() => {
    orbStatusBus.setConnected(connected);
  }, [connected]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_SIDEBAR_QUERY);
    const syncLayout = (event: MediaQueryListEvent | MediaQueryList) => {
      setMobileLayout(event.matches);
      if (!event.matches) setMobileOpen(false);
    };
    syncLayout(query);
    query.addEventListener('change', syncLayout);
    return () => query.removeEventListener('change', syncLayout);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMobileOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [mobileOpen]);

  const mobileClosed = mobileLayout && !mobileOpen;
  // React 18's HTML attribute types predate `inert`; an attribute spread
  // keeps the standards-native focus exclusion in the rendered DOM.
  const inertWhenClosed = mobileClosed ? { inert: '' } : {};

  return (
    <>
      <button
        ref={menuButtonRef}
        className="sidebar-hamburger"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileOpen}
        aria-controls="sidebar-navigation"
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      <div
        className={`sidebar-backdrop ${mobileOpen ? 'sidebar-backdrop-visible' : ''}`}
        onClick={() => setMobileOpen(false)}
      />

      <aside
        id="sidebar-navigation"
        aria-label="Application sidebar"
        className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}
        aria-hidden={mobileClosed || undefined}
        {...inertWhenClosed}
      >
        <div className="sidebar-avatar-section">
          <div className="avatar-container">
            <OrbAvatar state="idle" plugins={plugins} />
          </div>
        </div>

        <div className="sidebar-nav-section">
          <nav aria-label="Main navigation">
            {getSidebarGroups().map(({ group, items }) => (
              <NavGroupSection key={group.id} group={group} items={items} />
            ))}

            {!pluginsLoading && pluginItems.length > 0 && (
              <CollapsibleGroup
                id="plugins"
                label="Plugins"
                icon={<Puzzle size={16} />}
                defaultCollapsed={false}
              >
                {pluginItems.map((item) => (
                  <PluginNavLink
                    key={`${item.pluginName}-${item.path}`}
                    item={item}
                  />
                ))}
              </CollapsibleGroup>
            )}
          </nav>
        </div>


        <div className="sidebar-section logout-section">
          {/* RH-UI.SETTINGS.2 (card d0f030a9, contract 8dbc0b81): ONE account
              destination. The sidebar used to carry both `Settings` and
              `Preferences`, which made a person's own theme look like a
              different product from their own access — the owner's first
              information-architecture finding of the 2026-08-24 review.
              Preferences is now the first entry inside the shell, `/preferences`
              is an alias that still resolves, and the shell decides per entry
              what this session may see.

              The entry is no longer authority-CONDITIONAL and no longer
              authority-TITLED: it reads `Settings` for every session, where it
              used to read "Administration settings" or "Access manager" and so
              published which of the two the session was. It is still withheld
              from an identity with no resolved principal, because the shell has
              nothing to show that one and a link to a refusal is not
              navigation (AZ-S4, design 4d961e37 §6.1/AZ-16; review 644a2538
              F2). */}
          {me && (
            <Link
              to="/settings"
              className="sidebar-preferences-link"
              title="Settings"
            >
              <Settings size={16} aria-hidden="true" />
              <span className="sidebar-preferences-text">Settings</span>
            </Link>
          )}
          <button
            className="sidebar-logout-button"
            onClick={() => auth.logout()}
            title="Logout"
          >
            <LogOut size={16} />
            <span className="logout-text">Logout</span>
          </button>
        </div>

        {/* One quiet product line at the foot of the shell (§6, D17). The
            sidebar carries no DEPLOYMENT identity — that lives on the login
            page — so this is the software naming itself and nothing more. Fixed
            attribution (§5.3): no Appearance field reaches it. */}
        <div className="sidebar-product-line">
          <Link to="/about" className="sidebar-product-link" aria-label="About RelayHall">
            <Wordmark height={13} mono quiet />
          </Link>
        </div>
      </aside>
    </>
  );
}

const STORAGE_KEY_PREFIX = 'sidebar-group-';

interface CollapsibleGroupProps {
  id: string;
  label: string;
  icon: React.ReactNode;
  defaultCollapsed: boolean;
  children: React.ReactNode;
}

function CollapsibleGroup({ id, label, icon, defaultCollapsed, children }: CollapsibleGroupProps) {
  const storageKey = STORAGE_KEY_PREFIX + id;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? stored === '1' : defaultCollapsed;
    } catch {
      return defaultCollapsed;
    }
  });
  const contentId = `sidebar-group-${id}`;

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch {}
      return next;
    });
  }, [storageKey]);

  return (
    <div className="nav-group">
      <button
        className="nav-group-header"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        title={label}
      >
        <span className="nav-group-icon">{icon}</span>
        <span className="nav-group-label">{label}</span>
        <ChevronDown size={16} className={`nav-group-chevron ${collapsed ? 'chevron-collapsed' : ''}`} />
      </button>
      <div
        id={contentId}
        aria-hidden={collapsed || undefined}
        {...(collapsed ? { inert: '' } : {})}
        className={`nav-group-content ${collapsed ? 'nav-group-content--collapsed' : 'nav-group-content--expanded'}`}
      >
        <div className="nav-group-items">{children}</div>
      </div>
    </div>
  );
}

function NavGroupSection({ group, items }: { group: NavGroupMeta; items: NavItem[] }) {
  if (!group.collapsible) {
    return (
      <div className="nav-group nav-group--flat">
        {items.map(item => (
          <SidebarNavLink key={item.id} to={item.path} icon={<item.icon size={16} />} label={item.label} />
        ))}
      </div>
    );
  }

  return (
    <CollapsibleGroup
      id={group.id}
      label={group.label}
      icon={<group.icon size={16} />}
      defaultCollapsed={group.defaultCollapsed}
    >
      {items.map(item => (
        <SidebarNavLink key={item.id} to={item.path} icon={<item.icon size={16} />} label={item.label} />
      ))}
    </CollapsibleGroup>
  );
}

interface SidebarNavLinkProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

function SidebarNavLink({ to, icon, label }: SidebarNavLinkProps) {
  const location = useLocation();
  const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
  return (
    <Link
      to={to}
      className={`sidebar-nav-link ${isActive ? 'sidebar-nav-link--active' : ''}`}
      title={label}
      aria-label={label}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </Link>
  );
}

function PluginNavLink({ item }: { item: PluginNavItem }) {
  const location = useLocation();
  const isActive = location.pathname.startsWith(item.path);

  return (
    <Link
      to={item.path}
      className={`sidebar-nav-link plugin-nav-link ${isActive ? 'sidebar-nav-link--active' : ''}`}
      title={!item.healthy ? `${item.label} (plugin unhealthy)` : item.label}
      aria-label={item.label}
    >
      <span className="nav-icon">
        <DynamicIcon name={item.icon} size={16} />
      </span>
      <span className="nav-label">{item.label}</span>
      {!item.healthy && <span className="plugin-health-dot" title="Plugin unhealthy" />}
    </Link>
  );
}

function OrbAvatar({ state, plugins: pluginsList }: { state: string; plugins: { name: string; healthy: boolean }[] }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const orbPlugin = pluginsList.find(p => p.name === 'nim-orb' && p.healthy);
  const initialStateRef = useRef(state);
  const [fallbackSize, setFallbackSize] = useState(() => {
    if (typeof window === 'undefined') return 120;
    return window.innerWidth >= 961 && window.innerWidth <= 1279 ? 64 : 120;
  });
  const [orbReady, setOrbReady] = useState(false);
  const browserSessionReady = useBrowserSession();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateFallbackSize = () => {
      setFallbackSize(window.innerWidth >= 961 && window.innerWidth <= 1279 ? 64 : 120);
    };

    updateFallbackSize();
    window.addEventListener('resize', updateFallbackSize);
    return () => window.removeEventListener('resize', updateFallbackSize);
  }, []);


  useEffect(() => {
    if (!orbPlugin) {
      setOrbReady(false);
      return;
    }
    const timer = setTimeout(() => setOrbReady(true), 2000);
    return () => clearTimeout(timer);
  }, [orbPlugin]);

  useEffect(() => {
    if (!orbPlugin || !iframeRef.current?.contentWindow) return;
    // Legacy single-state message for pre-v2 orb builds (origin-pinned).
    iframeRef.current.contentWindow.postMessage({ type: 'orb-state', state }, window.location.origin);
  }, [state, orbPlugin]);

  // v2 protocol: full orb-status snapshots + orb-ready handshake.
  useEffect(() => {
    if (!orbPlugin || !orbReady || !iframeRef.current) return;
    return attachOrbStatusForwarder(iframeRef.current);
  }, [orbPlugin, orbReady]);

  if (orbPlugin && orbReady && browserSessionReady) {
    return (
      <iframe
        ref={iframeRef}
        className="sidebar-orb-frame"
        src={`${import.meta.env.VITE_API_BASE_URL || '/api'}/plugins/nim-orb/avatar?state=${initialStateRef.current}`}
        title="NimOrb Avatar"
        allow="accelerometer; autoplay"
      />
    );
  }

  return <StatusOrb state={state} size={fallbackSize} />;
}
