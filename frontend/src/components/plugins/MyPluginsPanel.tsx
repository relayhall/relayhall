import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../Button';
import {
  fetchOwnPluginSettings, fetchPluginChoices, saveOwnPluginSettings, savePluginChoice,
  type OwnPluginSettings, type PluginChoice,
} from '../../utils/pluginSettingsApi';
import { PluginSettingsForm } from './PluginSettingsForm';
import './PluginSettingsPanels.css';

const STATE_SENTENCES: Record<PluginChoice['state'], string> = {
  required: 'Required by your administrator: always on.',
  default_on: 'On unless you turn it off.',
  available: 'Off unless you turn it on.',
};

/**
 * MY PLUGINS (card bedf50cc; owner ruling E380, design section 11): every
 * plugin this Account may see or switch on, fed by `GET /plugin-host/choices`,
 * each with its on/off switch where the administrators allow it, and the
 * host-rendered form for the person's own settings when the plugin is on.
 * The switch and the form are the Account's own acts: the board admits them
 * only from this person's own signed-in session, and checks every value again.
 */
export const MyPluginsPanel: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [choices, setChoices] = useState<PluginChoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [settings, setSettings] = useState<OwnPluginSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setChoices(await fetchPluginChoices()); setFailed(false); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openSettings = useCallback(async (name: string, keepMessage = false) => {
    setOpen(name); setSettings(null);
    if (!keepMessage) setMessage(null);
    try { setSettings(await fetchOwnPluginSettings(name)); }
    catch { setMessage({ kind: 'alert', text: 'The settings of this plugin could not be loaded.' }); }
  }, []);

  const toggle = async (choice: PluginChoice) => {
    setBusy(true); setMessage(null);
    try {
      const saved = await savePluginChoice(choice.name, !choice.enabled, choice.revision);
      setMessage({ kind: 'status', text: `${choice.label} is now ${saved.enabled ? 'on' : 'off'} for you.` });
      if (!saved.enabled && open === choice.name) { setOpen(null); setSettings(null); }
      await load();
      onChanged?.();
    } catch (err) {
      setMessage({ kind: 'alert', text: (err as Error).message || 'The change was not saved.' });
      await load();
    } finally { setBusy(false); }
  };

  const save = async (values: Record<string, unknown>) => {
    if (!settings) return;
    setBusy(true); setMessage(null);
    try {
      await saveOwnPluginSettings(settings.name, values, settings.revision);
      await openSettings(settings.name, true);
      setMessage({ kind: 'status', text: 'Your settings are saved.' });
    } catch (err) {
      setMessage({ kind: 'alert', text: (err as Error).message || 'Your settings were not saved.' });
    } finally { setBusy(false); }
  };

  if (failed) return <section className="plugin-host-settings" aria-label="My plugins"><h3>My plugins</h3>
    <p role="alert">Your plugins could not be loaded. <Button size="compact" variant="secondary" onClick={() => void load()}>Retry</Button></p></section>;
  if (choices === null) return <p role="status">Loading your plugins…</p>;
  if (choices.length === 0) return null;

  return <section className="plugin-host-settings" aria-label="My plugins">
    <h3>My plugins</h3>
    <p className="plugin-host-settings-note">Choose which plugins are on for you and set your own preferences. Your administrator decides which plugins are available and may set some values for everyone.</p>
    {message && <p role={message.kind}>{message.text}</p>}
    <ul className="plugin-host-settings-list">{choices.map((choice) => <li key={choice.name} className="plugin-host-settings-item">
      <div className="plugin-host-settings-row">
        <span className="plugin-host-settings-label">{choice.label}</span>
        <span className="plugin-host-settings-note">{STATE_SENTENCES[choice.state]}</span>
        {choice.userControlled
          ? <label className="plugin-host-settings-choice">
            <input type="checkbox" role="switch" aria-checked={choice.enabled} checked={choice.enabled} disabled={busy}
              onChange={() => void toggle(choice)} />
            {choice.enabled ? 'On' : 'Off'}
          </label>
          : <span className="plugin-host-settings-value">{choice.enabled ? 'On' : 'Off'}</span>}
        {choice.enabled && <Button size="compact" variant="secondary" ariaExpanded={open === choice.name}
          onClick={() => (open === choice.name ? setOpen(null) : void openSettings(choice.name))}>
          {open === choice.name ? 'Hide settings' : 'Settings'}
        </Button>}
      </div>
      {open === choice.name && settings && settings.name === choice.name && <div className="plugin-host-settings-detail">
        {settings.stale.length > 0 && <p className="plugin-host-settings-note">Some of your saved values no longer fit this plugin and are ignored: {settings.stale.join(', ')}. Saving replaces them.</p>}
        <PluginSettingsForm key={`${settings.name}:${settings.revision}`} pluginName={settings.name} schema={settings.schema} mode="account"
          initial={Object.fromEntries(Object.entries(settings.values).filter(([key]) => settings.sources[key]?.source === 'account'))}
          effective={settings.values} sources={settings.sources} busy={busy} onSubmit={(values) => void save(values)} />
      </div>}
    </li>)}</ul>
  </section>;
};
