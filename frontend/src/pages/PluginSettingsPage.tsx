import { useSearchParams } from 'react-router-dom';
import { usePlugins } from '../contexts/PluginContext';
import { PluginFrame } from '../components/PluginFrame';
import { MyPluginsPanel } from '../components/plugins/MyPluginsPanel';
import { PluginAdministrationPanel } from '../components/plugins/PluginAdministrationPanel';
import './PluginSettingsPage.css';

/** Scope identifies the registered setting; proxy-write access describes the
 * entire plugin connection and is checked again by the server on each request.
 */
export function settingsEffect(setting: { scope: 'personal' | 'deployment' },
  access?: { writeCapable: boolean }): { scope: string; access: string } {
  return {
    scope: setting.scope === 'personal' ? 'Registered as a personal setting.' : 'Registered as a deployment setting.',
    access: access === undefined
      ? 'Access through this plugin’s RelayHall connection is checked on each request.'
      : access.writeCapable
        ? 'Your account has permission to make changes through this plugin’s RelayHall connection.'
        : 'You can view this plugin; changes through its RelayHall connection are not permitted.',
  };
}

/** The server's per-entry statement for this Account; null when an older
 * registry response carries no flag (the plugin-level statement then applies).
 */
export function settingEditability(setting: { readOnly?: boolean }): { detail: string; badge: string } | null {
  if (setting.readOnly === true) return {
    detail: 'Read-only for your account: you can view this page, but your account cannot change these settings.',
    badge: 'Read-only for you',
  };
  if (setting.readOnly === false) return { detail: 'Your account can change these settings.', badge: 'You can change this' };
  return null;
}

/** Navigation metadata is server-filtered; it never grants settings authority. */
export function PluginSettingsPage() {
  const { plugins, loading, error, refresh } = usePlugins();
  const [params, setParams] = useSearchParams();
  const entries = plugins.filter(p => p.schema_version === 'rh.plugin/1').flatMap(plugin =>
    (plugin.settings ?? []).map(setting => ({ plugin, setting })));
  const selected = entries.find(({ plugin, setting }) => plugin.name === params.get('plugin') && setting.id === params.get('setting'));
  if (loading) return <p role="status">Loading plugin settings…</p>;
  if (error) return <div role="alert">Plugin settings could not be loaded. <button onClick={() => void refresh()}>Retry</button></div>;
  const selectedEditability = selected ? settingEditability(selected.setting) : null;
  return <section className="plugin-settings">
    <h2>Plugin settings</h2>
    <p>Each page identifies who its changes affect and whether your account can change it. Access is checked by the server.</p>
    {/* Card bedf50cc (E380): the host-rendered My plugins list for every person,
        and the administrators' plugin administration (rendered only when the
        board admits this session). Plugins with custom pages keep them below. */}
    <MyPluginsPanel onChanged={() => void refresh()} />
    <PluginAdministrationPanel onChanged={() => void refresh()} />
    {entries.length === 0 && <p>No plugin settings are available to this account. Installed plugins may not provide a settings page.</p>}
    {(['personal', 'deployment'] as const).map(scope => {
      const group = entries.filter(e => e.setting.scope === scope);
      return group.length > 0 && <section key={scope} aria-label={scope === 'personal' ? 'Personal plugin settings' : 'Deployment plugin settings'}>
        <h3>{scope === 'personal' ? 'Personal — your account' : 'Deployment — shared configuration'}</h3>
        <ul className="plugin-settings-list">{group.map(({ plugin, setting }) => {
          const editability = settingEditability(setting);
          return <li key={plugin.name + ':' + setting.id}>
            <button onClick={() => setParams({ plugin: plugin.name, setting: setting.id })} aria-pressed={selected?.plugin.name === plugin.name && selected.setting.id === setting.id}>
              {setting.label}<small>{plugin.name}{!plugin.healthy ? ' — unavailable' : ''}{editability ? ' — ' + editability.badge : ''}</small>
            </button>
          </li>;
        })}</ul>
      </section>;
    })}
    {(params.has('plugin') || params.has('setting')) && !selected && <p role="status">This settings page is not available to this account.</p>}
    {selected && <section aria-label={selected.setting.label} className="plugin-settings-detail">
      <h3>{selected.setting.label}</h3><p>{settingsEffect(selected.setting, selected.plugin.hostProxyAccess).scope}</p>
      <p>{selectedEditability ? selectedEditability.detail : settingsEffect(selected.setting, selected.plugin.hostProxyAccess).access}</p>
      <PluginFrame surface="embedded" key={selected.plugin.name + ':' + selected.setting.id} pluginName={selected.plugin.name} proxyPath={selected.setting.path} apiBase={import.meta.env.VITE_API_BASE_URL || '/api'} />
    </section>}
  </section>;
}
