import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Bookmark,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  Globe,
  Pencil,
  Plus,
  Repeat,
} from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import {
  AGENT_VISIBILITY_LABELS,
  EXPORT_POLICY_LABELS,
  RESOURCE_KIND_DESCRIPTIONS,
  RESOURCE_KIND_LABELS,
  RESOURCE_KINDS,
  RESOURCE_TRUST_CALLOUT,
  Resource,
  ResourceKind,
} from '../../types/resource';
import { safeResourceSummary } from '../../utils/resources';
import { ProjectResourcesEditModal, ResourceEditorMode } from './ProjectResourcesEditModal';
import { ContextPreview } from './ContextPreview';
import { ConfirmationModal } from '../ConfirmationModal';
import { Button } from '../Button';
import './ProjectResources.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const KIND_ICONS: Record<ResourceKind, React.ReactNode> = {
  repository: <GitBranch size={16} />,
  environment: <Globe size={16} />,
  workspace: <FolderOpen size={16} />,
  reference: <Bookmark size={16} />,
};

interface ProjectResourcesProps {
  projectId: string;
  projectName: string;
  /** When the project is archived the section is read-only history. */
  projectArchived: boolean;
  /** Optional: notified with the number of active resources after each load. */
  onActiveCountChange?: (count: number) => void;
}

interface EditorState {
  mode: ResourceEditorMode;
  resource?: Resource;
}

export const ProjectResources: React.FC<ProjectResourcesProps> = ({
  projectId,
  projectName,
  projectArchived,
  onActiveCountChange,
}) => {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Resource | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyResourceId, setBusyResourceId] = useState<string | null>(null);
  const [showContextPreview, setShowContextPreview] = useState(false);

  const fetchResources = useCallback(async (includeArchived: boolean) => {
    setLoading(true);
    setListError(null);
    try {
      const url = includeArchived
        ? `${API_BASE_URL}/projects/${projectId}/resources?includeArchived=true`
        : `${API_BASE_URL}/projects/${projectId}/resources`;
      const res = await authenticatedFetch(url);
      const data = await res.json();
      if (res.ok && data.success) {
        // Order is deterministic and comes from the API; do not re-sort.
        setResources(data.resources || []);
        if (onActiveCountChange) {
          onActiveCountChange((data.resources || []).filter((r: Resource) => r.state === 'active').length);
        }
      } else {
        setListError(data.message || data.error || 'Failed to load resources');
      }
    } catch {
      setListError('Failed to load resources. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [projectId, onActiveCountChange]);

  useEffect(() => {
    fetchResources(showArchived);
  }, [fetchResources, showArchived]);

  const refresh = useCallback(() => {
    fetchResources(showArchived);
  }, [fetchResources, showArchived]);

  const handleArchive = async (resource: Resource) => {
    setBusyResourceId(resource.id);
    setActionError(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/resources/${resource.id}/archive`, {
        method: 'POST',
        headers: { 'If-Match': resource.revision },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setArchiveTarget(null);
        refresh();
      } else if (res.status === 412) {
        setArchiveTarget(null);
        setActionError('This resource changed since the list was loaded. The list has been refreshed — try again.');
        refresh();
      } else {
        setArchiveTarget(null);
        setActionError(data.message || data.error || 'Failed to archive the resource');
      }
    } catch {
      setArchiveTarget(null);
      setActionError('The request failed. Check your connection and try again.');
    } finally {
      setBusyResourceId(null);
    }
  };

  const handleRestore = async (resource: Resource) => {
    setBusyResourceId(resource.id);
    setActionError(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/resources/${resource.id}/restore`, {
        method: 'POST',
        headers: { 'If-Match': resource.revision },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        refresh();
      } else if (res.status === 412) {
        setActionError('This resource changed since the list was loaded. The list has been refreshed — try again.');
        refresh();
      } else {
        // Includes 409 RESOURCE_NAME_CONFLICT: show the server message only,
        // without revealing any other records.
        setActionError(data.message || data.error || 'Failed to restore the resource');
      }
    } catch {
      setActionError('The request failed. Check your connection and try again.');
    } finally {
      setBusyResourceId(null);
    }
  };

  const activeResources = resources.filter(r => r.state === 'active');
  const archivedResources = resources.filter(r => r.state === 'archived');

  const renderBadges = (resource: Resource) => (
    <div className="resource-row-badges">
      {resource.state === 'archived' ? (
        <span className="resource-badge resource-badge-archived">
          <Archive size={16} aria-hidden="true" /> Archived
        </span>
      ) : (
        <span className="resource-badge resource-badge-active">
          <CheckCircle2 size={16} aria-hidden="true" /> Active
        </span>
      )}
      <span className={`resource-badge resource-badge-visibility-${resource.agentVisibility}`}>
        {resource.agentVisibility === 'hidden'
          ? <EyeOff size={16} aria-hidden="true" />
          : <Eye size={16} aria-hidden="true" />}
        {' '}{AGENT_VISIBILITY_LABELS[resource.agentVisibility]}
      </span>
      <span className={`resource-badge resource-badge-export-${resource.exportPolicy}`}>
        {EXPORT_POLICY_LABELS[resource.exportPolicy]}
      </span>
    </div>
  );

  const renderRow = (resource: Resource) => {
    const busy = busyResourceId === resource.id;
    return (
      <li key={resource.id} className={`resource-row ${resource.state === 'archived' ? 'resource-row-archived' : ''}`}>
        <div className="resource-row-main">
          <span className="resource-row-kind">
            {KIND_ICONS[resource.kind]}
            <span className="resource-row-kind-label">{RESOURCE_KIND_LABELS[resource.kind]}</span>
          </span>
          <div className="resource-row-identity">
            <span className="resource-row-name">{resource.name}</span>
            {safeResourceSummary(resource) && (
              <span className="resource-row-summary">{safeResourceSummary(resource)}</span>
            )}
          </div>
          {renderBadges(resource)}
        </div>
        {!projectArchived && (
          <div className="resource-row-actions">
            {resource.state === 'active' ? (
              <>
                <Button
                  variant="secondary"
                  size="compact"
                  className="resource-action-btn"
                  icon={<Pencil size={16} aria-hidden="true" />}
                  onClick={() => setEditor({ mode: 'edit', resource })}
                  disabled={busy}
                >
                  Edit
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  className="resource-action-btn"
                  icon={<Repeat size={16} aria-hidden="true" />}
                  onClick={() => setEditor({ mode: 'replace', resource })}
                  disabled={busy}
                >
                  Change kind
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  className="resource-action-btn resource-action-archive"
                  icon={<Archive size={16} aria-hidden="true" />}
                  onClick={() => setArchiveTarget(resource)}
                  disabled={busy}
                >
                  Archive
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="compact"
                className="resource-action-btn"
                icon={<ArchiveRestore size={16} aria-hidden="true" />}
                onClick={() => handleRestore(resource)}
                disabled={busy}
              >
                {busy ? 'Restoring...' : 'Restore'}
              </Button>
            )}
          </div>
        )}
      </li>
    );
  };

  const renderEmptyState = () => (
    <div className="resources-empty-state">
      <h4>No resources yet</h4>
      <p>
        A resource records factual data about where project work lives. There are four kinds:
      </p>
      <ul className="resources-empty-kinds">
        {RESOURCE_KINDS.map(k => (
          <li key={k}>
            <span className="resources-empty-kind-icon">{KIND_ICONS[k]}</span>
            <strong>{RESOURCE_KIND_LABELS[k]}</strong> — {RESOURCE_KIND_DESCRIPTIONS[k]}
          </li>
        ))}
      </ul>
      <p className="resources-empty-defaults">
        New resources start hidden from agents and marked installation only, so nothing is shared until you decide.
        A resource is descriptive data only — it never connects to anything and never grants access.
      </p>
    </div>
  );

  return (
    <div className="project-resources">
      <div className="project-resources-header">
        <div>
          <h3 className="project-resources-title">Resources</h3>
          <p className="project-resources-subtitle">
            Typed, factual records of where this project's work lives
          </p>
        </div>
        {!projectArchived && (
          <Button
            variant="primary"
            size="compact"
            className="btn-add-resource"
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setEditor({ mode: 'create' })}
          >
            Add resource
          </Button>
        )}
      </div>

      <p className="resources-trust-callout">
        <AlertTriangle size={16} aria-hidden="true" /> {RESOURCE_TRUST_CALLOUT}
      </p>

      {projectArchived && (
        <p className="resources-archived-note" role="note">
          <Archive size={16} aria-hidden="true" /> This project is archived. Resources are shown for history only and
          cannot be changed until the project is restored.
        </p>
      )}

      {actionError && (
        <div className="resources-action-error" role="alert">
          {actionError}
          <Button variant="secondary" size="compact" className="resources-action-error-dismiss" onClick={() => setActionError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div className="project-resources-controls">
        <label className="show-archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={e => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {loading ? (
        <div className="resources-loading">Loading resources...</div>
      ) : listError ? (
        <div className="resources-action-error" role="alert">
          {listError}
          <Button variant="secondary" size="compact" className="resources-action-error-dismiss" onClick={refresh}>Try again</Button>
        </div>
      ) : (
        <>
          {activeResources.length === 0 && !showArchived
            ? renderEmptyState()
            : (
              <ul className="resource-list" aria-label="Active resources">
                {activeResources.map(renderRow)}
                {activeResources.length === 0 && (
                  <li className="resource-list-none">No active resources</li>
                )}
              </ul>
            )}

          {showArchived && (
            <div className="resource-archived-group">
              <h4 className="resource-archived-heading">
                <Archive size={16} aria-hidden="true" /> Archived resources
              </h4>
              {archivedResources.length === 0 ? (
                <p className="resource-list-none">No archived resources</p>
              ) : (
                <ul className="resource-list" aria-label="Archived resources">
                  {archivedResources.map(renderRow)}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      <div className="project-resources-secondary">
        <Button
          variant="secondary"
          size="compact"
          className="btn-context-preview"
          onClick={() => setShowContextPreview(v => !v)}
          disabled={projectArchived}
          ariaExpanded={showContextPreview}
        >
          {showContextPreview ? 'Hide context preview' : 'Preview agent context'}
        </Button>
        {projectArchived && (
          <span className="project-resources-resources-hint">Context is not exported for archived projects.</span>
        )}
      </div>
      {showContextPreview && !projectArchived && (
        <ContextPreview projectId={projectId} />
      )}

      {editor && (
        <ProjectResourcesEditModal
          projectId={projectId}
          projectName={projectName}
          mode={editor.mode}
          resource={editor.resource}
          onClose={() => setEditor(null)}
          onSaved={refresh}
        />
      )}

      {archiveTarget && (
        <ConfirmationModal
          title="Archive resource"
          message={
            <div>
              <p>Archive <strong>{archiveTarget.name}</strong> ({RESOURCE_KIND_LABELS[archiveTarget.kind]})?</p>
              <p>
                Archiving removes it from the active list, from agent context and from exports. Its history is
                retained and it can be restored later. Nothing is deleted.
              </p>
            </div>
          }
          confirmLabel="Archive"
          cancelLabel="Cancel"
          onConfirm={() => handleArchive(archiveTarget)}
          onCancel={() => setArchiveTarget(null)}
        />
      )}
    </div>
  );
};
