import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Bot, ArrowLeft, Star, ExternalLink, CheckCircle, Clock, Pencil, Trash2, Lock } from 'lucide-react';
import { PersonalityDetail, PERSONALITY_COLORS, formatPersonalitySource, getPersonalityColor } from '../types/personality';
import { authenticatedFetch } from '../utils/auth';
import { formatSessionCost } from '../utils/sessionCost';
import { Button } from '../components/Button';
import { ConfirmationModal } from '../components/ConfirmationModal';
import './PersonalityDetailPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';


export const PersonalityDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<PersonalityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', category: '', color: '', content: '' });

  useEffect(() => {
    if (!id) return;
    const fetch_ = async () => {
      try {
        setLoading(true);
        const res = await authenticatedFetch(`${API_BASE_URL}/personalities/${id}`);
        const data = await res.json();
        if (data.success) {
          const loaded = { ...data.personality, linkedSessions: data.linkedSessions, linkedTasks: data.linkedTasks };
          setDetail(loaded);
          setDraft({
            name: loaded.name || '', description: loaded.description || '',
            category: loaded.category || '', color: loaded.color || '', content: loaded.content || '',
          });
        } else {
          setError(data.error || 'Not found');
        }
      } catch {
        setError('Failed to load');
      } finally {
        setLoading(false);
      }
    };
    fetch_();
  }, [id]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!id || saving) return;
    setMutationError(null);
    setSaving(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/personalities/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok || !data.success) { setMutationError(data.error || 'Failed to update personality'); return; }
      setDetail(current => current ? { ...current, ...data.personality } : current);
      setEditing(false);
    } catch {
      setMutationError('Failed to connect to the RelayHall API');
    } finally {
      setSaving(false);
    }
  };

  const retire = async () => {
    if (!id || !detail) return;
    setMutationError(null);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/personalities/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setConfirmingRetire(false);
        setMutationError(data.error || 'Failed to retire personality');
        return;
      }
      navigate('/personalities');
    } catch {
      setConfirmingRetire(false);
      setMutationError('Failed to connect to the RelayHall API');
    }
  };

  const backButton = (
    <button type="button" className="personality-detail-back" onClick={() => navigate('/personalities')}>
      <ArrowLeft size={16} /> Personalities
    </button>
  );

  if (loading) {
    return (
      <div className="personality-detail-page">
        <div className="personality-detail-loading">
          <div className="loading-spinner" />
          Loading...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="personality-detail-page">
        <div className="personality-detail-nav">{backButton}</div>
        <div className="personality-detail-error" role="alert">{error}</div>
      </div>
    );
  }

  if (!detail) return null;

  const color = getPersonalityColor(detail.color);
  // Presentational mirror of the server rule: only managed personalities are
  // editable (routes/personalities.ts returns 409 for the rest).
  const readOnlyLabel = detail.source !== 'managed'
    ? `${formatPersonalitySource(detail.source)} · read-only`
    : null;

  // Parse markdown content sections for a nicer display
  const sections = detail.content ? parseMarkdownSections(detail.content) : [];

  return (
    <div className="personality-detail-page">
      <div className="personality-detail-nav">
        {backButton}
        {detail.source === 'managed' ? (
          <div className="personality-detail-actions">
            <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => setEditing(value => !value)}>
              Edit
            </Button>
            <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirmingRetire(true)}>
              Retire
            </Button>
          </div>
        ) : (
          <span
            className="personality-readonly-badge"
            title="Built-in and imported personalities are read-only; create a managed personality instead."
          >
            <Lock size={16} /> {readOnlyLabel}
          </span>
        )}
      </div>

      {mutationError && <div className="personality-detail-error" role="alert">{mutationError}</div>}

      <div className="personality-detail-header" style={{ '--personality-color': color } as React.CSSProperties}>
        <div className="personality-detail-accent" />
        <div className="personality-detail-hero">
          <div className="personality-detail-icon">
            <Bot size={32} color={color} />
          </div>
          <div className="personality-detail-meta">
            <div className="personality-detail-name-row">
              <h1>{detail.name}</h1>
              {detail.is_custom && (
                <span className="personality-custom-badge" title="Custom personality">
                  <Star size={16} /> Custom
                </span>
              )}
            </div>
            {detail.category && (
              <span className="personality-detail-category">{detail.category}</span>
            )}
            {detail.description && (
              <p className="personality-detail-desc">{detail.description}</p>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <form className="personality-detail-editor" onSubmit={save} aria-busy={saving}>
          <div className="form-group">
            <label htmlFor="personality-edit-name">Name</label>
            <input
              id="personality-edit-name"
              className="form-input"
              type="text"
              required
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="personality-edit-description">Description</label>
            <textarea
              id="personality-edit-description"
              className="form-textarea"
              rows={2}
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="personality-detail-editor-row">
            <div className="form-group">
              <label htmlFor="personality-edit-category">Category</label>
              <input
                id="personality-edit-category"
                className="form-input"
                type="text"
                value={draft.category}
                onChange={e => setDraft({ ...draft, category: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="personality-edit-color">Color</label>
              <select
                id="personality-edit-color"
                className="form-select"
                value={draft.color}
                onChange={e => setDraft({ ...draft, color: e.target.value })}
              >
                {!PERSONALITY_COLORS[draft.color] && draft.color && (
                  <option value={draft.color}>{draft.color}</option>
                )}
                {Object.keys(PERSONALITY_COLORS).map(colorName => (
                  <option key={colorName} value={colorName}>{colorName}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="personality-edit-content">Instructions (Markdown)</label>
            <textarea
              id="personality-edit-content"
              className="form-textarea form-textarea-lg form-textarea-mono"
              value={draft.content}
              onChange={e => setDraft({ ...draft, content: e.target.value })}
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel" onClick={() => setEditing(false)}>Cancel</button>
            <button type="submit" className="btn-save" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}

      <div className="personality-detail-layout">
        <div className="personality-detail-main">
          {sections.length > 0 ? (
            <div className="personality-detail-sections">
              {sections.map((section, i) => (
                <div key={i} className="personality-section">
                  {section.heading && <h2 className="personality-section-heading">{section.heading}</h2>}
                  <div className="personality-section-content" dangerouslySetInnerHTML={{ __html: simpleMarkdown(section.body) }} />
                </div>
              ))}
            </div>
          ) : (
            <pre className="personality-detail-raw">{detail.content}</pre>
          )}
        </div>

        <div className="personality-detail-sidebar">
          {/* Linked Tasks */}
          <div className="personality-sidebar-section">
            <h3>Linked Tasks <span className="personality-count-badge">{detail.linkedTasks.length}</span></h3>
            {detail.linkedTasks.length === 0 ? (
              <p className="personality-sidebar-empty">No tasks yet</p>
            ) : (
              <ul className="personality-linked-list">
                {detail.linkedTasks.map(task => (
                  <li key={task.id}>
                    <Link to={`/tasks?id=${task.id}`} className="personality-linked-task">
                      <span className={`personality-task-status-dot personality-task-status--${task.status}`} />
                      <span className="personality-linked-title">{task.title}</span>
                      <ExternalLink size={16} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Linked Sessions */}
          <div className="personality-sidebar-section">
            <h3>Linked agent sessions <span className="personality-count-badge">{detail.linkedSessions.length}</span></h3>
            {detail.linkedSessions.length === 0 ? (
              <p className="personality-sidebar-empty">No sessions yet</p>
            ) : (
              <ul className="personality-linked-list">
                {detail.linkedSessions.map(sess => (
                  <li key={sess.session_key}>
                    <Link to={`/sessions?key=${encodeURIComponent(sess.session_key)}`} className="personality-linked-session">
                      {sess.ended_at ? <CheckCircle size={16} /> : <Clock size={16} />}
                      <span className="personality-linked-title">{sess.label || sess.session_key}</span>
                      {formatSessionCost(sess.total_cost_usd) && (
                        <span className="personality-session-cost">{formatSessionCost(sess.total_cost_usd)}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {confirmingRetire && (
        <ConfirmationModal
          title={`Retire ${detail.name}?`}
          message="Retiring removes this personality from new assignments. Existing history and links are preserved."
          confirmLabel="Retire"
          danger
          onConfirm={retire}
          onCancel={() => setConfirmingRetire(false)}
        />
      )}
    </div>
  );
};

/** Splits markdown into heading+body sections */
function parseMarkdownSections(md: string): Array<{ heading: string; body: string }> {
  // Skip frontmatter
  const withoutFm = md.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const lines = withoutFm.split('\n');
  const sections: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    if (line.match(/^#{1,3} /)) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
      current = { heading: line.replace(/^#{1,3} /, ''), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      // Content before first heading
      if (!current && line.trim()) {
        if (!sections[0] || sections[0].heading) {
          sections.push({ heading: '', body: line });
        }
      }
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
  return sections.filter(s => s.heading || s.body);
}

/** Very minimal markdown → HTML (just bold, italic, code, lists) */
function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^/, '<p>').replace(/$/, '</p>');
}
