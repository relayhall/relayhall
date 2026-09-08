import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Check, Copy, Download, Folder, Link2, Pencil, Pin, X } from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import { renderMarkdownSafe } from '../utils/renderMarkdown';
import './ReportsPage.css';
import { isIntentionalAbort } from '../utils/fetchAbort';
import { formatDate, formatDateTimeFull } from '../utils/dateFormat';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ReportHandover {
  schema_version: 1;
  decisions: string[];
  assumptions: string[];
  alternatives_rejected: string[];
  unresolved_questions: string[];
}

interface Report {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  project_id: string | null;
  project_name?: string | null;
  task_ids: string[];
  /** Free-form label the CALLER supplied. Unverified and spoofable - never the
   * attribution (card 91599cd2). */
  author: string | null;
  /** The verified attribution: the identity the server resolved when the
   * Report was filed. Null means the Report has none. */
  author_actor_name: string | null;
  handover: ReportHandover | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

function formatFullDate(dateStr: string): string {
  return formatDateTimeFull(dateStr);
}

interface EditState {
  title: string;
  content: string;
  summary: string;
  tags: string;
  pinned: boolean;
  decisions: string;
  assumptions: string;
  alternativesRejected: string;
  unresolvedQuestions: string;
}

const toLines = (items: string[] | undefined): string => (items || []).join('\n');
const fromLines = (value: string): string[] => value
  .split(/\r?\n/)
  .map(item => item.trim())
  .filter(Boolean);

export function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Copy ID state
  const [copied, setCopied] = useState(false);

  // Edit modal state
  const [showEdit, setShowEdit] = useState(false);
  const [editState, setEditState] = useState<EditState>({
    title: '', content: '', summary: '', tags: '', pinned: false,
    decisions: '', assumptions: '', alternativesRejected: '', unresolvedQuestions: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);

    authenticatedFetch(`${API_BASE_URL}/reports/${id}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        const r = data.report || data;
        setReport(r);
      })
      .catch(err => {
        if (!isIntentionalAbort(err)) console.error('Failed to fetch report:', err);
        setError(err.message || 'Failed to load report');
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleCopyId = async () => {
    if (!report) return;
    try {
      const shortId = report.id.substring(0, 8);
      await navigator.clipboard.writeText(shortId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy report ID:', err);
    }
  };

  const openEdit = () => {
    if (!report) return;
    setEditState({
      title: report.title,
      content: report.content,
      summary: report.summary || '',
      tags: report.tags.join(', '),
      pinned: report.pinned,
      decisions: toLines(report.handover?.decisions),
      assumptions: toLines(report.handover?.assumptions),
      alternativesRejected: toLines(report.handover?.alternatives_rejected),
      unresolvedQuestions: toLines(report.handover?.unresolved_questions),
    });
    setSaveError(null);
    setShowEdit(true);
  };

  const handleSave = async () => {
    if (!report) return;
    setSaving(true);
    setSaveError(null);
    try {
      const tagsArray = editState.tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const handoverValues = {
        decisions: fromLines(editState.decisions),
        assumptions: fromLines(editState.assumptions),
        alternatives_rejected: fromLines(editState.alternativesRejected),
        unresolved_questions: fromLines(editState.unresolvedQuestions),
      };
      const hasHandover = Object.values(handoverValues).some(items => items.length > 0);

      const res = await authenticatedFetch(`${API_BASE_URL}/reports/${report.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editState.title,
          content: editState.content,
          summary: editState.summary || null,
          tags: tagsArray,
          handover: hasHandover ? { schema_version: 1, ...handoverValues } : null,
          pinned: editState.pinned,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setReport(data.report || data);
      setShowEdit(false);
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="report-detail-page">
        <div className="report-detail-loading">
          <div className="reports-spinner" />
          <p>Loading report...</p>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="report-detail-page">
        <div className="report-detail-error">
          <h2>Report not found</h2>
          <p>{error || 'The report you are looking for does not exist.'}</p>
          <Link to="/reports" className="report-back-link">
            <ArrowLeft size={16} />
            Back to Reports
          </Link>
        </div>
      </div>
    );
  }

  const shortId = report.id.substring(0, 8);

  return (
    <div className="report-detail-page fade-in">
      {/* Navigation */}
      <nav className="report-detail-nav" aria-label="Report">
        <Link to="/reports" className="report-back-link">
          <ArrowLeft size={16} />
          Back to Reports
        </Link>

        {/* Action buttons */}
        <div className="report-detail-actions">
          <div className="report-detail-id-container">
            <code className="report-detail-id">{shortId}</code>
            <button
              onClick={handleCopyId}
              className="report-detail-copy-btn"
              aria-label={copied ? 'Copied!' : 'Copy report ID'}
              title={copied ? 'Copied!' : 'Copy report ID'}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <button
            onClick={() => {
              if (!report) return;
              const frontmatter = [
                `# ${report.title}`,
                '',
                `> ${report.summary || ''}`,
                '',
                `**Tags:** ${(report.tags || []).join(', ')}`,
                `**Created:** ${formatDate(report.created_at || '')}`,
                '',
                '---',
                '',
              ].join('\n');
              const handoverMarkdown = report.handover
                ? `## Structured handover\n\n\`\`\`json\n${JSON.stringify(report.handover, null, 2)}\n\`\`\`\n\n`
                : '';
              const content = frontmatter + handoverMarkdown + (report.content || '');
              const slug = (report.title || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
              const blob = new Blob([content], { type: 'text/markdown' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${slug}.md`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="report-detail-edit-btn"
            title="Download as Markdown"
          >
            <Download size={16} />
            Download
          </button>
          <button
            onClick={openEdit}
            className="report-detail-edit-btn"
            title="Edit report"
          >
            <Pencil size={16} />
            Edit
          </button>
        </div>
      </nav>

      {/* Header */}
      <header className="report-detail-header">
        <div className="report-detail-title-row">
          {report.pinned && <span className="report-detail-pin"><Pin size={16} aria-hidden="true" /></span>}
          <h1 className="report-detail-title">{report.title}</h1>
        </div>

        <div className="report-detail-meta">
          {/* The attribution is the VERIFIED identity the server resolved when
              the Report was filed, never the caller-supplied `author` label -
              which is recorded unverified, defaults to the literal 'system',
              and was confirmed spoofable (card 91599cd2). The label is still
              shown when it says something the verified name does not, and it
              is shown AS a label. */}
          <span className="report-detail-author">
            By <strong>{report.author_actor_name ?? 'Unattributed'}</strong>
            {report.author
              && report.author !== report.author_actor_name
              && ` · filed as “${report.author}” (unverified label)`}
          </span>
          <span className="report-detail-date">
            {formatFullDate(report.created_at)}
          </span>
          {report.updated_at !== report.created_at && (
            <span className="report-detail-updated">
              Updated {formatFullDate(report.updated_at)}
            </span>
          )}
        </div>

        {/* Tags */}
        {report.tags.length > 0 && (
          <div className="report-detail-tags">
            {report.tags.map((tag) => (
              <span
                key={tag}
                className="report-detail-tag"
                onClick={() => navigate(`/reports?tag=${encodeURIComponent(tag)}`)}
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Project badge — links to project detail */}
        {report.project_name && (
          <Link
            to={`/projects?open=${encodeURIComponent(report.project_name)}`}
            className="report-detail-project"
            title={`View project: ${report.project_name}`}
          >
            <Folder size={16} aria-hidden="true" /> {report.project_name}
          </Link>
        )}
      </header>

      {/* Summary */}
      {report.summary && (
        <div className="report-detail-summary">
          <p>{report.summary}</p>
        </div>
      )}

      {report.handover && (
        <section className="report-detail-handover" aria-labelledby="structured-handover-heading">
          <h2 id="structured-handover-heading">Structured handover</h2>
          <p className="report-handover-intro">Machine-readable resumption context recorded with this Report.</p>
          <div className="report-handover-grid">
            {([
              ['Decisions', report.handover.decisions],
              ['Assumptions', report.handover.assumptions],
              ['Alternatives rejected', report.handover.alternatives_rejected],
              ['Unresolved questions', report.handover.unresolved_questions],
            ] as Array<[string, string[]]>).map(([label, items]) => (
              <section key={label} className="report-handover-group">
                <h3>{label}</h3>
                {items.length > 0 ? (
                  <ul>{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul>
                ) : (
                  <p className="report-handover-empty">None recorded</p>
                )}
              </section>
            ))}
          </div>
        </section>
      )}

      {/* Content */}
      <article className="report-detail-content">
        <div
          className="report-markdown"
          dangerouslySetInnerHTML={{
            __html: renderMarkdownSafe(report.content),
          }}
        />
      </article>

      {/* Linked Tasks */}
      {report.task_ids && report.task_ids.length > 0 && (
        <div className="report-detail-tasks">
          <h3><Link2 size={16} aria-hidden="true" /> Linked Tasks</h3>
          <div className="report-task-chips">
            {report.task_ids.map((taskId) => (
              <Link
                key={taskId}
                to={`/tasks?focus=${taskId}`}
                className="report-task-chip"
              >
                {taskId.substring(0, 8)}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* A convenience repeat of the back link, not a second navigation
          region: two unnamed nav landmarks is what axe landmark-unique was
          reporting on every cell (walkthrough item R15). */}
      <div className="report-detail-nav report-detail-nav-bottom">
        <Link to="/reports" className="report-back-link">
          <ArrowLeft size={16} />
          Back to Reports
        </Link>
      </div>

      {/* Edit Modal */}
      {showEdit && (
        <div className="report-edit-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowEdit(false); }}>
          <div className="report-edit-modal">
            <div className="report-edit-header">
              <h2>Edit Report</h2>
              <button className="report-edit-close" onClick={() => setShowEdit(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="report-edit-body">
              <label className="report-edit-label">
                Title
                <input
                  type="text"
                  className="report-edit-input"
                  value={editState.title}
                  onChange={(e) => setEditState(s => ({ ...s, title: e.target.value }))}
                  placeholder="Report title"
                />
              </label>

              <label className="report-edit-label">
                Summary <span className="report-edit-hint">(optional)</span>
                <input
                  type="text"
                  className="report-edit-input"
                  value={editState.summary}
                  onChange={(e) => setEditState(s => ({ ...s, summary: e.target.value }))}
                  placeholder="Short summary..."
                />
              </label>

              <label className="report-edit-label">
                Tags <span className="report-edit-hint">(comma-separated)</span>
                <input
                  type="text"
                  className="report-edit-input"
                  value={editState.tags}
                  onChange={(e) => setEditState(s => ({ ...s, tags: e.target.value }))}
                  placeholder="tag1, tag2, tag3"
                />
              </label>

              <label className="report-edit-label report-edit-checkbox-label">
                <input
                  type="checkbox"
                  checked={editState.pinned}
                  onChange={(e) => setEditState(s => ({ ...s, pinned: e.target.checked }))}
                />
                <Pin size={16} />
                Pin this report
              </label>

              <fieldset className="report-edit-handover">
                <legend>Structured handover <span className="report-edit-hint">(optional, one item per line)</span></legend>
                <label className="report-edit-label">
                  Decisions
                  <textarea className="report-edit-textarea report-edit-handover-textarea" rows={3}
                    value={editState.decisions}
                    onChange={(e) => setEditState(s => ({ ...s, decisions: e.target.value }))}
                    placeholder="Decision made" />
                </label>
                <label className="report-edit-label">
                  Assumptions
                  <textarea className="report-edit-textarea report-edit-handover-textarea" rows={3}
                    value={editState.assumptions}
                    onChange={(e) => setEditState(s => ({ ...s, assumptions: e.target.value }))}
                    placeholder="Assumption carried forward" />
                </label>
                <label className="report-edit-label">
                  Alternatives rejected
                  <textarea className="report-edit-textarea report-edit-handover-textarea" rows={3}
                    value={editState.alternativesRejected}
                    onChange={(e) => setEditState(s => ({ ...s, alternativesRejected: e.target.value }))}
                    placeholder="Alternative and why it was rejected" />
                </label>
                <label className="report-edit-label">
                  Unresolved questions
                  <textarea className="report-edit-textarea report-edit-handover-textarea" rows={3}
                    value={editState.unresolvedQuestions}
                    onChange={(e) => setEditState(s => ({ ...s, unresolvedQuestions: e.target.value }))}
                    placeholder="Question still requiring an answer" />
                </label>
              </fieldset>

              <label className="report-edit-label">
                Content <span className="report-edit-hint">(Markdown)</span>
                <textarea
                  ref={editTextareaRef}
                  className="report-edit-textarea"
                  value={editState.content}
                  onChange={(e) => setEditState(s => ({ ...s, content: e.target.value }))}
                  placeholder="Report content in Markdown..."
                  rows={16}
                />
              </label>

              {saveError && (
                <div className="report-edit-error">{saveError}</div>
              )}
            </div>

            <div className="report-edit-footer">
              <button className="report-edit-cancel" onClick={() => setShowEdit(false)} disabled={saving}>
                Cancel
              </button>
              <button
                className="report-edit-save"
                onClick={handleSave}
                disabled={saving || !editState.title.trim()}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
