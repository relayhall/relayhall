import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import { StepUpDialog } from '../access/StepUpDialog';
import {
  AVAILABILITY_LABELS, PLUGIN_ADMIN_STEP_UP_ACTION, PluginSettingsRequestError, cleanUpPluginSettings,
  fetchAdministeredPlugins, fetchDeploymentPluginSettings, saveDeploymentPluginSettings, savePluginPolicy,
  type AdministeredPlugin, type DeploymentPluginSettings, type PluginAvailabilityState,
} from '../../utils/pluginSettingsApi';
import { PluginSettingsForm } from './PluginSettingsForm';
import './PluginSettingsPanels.css';

interface PendingStepUp { targetId: string; description: string; onToken: (token: string) => void }

/**
 * SETTINGS > PLUGINS FOR ADMINISTRATORS (card bedf50cc; owner ruling E380,
 * design sections 4, 5, 7 and 11): per plugin, its availability state, the
 * deployment values in the host-rendered form, a lock toggle per
 * account_overridable key, and the clean-up of stale values.
 *
 * The board decides who sees it: the panel asks `GET /plugin-admin`, and a
 * session the board refuses (anything but an admin or operator login session)
 * renders NOTHING. Every write asks for a single-use step-up bound to
 * (plugin.admin, the plugin name) first, and the board checks it again.
 */
export const PluginAdministrationPanel: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [plugins, setPlugins] = useState<AdministeredPlugin[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<PluginAvailabilityState>('default_on');
  const [clearChoices, setClearChoices] = useState(false);
  const [settings, setSettings] = useState<DeploymentPluginSettings | null>(null);
  const [stepUp, setStepUp] = useState<PendingStepUp | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setPlugins(await fetchAdministeredPlugins()); }
    catch (err) {
      if (err instanceof PluginSettingsRequestError && (err.status === 401 || err.status === 403)) { setHidden(true); return; }
      setPlugins([]);
      setMessage({ kind: 'alert', text: 'The plugin administration could not be loaded.' });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const choose = useCallback(async (name: string, keepMessage = false) => {
    setSelected(name); setSettings(null); setClearChoices(false);
    if (!keepMessage) setMessage(null);
    const plugin = plugins?.find((entry) => entry.name === name);
    if (plugin) setState(plugin.state);
    try { setSettings(await fetchDeploymentPluginSettings(name)); }
    catch { setMessage({ kind: 'alert', text: 'The deployment settings of this plugin could not be loaded.' }); }
  }, [plugins]);

  const withStepUp = (name: string, description: string, act: (token: string) => Promise<string>) => {
    setStepUp({ targetId: name, description, onToken: (token) => {
      setStepUp(null);
      void (async () => {
        setBusy(true); setMessage(null);
        try {
          const text = await act(token);
          await load();
          await choose(name, true);
          setMessage({ kind: 'status', text });
          onChanged?.();
        } catch (err) {
          setMessage({ kind: 'alert', text: (err as Error).message || 'The change was not saved.' });
        } finally { setBusy(false); }
      })();
    } });
  };

  if (hidden) return null;
  if (plugins === null) return <p role="status">Loading plugin administration…</p>;
  const plugin = plugins.find((entry) => entry.name === selected) ?? null;

  return <section className="plugin-host-settings" aria-label="Plugin administration">
    <h3>Plugin administration</h3>
    <p className="plugin-host-settings-note">Decide, for each installed plugin, whether it is required, on by default, available on request or disabled, and set its shared values. Each change asks you to confirm it is you, and is recorded.</p>
    {message && <p role={message.kind}>{message.text}</p>}
    {plugins.length === 0 ? <p className="plugin-host-settings-note">No installed plugin can be administered here.</p>
      : <ul className="plugin-host-settings-list">{plugins.map((entry) => <li key={entry.name} className="plugin-host-settings-item">
        <div className="plugin-host-settings-row">
          <span className="plugin-host-settings-label">{entry.label}</span>
          <span className="plugin-host-settings-note">{AVAILABILITY_LABELS[entry.state]}</span>
          <Button size="compact" variant="secondary" ariaExpanded={selected === entry.name}
            onClick={() => (selected === entry.name ? setSelected(null) : void choose(entry.name))}>
            {selected === entry.name ? 'Close' : 'Manage'}
          </Button>
        </div>
        {selected === entry.name && plugin && <div className="plugin-host-settings-detail">
          <div className="form-group">
            <label htmlFor={`plugin-availability-${entry.name}`}>Availability</label>
            <Select id={`plugin-availability-${entry.name}`} value={state} onChange={(event) => setState(event.target.value as PluginAvailabilityState)}>
              {(Object.keys(AVAILABILITY_LABELS) as PluginAvailabilityState[]).map((value) =>
                <option key={value} value={value}>{AVAILABILITY_LABELS[value]}</option>)}
            </Select>
            <label className="plugin-host-settings-choice">
              <input type="checkbox" checked={clearChoices} onChange={(event) => setClearChoices(event.target.checked)} />
              Also clear every person's own on/off choice
            </label>
            <div className="form-actions">
              <Button size="compact" variant="primary" disabled={busy} onClick={() => withStepUp(entry.name,
                `Set ${entry.label} to "${AVAILABILITY_LABELS[state]}"${clearChoices ? ' and clear every person\'s choice' : ''}. The change applies on everyone's next request and is recorded.`,
                async (token) => {
                  const saved = await savePluginPolicy(entry.name, { availability: state, clearChoices, stepUpToken: token }, entry.revision);
                  return `Availability saved${saved.clearedChoices ? `; ${saved.clearedChoices} personal choices cleared` : ''}.`;
                })}>Save availability</Button>
            </div>
          </div>
          {settings && settings.name === entry.name && <>
            <h4>Shared settings</h4>
            {(settings.stale.keys.length > 0 || settings.stale.lockedKeys.length > 0 || settings.stale.accountRows > 0) && <div className="plugin-host-settings-note">
              <p>Some stored values no longer fit this plugin and are ignored{settings.stale.accountRows ? ` (including ${settings.stale.accountRows} people's values)` : ''}.</p>
              <Button size="compact" variant="secondary" disabled={busy} onClick={() => withStepUp(entry.name,
                `Remove every stored value of ${entry.label} that the plugin no longer accepts, for the deployment and for every person.`,
                async (token) => { const done = await cleanUpPluginSettings(entry.name, token); return `Removed ${done.keysRemoved.length} stale keys from ${done.rowsChanged} records.`; })}>
                Clean up stale values
              </Button>
            </div>}
            <PluginSettingsForm key={`${settings.name}:${settings.revision}`} pluginName={settings.name} schema={settings.schema} mode="deployment"
              initial={settings.values} initialLocked={settings.lockedKeys} busy={busy}
              onSubmit={(values, lockedKeys) => withStepUp(entry.name, `Save the shared settings of ${entry.label} for everyone.`,
                async (token) => { await saveDeploymentPluginSettings(entry.name, { values, lockedKeys, stepUpToken: token }, settings.revision); return 'Shared settings saved.'; })} />
          </>}
        </div>}
      </li>)}</ul>}
    {stepUp && <StepUpDialog action={PLUGIN_ADMIN_STEP_UP_ACTION} targetId={stepUp.targetId} description={stepUp.description}
      onToken={stepUp.onToken} onCancel={() => setStepUp(null)} />}
  </section>;
};
