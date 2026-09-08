import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ScrollText, Pencil, History, X } from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import { renderMarkdownSafe } from '../utils/renderMarkdown';
import './CharterPage.css';
import { formatDateTimeLong } from '../utils/dateFormat';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// The Charter is the project's authority index (vocabulary A9): one per
// project, included in every compiled Brief automatically. Reads are ordinary
// project disclosure; WRITES are owner-plane — the backend answers 403 for
// agent credentials, and this page surfaces that rather than hiding the
// button (the owner uses the same dashboard).

interface Charter {
  id: string;
  projectId: string;
  content: string;
  contentHash: string;
  version: number;
  revision: string;
  updatedByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CharterVersionMeta {
  version: number;
  contentHash: string;
  actorPrincipalId: string | null;
  createdAt: string;
}

function formatDate(dateStr: string): string {
  return formatDateTimeLong(dateStr);
}

export function CharterPage() {
  const { id } = useParams<{ id: string }>();
  const [charter, setCharter] = useState<Charter | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [absent, setAbsent] = useState(false);

  const [versions, setVersions] = useState<CharterVersionMeta[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [viewedVersion, setViewedVersion] = useState<{ version: number; content: string } | null>(null);

  const [showEdit, setShowEdit] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setAbsent(false);
    authenticatedFetch(`${API_BASE_URL}/projects/${id}/charter`)
      .then(async res => {
        const data = await res.json().catch(() => null);
        if (res.status === 404 && data?.code === 'CHARTER_NOT_FOUND') {
          setAbsent(true);
          setCharter(null);
          return;
        }
        if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        setCharter(data.charter);
      })
      .catch(err => setError(err.message || 'Failed to load the Charter'))
      .finally(() => setLoading(false));

    authenticatedFetch(`${API_BASE_URL}/projects/${id}`)
      .then(res => res.json())
      .then(data => setProjectName(data.project?.name || ''))
      .catch(() => setProjectName(''));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const loadVersions = () => {
    if (!id) return;
    setShowVersions(v => !v);
    if (versions) return;
    authenticatedFetch(`${API_BASE_URL}/projects/${id}/charter/versions`)
      .then(res => res.json())
      .then(data => setVersions(data.versions || []))
      .catch(() => setVersions([]));
  };

  const viewVersion = (version: number) => {
    if (!id) return;
    authenticatedFetch(`${API_BASE_URL}/projects/${id}/charter/versions/${version}`)
      .then(res => res.json())
      .then(data => {
        if (data.version) setViewedVersion({ version: data.version.version, content: data.version.content });
      })
      .catch(() => setViewedVersion(null));
  };

  const openEdit = () => {
    setEditContent(charter?.content ?? '');
    setSaveError(null);
    setShowEdit(true);
  };

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setSaveError(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (charter) headers['If-Match'] = charter.revision;
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${id}/charter`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: editContent }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 412) {
          throw new Error('The Charter changed since it was loaded — close, review the new version, and retry.');
        }
        if (res.status === 403) {
          throw new Error('Charter writes are owner-plane; this credential cannot write it.');
        }
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      setShowEdit(false);
      setVersions(null);
      load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save the Charter');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="charter-page"><div className="charter-loading">Loading Charter…</div></div>;
  }

  return (
    <div className="charter-page">
      <div className="charter-header">
        <Link to="/projects" className="charter-back"><ArrowLeft size={16} /> Projects</Link>
        <h1><ScrollText size={20} aria-hidden="true" /> Charter{projectName ? ` — ${projectName}` : ''}</h1>
        <div className="charter-actions">
          {charter && (
            <button type="button" className="charter-action-btn" onClick={loadVersions}>
              <History size={16} /> Versions
            </button>
          )}
          <button type="button" className="charter-action-btn" onClick={openEdit}>
            <Pencil size={16} /> {charter ? 'Edit' : 'Create'}
          </button>
        </div>
      </div>

      {error && <div className="charter-error">{error}</div>}

      {absent && !error && (
        <div className="charter-empty">
          <ScrollText size={48} aria-hidden="true" />
          <h2>This project has no Charter yet</h2>
          <p>
            A Charter is the project's authority index: it locates every governing
            agreement with status and precedence, carries the standing directives,
            and asserts nothing new — conflicts always resolve to the underlying
            document. Once created, it is included in every compiled Brief for the
            project automatically.
          </p>
          <p className="charter-empty-note">
            Charter writes are owner-plane: agents propose changes through Reports;
            the owner creates and amends the Charter itself.
          </p>
        </div>
      )}

      {charter && (
        <>
          <div className="charter-meta">
            <span>Version {charter.version}</span>
            <span>Updated {formatDate(charter.updatedAt)}</span>
            <span>By {charter.updatedByPrincipalId || 'unknown'}</span>
          </div>

          {showVersions && (
            <div className="charter-versions">
              <h3>Version history</h3>
              {versions === null && <p>Loading…</p>}
              {versions && versions.length === 0 && <p>No versions recorded.</p>}
              {versions && versions.map(v => (
                <button type="button" key={v.version} className="charter-version-row" onClick={() => viewVersion(v.version)}>
                  <span>v{v.version}</span>
                  <span>{formatDate(v.createdAt)}</span>
                  <span>{v.actorPrincipalId || 'unknown'}</span>
                </button>
              ))}
            </div>
          )}

          <article
            className="charter-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(charter.content) }}
          />
        </>
      )}

      {viewedVersion && (
        <div className="charter-modal-backdrop" onClick={() => setViewedVersion(null)}>
          <div className="charter-modal" onClick={e => e.stopPropagation()}>
            <div className="charter-modal-header">
              <h3>Charter — version {viewedVersion.version}</h3>
              <button type="button" className="charter-action-btn" onClick={() => setViewedVersion(null)}><X size={16} /></button>
            </div>
            <article
              className="charter-content"
              dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(viewedVersion.content) }}
            />
          </div>
        </div>
      )}

      {showEdit && (
        <div className="charter-modal-backdrop" onClick={() => !saving && setShowEdit(false)}>
          <div className="charter-modal" onClick={e => e.stopPropagation()}>
            <div className="charter-modal-header">
              <h3>{charter ? `Edit Charter (v${charter.version} → v${charter.version + 1})` : 'Create Charter'}</h3>
              <button type="button" className="charter-action-btn" onClick={() => setShowEdit(false)} disabled={saving}><X size={16} /></button>
            </div>
            <div className="form-group">
              <label htmlFor="charter-content">Content (markdown — an index, not a copy)</label>
              <textarea
                id="charter-content"
                className="form-textarea form-textarea-lg form-textarea-mono"
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                rows={20}
              />
            </div>
            {saveError && <div className="charter-error">{saveError}</div>}
            <div className="form-actions">
              <button type="button" className="btn-cancel" onClick={() => setShowEdit(false)} disabled={saving}>Cancel</button>
              <button type="button" className="btn-save" onClick={handleSave} disabled={saving || editContent.trim().length === 0}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CharterPage;
