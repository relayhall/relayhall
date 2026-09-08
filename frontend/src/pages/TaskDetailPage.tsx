import { TaskTextSectionEditor as EditableSection } from '../components/tasks/TaskTextSectionEditor';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Copy, Lock, MoreHorizontal, PanelRight } from 'lucide-react';
import { Link, Navigate, useHref, useLocation, useNavigate, useParams } from 'react-router-dom';
import { DueAtResolution, SubtaskStatus, SubtaskTransitionDetails, Task, TaskDueAtWrite, TaskExecutionProfile, TaskPriority, TaskStatus, TaskWritePayload } from '../types/task';
import ExecutionProfileEditor from '../components/tasks/ExecutionProfileEditor';
import TaskAccessVehicle from '../components/tasks/TaskAccessVehicle';
import { authenticatedFetch } from '../utils/auth';
import { getTaskBoardOriginBoardUrl } from '../utils/taskBoardNavigation';
import { useRelayHallConfig } from '../contexts/RelayHallConfigContext';
import { taskDetailSectionsFor } from '../components/tasks/taskDetailSectionRegistry';
import { parseTaskDetailSections } from '../components/tasks/taskDetailSections';
import { renderTaskMarkdown } from '../components/tasks/renderTaskMarkdown';
import { SubtaskList } from '../components/tasks/SubtaskList';
import { TaskTimeline } from '../components/tasks/TaskTimeline';
import { PrincipalName, principalDisplayLabel, usePrincipalDirectory, type DirectoryPrincipal } from '../components/principals/principalDirectory';
import { useWebSocket } from '../hooks/useWebSocket';
import { PhaseName, PhaseSelect } from '../components/tasks/PhaseSelect';
import { Button } from '../components/Button';
import { IconButton } from '../components/ui/IconButton';
import { Select } from '../components/ui/Select';
import { DueAtInput, EditableFrame, ModelInput, PersonalitySelect, PrioritySelect, ProjectSelect, StatusSelect, TagsInput, TASK_STATUS_OPTIONS, ThinkingSelect, parseTagsInput } from '../components/tasks/taskFieldEditors';
import './TaskDetailPage.css';
import { dueTone, formatDateTime, formatDateTimeLong, formatInstantUtc, formatRelativeDue } from '../utils/dateFormat';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
export const FULL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Status/priority vocabularies and controls are the SHARED field editors
// (taskFieldEditors, candidate A5) — one source of truth for both modes.
const LIVENESS_LABELS = {
  active: 'Active', idle: 'Idle', stale: 'Stale', orphan: 'Orphan',
  finished: 'Finished', unknown: 'Unknown', none: 'No agent session',
} as const;
type LivenessState = keyof typeof LIVENESS_LABELS;

const DEPENDENCY_STATUS_CLASSES: Record<TaskStatus, string> = {
  ideas: 'task-detail-status-dot--ideas',
  todo: 'task-detail-status-dot--todo',
  'in-progress': 'task-detail-status-dot--in-progress',
  review: 'task-detail-status-dot--review',
  stuck: 'task-detail-status-dot--stuck',
  completed: 'task-detail-status-dot--completed',
  archived: 'task-detail-status-dot--archived',
};

function dependencyStatusClass(status?: string) {
  return status && status in DEPENDENCY_STATUS_CLASSES
    ? DEPENDENCY_STATUS_CLASSES[status as TaskStatus]
    : 'task-detail-status-dot--unknown';
}

interface TaskReference {
  kind?: string;
  provenance?: string;
  value?: unknown;
}

export class TaskDetailRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The body field the server named, when it named one. Card 7d38a6e0: a
     *  refusal that names `dueAt` is shown ON the deadline control rather than
     *  only in the page banner, so it is announced where it happened. */
    public readonly field?: string,
  ) {
    super(message);
  }
}

async function readEnvelope(response: Response) {
  return response.json().catch(() => ({}));
}

export async function fetchTaskDetail(taskId: string): Promise<Task> {
  const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}`);
  const data = await readEnvelope(response);
  if (!response.ok || !data.success || !data.task) {
    throw new TaskDetailRequestError(response.status, data.error || data.message || 'Task details could not be loaded.');
  }
  return data.task as Task;
}

async function patchTaskDetail(taskId: string, updates: TaskWritePayload): Promise<{ task: Task; warning?: string; dueAtResolution?: DueAtResolution }> {
  const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
  });
  const data = await readEnvelope(response);
  if (!response.ok || !data.success) {
    throw new TaskDetailRequestError(response.status, data.error || data.message || 'The Task update was rejected.', typeof data.details?.field === 'string' ? data.details.field : (typeof data.field === 'string' ? data.field : undefined));
  }
  return {
    task: (data.task || updates) as Task,
    warning: typeof data.warning === 'string' ? data.warning : undefined,
    // Card 7d38a6e0: present when the deadline was sent as a wall clock plus a
    // zone. It carries the offset the server used and whether that clock was
    // ambiguous, which is the one thing a reader cannot work out for
    // themselves from an echoed UTC instant.
    dueAtResolution: (data.dueAtResolution || undefined) as DueAtResolution | undefined,
  };
}

/** Report the server-selected offset for every zoned write, including folds. */
export function dueAtAmbiguityNote(resolution?: DueAtResolution): string {
  if (!resolution) return '';
  return `Deadline set to ${formatInstantUtc(resolution.instant)} in ${resolution.zone} `
    + `(UTC${resolution.offset}). If the local time happens twice, the server uses the offset after the clock change.`;
}

async function fetchLiveness(taskId: string): Promise<LivenessState> {
  const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/session-status`);
  const data = await readEnvelope(response);
  const state = data?.data?.state;
  return typeof state === 'string' && state in LIVENESS_LABELS ? state as LivenessState : 'unknown';
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="task-detail-field"><dt>{label}</dt><dd>{children || 'Not set'}</dd></div>;
}

function DateValue({ value }: { value?: string | null }) {
  if (!value) return <>Not set</>;
  const date = new Date(value);
  return <time dateTime={value}>{Number.isNaN(date.valueOf()) ? value : formatDateTime(date)}</time>;
}

function TaskDetailState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const boardReturnPath = getTaskBoardOriginBoardUrl(taskId) || '/tasks';
  const requestError = error instanceof TaskDetailRequestError ? error : null;
  const permissionDenied = requestError?.status === 403;
  const notFound = requestError?.status === 404;
  const heading = permissionDenied ? 'Permission denied' : notFound ? 'Task not found' : 'Task details could not be loaded';
  const fallback = permissionDenied
    ? 'You need permission to view this Task.'
    : notFound ? 'The requested Task does not exist.' : 'Task details could not be loaded.';
  const stateClass = permissionDenied
    ? 'task-detail-state task-detail-state--permission'
    : notFound
      ? 'task-detail-state task-detail-state--not-found'
      : 'task-detail-state task-detail-state--error';
  return (
    <section className={stateClass} aria-labelledby="task-detail-error-heading">
      {permissionDenied ? <Lock size={24} aria-hidden="true" /> : null}
      <h1 id="task-detail-error-heading">{heading}</h1>
      <p role="alert">{requestError?.message || fallback}</p>
      <div className="task-detail-state-actions">
        {!permissionDenied && !notFound ? <Button variant="secondary" size="compact" onClick={onRetry}>Retry</Button> : null}
        <Link to={boardReturnPath}>Back to Tasks</Link>
      </div>
    </section>
  );
}

function TaskRegionNavigation({ route }: { route: string }) {
  return (
    <nav className="task-detail-tabs" aria-label="Task details regions">
      <a href={`${route}#task-detail-work`}>Work</a>
      <a href={`${route}#task-detail-panel-details`}>Details</a>
      <a href={`${route}#task-detail-timeline`}>Timeline</a>
    </nav>
  );
}

function LeftRail({ task, update, onEditingChange, dueRefusal, onDueEdited }: { task: Task; update: (updates: TaskWritePayload, onSuccess?: () => void) => void; onEditingChange: (editing: boolean) => void; dueRefusal: string | null; onDueEdited: () => void }) {
  type RailEditor = 'project' | 'phase' | 'tags' | 'due' | 'execution' | 'shepherd' | 'verifier' | 'links';
  type ProjectOption = { id: string; name: string };
  type DependencyTask = { id: string; title: string; status?: TaskStatus };
  const [activeEditor, setActiveEditor] = useState<RailEditor | null>(null);
  const [shepherdDraft, setShepherdDraft] = useState('');
  const [verifierDraft, setVerifierDraft] = useState('');
  const [rolesError, setRolesError] = useState('');
  const [linksDraft, setLinksDraft] = useState<Array<{ type: string; title: string; url: string }>>([]);
  const [linkTitleDraft, setLinkTitleDraft] = useState('');
  const [linkUrlDraft, setLinkUrlDraft] = useState('');
  const queryClient = useQueryClient();
  const { directory } = usePrincipalDirectory();
  const activePrincipals: DirectoryPrincipal[] = Array.from(directory?.values() ?? []).filter(principal => principal.status === 'active');
  const endRolesEditor = () => { setRolesError(''); endEditor(); };
  // Role assignment goes over the DEDICATED server-owned surface (§8): the
  // generic PATCH rejects these fields; server errors surface verbatim.
  const saveRoles = async (body: { shepherdPrincipalId?: string; verifierPrincipalId?: string | null }) => {
    setRolesError('');
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/roles`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) { setRolesError(data.message || data.error || 'The role assignment was rejected.'); return; }
      queryClient.invalidateQueries({ queryKey: ['task-detail'] });
      endEditor();
    } catch { setRolesError('The role assignment could not be sent.'); }
  };
  const [projectDraft, setProjectDraft] = useState('');
  const [phaseDraft, setPhaseDraft] = useState(task.phaseId || '');
  const [tagsDraft, setTagsDraft] = useState(task.tags?.join(', ') || '');
  // Card 7d38a6e0. null is a real value here (no deadline), so the draft is
  // nullable rather than an empty string standing in for one. It holds what
  // will be SENT — a wall clock with its zone after an edit, the stored
  // instant verbatim when the clock was not touched.
  const [dueDraft, setDueDraft] = useState<TaskDueAtWrite>(task.dueAt ?? null);
  const [executionDraft, setExecutionDraft] = useState<TaskExecutionProfile | null>(task.executionProfile ?? null);
  const [modelDraft, setModelDraft] = useState(task.model || '');
  const [thinkingDraft, setThinkingDraft] = useState(task.thinking || '');
  const [personalityDraft, setPersonalityDraft] = useState(task.personalityId || '');
  const personalitiesQuery = useQuery({
    queryKey: ['task-detail-personalities'],
    queryFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/personalities`);
      const data = await readEnvelope(response);
      if (!response.ok || !data.success) throw new TaskDetailRequestError(response.status, data.error || 'Personalities could not be loaded.');
      return (data.personalities || []) as Array<{ id: string; name: string; slug: string }>;
    },
  });
  const references = ((task as Task & { references?: TaskReference[] }).references || []);
  const executionOptions = Object.entries(task.executionProfile?.options || {});
  const projectsQuery = useQuery({
    queryKey: ['task-detail-projects'],
    queryFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects?includeHidden=true&includeArchived=true`);
      const data = await readEnvelope(response);
      if (!response.ok || !data.success) throw new TaskDetailRequestError(response.status, data.error || 'Projects could not be loaded.');
      return (data.projects || []).map((project: ProjectOption) => ({ id: project.id, name: project.name })) as ProjectOption[];
    },
  });
  const dependenciesQuery = useQuery({
    queryKey: ['task-detail-dependencies', task.id],
    queryFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(task.id)}/dependencies`);
      const data = await readEnvelope(response);
      if (!response.ok || !data.success) throw new TaskDetailRequestError(response.status, data.error || 'Dependencies could not be loaded.');
      return (data.dependsOn || []) as DependencyTask[];
    },
  });
  const projects = projectsQuery.data || [];
  const currentProject = projects.find(project => project.name === task.project);
  const beginEditor = (editor: RailEditor) => {
    if (editor === 'project') setProjectDraft(currentProject?.id || '');
    if (editor === 'phase') setPhaseDraft(task.phaseId || '');
    if (editor === 'tags') setTagsDraft(task.tags?.join(', ') || '');
    if (editor === 'due') { setDueDraft(task.dueAt ?? null); onDueEdited(); }
    if (editor === 'execution') {
      setExecutionDraft(task.executionProfile ?? null);
      setModelDraft(task.model || '');
      setThinkingDraft(task.thinking || '');
      setPersonalityDraft(task.personalityId || '');
    }
    setActiveEditor(editor);
    onEditingChange(true);
  };
  const endEditor = () => { setActiveEditor(null); onEditingChange(false); };
  const placement = <section className="task-detail-rail-group"><h3>Placement</h3><dl>
    <Field label="Project">{activeEditor === 'project' ? <div className="task-detail-field-editor"><ProjectSelect projects={projects} value={projectDraft} onChange={setProjectDraft} /><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" onClick={() => { const selected = projects.find(project => project.id === projectDraft); update({ project: selected?.name || undefined, phaseId: selected?.name === task.project ? task.phaseId : null }); endEditor(); }}>Save Project</Button><Button variant="secondary" size="compact" onClick={endEditor}>Cancel Project</Button></div></div> : <EditableFrame label="Project" onEdit={() => beginEditor('project')}><span>{task.project || 'No Project'}</span></EditableFrame>}</Field>
    <Field label="Phase">{activeEditor === 'phase' ? <div className="task-detail-field-editor"><PhaseSelect projectId={currentProject?.id || null} value={phaseDraft} currentPhase={task.phaseId ? { id: task.phaseId, name: 'Current phase' } : null} onChange={setPhaseDraft} /><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" onClick={() => { update({ phaseId: phaseDraft || null }); endEditor(); }}>Save Phase</Button><Button variant="secondary" size="compact" onClick={endEditor}>Cancel Phase</Button></div></div> : <EditableFrame label="Phase" disabled={!currentProject} onEdit={() => beginEditor('phase')}><span>{task.phaseId ? <PhaseName phaseId={task.phaseId} /> : 'No phase (backlog)'}</span></EditableFrame>}</Field>
    <Field label="Tags">{activeEditor === 'tags' ? <div className="task-detail-field-editor"><label className="sr-only" htmlFor="task-detail-tags-editor">Tags</label><TagsInput id="task-detail-tags-editor" value={tagsDraft} onChange={setTagsDraft} /><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" onClick={() => { update({ tags: parseTagsInput(tagsDraft) }); endEditor(); }}>Save Tags</Button><Button variant="secondary" size="compact" onClick={endEditor}>Cancel Tags</Button></div></div> : <EditableFrame label="Tags" onEdit={() => beginEditor('tags')}>{task.tags?.length ? <ul className="task-detail-chip-list">{task.tags.map(tag => <li key={tag}>{tag}</li>)}</ul> : <span>No Tags</span>}</EditableFrame>}</Field>
    <Field label="Due">{activeEditor === 'due' ? <div className="task-detail-field-editor"><label className="sr-only" htmlFor="task-detail-due-editor">Due</label><DueAtInput id="task-detail-due-editor" value={task.dueAt ?? null} refusal={dueRefusal} onChange={next => { setDueDraft(next); onDueEdited(); }} /><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" disabled={dueRefusal !== null} onClick={() => { update({ dueAt: dueDraft }, endEditor); }}>Save Due</Button><Button variant="secondary" size="compact" onClick={() => { setDueDraft(null); onDueEdited(); update({ dueAt: null }, endEditor); }}>Clear Due</Button><Button variant="secondary" size="compact" onClick={endEditor}>Cancel Due</Button></div></div> : <EditableFrame label="Due" onEdit={() => beginEditor('due')}>{task.dueAt ? <span className={`task-detail-due task-detail-due--${dueTone(task.dueAt)}`}>{formatDateTimeLong(task.dueAt)}<span className="task-detail-due-relative">{` — ${formatRelativeDue(task.dueAt)}`}</span></span> : <span>No due date</span>}</EditableFrame>}</Field>
  </dl></section>;
  const dependencyTasks = dependenciesQuery.data || [];
  const sections: Record<string, ReactNode> = {
    placement,
    people: <section className="task-detail-rail-group"><h3>People</h3><dl>
      <Field label="Creator">{task.creatorPrincipalId ? <PrincipalName id={task.creatorPrincipalId} directory={directory} /> : 'Unknown'}</Field>
      <Field label="Assignee">{task.ownerPrincipalId ? <PrincipalName id={task.ownerPrincipalId} directory={directory} /> : 'Unassigned'}</Field>
      <Field label="Shepherd">{activeEditor === 'shepherd' ? <div className="task-detail-field-editor"><label className="sr-only" htmlFor="task-detail-shepherd-editor">Shepherd</label><Select id="task-detail-shepherd-editor" value={shepherdDraft} onChange={event => setShepherdDraft(event.target.value)}><option value="" disabled>— Select Principal —</option>{activePrincipals.map(principal => <option key={principal.id} value={principal.id}>{principalDisplayLabel(principal, principal.id)}</option>)}</Select><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" disabled={!shepherdDraft} onClick={() => saveRoles({ shepherdPrincipalId: shepherdDraft })}>Save Shepherd</Button><Button variant="secondary" size="compact" onClick={endRolesEditor}>Cancel Shepherd</Button></div></div> : <EditableFrame label="Shepherd" onEdit={() => { setShepherdDraft(task.shepherdPrincipalId || ''); setRolesError(''); beginEditor('shepherd'); }}><span>{task.shepherdPrincipalId ? <PrincipalName id={task.shepherdPrincipalId} directory={directory} /> : 'Unassigned'}</span></EditableFrame>}</Field>
      <Field label="Verifier">{activeEditor === 'verifier' ? <div className="task-detail-field-editor"><label className="sr-only" htmlFor="task-detail-verifier-editor">Verifier</label><Select id="task-detail-verifier-editor" value={verifierDraft} onChange={event => setVerifierDraft(event.target.value)}><option value="">Unassigned</option>{activePrincipals.map(principal => <option key={principal.id} value={principal.id}>{principalDisplayLabel(principal, principal.id)}</option>)}</Select><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" onClick={() => saveRoles({ verifierPrincipalId: verifierDraft || null })}>Save Verifier</Button><Button variant="secondary" size="compact" onClick={endRolesEditor}>Cancel Verifier</Button></div></div> : <EditableFrame label="Verifier" onEdit={() => { setVerifierDraft(task.verifierPrincipalId || ''); setRolesError(''); beginEditor('verifier'); }}><span>{task.verifierPrincipalId ? <PrincipalName id={task.verifierPrincipalId} directory={directory} /> : 'Unassigned'}</span></EditableFrame>}</Field>
      {rolesError ? <p className="task-detail-inline-error" role="alert">{rolesError}</p> : null}
      {task.activeAgent ? <Field label="Active agent">{typeof task.activeAgent === 'string' ? task.activeAgent : task.activeAgent.name}</Field> : null}
    </dl></section>,
    execution: <section className="task-detail-rail-group"><h3>Execution</h3>{activeEditor === 'execution' ? <div className="task-detail-rail-editor">
      <ExecutionProfileEditor value={executionDraft} onChange={setExecutionDraft} />
      {!executionDraft?.serviceId && (
        <div className="task-detail-field-editor">
          <label>Personality<PersonalitySelect personalities={(personalitiesQuery.data || []) as any} value={personalityDraft} onChange={setPersonalityDraft} /></label>
          <label>Model<ModelInput value={modelDraft} onChange={setModelDraft} /></label>
          <label>Thinking<ThinkingSelect value={thinkingDraft} onChange={setThinkingDraft} /></label>
        </div>
      )}
      <div className="task-detail-editor-actions"><Button variant="secondary" size="compact" onClick={() => {
        // A connector owns execution: the board-native fields clear so a
        // Task never carries two execution sources of truth (F4 parity).
        // Clears are EXPLICIT JSON nulls — undefined disappears under
        // JSON.stringify and the server only clears present properties
        // (review 7e5fcea0 B1).
        const patch = (executionDraft?.serviceId
          ? { executionProfile: executionDraft, model: null, thinking: null, personalityId: null }
          : { executionProfile: null, model: modelDraft || null, thinking: thinkingDraft || null, personalityId: personalityDraft || null }) as unknown as Partial<Task>;
        update(patch);
        endEditor();
      }}>Save Execution</Button><Button variant="secondary" size="compact" onClick={endEditor}>Cancel</Button></div>
    </div> : <><EditableFrame label="Execution" onEdit={() => beginEditor('execution')}><dl>
      <Field label="Model">{task.model || 'Not set'}</Field>
      <Field label="Thinking">{task.thinking || 'Not set'}</Field>
      <Field label="Personality">{typeof task.personality === 'string' ? task.personality : (task.personality as any)?.name ?? task.personalityId ?? 'Not set'}</Field>
      <Field label="Connector">{task.executionProfile?.serviceId || 'Basic'}</Field>
      {executionOptions.map(([key, value]) => <Field key={key} label={key}>{String(value)}</Field>)}
      {task.legacyExecutionProfile ? <Field label="Legacy profile"><span className="task-detail-read-only">Read-only</span></Field> : null}
    </dl></EditableFrame><TaskAccessVehicle taskId={task.id} /></>}</section>,
    relations: <section className="task-detail-rail-group"><h3>Relations</h3><dl>
      <Field label="Dependencies">{dependenciesQuery.isLoading ? 'Loading…' : dependenciesQuery.error ? <span role="alert">Dependencies could not be loaded.</span> : dependencyTasks.length ? <ul className="task-detail-relation-list">{dependencyTasks.map(dependency => <li key={dependency.id}><span className={`task-detail-status-dot ${dependencyStatusClass(dependency.status)}`} aria-hidden="true" />{dependency.title}</li>)}</ul> : 'No Dependencies'}</Field>
      <Field label="References">{references.length ? <ul className="task-detail-reference-list">{references.map((reference, index) => <li key={`${reference.kind || 'reference'}-${index}`}><strong>{reference.kind || 'reference'}</strong><span>{reference.provenance || 'system'}</span><code>{String(reference.value ?? '')}</code></li>)}</ul> : 'No References'}</Field>
      <Field label="Links">{activeEditor === 'links' ? <div className="task-detail-field-editor">
        {linksDraft.length ? <ul className="task-detail-links-editor-list">{linksDraft.map((link, index) => <li key={`${link.url}-${index}`}><span>{link.title}</span><Button variant="secondary" size="compact" ariaLabel={`Remove link ${link.title}`} onClick={() => setLinksDraft(current => current.filter((_, i) => i !== index))}>Remove</Button></li>)}</ul> : <p className="task-detail-empty-line">No Links yet.</p>}
        <label>Link title<input value={linkTitleDraft} onChange={event => setLinkTitleDraft(event.target.value)} /></label>
        <label>Link URL<input value={linkUrlDraft} onChange={event => setLinkUrlDraft(event.target.value)} /></label>
        <Button variant="secondary" size="compact" disabled={!linkTitleDraft.trim() || !linkUrlDraft.trim()} onClick={() => { setLinksDraft(current => [...current, { type: 'reference', title: linkTitleDraft.trim(), url: linkUrlDraft.trim() }]); setLinkTitleDraft(''); setLinkUrlDraft(''); }}>Add link</Button>
        <div className="task-detail-editor-actions"><Button variant="secondary" size="compact" onClick={() => { update({ links: linksDraft } as unknown as Partial<Task>); endEditor(); }}>Save Links</Button><Button variant="secondary" size="compact" onClick={endEditor}>Cancel Links</Button></div>
      </div> : <EditableFrame label="Links" onEdit={() => { setLinksDraft(task.links ? task.links.map(link => ({ ...link })) : []); setLinkTitleDraft(''); setLinkUrlDraft(''); beginEditor('links'); }}>{task.links?.length ? <ul>{task.links.map(link => <li key={`${link.type}-${link.url}`}><a className="task-detail-inline-link" href={link.url}>{link.title}</a></li>)}</ul> : <span>No Links</span>}</EditableFrame>}</Field>
    </dl></section>,
    'dates-counters': <section className="task-detail-rail-group"><h3>Dates &amp; counters</h3><dl>
      <Field label="Created"><DateValue value={task.created} /></Field><Field label="Updated"><DateValue value={task.updated} /></Field>
      <Field label="Started"><DateValue value={task.startedAt} /></Field><Field label="Completed"><DateValue value={task.completedAt || task.completed} /></Field>
      <Field label="Archived"><DateValue value={task.archivedAt} /></Field><Field label="Attempts">{task.attemptCount ?? 0} / {task.maxRetries ?? 3}</Field>
    </dl></section>,
    advanced: <details className="task-detail-advanced"><summary><h3>Advanced</h3></summary><dl>
      <Field label="ACP key">{task.acpSessionKey || 'Not set'}</Field><Field label="Discord thread">{task.discordThreadId || 'Not set'}</Field>
      <Field label="Tracker URL">{task.trackerUrl || 'Not set'}</Field><Field label="Auto-created">{task.autoCreated ? 'Yes' : 'No'}</Field><Field label="UUID"><code>{task.id}</code></Field>
    </dl></details>,
  };
  return <>{taskDetailSectionsFor('left-rail').map(descriptor => <div key={descriptor.id}>{descriptor.render(task, { sections })}</div>)}</>;
}

/** §8 empty states: one compact line per section — the tall five-card icon
 *  repetition retired. CoreSurfacePlaceholder remains for empty SURFACES. */
function EmptySection({ description }: { heading?: string; description: string }) {
  return <p className="task-detail-empty-line">{description}</p>;
}


interface TaskReport {
  id: string;
  title: string;
  /** The verified attribution (card 91599cd2). `author_name` never existed on
   * any response this page reads - it was a field the backend has never
   * produced, so this list fell through to the unverified `author` label for
   * every Report it has ever rendered. */
  author_actor_name?: string | null;
  updated?: string;
  updated_at?: string;
  summary?: string | null;
  handover?: Record<string, unknown> | null;
}

const listFrom = (value: string | string[] | undefined): string[] =>
  Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
const listAsLines = (value: string | string[] | undefined): string => listFrom(value).join('\n');
const linesAsList = (value: string): string[] =>
  value.split('\n').map(line => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean);

function BoardTextQuote({ children }: { children: ReactNode }) {
  return <blockquote><span>Board text · reported</span><p>{children}</p></blockquote>;
}

function HandoverBoardText({ value }: { value: unknown }) {
  const values = Array.isArray(value) ? value : [value];
  return <>{values.map((item, index) => <BoardTextQuote key={`${String(item)}-${index}`}>{String(item ?? '')}</BoardTextQuote>)}</>;
}

function ContentRegion({ task, updatedElsewhere, onEditingChange, saveTask, refreshTask, onViewReviewEvents }: {
  task: Task;
  updatedElsewhere: boolean;
  onEditingChange: (editing: boolean) => void;
  saveTask: (updates: Partial<Task>) => Promise<void>;
  refreshTask: () => Promise<void>;
  onViewReviewEvents: () => void;
}) {
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
  const reportsQuery = useQuery({
    queryKey: ['task-reports', task.id],
    queryFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/reports?taskId=${encodeURIComponent(task.id)}`);
      const data = await readEnvelope(response);
      if (!response.ok) throw new TaskDetailRequestError(response.status, data.error || data.message || 'Reports could not be loaded.');
      return (data.reports || []) as TaskReport[];
    },
  });
  const setEditor = (id: string | null) => { setActiveEditor(id); onEditingChange(Boolean(id)); };
  const parsed = parseTaskDetailSections(task.description || '');
  const taskWithInstructions = task as Task & { agentInstructions?: string };
  const criteria = Array.isArray(task.successCriteria) ? task.successCriteria : task.successCriteria ? [task.successCriteria] : [];
  const latestReview = task.reviewHistory?.length ? task.reviewHistory[task.reviewHistory.length - 1] : null;

  const [subtaskDraft, setSubtaskDraft] = useState('');
  const [subtaskEditError, setSubtaskEditError] = useState('');
  const [savingSubtasks, setSavingSubtasks] = useState(false);
  const subtaskSavePending = useRef(false);
  // Add and rename ride the EXISTING generic-PATCH full-replacement contract
  // (the same one the create page uses); by-id PUT owns status only. §8
  // records this as the chartered route — no silent backend widening.
  const patchSubtasks = async (subtasks: Array<Record<string, unknown>>) => {
    if (subtaskSavePending.current) return false;
    subtaskSavePending.current = true;
    setSavingSubtasks(true);
    setSubtaskEditError('');
    try { await saveTask({ subtasks } as unknown as Partial<Task>); return true; }
    catch (cause) { setSubtaskEditError(cause instanceof Error ? cause.message : 'The Subtask change was rejected.'); return false; }
    finally { subtaskSavePending.current = false; setSavingSubtasks(false); }
  };
  const addSubtask = async () => {
    const title = subtaskDraft.trim();
    if (!title) return;
    const saved = await patchSubtasks([...(task.subtasks ?? []).map(subtask => ({ ...subtask })), { text: title, status: 'empty' }]);
    if (saved) setSubtaskDraft('');
  };
  const renameSubtask = (subtaskId: string, newText: string) => {
    void patchSubtasks((task.subtasks ?? []).map(subtask => subtask.id === subtaskId ? { ...subtask, text: newText } : { ...subtask }));
  };
  const transitionSubtask = async (subtaskId: string, nextStatus: SubtaskStatus, details?: SubtaskTransitionDetails) => {
    const index = task.subtasks.findIndex(subtask => subtask.id === subtaskId);
    if (index < 0) throw new Error('The subtask no longer exists.');
    const currentStatus = task.subtasks[index].status || (task.subtasks[index].completed ? 'completed' : 'empty');
    let path = `${API_BASE_URL}/tasks/${encodeURIComponent(task.id)}/subtasks/by-id/${encodeURIComponent(subtaskId)}/status`;
    let method: 'PATCH' | 'POST' = 'PATCH';
    let body: Record<string, unknown> = { status: nextStatus, reviewNote: details?.reviewNote, blockedReason: details?.blockedReason };
    const positionalRoot = `${API_BASE_URL}/tasks/${encodeURIComponent(task.id)}/subtasks/${index}`;
    if (nextStatus === 'completed') { path = `${positionalRoot}/approve`; method = 'POST'; body = {}; }
    else if (currentStatus === 'review' && nextStatus === 'empty') { path = `${positionalRoot}/reject`; method = 'POST'; body = { note: details?.reviewNote }; }
    else if (nextStatus === 'skipped') { path = `${positionalRoot}/skip`; method = 'POST'; body = {}; }
    const response = await authenticatedFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await readEnvelope(response);
    if (!response.ok || !data.success) throw new Error(data.error || data.message || 'The subtask lifecycle transition was rejected.');
    await refreshTask();
  };

  const sections: Record<string, ReactNode> = {
    description: <EditableSection id="description" heading="Description" value={task.description || ''} activeEditor={activeEditor} updatedElsewhere={updatedElsewhere} onBegin={setEditor} onEnd={() => setEditor(null)} onSave={description => saveTask({ description })}>
      {task.description ? <div className="task-detail-markdown" dangerouslySetInnerHTML={{ __html: renderTaskMarkdown(parsed.overviewMarkdown || task.description) }} /> : <EmptySection heading="No Description" description="This Task has no Description yet." />}
      {parsed.additionalSections.map(section => <div key={section.title} className="task-detail-additional-section"><h3>{section.title}</h3><div className="task-detail-markdown" dangerouslySetInnerHTML={{ __html: renderTaskMarkdown(section.markdown) }} /></div>)}
    </EditableSection>,
    // Canonical structured fields (986be411 §7, candidate A5): these sections
    // render/edit the FIELDS; the description-embedded markdown lists remain
    // only as the read-only fallback for legacy tasks (never the write path).
    dod: <EditableSection id="dod" heading="Definition of done" value={listAsLines(task.definitionOfDone)} activeEditor={activeEditor} updatedElsewhere={updatedElsewhere} onBegin={setEditor} onEnd={() => setEditor(null)} onSave={value => saveTask({ definitionOfDone: linesAsList(value) })}>
      {listFrom(task.definitionOfDone).length
        ? <ul className="task-detail-structured-list">{listFrom(task.definitionOfDone).map(item => <li key={item}>{item}</li>)}</ul>
        : parsed.definitionOfDone.length
          ? <><p className="task-detail-legacy-note" role="note">Read from the Description (legacy) — editing writes the structured field.</p><ul className="task-detail-structured-list">{parsed.definitionOfDone.map(item => <li key={item}>{item}</li>)}</ul></>
          : <EmptySection heading="No Definition of done" description="No Definition of done is stored." />}
    </EditableSection>,
    constraints: <EditableSection id="constraints" heading="Constraints" value={listAsLines(task.constraints)} activeEditor={activeEditor} updatedElsewhere={updatedElsewhere} onBegin={setEditor} onEnd={() => setEditor(null)} onSave={value => saveTask({ constraints: linesAsList(value) })}>
      {listFrom(task.constraints).length
        ? <ul className="task-detail-structured-list">{listFrom(task.constraints).map(item => <li key={item}>{item}</li>)}</ul>
        : parsed.constraints.length
          ? <><p className="task-detail-legacy-note" role="note">Read from the Description (legacy) — editing writes the structured field.</p><ul className="task-detail-structured-list">{parsed.constraints.map(item => <li key={item}>{item}</li>)}</ul></>
          : <EmptySection heading="No Constraints" description="No Constraints are stored." />}
    </EditableSection>,
    'agent-instructions': <EditableSection id="agent-instructions" heading="Agent instructions" value={taskWithInstructions.agentInstructions || ''} activeEditor={activeEditor} updatedElsewhere={updatedElsewhere} onBegin={setEditor} onEnd={() => setEditor(null)} onSave={agentInstructions => saveTask({ agentInstructions } as Partial<Task>)}>{taskWithInstructions.agentInstructions ? <div className="task-detail-markdown" dangerouslySetInnerHTML={{ __html: renderTaskMarkdown(taskWithInstructions.agentInstructions) }} /> : <EmptySection heading="No Agent instructions" description="No additional Agent instructions are stored." />}</EditableSection>,
    notes: <EditableSection id="notes" heading="Notes" value={task.notes || ''} activeEditor={activeEditor} updatedElsewhere={updatedElsewhere} onBegin={setEditor} onEnd={() => setEditor(null)} onSave={notes => saveTask({ notes })}><p className="task-detail-advisory" role="note">Advisory only — accountability comes from History.</p>{task.notes ? <div className="task-detail-markdown" dangerouslySetInnerHTML={{ __html: renderTaskMarkdown(task.notes) }} /> : <EmptySection heading="No Notes" description="No advisory Notes are stored." />}</EditableSection>,
    'verifier-settings': <section className="task-detail-content-section" aria-labelledby="task-detail-verifier-heading"><h2 id="task-detail-verifier-heading">Verifier settings</h2>{criteria.length ? <ul>{criteria.map(item => <li key={item}>{item}</li>)}</ul> : <EmptySection heading="No success criteria" description="No Verifier success criteria are stored." />}<p>Latest decision: {latestReview?.decision || 'None'} · Attempts: {task.attemptCount ?? 0} / {task.maxRetries ?? 3}</p><Link replace className="task-detail-inline-link" to={{ search: '?filter=handover', hash: '#task-detail-timeline' }} onClick={onViewReviewEvents}>View review events in Timeline</Link></section>,
    subtasks: <section className="task-detail-content-section" aria-labelledby="task-detail-subtasks-heading"><h2 id="task-detail-subtasks-heading">Subtasks</h2>{task.subtasks?.length ? <SubtaskList subtasks={task.subtasks} onStatusChange={transitionSubtask} onEditText={renameSubtask} /> : <EmptySection description="This Task has no Subtasks." />}
      <form className="task-detail-inline-add" aria-busy={savingSubtasks} onSubmit={event => { event.preventDefault(); void addSubtask(); }}><label className="sr-only" htmlFor="task-detail-subtask-add">Add a subtask</label><input className="form-input" id="task-detail-subtask-add" placeholder="Add a subtask" value={subtaskDraft} disabled={savingSubtasks} onChange={event => setSubtaskDraft(event.target.value)} /><Button type="submit" variant="secondary" size="compact" disabled={savingSubtasks || !subtaskDraft.trim()}>{savingSubtasks ? 'Adding subtask…' : 'Add subtask'}</Button></form>
      <span className="sr-only" role="status">{savingSubtasks ? 'Saving subtask changes' : ''}</span>
      {subtaskEditError ? <p className="task-detail-inline-error" role="alert">{subtaskEditError}</p> : null}</section>,
    'reports-handovers': <section className="task-detail-content-section" aria-labelledby="task-detail-reports-heading"><h2 id="task-detail-reports-heading">Reports &amp; handovers</h2>{reportsQuery.isLoading ? <p role="status">Loading Reports…</p> : reportsQuery.error ? <div role="alert">{reportsQuery.error instanceof Error ? reportsQuery.error.message : 'Reports could not be loaded.'} <Button variant="secondary" size="compact" onClick={() => void reportsQuery.refetch()}>Retry</Button></div> : reportsQuery.data?.length ? <ul className="task-detail-report-list">{reportsQuery.data.map(report => <li key={report.id}><h3><Link to={`/reports/${report.id}`}>{report.title}</Link></h3><p>{report.author_actor_name || 'Unattributed'} · <DateValue value={report.updated_at || report.updated} /></p>{report.summary ? <BoardTextQuote>{report.summary}</BoardTextQuote> : null}{report.handover ? <dl>{Object.entries(report.handover).map(([label, value]) => <div key={label}><dt>{label.replace(/_/g, ' ')}</dt><dd><HandoverBoardText value={value} /></dd></div>)}</dl> : null}</li>)}</ul> : <EmptySection heading="No Reports or handovers" description="No Reports or handovers are linked to this Task." />}</section>,
  };
  return <>{taskDetailSectionsFor('content').map(descriptor => <div key={descriptor.id}>{descriptor.render(task, { sections })}</div>)}</>;
}

function TimelineRegion({ task }: { task: Task }) {
  const { directory } = usePrincipalDirectory();
  const sections: Record<string, ReactNode> = { 'timeline-rail': <TaskTimeline taskId={task.id} directory={directory} /> };
  return <>{taskDetailSectionsFor('timeline').map(descriptor => <div key={descriptor.id}>{descriptor.render(task, { sections })}</div>)}</>;
}

export function TaskDetailPage() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const location = useLocation();
  // Resolve against this routed Task, including the router basename. Raw hash
  // links otherwise inherit the document base and return to the Dashboard.
  const route = useHref({ pathname: location.pathname, search: location.search });
  // The board-origin handoff carries the originating board URL so the return
  // control restores view + filters (986be411 s3; review f4ec788c B2).
  const boardReturnPath = getTaskBoardOriginBoardUrl(taskId) || '/tasks';
  const { config } = useRelayHallConfig();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { subscribe } = useWebSocket();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const timelinePanelRef = useRef<HTMLElement>(null);
  const guardedHistoryIndexRef = useRef<number | null>(null);
  const restoringHistoryRef = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [contentEditorOpen, setContentEditorOpen] = useState(false);
  const [railEditorOpen, setRailEditorOpen] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false);
  const [operationFeedback, setOperationFeedback] = useState(() => dueAtAmbiguityNote(location.state?.dueAtResolution));
  const editorOpen = contentEditorOpen || railEditorOpen || titleEditing;
  const validTaskId = FULL_UUID_PATTERN.test(taskId);
  const taskQuery = useQuery({ queryKey: ['task-detail', taskId], queryFn: () => fetchTaskDetail(taskId), enabled: validTaskId });
  const livenessQuery = useQuery({ queryKey: ['task-liveness', taskId], queryFn: () => fetchLiveness(taskId), enabled: validTaskId && Boolean(taskQuery.data) });
  const updateMutation = useMutation({
    mutationFn: (updates: TaskWritePayload) => patchTaskDetail(taskId, updates),
    onMutate: async updates => {
      await queryClient.cancelQueries({ queryKey: ['task-detail', taskId] });
      const previous = queryClient.getQueryData<Task>(['task-detail', taskId]);
      // `dueAt` is excluded from the optimistic merge: the write form is a
      // wall clock plus a zone, and only the server can turn that into the
      // instant every reader below renders. Showing a guess would be this
      // interface deciding a timezone again.
      const { dueAt: _pendingDueAt, ...optimistic } = updates;
      if (previous) queryClient.setQueryData(['task-detail', taskId], { ...previous, ...optimistic });
      return { previous };
    },
    onError: (_error, _updates, context) => { if (context?.previous) queryClient.setQueryData(['task-detail', taskId], context.previous); },
    onSuccess: result => {
      queryClient.setQueryData<Task>(['task-detail', taskId], current => ({ ...current, ...result.task } as Task));
      setOperationFeedback(result.warning || dueAtAmbiguityNote(result.dueAtResolution));
    },
  });
  // Unarchive-to-prior-state (986be411 §4, E5): the server derives the
  // archived-from state; the inline status line announces where it went.
  const unarchiveMutation = useMutation({
    mutationFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/unarchive`, { method: 'POST' });
      const data = await readEnvelope(response);
      if (!response.ok || data.success === false) throw new TaskDetailRequestError(response.status, data.error || data.message || 'The Task could not be unarchived.');
      return data as { task: Task; restoredTo: TaskStatus; derivedFrom: string };
    },
    onSuccess: result => {
      queryClient.setQueryData<Task>(['task-detail', taskId], current => ({ ...current, ...result.task } as Task));
      setOperationFeedback(`Unarchived to ${TASK_STATUS_OPTIONS.find(status => status.value === result.restoredTo)?.label ?? result.restoredTo}`);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      const data = await readEnvelope(response);
      if (!response.ok || data.success === false) throw new TaskDetailRequestError(response.status, data.error || data.message || 'The Task could not be deleted.');
    },
    onSuccess: () => navigate('/tasks', { replace: true }),
  });

  useEffect(() => {
    if (!taskQuery.data) return;
    document.title = `${taskQuery.data.title} · Task details · ${config.displayName}`;
    titleRef.current?.focus();
  }, [taskQuery.data?.id, config.displayName]);



  useEffect(() => {
    if (!editorOpen) setUpdatedElsewhere(false);
  }, [editorOpen]);

  useEffect(() => subscribe('task.updated', (message: { task?: Task }) => {
    if (message.task?.id !== taskId) return;
    if (editorOpen) setUpdatedElsewhere(true);
    void queryClient.invalidateQueries({ queryKey: ['task-detail', taskId] });
  }), [subscribe, taskId, editorOpen, queryClient]);

  useEffect(() => {
    if (!editorOpen) return;
    guardedHistoryIndexRef.current = typeof window.history.state?.idx === 'number' ? window.history.state.idx : null;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const guardLinks = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest('a[href]');
      if (!link || !window.confirm('Discard unsaved changes?')) { if (link) event.preventDefault(); }
    };
    const guardHistoryTraversal = (event: PopStateEvent) => {
      if (restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        event.stopImmediatePropagation();
        return;
      }
      if (window.confirm('Discard unsaved changes?')) return;
      event.stopImmediatePropagation();
      const currentIndex = guardedHistoryIndexRef.current;
      const nextIndex = typeof event.state?.idx === 'number' ? event.state.idx : null;
      restoringHistoryRef.current = true;
      if (currentIndex !== null && nextIndex !== null && currentIndex !== nextIndex) {
        window.history.go(currentIndex - nextIndex);
      } else {
        window.history.forward();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', guardHistoryTraversal, true);
    document.addEventListener('click', guardLinks, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('popstate', guardHistoryTraversal, true);
      document.removeEventListener('click', guardLinks, true);
    };
  }, [editorOpen]);

  if (!validTaskId) return <Navigate to={`/tasks?focus=${encodeURIComponent(taskId)}`} replace />;
  if (taskQuery.isLoading) return <div className="task-detail-skeleton" role="status" aria-label="Loading Task details"><span className="sr-only">Loading Task details…</span><div aria-hidden="true" /><div aria-hidden="true" /><div aria-hidden="true" /></div>;
  if (!taskQuery.data) return <TaskDetailState error={taskQuery.error} onRetry={() => void taskQuery.refetch()} />;

  const task = taskQuery.data;
  const unarchiveError = unarchiveMutation.error instanceof Error ? unarchiveMutation.error.message : null;
  // Card 7d38a6e0. A refusal the server attributed to `dueAt` is shown on the
  // deadline control, as an alert the input points at, and NOT also in the
  // page banner: one refusal, announced once, where it happened.
  const dueRefusal = updateMutation.error instanceof TaskDetailRequestError && updateMutation.error.field === 'dueAt'
    ? updateMutation.error.message
    : null;
  const mutationError = unarchiveError ?? (dueRefusal ? null : updateMutation.error instanceof Error
    ? updateMutation.error.message
    : deleteMutation.error instanceof Error ? deleteMutation.error.message : null);
  const livenessState = livenessQuery.data || 'unknown';
  const liveness = LIVENESS_LABELS[livenessState];
  const saveTask = async (updates: Partial<Task>) => { await updateMutation.mutateAsync(updates); };

  return (
    <div className="task-detail-page" >
      <a className="task-detail-skip" href={`${route}#task-detail-work`}>Skip to Task work</a>
      <header className="task-detail-page-header" aria-label="Task identity and actions">
        <Link className="task-detail-back" to={boardReturnPath}><ChevronLeft size={16} aria-hidden="true" /> Tasks</Link>
        <div className="task-detail-heading">{titleEditing ? <><h1 className="sr-only">{task.title}</h1><div className="task-detail-title-editor">
          <label htmlFor="task-detail-title-input" className="sr-only">Title</label>
          <input id="task-detail-title-input" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} />
          <Button variant="secondary" disabled={!titleDraft.trim() || updateMutation.isPending} onClick={() => void updateMutation.mutateAsync({ title: titleDraft.trim() }).then(() => setTitleEditing(false))}>Save title</Button>
          <Button variant="secondary" disabled={updateMutation.isPending} onClick={() => setTitleEditing(false)}>Cancel title edit</Button>
        </div></> : <EditableFrame label="title" onEdit={() => { setTitleDraft(task.title); setTitleEditing(true); }}><h1 ref={titleRef} tabIndex={-1}>{task.title}</h1></EditableFrame>}
          <Button variant="secondary" size="compact" className="task-detail-id" onClick={() => void navigator.clipboard?.writeText(task.id)}>{task.id.slice(0, 8)} <Copy size={16} aria-hidden="true" /><span className="sr-only">Copy Task ID</span></Button>
        </div>
        <div className="task-detail-page-header-controls">
          <label>Status<StatusSelect value={task.status as TaskStatus} disabled={updateMutation.isPending} onChange={status => updateMutation.mutate({ status })} /></label>
          <label>Priority<PrioritySelect value={task.priority as TaskPriority} disabled={updateMutation.isPending} onChange={priority => updateMutation.mutate({ priority })} /></label>
          <span className={`task-detail-liveness task-detail-liveness--${livenessState}`}>{liveness}</span>
          <Button variant="secondary" onClick={() => updateMutation.mutate({ autoStart: !task.autoStart })}>{task.autoStart ? 'Park' : 'Arm'}</Button>
          <button type="button" className="task-detail-timeline-toggle" aria-label="Go to Timeline" aria-controls="task-detail-timeline" onClick={() => { timelinePanelRef.current?.focus(); timelinePanelRef.current?.scrollIntoView({ block: 'nearest' }); }}><PanelRight size={20} aria-hidden="true" /> Timeline</button>
          <Button variant="secondary" icon={<Copy size={16} aria-hidden="true" />} onClick={() => void navigator.clipboard?.writeText(window.location.href)}>Copy link</Button>
          <div className="task-detail-actions"><IconButton size="standard" ariaLabel="More Task actions" ariaExpanded={actionsOpen} icon={<MoreHorizontal size={20} aria-hidden="true" />} onClick={() => setActionsOpen(value => !value)} />
            {actionsOpen ? <div className="task-detail-actions-menu" role="menu">
              {task.status === 'archived'
                ? <button type="button" role="menuitem" disabled={unarchiveMutation.isPending} onClick={() => { unarchiveMutation.mutate(); setActionsOpen(false); }}>Unarchive</button>
                : <button type="button" role="menuitem" onClick={() => { if (window.confirm(`Archive “${task.title}”? The Task leaves the active board but remains in Archived.`)) { updateMutation.mutate({ status: 'archived' }); setActionsOpen(false); } }}>Archive</button>}
              <button type="button" role="menuitem" className="task-detail-danger" onClick={() => { if (window.confirm(`Delete “${task.title}” permanently? This removes the Task and cannot be undone.`)) { deleteMutation.mutate(); setActionsOpen(false); } }}>Delete</button>
            </div> : null}
          </div>
        </div>
        {mutationError ? <p className="task-detail-inline-error" role="alert">{mutationError}</p> : null}
        {operationFeedback ? <p className="task-detail-inline-warning" role="status">{operationFeedback}</p> : null}
      </header>
      <TaskRegionNavigation route={route} />
      <div className="task-detail-layout">
        <aside id="task-detail-panel-details" tabIndex={0} role="complementary" className="task-detail-left-rail" aria-labelledby="task-detail-details-heading"><h2 id="task-detail-details-heading">Details</h2><LeftRail task={task} update={(updates, onSuccess) => updateMutation.mutate(updates, { onSuccess })} onEditingChange={setRailEditorOpen} dueRefusal={dueRefusal} onDueEdited={() => { if (updateMutation.error) updateMutation.reset(); }} /></aside>
        <div id="task-detail-work" tabIndex={0} role="region" className="task-detail-work" aria-labelledby="task-detail-work-heading"><div id="task-detail-panel-work"><h2 id="task-detail-work-heading" className="sr-only">Work</h2><ContentRegion task={task} updatedElsewhere={updatedElsewhere} onEditingChange={setContentEditorOpen} saveTask={saveTask} refreshTask={async () => { await queryClient.invalidateQueries({ queryKey: ['task-detail', taskId] }); }} onViewReviewEvents={() => { timelinePanelRef.current?.focus(); timelinePanelRef.current?.scrollIntoView({ block: 'nearest' }); }} /></div></div>
        <aside ref={timelinePanelRef} id="task-detail-timeline" tabIndex={0} className="task-detail-timeline" aria-labelledby="task-detail-timeline-heading"><div id="task-detail-panel-timeline"><h2 id="task-detail-timeline-heading">Timeline</h2><TimelineRegion task={task} /></div></aside>
      </div>
    </div>
  );
}
