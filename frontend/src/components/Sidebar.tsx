import { PluginSidebarWidget } from './PluginSidebarWidget';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, LogOut, ChevronDown, Puzzle, Settings, User } from 'lucide-react';
import { getSidebarGroups, NavGroupMeta, NavItem, type NavAudience } from '../config/navigation';
import './Sidebar.css';
import { usePlugins } from '../contexts/PluginContext';
import { auth } from '../utils/auth';
import { orbStatusBus, attachOrbStatusForwarder } from '../utils/orbStatus';
import { StatusOrb } from './StatusOrb';
import { Wordmark } from './Wordmark';
import { DynamicIcon } from '../utils/icons';
import { PluginInfo, PluginNavItem } from '../types/plugin';
import { useBrowserSession } from '../utils/browserSession';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { useMyLenses } from '../hooks/useMyLenses';
import { activeNavEntry } from '../utils/navActive';
import { NotificationBell } from './notifications/NotificationBell';

interface SidebarProps {
  connected: boolean;
}

const MOBILE_SIDEBAR_QUERY = '(max-width: 1279px)';

/**
 * The identity widget is the one the circular avatar host has always carried.
 * The name lives in exactly ONE place: `hasOrbWidget` and the avatar host both
 * decide through this predicate, so a deployment without the widget still falls
 * back to the legacy avatar and no second plugin name is ever hardcoded.
 * The value is the registry id a plugin ships under: a plugin relies on it, so
 * it is behaviour and stays as it is.
 */
const IDENTITY_WIDGET_PLUGIN = 'nim-orb';
const isIdentityWidget = (plugin: { name: string }) => plugin.name === IDENTITY_WIDGET_PLUGIN;

/**
 * The identity widget's VISIBLE name. It used to be derived from the plugin
 * id, which rendered an older product name; the block is now named for what it
 * shows at a glance. Only
 * the label changed: the plugin id above, the disclosure's remembered-state key
 * and its body id still carry the plugin id, so a collapsed block stays
 * collapsed across the rename.
 */
const IDENTITY_WIDGET_LABEL = 'Activity Status';

/** `usage-limits` -> `Usage limits`: a visible name for a widget block. */
function widgetLabel(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

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
  const { me, scopes, settingsSurfaces } = useMyPrincipal();
  // RH-LENSES-d (card 4e159741): the navigation is drawn for the server's lens
  // answer and the Settings shell's own audience. The fallback predicate is
  // the Settings shell's, unchanged, and is used only when the board did not
  // answer `settingsSurfaces`; neither decides authority.
  const { lenses } = useMyLenses();
  const navAudience: NavAudience = {
    lenses,
    settings: {
      surfaces: settingsSurfaces,
      canManage: Array.isArray(scopes)
        ? scopes.includes('root')
        : me?.role === 'admin' || me?.role === 'orchestrator',
    },
  };

  const pluginItems = [...pluginSidebarItems];
  const sidebarGroups = getSidebarGroups(navAudience);
  const showPluginItems = !pluginsLoading && pluginItems.length > 0;
  // THE ONE CURRENT PAGE (owner bug report E406). Decided once, over every
  // entry the rail actually draws (its groups, then its plugin entries), by
  // the shared whole-segment, longest-match rule, so at most one entry is
  // marked active and announced as the page. Each link used to decide alone
  // with a character prefix, and Advanced lit Access as well.
  const drawnEntries: Array<NavItem | PluginNavItem> = [
    ...sidebarGroups.flatMap(({ items }) => items),
    ...(showPluginItems ? pluginItems : []),
  ];
  const activeEntry = activeNavEntry(location.pathname, drawnEntries);
  // Registry order, narrowed to the healthy `rh.plugin/1` plugins that declare
  // a sidebar widget. The identity widget is taken out of that list by the same
  // predicate `hasOrbWidget` has always used; everything else renders in its own
  // block below the avatar instead of sharing the avatar's circle.
  const widgetPlugins = plugins.filter(p => p.healthy && p.schema_version === 'rh.plugin/1' && !!p.sidebar_widget);
  const identityWidget = widgetPlugins.find(isIdentityWidget) ?? null;
  const hasOrbWidget = identityWidget !== null;
  const sidebarWidgets = widgetPlugins.filter(p => p !== identityWidget);

  // Keep the orb-status bus (also the identity-widget plugin payload) aware of the
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

      {/* CLOSED-STATE IDENTITY (card 89c4eb9a; the P2 scope A deferred).
          Below 1280px with the drawer closed the rail is off-screen, so the
          signed-in identity either lives in the floating chrome or is not
          visible at all — and the brief asks for a persistently visible
          username. It used to be a bare text pill of its own, top-right. It is
          now the second cell of the ONE top bar the menu control already
          draws: the same top edge, the same 44px height, the same corner
          radius and border, so control and identity read as one row rather
          than a control and a stray notice; and it speaks the account row's
          own grammar — monogram, then handle, at the row's type size — so the
          closed state and the open drawer show the same identity the same
          way. The handle truncates with an ellipsis and the chip is clamped
          to the room the control leaves, so the two cannot meet at 320px
          whatever the handle is (Sidebar.geometry.test.ts derives the
          arithmetic from the control's own declarations).

          NOT AN ACTION. No Settings glyph, no link, no button: the one account
          destination stays inside the drawer, above Logout (RH-UI.SETTINGS.2;
          owner ruling E21), and nothing here invents a second one. It claims
          nothing it does not know — no handle, no chip — exactly as the pill
          did. E21 also retired the `Signed in as` copy: the chip is the small
          avatar and the account name, and its text is the handle itself (the
          tooltip repeats the full handle for when it ellipsises). The monogram
          is decoration and is hidden so the text does not read "R river".

          SAFE SPACE (1f8824c1). The chip's bottom edge is the control's, so
          the 4rem band `PluginFrame.css` reserves for the host's floating
          chrome still clears both; `PluginFrame.geometry.test.ts` now
          measures the two pieces of chrome rather than one. */}
      {mobileLayout && !mobileOpen && me?.handle && (
        <span className="sidebar-mobile-account sidebar-mobile-account--beside-bell" title={me.handle}>
          <span className="sidebar-mobile-account-avatar" aria-hidden="true">{me.handle.slice(0, 1).toUpperCase()}</span>
          <span className="sidebar-mobile-account-handle">{me.handle}</span>
        </span>
      )}

      {/* THE BELL IN THE CLOSED STATE (card b1e3b16d, lane L1; design T2).
          With the drawer closed the account row and its bell are off-screen
          and inert, so the bell rides the floating bar too: at the chip's own
          right edge, top and height, drawn over the cell the chip reserves for
          it (`--beside-bell`), so the two read as one pill — identity, then
          the bell. It is a SIBLING of the chip, not a child: the chip stays
          exactly what the comment above says it is, not an action. The chip
          widens by the bell's cell and no further: its width budget is
          unchanged, so it still cannot meet the menu control at 320px, and
          the bell's bottom edge is the control's, so the band
          `PluginFrame.css` reserves still clears all of the chrome
          (`Sidebar.bell.geometry.test.ts`). An identity with no handle has no
          chip, and the bell then stands alone in that corner. Withheld from
          an identity with no resolved principal, as the row is. */}
      {mobileLayout && !mobileOpen && me && (
        <NotificationBell className={me.handle ? 'sidebar-mobile-bell sidebar-mobile-bell--in-chip' : 'sidebar-mobile-bell'} />
      )}

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
        {/* IDENTITY BLOCK (card 89c4eb9a scope A; live audit 2026-09-18).
            The account used to be a boxed `Signed in as / river` notice
            floating above an unrelated avatar graphic — four stacked blocks
            with no hierarchy and no account affordance. It is now one block:
            an account row over the identity widget host, closed by a single
            hairline.

            THE ROW IS THREE THINGS (owner ruling E21, 10 Oct 2026): a small
            avatar, the signed-in account's name, and the notification bell.
            The `Signed in as` caption and the Settings link have left it — the
            owner found the header busy, and Settings is not used as often as
            the rest of the rail, so it now sits immediately above Logout at the
            foot of the rail (below). The avatar is the monogram the row has
            always drawn (no new asset, nothing fetched).

            CONDITION, unchanged: the row renders on `me`, so a resolved
            principal with no handle still gets the row and its bell, and it
            shows the handle only when there IS one. It claims nothing it does
            not know: no handle, no handle text, no tooltip.

            The row stays a DIRECT child of the rail, so the `position: sticky`
            it already shipped with still works against the rail's whole scroll
            range. */}
          {me && (
            <div className="sidebar-account" title={me.handle || undefined}>
              <span className="sidebar-account-avatar" aria-hidden="true">
                {me.handle ? me.handle.slice(0, 1).toUpperCase() : <User size={16} />}
              </span>
              {me.handle && (
                <span className="sidebar-account-text">
                  <strong className="sidebar-account-handle">{me.handle}</strong>
                </span>
              )}
              {/* THE BELL (card b1e3b16d, lane L1; design T2): a control in the
                  account row, not a navigation entry — the left menu and
                  `config/navigation` are untouched (E16). Its badge is unread
                  notifications plus pending decisions. Since E21 it is the
                  row's only control, so it closes the row on its own. */}
              <NotificationBell className="sidebar-account-bell" />
            </div>
          )}

        {/* KEYED on the resolved widget name. The plugin registry arrives
            AFTER the first render, and the disclosure reads its remembered
            state once, in a useState initialiser; without this key the host
            would keep the state it read before it knew which widget it carries,
            and a collapsed Orb would come back expanded on every load. A real
            browser found that — the unit suite hands the registry over before
            the first render, so it cannot. */}
        <IdentityWidgetHost
          key={identityWidget?.name ?? 'identity'}
          identityWidget={identityWidget}
          hasOrbWidget={hasOrbWidget}
          legacyPlugins={plugins.filter(p => p.schema_version !== 'rh.plugin/1')}
        />

        <div className="sidebar-nav-section">
          <nav aria-label="Main navigation">
            {/* PER-LENS NAVIGATION (RH-LENSES-d; design 96f0bd3d s8.4). The
                union of this session's lenses is shown and there is no lens
                switcher. A section is OFFERED by a lens and still guarded by
                its own page and route: the lens decides only what is drawn. */}
            {sidebarGroups.map(({ group, items }) => (
              <NavGroupSection key={group.id} group={group} items={items} activeEntry={activeEntry} />
            ))}

            {showPluginItems && (
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
                    active={item === activeEntry}
                  />
                ))}
              </CollapsibleGroup>
            )}
          </nav>
        </div>


        {/* SECONDARY widgets, one rank below navigation (live audit
            2026-09-18, defect 5). They used to sit between identity and the
            navigation, which put the CURRENT destination below the fold on a
            1440x900 desktop and inside the 390px drawer. A widget's height is
            the PLUGIN's to declare (48..240, plugin-host-v1) and clamping it
            in the host would be the host lying to the plugin, so the repair is
            ORDER, not size: identity, navigation, then telemetry. Nothing is
            hidden, nothing is smaller, and every widget block still renders in
            full. Each block also carries a disclosure — EXPANDED by default,
            remembered per widget — for a person who wants the rail shorter
            still. */}
        {sidebarWidgets.length > 0 && (
          <div className="sidebar-plugin-widgets">
            {sidebarWidgets.map(p => (
              <PluginWidgetBlock key={p.name} plugin={p} label={widgetLabel(p.name)} />
            ))}
          </div>
        )}

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
              F2).

              Card 89c4eb9a scope A moved that ONE entry up into the account
              row; owner ruling E21 (10 Oct 2026) brings it back down, to sit
              IMMEDIATELY ABOVE Logout, because it is used less often than the
              rest of the rail and it made the account row busy. Nothing about
              the ruling above changed — one destination, one name, the same
              route and icon, withheld from an unresolved identity — only its
              place. It precedes Logout in the DOM as on screen, so keyboard
              order follows the visual order. The word stays VISIBLE here, in
              the full rail and in the drawer; the 96px compact rail, which
              withholds every other text label, is the only place it is hidden,
              and there it is clipped rather than removed so the name survives. */}
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

/**
 * Whether ONE widget block is collapsed, remembered per widget.
 *
 * Its own key prefix: a widget is not a navigation group, and sharing
 * `sidebar-group-` would let a plugin called `plugins` collide with the
 * navigation group of the same id.
 */
const WIDGET_STORAGE_KEY_PREFIX = 'sidebar-widget-';

function useWidgetDisclosure(name: string) {
  const storageKey = WIDGET_STORAGE_KEY_PREFIX + name;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch {}
      return next;
    });
  }, [storageKey]);
  return { collapsed, toggle, bodyId: `sidebar-widget-body-${name}` };
}

/**
 * Owner ruling E458: a widget that declares `ui.sidebar_widget.frame: "section"`
 * is drawn as a sidebar SECTION instead of a boxed block. The test is strict on
 * purpose, as the `grow` opt-in's is: only the exact string `section` opts in,
 * and absence, a different case, a boolean, a number, null, an object or any
 * other string all keep today's boxed block.
 */
const isSectionFrame = (plugin: PluginInfo) => plugin.sidebar_widget?.frame === 'section';

/** The label row that is also the block's disclosure control. */
function WidgetDisclosureLabel({ label, collapsed, toggle, bodyId, section = false }: {
  label: string; collapsed: boolean; toggle: () => void; bodyId: string; section?: boolean;
}) {
  return (
    <button
      className={section ? 'sidebar-plugin-widget-label sidebar-plugin-widget-label--section' : 'sidebar-plugin-widget-label'}
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-controls={bodyId}
    >
      <span className="sidebar-plugin-widget-name">{label}</span>
      <ChevronDown size={16} className={`nav-group-chevron ${collapsed ? 'chevron-collapsed' : ''}`} />
    </button>
  );
}

/**
 * The IDENTITY widget host: the circle that carries exactly one widget.
 *
 * It gets the same disclosure every other widget block has (live audit
 * 2026-09-18, defect 6) — it was the one widget a person could not put away —
 * but only when a plugin widget is actually mounted there. The legacy
 * `OrbAvatar` fallback is chrome the host draws itself, not a plugin's
 * telemetry, and it carries no plugin name to label a control with.
 *
 * The disclosure reads `Activity Status` (IDENTITY_WIDGET_LABEL, owner rulings
 * E21 + E24), not a name derived from the plugin id; the fold itself and the
 * widget it folds are unchanged. The widget's frame carries the SAME name as
 * its accessible name (E64), so a screen reader announces "Activity Status",
 * never the plugin id.
 */
function IdentityWidgetHost({ identityWidget, hasOrbWidget, legacyPlugins }: {
  identityWidget: PluginInfo | null;
  hasOrbWidget: boolean;
  legacyPlugins: { name: string; healthy: boolean }[];
}) {
  const { collapsed, toggle, bodyId } = useWidgetDisclosure(identityWidget?.name ?? 'identity');
  const showDisclosure = identityWidget !== null;
  const hidden = showDisclosure && collapsed;

  return (
    <div className="sidebar-avatar-section">
      {showDisclosure && (
        <WidgetDisclosureLabel
          label={IDENTITY_WIDGET_LABEL}
          collapsed={collapsed}
          toggle={toggle}
          bodyId={bodyId}
        />
      )}
      <div
        id={bodyId}
        className={`sidebar-identity-host ${hidden ? 'sidebar-identity-host--collapsed' : ''}`}
        aria-hidden={hidden || undefined}
        {...(hidden ? { inert: '' } : {})}
      >
        {/* ONE identity widget, never two. The host keeps its circular mask
            only while it carries the legacy circular OrbAvatar; the Orb's own
            widget is a laid-out page, so the host switches to a rectangular
            full-width box (`avatar-container--widget`) that fits the declared
            height instead of clipping the page into a 180px circle. */}
        <div className={`avatar-container${hasOrbWidget ? ' avatar-container--widget' : ''}`}>
          {identityWidget
            ? <PluginSidebarWidget key={identityWidget.name} plugin={identityWidget} title={IDENTITY_WIDGET_LABEL} />
            : <OrbAvatar state="idle" plugins={legacyPlugins} />}
        </div>
      </div>
    </div>
  );
}

/**
 * One labelled, collapsible plugin widget block.
 *
 * Collapsing hides the body with `display: none` rather than unmounting it:
 * the iframe stays in the document, so the host/widget bridge and the widget's
 * declared height survive a collapse and nothing re-handshakes on expand.
 */
function PluginWidgetBlock({ plugin, label }: { plugin: PluginInfo; label: string }) {
  const { collapsed, toggle, bodyId } = useWidgetDisclosure(plugin.name);
  const section = isSectionFrame(plugin);

  return (
    <section className={section ? 'sidebar-plugin-widget sidebar-plugin-widget--section' : 'sidebar-plugin-widget'} aria-label={label}>
      <WidgetDisclosureLabel label={label} collapsed={collapsed} toggle={toggle} bodyId={bodyId} section={section} />
      <div
        id={bodyId}
        className={`sidebar-plugin-widget-body ${collapsed ? 'sidebar-plugin-widget-body--collapsed' : ''}${section ? ' sidebar-plugin-widget-body--section' : ''}`}
        aria-hidden={collapsed || undefined}
        {...(collapsed ? { inert: '' } : {})}
      >
        <PluginSidebarWidget plugin={plugin} title={label} section={section} />
      </div>
    </section>
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

function NavGroupSection({ group, items, activeEntry }: {
  group: NavGroupMeta;
  items: NavItem[];
  activeEntry: NavItem | PluginNavItem | null;
}) {
  if (!group.collapsible) {
    return (
      <div className="nav-group nav-group--flat">
        {items.map(item => (
          <SidebarNavLink key={item.id} to={item.path} icon={<item.icon size={16} />} label={item.label} active={item === activeEntry} />
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
        <SidebarNavLink key={item.id} to={item.path} icon={<item.icon size={16} />} label={item.label} active={item === activeEntry} />
      ))}
    </CollapsibleGroup>
  );
}

interface SidebarNavLinkProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  /** Whether this entry is THE current page; the Sidebar decides it once for all entries. */
  active: boolean;
}

function SidebarNavLink({ to, icon, label, active }: SidebarNavLinkProps) {
  return (
    <Link
      to={to}
      className={`sidebar-nav-link ${active ? 'sidebar-nav-link--active' : ''}`}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </Link>
  );
}

function PluginNavLink({ item, active }: { item: PluginNavItem; active: boolean }) {
  return (
    <Link
      to={item.path}
      className={`sidebar-nav-link plugin-nav-link ${active ? 'sidebar-nav-link--active' : ''}`}
      title={!item.healthy ? `${item.label} (plugin unhealthy)` : item.label}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
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
        title={IDENTITY_WIDGET_LABEL}
        allow="accelerometer; autoplay"
      />
    );
  }

  return <StatusOrb state={state} size={fallbackSize} />;
}
