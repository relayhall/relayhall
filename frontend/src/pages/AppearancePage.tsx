import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ImageUp, Loader2, Palette, Plus, RotateCcw, Save, Trash2, Undo2 } from 'lucide-react';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { BUILT_IN_THEMES, THEME_LABELS } from '../utils/theme';
import {
  AppearanceLink,
  APPEARANCE_LINK_KINDS,
  AppearanceOverrides,
  AppearanceVersion,
  AppearanceView,
  AssetKind,
  listAppearanceVersions,
  loadAppearance,
  resetAppearance,
  revertAppearance,
  saveAppearance,
  uploadAppearanceAsset,
} from '../services/appearance';
import './AppearancePage.css';
import { formatDateTime } from '../utils/dateFormat';

const ASSET_KINDS: AssetKind[] = ['logo', 'favicon', 'mark'];

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normaliseDraft(draft: AppearanceOverrides): AppearanceOverrides {
  return {
    ...draft,
    displayName: blankToNull(draft.displayName ?? ''),
    loginTitle: blankToNull(draft.loginTitle ?? ''),
    loginSubtitle: blankToNull(draft.loginSubtitle ?? ''),
    accentColor: blankToNull(draft.accentColor ?? ''),
    description: blankToNull(draft.description ?? ''),
    teamMarkdown: blankToNull(draft.teamMarkdown ?? ''),
    links: draft.links.map(link => ({ kind: link.kind, label: link.label.trim(), url: link.url.trim() })),
  };
}

function colourPickerValue(value: string | null, fallback: string): string {
  const candidate = (value || fallback).trim();
  const short = candidate.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
}

function dateLabel(value: string): string {
  return formatDateTime(value, 'Unknown time');
}

export const AppearancePage: React.FC = () => {
  const { me, scopes, loading: authorityLoading } = useMyPrincipal();
  const [appearance, setAppearance] = useState<AppearanceView | null>(null);
  const [draft, setDraft] = useState<AppearanceOverrides | null>(null);
  const [versions, setVersions] = useState<AppearanceVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<AssetKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const canManage = Array.isArray(scopes)
    ? scopes.includes('root')
    : me?.role === 'admin' || me?.role === 'orchestrator';

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [nextAppearance, nextVersions] = await Promise.all([
        loadAppearance(),
        listAppearanceVersions().catch(() => []),
      ]);
      setAppearance(nextAppearance);
      setDraft(nextAppearance.overrides);
      setVersions(nextVersions);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load Appearance');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const update = <K extends keyof AppearanceOverrides>(key: K, value: AppearanceOverrides[K]) => {
    setSaved(false);
    setDraft(current => current ? { ...current, [key]: value } : current);
  };

  const preview = useMemo(() => {
    if (!appearance || !draft) return null;
    return {
      displayName: draft.displayName || appearance.effective.displayName,
      loginTitle: draft.loginTitle || appearance.effective.loginTitle,
      loginSubtitle: draft.loginSubtitle || appearance.effective.loginSubtitle,
      defaultTheme: draft.defaultTheme || appearance.effective.defaultTheme,
      accentColor: draft.accentColor || appearance.effective.accentColor,
    };
  }, [appearance, draft]);

  const commit = async () => {
    if (!draft || saving) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const next = await saveAppearance(normaliseDraft(draft));
      setAppearance(next); setDraft(next.overrides); setSaved(true);
      setVersions(await listAppearanceVersions());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save Appearance');
    } finally { setSaving(false); }
  };

  const upload = async (kind: AssetKind, file?: File) => {
    if (!file || uploading) return;
    setUploading(kind); setError(null); setSaved(false);
    try {
      await uploadAppearanceAsset(kind, file);
      await refresh();
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not upload ${kind}`);
    } finally { setUploading(null); }
  };

  const revert = async (versionNo: number) => {
    if (!window.confirm(`Revert to appearance version ${versionNo}? A new version will be appended.`)) return;
    setSaving(true); setError(null);
    try { await revertAppearance(versionNo); await refresh(); setSaved(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not revert Appearance'); }
    finally { setSaving(false); }
  };

  const reset = async () => {
    if (!window.confirm('Reset the deployment appearance and assets to built-in defaults? A new version will be appended.')) return;
    setSaving(true); setError(null);
    try { await resetAppearance(); await refresh(); setSaved(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not reset Appearance'); }
    finally { setSaving(false); }
  };

  if (loading || authorityLoading) {
    return <div className="appearance-state"><Loader2 className="appearance-spin" aria-hidden="true" /> Loading appearance…</div>;
  }
  if (!canManage) {
    return (
      <div className="appearance-page">
        <header className="appearance-header"><div><Palette aria-hidden="true" /><h1>Appearance</h1></div></header>
        <div className="appearance-error" role="alert">Only a root credential or deployment administrator can manage Appearance.</div>
      </div>
    );
  }
  if (!appearance || !draft || !preview) {
    return <div className="appearance-state" role="alert">{error || 'Appearance is unavailable.'}</div>;
  }

  const previewStyle = { '--accent-color': preview.accentColor } as React.CSSProperties;

  return (
    <div className="appearance-page">
      <header className="appearance-header">
        <div><Palette aria-hidden="true" /><h1>Appearance</h1></div>
        <div className="appearance-actions">
          <button type="button" className="appearance-button appearance-button--secondary" onClick={reset} disabled={saving}>
            <RotateCcw size={16} aria-hidden="true" /> Reset
          </button>
          <button type="button" className="appearance-button appearance-button--primary" onClick={commit} disabled={saving}>
            {saving ? <Loader2 className="appearance-spin" size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
            Save appearance
          </button>
        </div>
      </header>
      <p className="appearance-intro">Deployment identity, login copy, theme defaults and public-safe image assets. Saves, reverts and resets all append to history.</p>
      {error && <div className="appearance-error" role="alert">{error}</div>}
      <p className="appearance-status" role="status">{saved && <><Check size={16} aria-hidden="true" /> Saved as a new version.</>}</p>

      <div className="appearance-layout">
        <form className="appearance-editor" onSubmit={event => { event.preventDefault(); commit(); }}>
          <section className="appearance-card" aria-labelledby="appearance-identity-heading">
            <h2 id="appearance-identity-heading">Identity and login</h2>
            <div className="appearance-grid">
              <label>Display name<input value={draft.displayName ?? ''} maxLength={100} placeholder={appearance.effective.displayName} onChange={e => update('displayName', e.target.value)} /></label>
              <label>Login title<input value={draft.loginTitle ?? ''} maxLength={120} placeholder={appearance.effective.loginTitle} onChange={e => update('loginTitle', e.target.value)} /></label>
              <label className="appearance-wide">Login subtitle<input value={draft.loginSubtitle ?? ''} maxLength={240} placeholder={appearance.effective.loginSubtitle} onChange={e => update('loginSubtitle', e.target.value)} /></label>
              <label>Deployment theme<select value={draft.defaultTheme ?? ''} onChange={e => update('defaultTheme', (e.target.value || null) as AppearanceOverrides['defaultTheme'])}>
                <option value="">Built-in default</option>{BUILT_IN_THEMES.map(theme => <option key={theme} value={theme}>{THEME_LABELS[theme]}</option>)}
              </select></label>
              <div className="appearance-colour-field">
                <label htmlFor="appearance-accent-hex">Accent colour</label>
                <div className="appearance-colour-controls">
                  <input id="appearance-accent-hex" aria-label="Accent colour hex value" value={draft.accentColor ?? ''} maxLength={7} pattern="#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?" placeholder={appearance.effective.accentColor} onChange={e => update('accentColor', e.target.value)} />
                  <input className="appearance-colour-picker" aria-label="Choose accent colour" title="Choose accent colour" type="color" value={colourPickerValue(draft.accentColor, appearance.effective.accentColor)} onChange={e => update('accentColor', e.target.value)} />
                </div>
              </div>
            </div>
          </section>

          <section className="appearance-card" aria-labelledby="appearance-info-heading">
            <h2 id="appearance-info-heading">Deployment information</h2>
            <label>Description<textarea rows={3} maxLength={1000} value={draft.description ?? ''} onChange={e => update('description', e.target.value)} /></label>
            <label>Team notes <span className="appearance-hint">Markdown</span><textarea rows={6} maxLength={20000} value={draft.teamMarkdown ?? ''} onChange={e => update('teamMarkdown', e.target.value)} /></label>
            <fieldset className="appearance-links"><legend>Links</legend>
              {draft.links.map((link, index) => <div className="appearance-link" key={index}>
                <label><span className="appearance-sr-only">Link {index + 1} kind</span><select aria-label={`Link ${index + 1} kind`} value={link.kind} onChange={e => { const links = [...draft.links]; links[index] = { ...link, kind: e.target.value as AppearanceLink['kind'] }; update('links', links); }}>{APPEARANCE_LINK_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
                <label><span className="appearance-sr-only">Link {index + 1} label</span><input aria-label={`Link ${index + 1} label`} placeholder="Documentation" value={link.label} onChange={e => { const links = [...draft.links]; links[index] = { ...link, label: e.target.value }; update('links', links); }} /></label>
                <label><span className="appearance-sr-only">Link {index + 1} URL</span><input aria-label={`Link ${index + 1} URL`} type="url" placeholder="https://…" value={link.url} onChange={e => { const links = [...draft.links]; links[index] = { ...link, url: e.target.value }; update('links', links); }} /></label>
                <button type="button" aria-label={`Remove link ${index + 1}`} onClick={() => update('links', draft.links.filter((_, i) => i !== index))}><Trash2 size={16} aria-hidden="true" /></button>
              </div>)}
              <button type="button" className="appearance-add-link" onClick={() => update('links', [...draft.links, { kind: 'custom', label: '', url: '' }])}><Plus size={16} aria-hidden="true" /> Add link</button>
            </fieldset>
          </section>

          <section className="appearance-card" aria-labelledby="appearance-assets-heading">
            <h2 id="appearance-assets-heading">Image assets</h2>
            <p className="appearance-card-note">PNG, JPEG or WebP; one file at a time; maximum 512 KB and 2048 × 2048. Metadata is stripped before storage.</p>
            <div className="appearance-assets">{ASSET_KINDS.map(kind => <div className="appearance-asset" key={kind}>
              <div className="appearance-asset-preview">{appearance.assets[kind] ? <img src={appearance.assets[kind]!.url} alt={`Current ${kind}`} /> : <span>No {kind}</span>}</div>
              <div><strong>{kind}</strong>{appearance.assets[kind] && <small>{appearance.assets[kind]!.width} × {appearance.assets[kind]!.height} · {Math.ceil(appearance.assets[kind]!.byteSize / 1024)} KB</small>}</div>
              <label className="appearance-upload"><ImageUp size={16} aria-hidden="true" />{uploading === kind ? 'Uploading…' : `Replace ${kind}`}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading !== null} onChange={e => { upload(kind, e.target.files?.[0]); e.currentTarget.value = ''; }} /></label>
            </div>)}</div>
          </section>
        </form>

        <aside className="appearance-side">
          <section className="appearance-card appearance-preview" data-theme={preview.defaultTheme} style={previewStyle} aria-labelledby="appearance-preview-heading">
            <h2 id="appearance-preview-heading">Live preview</h2>
            <div className="appearance-preview-brand">{appearance.assets.logo ? <img src={appearance.assets.logo.url} alt="" /> : <Palette aria-hidden="true" />}<strong>{preview.displayName}</strong></div>
            <div className="appearance-preview-login"><span>Sign in</span><h3>{preview.loginTitle}</h3><p>{preview.loginSubtitle}</p><button type="button">Continue</button></div>
          </section>
          <section className="appearance-card" aria-labelledby="appearance-history-heading">
            <h2 id="appearance-history-heading">Version history</h2>
            {versions.length === 0 ? <p className="appearance-card-note">No saved versions yet.</p> : <ol className="appearance-versions">{versions.map(version => <li key={version.id}>
              <div><strong>Version {version.versionNo}</strong><span>{version.reason} · {dateLabel(version.createdAt)}</span></div>
              <button type="button" onClick={() => revert(version.versionNo)} disabled={saving} aria-label={`Revert to version ${version.versionNo}`}><Undo2 size={16} aria-hidden="true" /> Revert</button>
            </li>)}</ol>}
          </section>
        </aside>
      </div>
    </div>
  );
};
