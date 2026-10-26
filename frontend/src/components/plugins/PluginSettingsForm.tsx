import React, { useMemo, useState } from 'react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import type { PluginSettingDeclaration, SettingSource } from '../../utils/pluginSettingsApi';
import './PluginSettingsPanels.css';

/**
 * The HOST-RENDERED settings form for one plugin (card bedf50cc; owner ruling
 * E380, design sections 5 and 11), drawn from the schema the plugin declares.
 *
 *   mode 'account'    a person's own values: `account` keys and unlocked
 *                     `account_overridable` keys are editable; everything the
 *                     administrators set (deployment keys, locked keys, keys
 *                     delivered to the plugin's backend only) reads "Set by
 *                     your administrator".
 *   mode 'deployment' the administrators' values: `deployment` and
 *                     `account_overridable` keys, and a lock toggle for each
 *                     `account_overridable` key.
 *
 * A `secret` setting never has a value here: it is configured by the plugin's
 * installer. The form sends only the keys it holds a value for; an emptied
 * field is left out, which resets it to the next layer. The exception is a
 * person's own key delivered to the plugin's backend only: its saved value is
 * never shown here, so the board keeps it unless the form sends a new value or
 * `null` ("Remove my saved value"). The server validates every value again.
 */
export const SET_BY_ADMINISTRATOR = 'Set by your administrator';
export const CONFIGURED_BY_INSTALLER = "Configured by the plugin's installer";
export const BACKEND_ONLY_NOTE = "Sent only to the plugin's server, so a saved value is not shown here. Leave this empty to keep it.";
export const REMOVE_SAVED_VALUE = 'Remove my saved value';

export function settingEditable(entry: PluginSettingDeclaration, mode: 'account' | 'deployment', locked: boolean): boolean {
  if (entry.type === 'secret') return false;
  if (mode === 'deployment') return entry.scope === 'deployment' || entry.scope === 'account_overridable';
  return entry.scope === 'account' || (entry.scope === 'account_overridable' && !locked);
}

/** A typed value from a form control's text, or undefined for "not set". */
export function parseSettingInput(entry: PluginSettingDeclaration, raw: string): unknown {
  if (raw === '') return undefined;
  if (entry.type === 'integer' || entry.type === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  return raw;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return 'Not set';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'None';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return String(value);
}

interface FormProps {
  pluginName: string;
  schema: PluginSettingDeclaration[];
  mode: 'account' | 'deployment';
  /** The stored values of this layer (the person's own, or the administrators'). */
  initial: Record<string, unknown>;
  /** Effective values and their sources, shown for keys this form does not edit (account mode). */
  effective?: Record<string, unknown>;
  sources?: Record<string, SettingSource>;
  /** Deployment mode: the locked keys. */
  initialLocked?: string[];
  busy?: boolean;
  onSubmit: (values: Record<string, unknown>, lockedKeys: string[]) => void;
}

export const PluginSettingsForm: React.FC<FormProps> = ({ pluginName, schema, mode, initial, effective = {}, sources = {},
  initialLocked = [], busy = false, onSubmit }) => {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...initial }));
  const [locked, setLocked] = useState<string[]>(() => [...initialLocked]);
  const shown = useMemo(() => schema.filter((entry) => mode === 'account' || entry.scope !== 'account'), [schema, mode]);
  const id = (key: string) => `plugin-setting-${pluginName}-${mode}-${key}`;
  const set = (key: string, value: unknown) => setDraft((current) => {
    const next = { ...current };
    if (value === undefined) delete next[key]; else next[key] = value;
    return next;
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const values: Record<string, unknown> = {};
    for (const entry of schema) {
      if (!settingEditable(entry, mode, mode === 'account' && Boolean(sources[entry.key]?.locked))) continue;
      if (Object.prototype.hasOwnProperty.call(draft, entry.key)) values[entry.key] = draft[entry.key];
    }
    onSubmit(values, mode === 'deployment' ? [...locked].sort() : []);
  };

  if (shown.length === 0) return <p className="plugin-host-settings-note">This plugin declares no settings here.</p>;

  return <form className="plugin-host-settings-form" onSubmit={submit} aria-label={`${pluginName} settings`}>
    {shown.map((entry) => {
      const isLocked = mode === 'account' ? Boolean(sources[entry.key]?.locked) : locked.includes(entry.key);
      const editable = settingEditable(entry, mode, mode === 'account' && isLocked);
      const help = entry.help ? <small id={`${id(entry.key)}-help`} className="plugin-host-settings-help">{entry.help}</small> : null;
      if (entry.type === 'secret') {
        return <div key={entry.key} className="form-group">
          <span className="plugin-host-settings-label">{entry.label}</span>
          <span className="plugin-host-settings-note">{CONFIGURED_BY_INSTALLER}</span>{help}
        </div>;
      }
      if (!editable) {
        const backendOnly = entry.deliver === 'backend' && mode === 'account';
        return <div key={entry.key} className="form-group">
          <span className="plugin-host-settings-label">{entry.label}</span>
          <span className="plugin-host-settings-value">{backendOnly ? SET_BY_ADMINISTRATOR : display(effective[entry.key])}</span>
          {!backendOnly && (entry.scope === 'deployment' || isLocked) && <span className="plugin-host-settings-note">{SET_BY_ADMINISTRATOR}</span>}
          {help}
        </div>;
      }
      const value = draft[entry.key];
      const describedBy = entry.help ? `${id(entry.key)}-help` : undefined;
      let control: React.ReactNode;
      switch (entry.type) {
        case 'boolean':
          control = <input id={id(entry.key)} type="checkbox" checked={value === true} aria-describedby={describedBy}
            onChange={(event) => set(entry.key, event.target.checked)} />;
          break;
        case 'text':
          control = <textarea id={id(entry.key)} className="form-textarea" value={typeof value === 'string' ? value : ''}
            maxLength={entry.max_length} aria-describedby={describedBy} onChange={(event) => set(entry.key, parseSettingInput(entry, event.target.value))} />;
          break;
        case 'integer':
        case 'number':
          control = <input id={id(entry.key)} className="form-input" type="number" value={value === undefined || value === null ? '' : String(value)}
            min={entry.min} max={entry.max} step={entry.type === 'integer' ? 1 : 'any'} aria-describedby={describedBy}
            onChange={(event) => set(entry.key, parseSettingInput(entry, event.target.value))} />;
          break;
        case 'enum':
          control = <Select id={id(entry.key)} value={typeof value === 'string' ? value : ''} aria-describedby={describedBy}
            onChange={(event) => set(entry.key, parseSettingInput(entry, event.target.value))}>
            <option value="">{mode === 'account' ? 'Use the shared setting' : 'Use the plugin default'}</option>
            {(entry.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>;
          break;
        case 'multi_enum': {
          const chosen = Array.isArray(value) ? value as string[] : [];
          control = <fieldset id={id(entry.key)} className="plugin-host-settings-choices" aria-describedby={describedBy}>
            <legend className="plugin-host-settings-label">{entry.label}</legend>
            {(entry.options ?? []).map((option) => <label key={option.value} className="plugin-host-settings-choice">
              <input type="checkbox" checked={chosen.includes(option.value)} onChange={(event) =>
                set(entry.key, event.target.checked ? [...chosen, option.value] : chosen.filter((item) => item !== option.value))} />
              {option.label}
            </label>)}
          </fieldset>;
          break;
        }
        default:
          control = <input id={id(entry.key)} className="form-input" type="text" value={typeof value === 'string' ? value : ''}
            maxLength={entry.max_length} aria-describedby={describedBy} onChange={(event) => set(entry.key, parseSettingInput(entry, event.target.value))} />;
      }
      return <div key={entry.key} className="form-group">
        {entry.type !== 'multi_enum' && <label htmlFor={id(entry.key)}>{entry.label}</label>}
        {control}
        {mode === 'account' && entry.deliver === 'backend'
          ? <span className="plugin-host-settings-note">{BACKEND_ONLY_NOTE}</span>
          : mode === 'account' && sources[entry.key] && !Object.prototype.hasOwnProperty.call(draft, entry.key)
            && <span className="plugin-host-settings-note">Now: {display(effective[entry.key])}</span>}
        {mode === 'account' && entry.deliver === 'backend' && sources[entry.key]?.source === 'account'
          && <label className="plugin-host-settings-choice">
            <input type="checkbox" checked={draft[entry.key] === null}
              onChange={(event) => set(entry.key, event.target.checked ? null : undefined)} />
            {REMOVE_SAVED_VALUE}
          </label>}
        {mode === 'deployment' && entry.scope === 'account_overridable' && <label className="plugin-host-settings-choice">
          <input type="checkbox" checked={locked.includes(entry.key)} onChange={(event) => setLocked((current) =>
            event.target.checked ? [...current, entry.key] : current.filter((key) => key !== entry.key))} />
          Lock for everyone
        </label>}
        {help}
      </div>;
    })}
    <div className="form-actions">
      <Button type="submit" variant="primary" size="compact" disabled={busy}>Save settings</Button>
    </div>
  </form>;
};
