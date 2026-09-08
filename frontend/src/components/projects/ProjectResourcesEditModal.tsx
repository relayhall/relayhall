import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Archive, ArrowLeft, Check, GitBranch, Globe, FolderOpen, Bookmark, RefreshCw, X } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { Select } from '../ui/Select';
import {
  AGENT_VISIBILITY_LABELS,
  AgentVisibility,
  DEFAULT_AGENT_VISIBILITY,
  DEFAULT_EXPORT_POLICY,
  EXPORT_POLICY_LABELS,
  EnvironmentStage,
  ExportPolicy,
  RESOURCE_KIND_DESCRIPTIONS,
  RESOURCE_KIND_LABELS,
  RESOURCE_KINDS,
  RESOURCE_TRUST_CALLOUT,
  ReferenceCategory,
  RepositoryRole,
  Resource,
  ResourceKind,
  ResourceWritePayload,
  WorkspacePurpose,
} from '../../types/resource';
import {
  KIND_FIELD_KEYS,
  RESOURCE_FIELD_LABELS,
  makeIdempotencyKey,
  safeResourceSummary,
} from '../../utils/resources';
import './ProjectResourcesEditModal.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export type ResourceEditorMode = 'create' | 'edit' | 'replace';

interface ProjectResourcesEditModalProps {
  projectId: string;
  projectName: string;
  mode: ResourceEditorMode;
  /** Required for edit and replace modes. */
  resource?: Resource;
  onClose: () => void;
  /** Called after a successful save so the caller can refresh the list. */
  onSaved: () => void;
}

interface ResourceFormState {
  name: string;
  description: string;
  agentVisibility: AgentVisibility;
  exportPolicy: ExportPolicy;
  repositoryUrl: string;
  repositoryRole: RepositoryRole;
  repositoryDefaultBranch: string;
  environmentUrl: string;
  environmentStage: EnvironmentStage;
  workspacePath: string;
  workspacePurpose: WorkspacePurpose;
  referenceUrl: string;
  referenceCategory: ReferenceCategory;
}

const emptyForm = (): ResourceFormState => ({
  name: '',
  description: '',
  agentVisibility: DEFAULT_AGENT_VISIBILITY,
  exportPolicy: DEFAULT_EXPORT_POLICY,
  repositoryUrl: '',
  repositoryRole: 'additional',
  repositoryDefaultBranch: '',
  environmentUrl: '',
  environmentStage: 'development',
  workspacePath: '',
  workspacePurpose: 'source',
  referenceUrl: '',
  referenceCategory: 'documentation',
});

const formFromResource = (resource: Resource): ResourceFormState => {
  const form = emptyForm();
  form.name = resource.name;
  form.description = resource.description || '';
  form.agentVisibility = resource.agentVisibility;
  form.exportPolicy = resource.exportPolicy;
  const details = resource.details as unknown as Record<string, unknown>;
  switch (resource.kind) {
    case 'repository':
      form.repositoryUrl = String(details.url || '');
      form.repositoryRole = (details.role as RepositoryRole) || 'additional';
      form.repositoryDefaultBranch = details.defaultBranch ? String(details.defaultBranch) : '';
      break;
    case 'environment':
      form.environmentUrl = String(details.url || '');
      form.environmentStage = (details.stage as EnvironmentStage) || 'development';
      break;
    case 'workspace':
      form.workspacePath = String(details.path || '');
      form.workspacePurpose = (details.purpose as WorkspacePurpose) || 'source';
      break;
    case 'reference':
      form.referenceUrl = String(details.url || '');
      form.referenceCategory = (details.category as ReferenceCategory) || 'documentation';
      break;
  }
  return form;
};

const buildPayload = (kind: ResourceKind, form: ResourceFormState): ResourceWritePayload => {
  const details =
    kind === 'repository'
      ? {
          url: form.repositoryUrl.trim(),
          role: form.repositoryRole,
          defaultBranch: form.repositoryDefaultBranch.trim() || null,
        }
      : kind === 'environment'
        ? { url: form.environmentUrl.trim(), stage: form.environmentStage }
        : kind === 'workspace'
          ? { path: form.workspacePath.trim(), purpose: form.workspacePurpose }
          : { url: form.referenceUrl.trim(), category: form.referenceCategory };
  return {
    kind,
    name: form.name.trim(),
    description: form.description.trim() || null,
    agentVisibility: form.agentVisibility,
    // Workspace values never leave this installation.
    exportPolicy: kind === 'workspace' ? 'installation-only' : form.exportPolicy,
    details,
  };
};

const validateForm = (kind: ResourceKind, form: ResourceFormState): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = 'Name is required';
  else if (form.name.trim().length > 120) errors.name = 'Name must be 120 characters or fewer';
  if (form.description.trim().length > 1000) errors.description = 'Description must be 1000 characters or fewer';
  if (kind === 'repository' && !form.repositoryUrl.trim()) errors.repositoryUrl = 'Repository URL is required';
  if (kind === 'environment' && !form.environmentUrl.trim()) errors.environmentUrl = 'Environment URL is required';
  if (kind === 'workspace' && !form.workspacePath.trim()) errors.workspacePath = 'Workspace path is required';
  if (kind === 'reference' && !form.referenceUrl.trim()) errors.referenceUrl = 'Reference URL is required';
  return errors;
};

/** Field ids as rendered in the DOM, used by the error summary links. */
const fieldDomId = (key: string) => `resource-field-${key}`;

const KIND_ICONS: Record<ResourceKind, React.ReactNode> = {
  repository: <GitBranch size={16} />,
  environment: <Globe size={16} />,
  workspace: <FolderOpen size={16} />,
  reference: <Bookmark size={16} />,
};

type EditorStep = 'kind' | 'form' | 'review' | 'done';

export const ProjectResourcesEditModal: React.FC<ProjectResourcesEditModalProps> = ({
  projectId,
  projectName,
  mode,
  resource,
  onClose,
  onSaved,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const [step, setStep] = useState<EditorStep>(mode === 'edit' ? 'form' : 'kind');
  const [kind, setKind] = useState<ResourceKind | null>(mode === 'edit' ? resource?.kind || null : null);
  const [form, setForm] = useState<ResourceFormState>(emptyForm());
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Edit mode: freshly-loaded copy of the resource (revision source for If-Match).
  const [loadedResource, setLoadedResource] = useState<Resource | null>(null);
  const [loadingResource, setLoadingResource] = useState(mode === 'edit');
  const [loadError, setLoadError] = useState<string | null>(null);

  // 412 conflict panel state
  const [conflictFields, setConflictFields] = useState<string[] | null>(null);
  const [reloadNote, setReloadNote] = useState<string | null>(null);

  // Replace flow state
  const idempotencyKeyRef = useRef<string | null>(null);
  const [transportFailed, setTransportFailed] = useState(false);
  const [replaceResult, setReplaceResult] = useState<{ replacement: Resource; replaced: Resource } | null>(null);

  const setField = <K extends keyof ResourceFormState>(key: K, value: ResourceFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setTouched(prev => ({ ...prev, [key]: true }));
    setFieldErrors(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const loadResourceForEdit = useCallback(async () => {
    if (!resource) return;
    setLoadingResource(true);
    setLoadError(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/resources/${resource.id}`);
      const data = await res.json();
      if (res.ok && data.success) {
        setLoadedResource(data.resource);
        setForm(formFromResource(data.resource));
        setTouched({});
      } else {
        setLoadError(data.message || data.error || 'Failed to load the resource');
      }
    } catch {
      setLoadError('Failed to load the resource. Check your connection and try again.');
    } finally {
      setLoadingResource(false);
    }
  }, [projectId, resource]);

  useEffect(() => {
    if (mode === 'edit') {
      loadResourceForEdit();
    }
  }, [mode, loadResourceForEdit]);

  const focusFirstError = (errors: Record<string, string>) => {
    const first = Object.keys(errors)[0];
    if (first && typeof document !== 'undefined' && document.getElementById) {
      const el = document.getElementById(fieldDomId(first));
      if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
    }
  };

  const focusField = (key: string) => {
    if (typeof document !== 'undefined' && document.getElementById) {
      const el = document.getElementById(fieldDomId(key));
      if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
    }
  };

  const changedFieldLabels = (): string[] =>
    Object.keys(touched)
      .filter(key => touched[key])
      .map(key => RESOURCE_FIELD_LABELS[key] || key);

  const handleCreateSubmit = async () => {
    if (!kind || submitting) return;
    const errors = validateForm(kind, form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstError(errors);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(kind, form)),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onSaved();
        onClose();
      } else {
        applyServerError(res.status, data);
      }
    } catch {
      setFormError('The request failed. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!kind || !loadedResource || submitting) return;
    const errors = validateForm(kind, form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstError(errors);
      return;
    }
    // Merge patch: only send what changed.
    const payload = buildPayload(kind, form);
    const patch: Record<string, unknown> = {};
    if (touched.name) patch.name = payload.name;
    if (touched.description) patch.description = payload.description;
    if (touched.agentVisibility) patch.agentVisibility = payload.agentVisibility;
    if (touched.exportPolicy) patch.exportPolicy = payload.exportPolicy;
    if (KIND_FIELD_KEYS[kind].some(key => touched[key])) patch.details = payload.details;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/resources/${loadedResource.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': loadedResource.revision,
        },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onSaved();
        onClose();
      } else if (res.status === 412) {
        setConflictFields(changedFieldLabels());
      } else {
        applyServerError(res.status, data);
      }
    } catch {
      setFormError('The request failed. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitReplace = async () => {
    if (!kind || !resource || submitting) return;
    // Reuse the same key across retries of this same operation.
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = makeIdempotencyKey();
    }
    setSubmitting(true);
    setFormError(null);
    setTransportFailed(false);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/resources/${resource.id}/replace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': resource.revision,
          'Idempotency-Key': idempotencyKeyRef.current,
        },
        body: JSON.stringify(buildPayload(kind, form)),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setReplaceResult({ replacement: data.replacement, replaced: data.replaced });
        setStep('done');
      } else if (res.status === 412) {
        // Definitive failure: the server did nothing. A resubmission after
        // reload is a new operation, so the key must not be reused.
        idempotencyKeyRef.current = null;
        setConflictFields(changedFieldLabels());
      } else {
        idempotencyKeyRef.current = null;
        applyServerError(res.status, data);
      }
    } catch {
      // Ambiguous transport failure: the server may or may not have acted.
      // Keep the key so "Retry same operation" repeats the exact request.
      setTransportFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const applyServerError = (status: number, data: { code?: string; message?: string; error?: string }) => {
    const message = data.message || data.error || `Request failed (${status})`;
    if (data.code === 'RESOURCE_NAME_CONFLICT') {
      setFieldErrors(prev => ({ ...prev, name: message }));
      focusFirstError({ name: message });
    } else {
      setFormError(message);
    }
  };

  const handleConflictReload = async () => {
    setConflictFields(null);
    if (mode === 'edit') {
      await loadResourceForEdit();
      setReloadNote('Reloaded the latest saved version. Re-apply your changes, then save again.');
    } else {
      // Replace: the underlying resource moved on. The caller refreshes the
      // list; the owner restarts the change-kind flow from current data.
      onSaved();
      onClose();
    }
  };

  const closeLabel = 'Close';

  const renderKindPicker = () => {
    const currentKind = mode === 'replace' ? resource?.kind : null;
    return (
      <div className="resource-kind-picker">
        {mode === 'replace' && resource && (
          <p className="resource-kind-picker-intro">
            Changing the kind of <strong>{resource.name}</strong> replaces it: the current resource is archived and a
            new one is created in a single step. Pick the new kind to begin.
          </p>
        )}
        {mode === 'create' && (
          <p className="resource-kind-picker-intro">What does this resource describe?</p>
        )}
        <div className="resource-kind-options" role="group" aria-label="Resource kind">
          {RESOURCE_KINDS.map(k => (
            <Button
              key={k}
              variant="secondary"
              size="compact"
              className="resource-kind-option"
              dataTestId={`resource-kind-${k}`}
              disabled={currentKind === k}
              onClick={() => {
                setKind(k);
                if (mode === 'replace' && resource) {
                  // Start the proposed replacement from the current common fields.
                  const seeded = emptyForm();
                  seeded.name = resource.name;
                  seeded.description = resource.description || '';
                  setForm(seeded);
                  setTouched({});
                } else {
                  setForm(prev => ({ ...emptyForm(), name: prev.name, description: prev.description }));
                }
                setFieldErrors({});
                setStep('form');
              }}
            >
              <span className="resource-kind-option-icon">{KIND_ICONS[k]}</span>
              <span className="resource-kind-option-text">
                <span className="resource-kind-option-label">
                  {RESOURCE_KIND_LABELS[k]}
                  {currentKind === k && <span className="resource-kind-current-tag"> (current kind)</span>}
                </span>
                <span className="resource-kind-option-desc">{RESOURCE_KIND_DESCRIPTIONS[k]}</span>
              </span>
            </Button>
          ))}
        </div>
      </div>
    );
  };

  const renderField = (
    key: keyof ResourceFormState,
    label: string,
    input: React.ReactNode,
    hint?: string,
  ) => (
    <div className="resources-field">
      <label className="resources-label" htmlFor={fieldDomId(key)}>{label}</label>
      {input}
      {hint && <p className="resources-hint">{hint}</p>}
      {fieldErrors[key] && (
        <p className="resources-field-error" id={`${fieldDomId(key)}-error`} role="alert">{fieldErrors[key]}</p>
      )}
    </div>
  );

  const renderKindFields = () => {
    if (!kind) return null;
    switch (kind) {
      case 'repository':
        return (
          <>
            {renderField('repositoryUrl', 'Repository URL',
              <input
                id={fieldDomId('repositoryUrl')}
                type="text"
                className="resources-input"
                value={form.repositoryUrl}
                onChange={e => setField('repositoryUrl', e.target.value)}
                placeholder="https://... or ssh://... (no embedded credentials)"
                aria-invalid={!!fieldErrors.repositoryUrl}
              />)}
            {renderField('repositoryRole', 'Repository role',
              <Select
                id={fieldDomId('repositoryRole')}
                value={form.repositoryRole}
                onChange={e => setField('repositoryRole', e.target.value as RepositoryRole)}
              >
                <option value="additional">Additional</option>
                <option value="primary">Primary</option>
              </Select>,
              'A project can have at most one primary repository.')}
            {renderField('repositoryDefaultBranch', 'Default branch (optional)',
              <input
                id={fieldDomId('repositoryDefaultBranch')}
                type="text"
                className="resources-input"
                value={form.repositoryDefaultBranch}
                onChange={e => setField('repositoryDefaultBranch', e.target.value)}
                placeholder="main"
              />)}
          </>
        );
      case 'environment':
        return (
          <>
            {renderField('environmentUrl', 'Environment URL',
              <input
                id={fieldDomId('environmentUrl')}
                type="text"
                className="resources-input"
                value={form.environmentUrl}
                onChange={e => setField('environmentUrl', e.target.value)}
                placeholder="https://app.example.com"
                aria-invalid={!!fieldErrors.environmentUrl}
              />)}
            {renderField('environmentStage', 'Stage',
              <Select
                id={fieldDomId('environmentStage')}
                value={form.environmentStage}
                onChange={e => setField('environmentStage', e.target.value as EnvironmentStage)}
              >
                <option value="development">Development</option>
                <option value="test">Test</option>
                <option value="staging">Staging</option>
                <option value="production">Production</option>
                <option value="other">Other</option>
              </Select>)}
          </>
        );
      case 'workspace':
        return (
          <>
            {renderField('workspacePath', 'Workspace path',
              <input
                id={fieldDomId('workspacePath')}
                type="text"
                className="resources-input resources-input-mono"
                value={form.workspacePath}
                onChange={e => setField('workspacePath', e.target.value)}
                placeholder="/srv/projects/example"
                aria-invalid={!!fieldErrors.workspacePath}
              />)}
            {renderField('workspacePurpose', 'Purpose',
              <Select
                id={fieldDomId('workspacePurpose')}
                value={form.workspacePurpose}
                onChange={e => setField('workspacePurpose', e.target.value as WorkspacePurpose)}
              >
                <option value="source">Source</option>
                <option value="build">Build</option>
                <option value="data">Data</option>
                <option value="backup">Backup</option>
                <option value="other">Other</option>
              </Select>)}
          </>
        );
      case 'reference':
        return (
          <>
            {renderField('referenceUrl', 'Reference URL',
              <input
                id={fieldDomId('referenceUrl')}
                type="text"
                className="resources-input"
                value={form.referenceUrl}
                onChange={e => setField('referenceUrl', e.target.value)}
                placeholder="https://docs.example.com/guide"
                aria-invalid={!!fieldErrors.referenceUrl}
              />)}
            {renderField('referenceCategory', 'Category',
              <Select
                id={fieldDomId('referenceCategory')}
                value={form.referenceCategory}
                onChange={e => setField('referenceCategory', e.target.value as ReferenceCategory)}
              >
                <option value="documentation">Documentation</option>
                <option value="research">Research</option>
                <option value="tool">Tool</option>
                <option value="other">Other</option>
              </Select>)}
          </>
        );
    }
  };

  const workspaceLocked = kind === 'workspace';

  const renderForm = () => (
    <div className="resources-section">
      {(mode === 'create' || mode === 'replace') && (
        <Button
          variant="secondary"
          size="compact"
          className="resources-back-btn"
          icon={<ArrowLeft size={16} />}
          onClick={() => { setStep('kind'); setFieldErrors({}); setFormError(null); }}
        >
          Choose a different kind
        </Button>
      )}

      <p className="resources-trust-callout" data-testid="resource-trust-callout">
        <AlertTriangle size={16} aria-hidden="true" /> {RESOURCE_TRUST_CALLOUT}
      </p>

      {reloadNote && <p className="resources-reload-note" role="status">{reloadNote}</p>}

      {Object.keys(fieldErrors).length > 0 && (
        <div className="resources-error-summary" role="alert">
          <p>Fix the following before saving:</p>
          <ul>
            {Object.entries(fieldErrors).map(([key, message]) => (
              <li key={key}>
                <Button variant="secondary" size="compact" className="resources-error-link" onClick={() => focusField(key)}>
                  {RESOURCE_FIELD_LABELS[key] || key}
                </Button>: {message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {renderField('name', 'Name',
        <input
          id={fieldDomId('name')}
          type="text"
          className="resources-input"
          value={form.name}
          onChange={e => setField('name', e.target.value)}
          maxLength={120}
          aria-invalid={!!fieldErrors.name}
        />)}
      {renderField('description', 'Description (optional)',
        <textarea
          id={fieldDomId('description')}
          className="resources-textarea"
          value={form.description}
          onChange={e => setField('description', e.target.value)}
          rows={2}
          maxLength={1000}
        />)}

      {renderKindFields()}

      {renderField('agentVisibility', 'Agent visibility',
        <Select
          id={fieldDomId('agentVisibility')}
          value={form.agentVisibility}
          onChange={e => setField('agentVisibility', e.target.value as AgentVisibility)}
        >
          <option value="hidden">{AGENT_VISIBILITY_LABELS.hidden} (default)</option>
          <option value="available">{AGENT_VISIBILITY_LABELS.available}</option>
        </Select>,
        'New resources start hidden from agents until you choose otherwise.')}

      {renderField('exportPolicy', 'Export policy',
        <Select
          id={fieldDomId('exportPolicy')}
          value={workspaceLocked ? 'installation-only' : form.exportPolicy}
          onChange={e => setField('exportPolicy', e.target.value as ExportPolicy)}
          disabled={workspaceLocked}
          aria-describedby={workspaceLocked ? 'workspace-export-note' : undefined}
        >
          <option value="installation-only">{EXPORT_POLICY_LABELS['installation-only']} (default)</option>
          <option value="portable">{EXPORT_POLICY_LABELS.portable}</option>
        </Select>,
        workspaceLocked ? undefined : 'Installation only keeps this value out of portable exports.')}
      {workspaceLocked && (
        <p className="resources-hint" id="workspace-export-note">
          Workspace paths are specific to this installation, so their export policy is locked to installation only.
        </p>
      )}
    </div>
  );

  const renderReplacementSummary = (payloadKind: ResourceKind) => {
    const payload = buildPayload(payloadKind, form);
    const detailEntries = Object.entries(payload.details as unknown as Record<string, unknown>);
    return (
      <dl className="replace-summary-fields">
        <div><dt>Kind</dt><dd>{RESOURCE_KIND_LABELS[payloadKind]}</dd></div>
        <div><dt>Name</dt><dd>{payload.name}</dd></div>
        <div><dt>Description</dt><dd>{payload.description || '—'}</dd></div>
        {detailEntries.map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{value === null || value === '' ? '—' : String(value)}</dd></div>
        ))}
        <div><dt>Agent visibility</dt><dd>{AGENT_VISIBILITY_LABELS[payload.agentVisibility]}</dd></div>
        <div><dt>Export policy</dt><dd>{EXPORT_POLICY_LABELS[payload.exportPolicy]}</dd></div>
      </dl>
    );
  };

  const renderReview = () => {
    if (!resource || !kind) return null;
    return (
      <div className="resources-section replace-review" data-testid="replace-review">
        <h3 className="replace-review-heading">Review the replacement</h3>
        <p className="replace-review-intro">
          Confirming performs one combined operation: the current resource is archived and the replacement is created
          together. Nothing changes until you confirm.
        </p>
        <div className="replace-review-columns">
          <div className="replace-review-card replace-review-old">
            <h4><Archive size={16} aria-hidden="true" /> Current resource (will be archived)</h4>
            <dl className="replace-summary-fields">
              <div><dt>Kind</dt><dd>{RESOURCE_KIND_LABELS[resource.kind]}</dd></div>
              <div><dt>Name</dt><dd>{resource.name}</dd></div>
              <div><dt>Summary</dt><dd>{safeResourceSummary(resource) || '—'}</dd></div>
            </dl>
          </div>
          <div className="replace-review-card replace-review-new">
            <h4><Check size={16} aria-hidden="true" /> Proposed replacement</h4>
            {renderReplacementSummary(kind)}
          </div>
        </div>

        {transportFailed && (
          <div className="resources-error-summary" role="alert">
            <p>
              The request could not be completed and the result is unknown. Retrying repeats the exact same operation —
              it will not create a duplicate.
            </p>
            <Button variant="primary" size="compact" onClick={submitReplace} disabled={submitting}>
              <RefreshCw size={16} /> {submitting ? 'Retrying...' : 'Retry same operation'}
            </Button>
          </div>
        )}
        {formError && <div className="resources-error" role="alert">{formError}</div>}
      </div>
    );
  };

  const renderDone = () => {
    if (!replaceResult) return null;
    const { replaced, replacement } = replaceResult;
    return (
      <div className="resources-section replace-done" data-testid="replace-done" role="status">
        <h3 className="replace-review-heading"><Check size={16} aria-hidden="true" /> Kind changed</h3>
        <div className="replace-review-columns">
          <div className="replace-review-card replace-review-old">
            <h4><Archive size={16} aria-hidden="true" /> Archived</h4>
            <p>{RESOURCE_KIND_LABELS[replaced.kind]} · {replaced.name}</p>
            <p className="resources-hint">Kept in history; no longer part of agent context or exports.</p>
          </div>
          <div className="replace-review-card replace-review-new">
            <h4><Check size={16} aria-hidden="true" /> Active</h4>
            <p>{RESOURCE_KIND_LABELS[replacement.kind]} · {replacement.name}</p>
            <p className="resources-hint">{AGENT_VISIBILITY_LABELS[replacement.agentVisibility]} · {EXPORT_POLICY_LABELS[replacement.exportPolicy]}</p>
          </div>
        </div>
      </div>
    );
  };

  const renderConflict = () => (
    <div className="resources-section resources-conflict" role="alert" data-testid="revision-conflict">
      <h3 className="replace-review-heading"><AlertTriangle size={16} aria-hidden="true" /> This resource changed while you were editing</h3>
      <p>Someone else saved a newer version. Your submission was not applied. Fields you had changed:</p>
      <ul>
        {(conflictFields || []).length > 0
          ? (conflictFields || []).map(label => <li key={label}>{label}</li>)
          : <li>(no fields changed)</li>}
      </ul>
      <p>Reload the latest version, re-apply your changes, and save again. There is no force overwrite.</p>
      <Button variant="primary" size="compact" onClick={handleConflictReload}>
        <RefreshCw size={16} /> Reload latest version
      </Button>
    </div>
  );

  const title =
    mode === 'create' ? `Add resource — ${projectName}`
    : mode === 'edit' ? `Edit resource — ${resource?.name || ''}`
    : `Change kind — ${resource?.name || ''}`;

  const goToReview = () => {
    if (!kind) return;
    const errors = validateForm(kind, form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstError(errors);
      return;
    }
    setFieldErrors({});
    setStep('review');
  };

  const primaryAction = () => {
    if (conflictFields) return null;
    if (step === 'kind') return null;
    if (step === 'done') {
      return (
        <Button variant="primary" size="compact" onClick={() => { onSaved(); onClose(); }}>
          Done
        </Button>
      );
    }
    if (mode === 'create') {
      return (
        <Button variant="primary" size="compact" onClick={handleCreateSubmit} disabled={submitting}>
          {submitting ? 'Adding...' : 'Add resource'}
        </Button>
      );
    }
    if (mode === 'edit') {
      return (
        <Button variant="primary" size="compact" onClick={handleEditSubmit} disabled={submitting || loadingResource || !!loadError}>
          {submitting ? 'Saving...' : 'Save changes'}
        </Button>
      );
    }
    // replace
    if (step === 'form') {
      return (
        <Button variant="primary" size="compact" onClick={goToReview}>
          Review replacement
        </Button>
      );
    }
    return (
      <Button
        variant="primary"
        size="compact"
        dataTestId="confirm-replace"
        onClick={submitReplace}
        disabled={submitting || transportFailed}
      >
        {submitting ? 'Replacing...' : 'Confirm replacement'}
      </Button>
    );
  };

  return (
    <div
      className="project-resources-edit-overlay"
      onClick={e => { if (e.target === e.currentTarget) { e.stopPropagation(); onClose(); } }}
    >
      <div
        className="project-resources-edit-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
      >
        <div className="project-resources-edit-header">
          <h2>{title}</h2>
          <IconButton
            className="project-resources-edit-close"
            variant="ghost"
            ariaLabel={closeLabel}
            icon={<X size={20} />}
            onClick={onClose}
          />
        </div>

        <div className="project-resources-edit-content">
          {conflictFields ? renderConflict() : (
            <>
              {mode === 'edit' && loadingResource && <div className="resources-loading">Loading resource...</div>}
              {mode === 'edit' && loadError && (
                <div className="resources-error" role="alert">
                  {loadError}
                  <Button variant="secondary" size="compact" onClick={loadResourceForEdit}>Try again</Button>
                </div>
              )}
              {!loadingResource && !loadError && (
                <>
                  {step === 'kind' && renderKindPicker()}
                  {step === 'form' && renderForm()}
                  {step === 'review' && renderReview()}
                  {step === 'done' && renderDone()}
                </>
              )}
            </>
          )}
        </div>

        {formError && step !== 'review' && <div className="resources-error" role="alert">{formError}</div>}

        <div className="project-resources-edit-actions">
          {step !== 'done' && (
            <Button variant="secondary" size="compact" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
          )}
          {step === 'review' && !transportFailed && !conflictFields && (
            <Button variant="secondary" size="compact" onClick={() => setStep('form')} disabled={submitting}>
              Back
            </Button>
          )}
          {primaryAction()}
        </div>
      </div>
    </div>
  );
};
