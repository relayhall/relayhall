import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Save, Pencil, Globe, Tag, GraduationCap, Plus, AlertTriangle, Send, Check, Ban } from 'lucide-react';
import { Skill, SkillProvenance, SkillVersion } from '../../types/skill';
import { authenticatedFetch } from '../../utils/auth';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { Select } from '../ui/Select';
import './SkillDetailModal.css';
import { formatDateTime } from '../../utils/dateFormat';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface SkillDetailModalProps {
  skill: Skill | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

export const SkillDetailModal: React.FC<SkillDetailModalProps> = ({ skill, onClose, onSaved }) => {
  const isCreate = skill === null;
  const [editing, setEditing] = useState(isCreate);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<SkillVersion | null>(skill?.current_version || null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const [name, setName] = useState(skill?.name || '');
  const [category, setCategory] = useState(skill?.category || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [skillMd, setSkillMd] = useState('');
  const [configText, setConfigText] = useState(JSON.stringify(skill?.config || {}, null, 2));
  const [tags, setTags] = useState<string[]>(skill?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [provenance, setProvenance] = useState<SkillProvenance>('human-authored');
  const [sourceUri, setSourceUri] = useState('');

  const loadContent = useCallback(async (version: SkillVersion) => {
    if (!skill) return;
    try {
      const response = await authenticatedFetch(
        `${API_BASE_URL}/skills/${skill.id}/versions/${version.id}/content`,
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load Version content');
      const full = data.version as SkillVersion;
      setSelectedVersion(full);
      setSkillMd(full.skill_md || '');
      setCategory(full.category || '');
      setDescription(full.description || '');
      setConfigText(JSON.stringify(full.config || {}, null, 2));
      setTags(full.tags || []);
      setProvenance(full.provenance);
      setSourceUri(full.source_uri || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Version content');
    }
  }, [skill]);

  useEffect(() => {
    if (!skill) return;
    void (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/skills/${skill.id}/versions`);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load Versions');
        const rows = (data.versions || []) as SkillVersion[];
        setVersions(rows);
        const initial = rows.find(v => v.id === skill.current_version?.id) || rows[0];
        if (initial) await loadContent(initial);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load Versions');
      }
    })();
  }, [skill, loadContent]);

  const addTag = useCallback(() => {
    const next = tagInput.trim().toLowerCase();
    if (next && !tags.includes(next)) setTags([...tags, next]);
    setTagInput('');
  }, [tagInput, tags]);

  const saveDraft = useCallback(async () => {
    if (!name.trim()) { setError('Skill name is required'); return; }
    let config: Record<string, unknown>;
    try { config = JSON.parse(configText); } catch { setError('Config must be valid JSON'); return; }
    setSaving(true); setError(null);
    try {
      const body = isCreate
        ? { name: name.trim(), description, usage_instructions: skillMd, category: category || undefined,
            config, tags, provenance, source_uri: provenance === 'imported' ? sourceUri : undefined }
        : { skill_md: skillMd, category: category || undefined, config, tags, provenance,
            source_uri: provenance === 'imported' ? sourceUri : undefined };
      const response = await authenticatedFetch(
        isCreate ? `${API_BASE_URL}/skills` : `${API_BASE_URL}/skills/${skill!.id}`,
        { method: isCreate ? 'POST' : 'PUT', headers: {
          'Content-Type': 'application/json', ...(!isCreate ? { 'If-Match': skill!.revision } : {}),
        }, body: JSON.stringify(body) },
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to save Skill Version');
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save Skill Version'); }
    finally { setSaving(false); }
  }, [name, description, skillMd, category, configText, tags, provenance, sourceUri, isCreate, skill, onSaved]);

  const lifecycle = useCallback(async (operation: 'submit-review' | 'reject' | 'publish' | 'retire') => {
    if (!skill || !selectedVersion) return;
    setAction(operation); setError(null);
    try {
      const response = await authenticatedFetch(
        `${API_BASE_URL}/skills/${skill.id}/versions/${selectedVersion.id}/${operation}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': skill.revision },
          body: JSON.stringify({}) },
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `Unable to ${operation}`);
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : `Unable to ${operation}`); }
    finally { setAction(null); }
  }, [skill, selectedVersion, onSaved]);

  const setAudience = useCallback(async () => {
    if (!skill) return;
    setAction('audience'); setError(null);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/skills/${skill.id}/audience`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': skill.revision },
        body: JSON.stringify({ is_global: !skill.is_global }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to change audience');
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to change audience'); }
    finally { setAction(null); }
  }, [skill, onSaved]);

  const formatDate = (value: string) => formatDateTime(value);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="skill-detail-modal"
        ref={modalRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-detail-modal-title"
      >
        <div className="skill-detail-header">
          <div className="skill-detail-title">
            <GraduationCap size={20} aria-hidden="true" />
            <h2 id="skill-detail-modal-title">{isCreate ? 'Create Skill Draft' : skill.name}</h2>
            {!isCreate && selectedVersion && (
              <div className="skill-detail-badges">
                {skill.is_global && <span className="skill-badge skill-badge-global"><Globe size={16} /> Global</span>}
                <span className="skill-badge skill-badge-version">v{selectedVersion.version} · {selectedVersion.status}</span>
              </div>
            )}
          </div>
          <div className="skill-detail-actions">
            {!isCreate && !editing && <Button variant="secondary" size="compact" className="btn-edit-skill" icon={<Pencil size={16} />} onClick={() => setEditing(true)}>New draft</Button>}
            <IconButton className="modal-close" variant="ghost" ariaLabel="Close" icon={<X size={24} />} onClick={onClose} />
          </div>
        </div>

        {error && <div className="skill-detail-error"><AlertTriangle size={16} /> {error}</div>}

        <div className="skill-detail-content">
          {editing ? (
            <div className="skill-form">
              <div className="form-group"><label htmlFor="skill-name">Agent Skills name *</label>
                <input id="skill-name" className="form-input" value={name} disabled={!isCreate}
                  onChange={e => setName(e.target.value)} placeholder="lowercase-hyphenated-name" autoFocus />
              </div>
              <div className="form-row skill-detail-modal-form-row">
                <div className="form-group"><label htmlFor="skill-category">Category</label>
                  <input id="skill-category" className="form-input" value={category} onChange={e => setCategory(e.target.value)} />
                </div>
                <div className="form-group"><label htmlFor="skill-provenance">Provenance</label>
                  <Select id="skill-provenance" value={provenance}
                    onChange={e => setProvenance(e.target.value as SkillProvenance)}>
                    <option value="human-authored">Human-authored</option>
                    <option value="imported">Imported</option>
                    <option value="agent-drafted">Agent-drafted</option>
                  </Select>
                </div>
              </div>
              {provenance === 'imported' && <div className="form-group"><label htmlFor="skill-source">Source URI *</label>
                <input id="skill-source" className="form-input" value={sourceUri} onChange={e => setSourceUri(e.target.value)} />
              </div>}
              {isCreate && <div className="form-group"><label htmlFor="skill-description">Description *</label>
                <textarea id="skill-description" className="form-textarea" rows={2} value={description}
                  onChange={e => setDescription(e.target.value)} />
              </div>}
              <div className="form-group"><label htmlFor="skill-md">{isCreate ? 'Markdown instructions' : 'Complete SKILL.md *'}</label>
                <textarea id="skill-md" className="form-textarea form-textarea-mono form-textarea-lg" rows={12}
                  value={skillMd} onChange={e => setSkillMd(e.target.value)}
                  placeholder={isCreate ? 'Instructions placed after generated YAML frontmatter' : '---\nname: ...\ndescription: ...\n---\n\nInstructions'} />
              </div>
              <div className="form-group"><label htmlFor="skill-config">Config (JSON)</label>
                <textarea id="skill-config" className="form-textarea form-textarea-mono" rows={4}
                  value={configText} onChange={e => setConfigText(e.target.value)} />
              </div>
              <div className="form-group"><label><Tag size={16} /> Tags</label>
                <div className="tag-list">{tags.map(tag => <span className="tag-item" key={tag}>{tag}
                  <IconButton className="tag-remove" variant="ghost" ariaLabel={`Remove tag ${tag}`} icon={<X size={16} />} onClick={() => setTags(tags.filter(value => value !== tag))} />
                </span>)}</div>
                <div className="tag-add-row"><label className="sr-only" htmlFor="skill-detail-tag-add">Add a tag</label><input id="skill-detail-tag-add" className="form-input tag-add-input" placeholder="Add a tag" value={tagInput}
                  onChange={e => setTagInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
                  <Button variant="secondary" size="compact" className="btn-add-tag" icon={<Plus size={16} />} onClick={addTag} disabled={!tagInput.trim()}>Add</Button></div>
              </div>
              <div className="form-actions"><Button variant="secondary" size="compact" onClick={() => isCreate ? onClose() : setEditing(false)}>Cancel</Button>
                <Button variant="primary" size="compact" icon={<Save size={16} />} onClick={saveDraft} disabled={saving}>{saving ? 'Saving…' : 'Save immutable draft'}</Button>
              </div>
            </div>
          ) : selectedVersion && skill ? (
            <div className="skill-view">
              <div className="form-group"><label htmlFor="skill-version-select">Versions</label>
                <Select id="skill-version-select" value={selectedVersion.id}
                  onChange={e => { const version = versions.find(v => v.id === e.target.value); if (version) void loadContent(version); }}>
                  {versions.map(version => <option key={version.id} value={version.id}>v{version.version} · {version.status} · {version.provenance}</option>)}
                </Select>
              </div>
              <div className="skill-view-section"><span className="view-label">Description</span><p className="view-text">{selectedVersion.description}</p></div>
              <div className="skill-view-section"><span className="view-label">Immutable SKILL.md</span><pre className="view-instructions">{selectedVersion.skill_md}</pre></div>
              <div className="skill-view-meta">
                <div className="meta-item"><span className="meta-label">Created</span><span className="meta-value">{formatDate(selectedVersion.created_at)}</span></div>
                <div className="meta-item"><span className="meta-label">SHA-256</span><span className="meta-value">{selectedVersion.content_sha256.slice(0, 12)}…</span></div>
                <div className="meta-item"><span className="meta-label">Provenance</span><span className="meta-value">{selectedVersion.provenance}</span></div>
              </div>
              <div className="form-actions">
                {selectedVersion.status === 'draft' && <Button variant="primary" size="compact" icon={<Send size={16} />} onClick={() => lifecycle('submit-review')} disabled={!!action}>Submit for review</Button>}
                {selectedVersion.status === 'review' && <><Button variant="secondary" size="compact" onClick={() => lifecycle('reject')} disabled={!!action}>Return to draft</Button>
                  <Button variant="primary" size="compact" icon={<Check size={16} />} onClick={() => lifecycle('publish')} disabled={!!action}>Publish (human admin)</Button></>}
                {selectedVersion.status !== 'retired' && <Button variant="danger" size="compact" className="btn-delete-confirm" icon={<Ban size={16} />} onClick={() => lifecycle('retire')} disabled={!!action}>Retire</Button>}
                {skill.current_published_version_id && <Button variant="secondary" size="compact" icon={<Globe size={16} />} onClick={setAudience} disabled={!!action}>{skill.is_global ? 'Remove global audience' : 'Make global'}</Button>}
              </div>
            </div>
          ) : <div className="skills-empty">No Versions available.</div>}
        </div>
      </div>
    </div>, document.body,
  );
};
