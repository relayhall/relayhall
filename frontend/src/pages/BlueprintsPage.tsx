import { IS_PUBLIC_BUILD, SOURCE_URL } from '../utils/build';
import { BlueprintDraftEditor } from '../components/blueprints/BlueprintDraftEditor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookOpen, Download, Plus, Upload } from 'lucide-react';
import { Button } from '../components/Button';
import { useMyPrincipal } from '../hooks/usePrincipals';
import { authenticatedFetch } from '../utils/auth';
import { formatDateTime } from '../utils/dateFormat';
import type { BlueprintDetail, BlueprintDocument, BlueprintSummary, BlueprintVersion } from '../types/blueprint';
import { BLUEPRINT_API_BASE, blueprintError, blueprintJson, blueprintRequest, BlueprintRequestError } from '../components/blueprints/api';
import { BlueprintUse } from '../components/blueprints/BlueprintUse';
import { BlueprintTile } from '../components/blueprints/BlueprintTile';
import { BlueprintData } from '../components/blueprints/BlueprintPlan';
import { BlueprintLedger } from '../components/blueprints/BlueprintLedger';
import './BlueprintsPage.css';

type EditorMode = 'create' | 'import' | 'edit' | 'new-version';
const emptyDocument = (): BlueprintDocument => ({ schemaVersion: 'rh.blueprint/1.0', blueprint: { key: 'new-blueprint', version: 1, name: 'New Blueprint', summary: '', description: '', provenance: 'agent-drafted', tags: [] },
  parameters: [], references: [], target: { mode: 'new-project', project: { name: 'New Project' } }, phases: [], tasks: [], reports: [], humanGates: [], dependencies: [] });

export function BlueprintsPage() {
  const [search, setSearch] = useSearchParams(); const { scopes } = useMyPrincipal();
  const [items, setItems] = useState<BlueprintSummary[]>([]); const [loading, setLoading] = useState(true); const [query, setQuery] = useState('');
  const [statusFilter,setStatusFilter]=useState('');const [targetFilter,setTargetFilter]=useState('');
  const [detail, setDetail] = useState<BlueprintDetail | null>(null); const [detailLoading, setDetailLoading] = useState(false); const [wizard, setWizard] = useState(false);
  const [error, setError] = useState<BlueprintRequestError | null>(null); const [notice, setNotice] = useState<string | null>(null); const errorRef = useRef<HTMLDivElement>(null);
  const [versions, setVersions] = useState<BlueprintVersion[] | null>(null); const [showLedger, setShowLedger] = useState(false);
  const [editor, setEditor] = useState<EditorMode | null>(null); const [documentText, setDocumentText] = useState(''); const [rename, setRename] = useState('');
  const [lifecycle, setLifecycle] = useState<string | null>(null); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const listGeneration = useRef(0); const detailGeneration = useRef(0); const fileGeneration = useRef(0);
  const canWrite = !!scopes && (scopes.includes('blueprints:write') || scopes.includes('root') || scopes.includes('*'));
  const chosen = search.get('blueprint'); const projectId = search.get('project') || undefined; const instantiationId = search.get('instantiation') || undefined;
  const versionQuery = search.get('version');
  const loadList = useCallback(async () => {
    const current = ++listGeneration.current; setLoading(true);
    try { const data = await blueprintRequest<{ blueprints: BlueprintSummary[] }>('/blueprints'); if (current === listGeneration.current) setItems(data.blueprints); }
    catch (failure) { if (current === listGeneration.current) setError(blueprintError(failure)); }
    finally { if (current === listGeneration.current) setLoading(false); }
  }, []);
  const loadDetail = useCallback(async () => {
    const current = ++detailGeneration.current; setDetail(null); setVersions(null); setLifecycle(null); setWizard(false); setShowLedger(!!instantiationId);
    if (!chosen) { setDetailLoading(false); return; }
    setDetailLoading(true); setError(null);
    try {
      const data = await blueprintRequest<{ blueprint: BlueprintDetail }>(`/blueprints/${encodeURIComponent(chosen)}${versionQuery ? `?version=${encodeURIComponent(versionQuery)}` : ''}`);
      if (current === detailGeneration.current) setDetail(data.blueprint);
    } catch (failure) { if (current === detailGeneration.current) setError(blueprintError(failure)); }
    finally { if (current === detailGeneration.current) setDetailLoading(false); }
  }, [chosen, versionQuery, instantiationId]);
  useEffect(() => { void loadList(); return () => { listGeneration.current++; }; }, [loadList]);
  useEffect(() => { void loadDetail(); return () => { detailGeneration.current++; }; }, [loadDetail]);
  useEffect(() => { errorRef.current?.focus(); }, [error]);
  const select = (id: string, version?: number) => {
    setError(null); setNotice(null); setEditor(null); setRename('');
    const next = new URLSearchParams(); next.set('blueprint', id); if (projectId) next.set('project', projectId); if (version !== undefined) next.set('version', String(version)); setSearch(next);
  };
  const openEditor = (mode: EditorMode) => {
    const document = mode === 'create' || mode === 'import' ? emptyDocument() : structuredClone(detail!.document);
    if (mode === 'new-version') document.blueprint.version = Math.max(detail!.version, ...(versions || []).map(row => row.version)) + 1;
    setDocumentText(mode === 'import' ? '' : JSON.stringify(document, null, 2)); setEditor(mode); setRename(''); setError(null); setNotice(null);
  };
  const saveDocument = async () => {
    if (busy || !editor) return; setError(null);
    let document: unknown;
    try { document = JSON.parse(documentText); } catch { setError(new BlueprintRequestError('Enter a valid JSON document.', 'BLUEPRINT_JSON_INVALID')); return; }
    setBusy(true);
    try {
      const path = editor === 'import' ? '/blueprints/import' : editor === 'create' ? '/blueprints' : `/blueprints/${encodeURIComponent(detail!.id)}/versions${editor === 'edit' ? `/${detail!.version}` : ''}`;
      const body = editor === 'import' ? { document, ...(rename.trim() ? { rename: rename.trim() } : {}) } : document;
      const data = await blueprintRequest<{ blueprint: { id: string; version: number } }>(path, blueprintJson(body, editor === 'edit' ? 'PATCH' : 'POST'));
      setEditor(null); setNotice('Draft saved. Publication requires independent review.'); await loadList(); select(data.blueprint.id, data.blueprint.version);
    } catch (failure) { setError(blueprintError(failure)); }
    finally { setBusy(false); }
  };
  const transition = async () => {
    if (!detail || !lifecycle || busy) return;
    if (lifecycle === 'reject' && !note.trim()) { setError(new BlueprintRequestError('A rejection note is required.', 'BLUEPRINT_NOTE_REQUIRED')); return; }
    setBusy(true); setError(null);
    try {
      const data = await blueprintRequest<{ blueprint: { supersededVersion?: number | null } }>(`/blueprints/${encodeURIComponent(detail.id)}/versions/${detail.version}/${lifecycle}`, blueprintJson({ note: note.trim() || undefined }));
      setNotice(data.blueprint.supersededVersion ? `Version ${data.blueprint.supersededVersion} was retired. Existing instances are unchanged.` : 'Version status updated. Existing instances are unchanged.');
      setLifecycle(null); setNote(''); await Promise.all([loadList(), loadDetail()]);
    } catch (failure) { setError(blueprintError(failure)); }
    finally { setBusy(false); }
  };
  const history = async () => {
    if (!detail) return; setBusy(true); setError(null);
    try { const data = await blueprintRequest<{ versions: BlueprintVersion[] }>(`/blueprints/${encodeURIComponent(detail.id)}/versions`); setVersions(data.versions); }
    catch (failure) { setError(blueprintError(failure)); } finally { setBusy(false); }
  };
  const download = async () => {
    if (!detail) return; setBusy(true); setError(null);
    try {
      const response = await authenticatedFetch(`${BLUEPRINT_API_BASE}/blueprints/${encodeURIComponent(detail.id)}/versions/${detail.version}/export`);
      if (!response.ok) { const body = await response.json(); throw new BlueprintRequestError(body.error || 'Export is unavailable.', body.code || 'BLUEPRINT_EXPORT_REFUSED'); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `${detail.key}-v${detail.version}.json`; link.click(); URL.revokeObjectURL(url);
    } catch (failure) { setError(blueprintError(failure)); } finally { setBusy(false); }
  };
  const actions = detail?.availableActions || [];
  const filtered = items.filter(item => (!statusFilter || item.status===statusFilter) && (!targetFilter || item.target.mode===targetFilter || targetFilter==='existing-project' && item.target.allowExisting===true) && (!projectId || item.target.mode === 'existing-project' || item.target.allowExisting===true) && `${item.name} ${item.key} ${item.summary} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="blueprints-page">
    <header className="blueprint-page-header"><div><h1><BookOpen aria-hidden="true" size={24} /> Blueprints</h1><p>Reusable plans that create ordinary Project work. {IS_PUBLIC_BUILD ? <a href={SOURCE_URL+'/blob/main/docs/blueprints/README.md'}>Blueprint guide</a> : <span>Guide: docs/blueprints/README.md</span>}</p></div>
      {!wizard && canWrite && <div className="blueprint-actions"><Button variant="secondary" icon={<Upload size={16} aria-hidden="true" />} onClick={() => openEditor('import')}>Import JSON</Button><Button icon={<Plus size={16} aria-hidden="true" />} onClick={() => openEditor('create')}>New Blueprint</Button></div>}
    </header>
    {notice && <p role="status">{notice}</p>}
    {error && <div className="blueprint-error" role="alert" tabIndex={-1} ref={errorRef}><strong>{error.code}</strong>: {error.message}{error.field && <p>Field: {error.field}</p>}</div>}
    {editor ? <section aria-label="Blueprint document editor"><h2>{editor === 'import' ? 'Import as a draft' : 'Edit draft document'}</h2>
      <p>Edit the captured fields and choose which answers can change when the Blueprint is used. Saving never publishes a Blueprint.</p>
      {editor === 'import' && <label>Choose JSON file<input type="file" accept=".json,application/json" onChange={async event => {
        const file = event.target.files?.[0]; if (!file) return; const current = ++fileGeneration.current;
        if (file.size > 65536) { setError(new BlueprintRequestError('The JSON document exceeds 64 KiB.', 'BLUEPRINT_DOCUMENT_TOO_LARGE')); return; }
        try { const text = await file.text(); if (current === fileGeneration.current) setDocumentText(text); }
        catch { if (current === fileGeneration.current) setError(new BlueprintRequestError('The selected JSON file could not be read.', 'BLUEPRINT_FILE_UNAVAILABLE')); }
      }} /></label>}
      {editor === 'import' ? <><label htmlFor="blueprint-document">Blueprint JSON</label><textarea id="blueprint-document" className="blueprint-document" value={documentText} onChange={event => setDocumentText(event.target.value)} rows={18} spellCheck={false} /></> :
        <BlueprintDraftEditor document={JSON.parse(documentText)} onChange={document => setDocumentText(JSON.stringify(document))} />}
      {editor === 'import' && <label htmlFor="blueprint-rename">Rename key explicitly if it already exists<input id="blueprint-rename" value={rename} onChange={event => setRename(event.target.value)} /></label>}
      <div className="blueprint-actions"><Button variant="secondary" disabled={busy} onClick={() => { fileGeneration.current++; setEditor(null); setError(null); }}>Cancel</Button><Button disabled={busy} onClick={saveDocument}>{busy ? 'Saving…' : 'Save draft'}</Button></div>
    </section> : wizard && detail ? <BlueprintUse key={`${detail.id}:${detail.version}`} blueprint={detail} projectId={projectId} onClose={() => setWizard(false)} /> : chosen ? <>
      <Button variant="secondary" onClick={() => { const next = new URLSearchParams(); if (projectId) next.set('project', projectId); setSearch(next); }}>Back to registry</Button>
      {detailLoading && <p role="status">Loading Blueprint…</p>}
      {detail && <section aria-label="Blueprint description"><h2>{detail.name} <span className="blueprint-status">v{detail.version} · {detail.status}</span></h2><p>{detail.summary}</p>
        <p>{detail.projection === 'use' ? 'Published content available for use.' : 'Version content visible to this session.'}</p><p>Target: {detail.target.mode === 'existing-project' ? 'Existing Project' : 'New Project'}</p>
        <BlueprintData value={detail.counts} /><p>{detail.tags.join(' · ')}</p>
        {detail.statusNote && <p>{detail.statusNote}</p>}
        <div className="blueprint-actions">
          {actions.includes('instantiate') && <Button onClick={() => { setError(null); setWizard(true); }}>Use Blueprint</Button>}
          {actions.includes('edit') && <Button variant="secondary" onClick={() => openEditor('edit')}>Edit draft</Button>}
          {actions.includes('new-version') && <Button variant="secondary" onClick={() => openEditor('new-version')}>New version</Button>}
          {actions.includes('history') && <Button variant="secondary" disabled={busy} onClick={history}>Version history</Button>}
          {actions.includes('ledger') && <Button variant="secondary" onClick={() => setShowLedger(value => !value)}>Instantiation ledger</Button>}
          {actions.includes('export') && <Button variant="secondary" disabled={busy} icon={<Download size={16} aria-hidden="true" />} onClick={download}>Export JSON</Button>}
          {['submit', 'withdraw', 'reject', 'publish', 'retire'].filter(action => actions.includes(action)).map(action => <Button key={action} variant="secondary" disabled={busy} onClick={() => { setLifecycle(action); setNote(''); setError(null); }}>{({ submit: 'Submit for review', withdraw: 'Withdraw review', reject: 'Reject version', publish: 'Publish version', retire: 'Retire version' } as Record<string, string>)[action]}</Button>)}
        </div>
        {lifecycle && <form className="blueprint-lifecycle" onSubmit={event => { event.preventDefault(); void transition(); }}><h3>Confirm {lifecycle} of version {detail.version}</h3>
          <p>Publication affects future instantiations. Existing Projects and Tasks are unchanged.</p><label htmlFor="blueprint-status-note">{lifecycle === 'reject' ? 'Rejection note (required)' : 'Status note (optional)'}</label><textarea id="blueprint-status-note" value={note} onChange={event => setNote(event.target.value)} />
          <div className="blueprint-actions"><Button variant="secondary" disabled={busy} onClick={() => setLifecycle(null)}>Cancel</Button><Button type="submit" disabled={busy || lifecycle === 'reject' && !note.trim()}>Confirm {lifecycle}</Button></div>
        </form>}
        <details><summary>Parameters and references</summary><BlueprintData value={{ parameters: detail.parameters, references: detail.references }} /></details>
        <details><summary>Portable document</summary><BlueprintData value={detail.document} /></details>
        {versions && <section aria-label="Version history"><h3>Version history</h3><ul>{versions.map(version => <li key={version.version}><Button size="compact" variant="secondary" onClick={() => select(detail.id, version.version)}>Version {version.version}</Button> {version.status}{version.status_note ? ` — ${version.status_note}` : ''}{version.status_changed_at ? ` — ${formatDateTime(version.status_changed_at)}` : ''}</li>)}</ul></section>}
        {showLedger && actions.includes('ledger') && <BlueprintLedger blueprintId={detail.id} instantiationId={instantiationId} />}
        {showLedger && !actions.includes('ledger') && <p>The instantiation ledger is not available to this session.</p>}
      </section>}
    </> : <section aria-label="Blueprint registry">
      {projectId && <p>Showing Blueprints for adding work to the selected existing Project.</p>}
      <label htmlFor="blueprint-search">Find a Blueprint</label><input id="blueprint-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, key or tag" />
      <div className="blueprint-actions"><label>Status<select value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="">All statuses</option>{['draft','review','published','retired'].map(status=><option key={status}>{status}</option>)}</select></label>
      <label>Target<select value={targetFilter} onChange={event=>setTargetFilter(event.target.value)}><option value="">All targets</option><option value="new-project">New Project</option><option value="existing-project">Existing Project</option></select></label></div>
      {loading ? <p role="status">Loading visible Blueprints…</p> : <><p>{filtered.length} visible Blueprints</p><div className="blueprint-registry">{filtered.map(item => <BlueprintTile key={item.id} blueprint={item} onSelect={() => select(item.id, item.version)} />)}</div></>}
      {!loading && !items.length && !error && <p>No Blueprints are visible to this session.</p>}{error && <Button variant="secondary" onClick={loadList}>Retry discovery</Button>}
    </section>}
  </div>;
}
