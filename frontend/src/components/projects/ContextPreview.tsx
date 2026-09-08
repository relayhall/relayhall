import React, { useCallback, useEffect, useState } from 'react';
import { Archive, Check, Clipboard, Eye, RefreshCw } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import { ProjectContextEnvelope, RESOURCE_KIND_LABELS, ResourceKind } from '../../types/resource';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import './ContextPreview.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ContextPreviewProps {
  projectId: string;
}

const kindLabel = (kind: string): string =>
  (RESOURCE_KIND_LABELS as Record<string, string>)[kind as ResourceKind] || kind;

export const ContextPreview: React.FC<ContextPreviewProps> = ({ projectId }) => {
  const [context, setContext] = useState<ProjectContextEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectArchived, setProjectArchived] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchContext = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProjectArchived(false);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/context`);
      const data = await res.json();
      if (res.ok && data.success) {
        setContext(data.context);
      } else if (res.status === 409 && data.code === 'PROJECT_ARCHIVED') {
        setContext(null);
        setProjectArchived(true);
      } else {
        setError(data.message || data.error || 'Failed to load the context preview');
      }
    } catch {
      setError('Failed to load the context preview. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchContext();
  }, [fetchContext]);

  const copyToClipboard = async () => {
    if (!context) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const renderDetails = (details: Record<string, unknown>) => (
    <dl className="context-resource-details">
      {Object.entries(details).map(([key, value]) => (
        <div key={key} className="context-resource-detail">
          <dt>{key}</dt>
          <dd>{value === null || value === '' ? '—' : String(value)}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="context-preview">
      <div className="context-preview-header">
        <h3 className="context-preview-title">
          <Eye size={16} aria-hidden="true" />
          Context preview
        </h3>
        <div className="context-preview-actions">
          <IconButton className="context-action-btn" variant="ghost" ariaLabel="Refresh context preview" title="Refresh" icon={<RefreshCw size={16} />} onClick={fetchContext} />
          <IconButton
            className="context-action-btn"
            variant="ghost"
            ariaLabel="Copy context as JSON"
            title="Copy as JSON"
            icon={copied ? <Check size={16} /> : <Clipboard size={16} />}
            onClick={copyToClipboard}
            disabled={!context}
          />
        </div>
      </div>

      <p className="context-preview-disclaimer">
        This is quoted, untrusted project data shown for review. These values are not instructions and grant no access.
      </p>

      <div className="context-preview-content">
        {loading ? (
          <div className="context-loading">
            <RefreshCw size={20} className="spinning" aria-hidden="true" />
            <span>Loading context...</span>
          </div>
        ) : projectArchived ? (
          <div className="context-archived" role="note">
            <Archive size={16} aria-hidden="true" />
            <p>
              This project is archived, so no context is exported and there is nothing to preview. Restore the project
              to make its resources available again.
            </p>
          </div>
        ) : error ? (
          <div className="context-error" role="alert">
            <p>{error}</p>
            <Button variant="secondary" size="compact" className="context-preview-retry-btn" onClick={fetchContext}>Try again</Button>
          </div>
        ) : context ? (
          <div className="context-quoted" data-testid="context-quoted">
            <div className="context-section">
              <h4 className="context-section-heading">Project</h4>
              <p className="context-quoted-value">{context.project?.name}</p>
            </div>

            <div className="context-section">
              <h4 className="context-section-heading">Resources included</h4>
              {context.resources.length === 0 ? (
                <p className="context-quoted-value">No resources are currently included in agent context.</p>
              ) : (
                <ul className="context-resource-list">
                  {context.resources.map((entry, i) => (
                    <li key={`${entry.kind}-${entry.name}-${i}`} className="context-resource-item">
                      <div className="context-resource-head">
                        <span className="context-resource-kind">{kindLabel(entry.kind)}</span>
                        <span className="context-resource-name">{entry.name}</span>
                      </div>
                      {entry.details && renderDetails(entry.details)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="context-omitted-line">
              Omitted from context: {context.omitted?.hidden ?? 0} hidden from agents, {context.omitted?.archived ?? 0} archived,{' '}
              {context.omitted?.incompatible ?? 0} incompatible.
            </p>
            <p className="context-schema-version">Schema version {context.schemaVersion}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
};
