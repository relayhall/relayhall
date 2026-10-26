import { TaskAccountOwnershipPanel } from '../components/tasks/TaskAccountOwnershipPanel';
import { useTaskActivity } from '../hooks/useTaskActivity';
import { TaskActivityBadge } from '../components/tasks/TaskActivityBadge';
import { ContextPreview, ContextPreviewTrigger, ContextPreviewPanel } from '../components/BriefContextPreview';
import { TaskTextSectionEditor as EditableSection } from '../components/tasks/TaskTextSectionEditor';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Copy, Lock, Maximize2, Minimize2, MoreHorizontal, PanelRight } from 'lucide-react';
import { Link, Navigate, useHref, useLocation, useNavigate, useParams } from 'react-router-dom';
import { DueAtResolution, SubtaskStatus, SubtaskTransitionDetails, Task, TaskDueAtWrite, TaskExecutionProfile, TaskPriority, TaskStatus, TaskWritePayload } from '../types/task';
import ExecutionProfileEditor from '../components/tasks/ExecutionProfileEditor';
import TaskAccessVehicle from '../components/tasks/TaskAccessVehicle';
import { authenticatedFetch } from '../utils/auth';
import { TaskSuccessCriteria } from '../components/tasks/TaskSuccessCriteria';
import { getTaskBoardOriginBoardUrl } from '../utils/taskBoardNavigation';
import { useRelayHallConfig } from '../contexts/RelayHallConfigContext';
import { useOptionalToast } from '../contexts/ToastContext';
import { taskDetailSectionsFor } from '../components/tasks/taskDetailSectionRegistry';
import { parseTaskDetailSections } from '../components/tasks/taskDetailSections';
import { renderTaskMarkdown } from '../components/tasks/renderTaskMarkdown';
import { SubtaskList } from '../components/tasks/SubtaskList';
import { NativeReviewPanel, latestTaskReviewDecision, useNativeReviews } from '../components/tasks/NativeReviewPanel';
import { NativeExecutionPanel } from '../components/tasks/NativeExecutionPanel';
import { TaskTimeline } from '../components/tasks/TaskTimeline';
import { PrincipalName, principalDisplayLabel, usePrincipalDirectory, type DirectoryPrincipal } from '../components/principals/principalDirectory';
import { VerifierReviewBanner } from '../components/tasks/VerifierReviewBanner';
import { VerificationNoneBadge, verificationModeLabel } from '../components/tasks/VerificationNoneBadge';
import { useMyPrincipal } from '../hooks/usePrincipals';
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
const ARM_ACCESS_REASONS: Record<string, string> = {
  WRITE_SCOPE_REQUIRED: 'Your current sign-in or credential does not permit Task writes.',
  TASK_WRITE_REQUIRED: 'This action requires Task write access. Ask an administrator for access or hand off to an authorized executor.',
};
const UNKNOWN_ARM_ACCESS = 'Task permissions are unavailable. Refresh to check access.';
// Card 3fc32dd1: a disabled Claim says why, in the words of the lifecycle
// projection's reason (lifecycleAccess.claim.reason) — the same reason a
// refused claim answers in details.reason and records on the audit row.
const CLAIM_ACCESS_REASONS: Record<string, string> = {
  ...ARM_ACCESS_REASONS,
  TASK_ALREADY_ASSIGNED: "Another principal is this Task's Assignee.",
  INDEPENDENT_VERIFIER: "You are this Task's Verifier, and a Verifier cannot also be its Assignee.",
  TASK_NOT_ARMED: 'Arm this Task before claiming it.',
  TASK_BLOCKED: 'This Task can be claimed when every dependency is completed.',
};
const UNKNOWN_CLAIM_ACCESS = 'Claim permissions are unavailable. Refresh to check access.';
const CLAIMED_NOTICE = "You are now this Task's Assignee.";
const CLAIMED_NEXT_STEP = ' Set Status to In progress to start work and save progress Reports.';
const ALREADY_ASSIGNEE_NOTICE = "You are already this Task's Assignee.";

/**
 * Card 3fc32dd1: the one supported dashboard path to a progress Report, read
 * from the server's own decisions. The claimant that maintains a progress
 * Report is the Task's Assignee — a human Account exactly as a Connector — and
 * saving opens while the Task is In progress. Review, Completed and Archived
 * freeze editing by design, so they get no path.
 */
export function reportPathGuidance(task: Task): string | null {
  if (!['ideas', 'todo', 'stuck'].includes(task.status)) return null;
  const reason = task.reportMaintenanceAccess?.reason;
  if (reason === 'TASK_REPORT_FROZEN') return "You are this Task's Assignee. Set Status to In progress to save a progress Report.";
  if (reason !== 'TASK_CLAIMANT_REQUIRED') return null;
  const claim = task.lifecycleAccess?.claim;
  if (claim?.allowed) return "Progress Reports are saved by this Task's Assignee while it is In progress: Claim Task, then set Status to In progress.";
  if (claim?.reason === 'TASK_NOT_ARMED') return "Progress Reports are saved by this Task's Assignee while it is In progress: Arm this Task, Claim Task, then set Status to In progress.";
  return null;
}

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

function isTaskReadRefusal(error: unknown): boolean {
  return error instanceof TaskDetailRequestError && [401, 403, 404].includes(error.status);
}

async function readEnvelope(response: Response) {
  return response.json().catch(() => ({}));
}

/** One of the caller's own progress Reports, with the body and hash the
 * progress-report editor continues from. */
type EditableTaskReport = { id: string; title: string; content: string; content_hash: string; author_principal_id: string; status?: string };

/**
 * Card 50b5e9c4 slice 3: `GET /tasks/:id/reports` answers bounded summaries,
 * never bodies. The progress-report editor needs the caller's OWN active
 * progress Reports with their content and content hash, so this pages the
 * task-bound summaries (`scope=progress`, following `nextCursor`) and then
 * fetches each editable body explicitly from the Task-authority read
 * `GET /tasks/:id/reports/:reportId`, which needs Task read authority only,
 * as the full-row list it replaces did (round-1 B1).
 */
export async function fetchEditableTaskReports(taskId: string, principalId: string): Promise<EditableTaskReport[]> {
  const summaries: Array<{ id: string; status?: string; authorPrincipalId?: string | null }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ scope: 'progress', limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}/reports?${query.toString()}`);
    const data = await readEnvelope(response);
    if (!response.ok) throw new Error(data.error || 'Task Reports are unavailable.');
    summaries.push(...(Array.isArray(data.reports) ? data.reports : []));
    cursor = data.pagination?.hasMore && typeof data.pagination.nextCursor === 'string' ? data.pagination.nextCursor : null;
    if (!cursor) break;
  }
  const own = summaries.filter(summary => summary.authorPrincipalId === principalId && summary.status === 'active');
  return Promise.all(own.map(async summary => {
    const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}/reports/${summary.id}`);
    const data = await readEnvelope(response);
    if (!response.ok || !data.report) throw new Error(data.error || 'Task Reports are unavailable.');
    const report = data.report;
    return { id: report.id, title: report.title, content: report.content, content_hash: report.content_hash, author_principal_id: report.author_principal_id, status: report.status };
  }));
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

function TaskDetailActivity({ task }: { task: Task }) {
  const { me } = useMyPrincipal();
  const activity = useTaskActivity([task], me?.id ?? null);
  return <TaskActivityBadge activity={activity.get(task.id.toLowerCase())} />;
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

/**
 * Card 41e24358: where the Verifier came from, beside its name. An inherited
 * Phase default names the card's Phase (design wording "(inherited from Phase
 * <name>)"); a card without a Phase keeps the bare sentence.
 */
function verifierSourceNote(source: Task['verifierSource'], phaseId?: string | null): ReactNode {
  if (source === 'inherited-phase') return phaseId ? <> (inherited from Phase <PhaseName phaseId={phaseId} nameOnly />)</> : ' (inherited from Phase)';
  if (source === 'inherited-project') return ' (inherited from Project)';
  if (source === 'explicit') return ' (named at creation)';
  return '';
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
  // Card 41e24358: "Set Verifier" on the Review banner for those the roles
  // route admits - the Task's Shepherd or an administrator (the server decides).
  const { me, scopes: myScopes } = useMyPrincipal();
  const canAssignRoles = Boolean(me && (me.id === task.shepherdPrincipalId
    || ['admin', 'operator', 'orchestrator'].includes(String(me.role || '').toLowerCase())))
    || Boolean(myScopes?.includes('root'));
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
    people: <section className="task-detail-rail-group"><h3>People</h3>
      <dl>
      <Field label="Creator">{task.creatorPrincipalId ? <PrincipalName id={task.creatorPrincipalId} directory={directory} /> : 'Unknown'}</Field>
      <Field label="Assignee">{task.ownerPrincipalId ? <PrincipalName id={task.ownerPrincipalId} directory={directory} /> : 'Unassigned'}</Field>
      <Field label="Shepherd">{activeEditor === 'shepherd' ? <div className="task-detail-field-editor"><label className="sr-only" htmlFor="task-detail-shepherd-editor">Shepherd</label><Select id="task-detail-shepherd-editor" value={shepherdDraft} onChange={event => setShepherdDraft(event.target.value)}><option value="" disabled>— Select Principal —</option>{activePrincipals.map(principal => <option key={principal.id} value={principal.id}>{principalDisplayLabel(principal, principal.id)}</option>)}</Select><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" disabled={!shepherdDraft} onClick={() => saveRoles({ shepherdPrincipalId: shepherdDraft })}>Save Shepherd</Button><Button variant="secondary" size="compact" onClick={endRolesEditor}>Cancel Shepherd</Button></div></div> : <EditableFrame label="Shepherd" onEdit={() => { setShepherdDraft(task.shepherdPrincipalId || ''); setRolesError(''); beginEditor('shepherd'); }}><span>{task.shepherdPrincipalId ? <PrincipalName id={task.shepherdPrincipalId} directory={directory} /> : 'Unassigned'}</span></EditableFrame>}</Field>
      <Field label="Verifier">{activeEditor === 'verifier' ? <div className="task-detail-field-editor"><label className="sr-only" htmlFor="task-detail-verifier-editor">Verifier</label><Select id="task-detail-verifier-editor" value={verifierDraft} onChange={event => setVerifierDraft(event.target.value)}><option value="">Unassigned</option>{activePrincipals.map(principal => <option key={principal.id} value={principal.id}>{principalDisplayLabel(principal, principal.id)}</option>)}</Select><div className="task-detail-editor-actions"><Button variant="secondary" size="compact" onClick={() => saveRoles({ verifierPrincipalId: verifierDraft || null })}>Save Verifier</Button><Button variant="secondary" size="compact" onClick={endRolesEditor}>Cancel Verifier</Button></div></div> : <EditableFrame label="Verifier" onEdit={() => { setVerifierDraft(task.verifierPrincipalId || ''); setRolesError(''); beginEditor('verifier'); }}><span>{task.verifierPrincipalId ? <><PrincipalName id={task.verifierPrincipalId} directory={directory} />{verifierSourceNote(task.verifierSource, task.phaseId)}{verificationModeLabel(task.verificationMode)}</> : task.verificationNone === true ? <VerificationNoneBadge /> : 'Unassigned'}</span></EditableFrame>}</Field>
      {rolesError ? <p className="task-detail-inline-error" role="alert">{rolesError}</p> : null}
    </dl>
      {/* E388: the banner follows the People list instead of pushing it down. */}
      <VerifierReviewBanner task={task}
        verifierName={task.verifierPrincipalId ? principalDisplayLabel(directory?.get(task.verifierPrincipalId), task.verifierPrincipalId) : null}
        onSetVerifier={canAssignRoles ? () => { setVerifierDraft(task.verifierPrincipalId || ''); setRolesError(''); beginEditor('verifier'); } : undefined} />
    </section>,
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
    'dates-counters': <section className="task-detail-rail-group"><h3>Dates &amp; counters</h3><dl className="task-detail-dates-grid">
      <Field label="Created"><DateValue value={task.created} /></Field><Field label="Updated"><DateValue value={task.updated} /></Field>
      <Field label="Started"><DateValue value={task.startedAt} /></Field><Field label="Completed"><DateValue value={task.completedAt || task.completed} /></Field>
      <Field label="Archived"><DateValue value={task.archivedAt} /></Field><Field label="Attempts">{task.attemptCount ?? 0} / {task.maxRetries ?? 3}</Field>
    </dl></section>,
    advanced: <details className="task-detail-advanced"><summary><h3>Advanced</h3></summary><dl>
      <Field label="Discord thread">{task.discordThreadId || 'Not set'}</Field>
      <Field label="Tracker URL">{task.trackerUrl || 'Not set'}</Field><Field label="UUID"><code>{task.id}</code></Field>
    </dl>
      {/* E387(4): Account ownership lives here, a nested disclosure of the
          Advanced section, instead of a full-width block above the columns.
          Keyed by Task so a pending read never crosses Tasks. */}
      <details className="task-detail-ownership-disclosure"><summary>Account ownership</summary><TaskAccountOwnershipPanel key={task.id} taskId={task.id} /></details>
    </details>,
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

type ReportDraft = { title: string; content: string; reportId: string; expectedContentHash: string };
type PendingReport = { key: string; body: Record<string, string>; requestHash: string };
const REPORT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REPORT_STORAGE_RECOVERY = "Saved Task Report storage is invalid or unavailable. Original evidence is preserved; saving and reconciliation are blocked. Choose a version below when available, or keep this page open and ask for help recovering the saved evidence. An uncertain save must be checked before another save can be made.";

function strictReportRecord(value: unknown, fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every(key => fields.includes(key));
}

function validReportPair(reportId: unknown, hash: unknown): boolean {
  return typeof reportId === "string" && FULL_UUID_PATTERN.test(reportId)
    && typeof hash === "string" && REPORT_HASH_PATTERN.test(hash);
}

export function validateStoredReportDraft(value: unknown): { draft: ReportDraft; dirty: boolean } {
  if (!strictReportRecord(value, ["draft", "dirty"]) || typeof value.dirty !== "boolean"
    || !strictReportRecord(value.draft, ["title", "content", "reportId", "expectedContentHash"]))
    throw new Error(REPORT_STORAGE_RECOVERY);
  const draft = value.draft;
  if (typeof draft.title !== "string" || typeof draft.content !== "string"
    || !(draft.reportId === "" && draft.expectedContentHash === "" || validReportPair(draft.reportId, draft.expectedContentHash)))
    throw new Error(REPORT_STORAGE_RECOVERY);
  return value as { draft: ReportDraft; dirty: boolean };
}

async function canonicalReportBodyHash(body: Record<string, string>): Promise<string> {
  // Exact server reportRequestHash ordering and null defaults; no trimming.
  const canonical = JSON.stringify({title: body.title, content: body.content, summary: null,
    reportId: body.reportId ?? null, expectedContentHash: body.expectedContentHash ?? null});
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function validatePendingReport(value: unknown): Promise<PendingReport> {
  if (!strictReportRecord(value, ["key", "body", "requestHash"])
    || typeof value.key !== "string" || !FULL_UUID_PATTERN.test(value.key)
    || typeof value.requestHash !== "string" || !REPORT_HASH_PATTERN.test(value.requestHash)
    || !strictReportRecord(value.body, ["title", "content", "reportId", "expectedContentHash"]))
    throw new Error(REPORT_STORAGE_RECOVERY);
  const body = value.body;
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 500
    || typeof body.content !== "string" || !body.content.trim()
    || !(body.reportId === undefined && body.expectedContentHash === undefined || validReportPair(body.reportId, body.expectedContentHash)))
    throw new Error(REPORT_STORAGE_RECOVERY);
  if (await canonicalReportBodyHash(body as Record<string, string>) !== value.requestHash)
    throw new Error(REPORT_STORAGE_RECOVERY);
  return value as PendingReport;
}

const emptyReportDraft = (): ReportDraft => ({ title: "", content: "", reportId: "", expectedContentHash: "" });
const pendingReportDraft = (operation: PendingReport): ReportDraft => ({
  title: operation.body.title, content: operation.body.content,
  reportId: operation.body.reportId ?? "", expectedContentHash: operation.body.expectedContentHash ?? "",
});
const sameReportDraft = (a: ReportDraft, b: ReportDraft): boolean =>
  a.title === b.title && a.content === b.content && a.reportId === b.reportId && a.expectedContentHash === b.expectedContentHash;
const hasReportEvidence = (draft: ReportDraft): boolean => Object.values(draft).some(value => value !== "");

type PreservedReportDraft = { draft: ReportDraft; dirty: boolean };
type ReportRecoveryConflict = {
  taskId: string; scope: string; principalId: string; memory: string; repaired: string;
  live: { draft: ReportDraft; dirty: boolean; pending: PendingReport | null } | null;
  saved: { draft: PreservedReportDraft | null; pending: PendingReport | null };
  raw: string | null; rawDraft: string | null; rawPreserved: string | null;
};
const MAX_PRESERVED_REPORT_BYTES = 262144;
export function validatePreservedReportDrafts(raw: string | null): PreservedReportDraft[] {
  if (raw === null) return [];
  if (new TextEncoder().encode(raw).byteLength > MAX_PRESERVED_REPORT_BYTES) throw new Error(REPORT_STORAGE_RECOVERY);
  const value: unknown = JSON.parse(raw);
  if (!strictReportRecord(value, ["version", "drafts"]) || value.version !== 1
    || !Array.isArray(value.drafts) || value.drafts.length > 2) throw new Error(REPORT_STORAGE_RECOVERY);
  return value.drafts.map(validateStoredReportDraft);
}
type ReportRestore = {
  version: 1; scope: string; pendingRaw: string | null;
  beforeDraft: string | null; beforePreserved: string | null;
  afterDraft: string; afterPreserved: string;
};
// Short-lived scoped safety record retains exact bytes until BOTH replacements
// read back durably. A partial swap blocks writes and is resumed only by a button.
export function validateReportRestore(raw: string, scope: string): ReportRestore {
  if (new TextEncoder().encode(raw).byteLength > 1048576) throw new Error(REPORT_STORAGE_RECOVERY);
  const value: unknown = JSON.parse(raw);
  if (!strictReportRecord(value, ["version", "scope", "pendingRaw", "beforeDraft", "beforePreserved", "afterDraft", "afterPreserved"])
    || value.version !== 1 || value.scope !== scope
    || !(value.pendingRaw === null || typeof value.pendingRaw === "string")
    || !(value.beforeDraft === null || typeof value.beforeDraft === "string")
    || !(value.beforePreserved === null || typeof value.beforePreserved === "string")
    || typeof value.afterDraft !== "string" || typeof value.afterPreserved !== "string") throw new Error(REPORT_STORAGE_RECOVERY);
  const before = value.beforeDraft === null ? null : validateStoredReportDraft(JSON.parse(value.beforeDraft));
  const chosen = validateStoredReportDraft(JSON.parse(value.afterDraft));
  const previous = validatePreservedReportDrafts(value.beforePreserved);
  const next = validatePreservedReportDrafts(value.afterPreserved);
  for (const item of [...previous, ...(before ? [before] : [])]) {
    if (hasReportEvidence(item.draft) && ![chosen, ...next].some(other => sameReportDraft(item.draft, other.draft))) throw new Error(REPORT_STORAGE_RECOVERY);
  }
  return value as ReportRestore;
}
const RESTORE_CANONICAL_REFUSAL = "This page is opened for a different Report. No versions were replaced. Open the Task without Report selection, then restore the preserved version.";
function ReadableReportVersion({ name, draft }: { name: string; draft: ReportDraft | undefined }) {
  return <section aria-label={name}><h3>{name}</h3><p>{draft?.title || "Untitled Report"}</p><pre style={{whiteSpace:"pre-wrap"}}>{draft?.content || "No progress text"}</pre><p>{draft?.reportId ? "Changes to an existing Report" : "New Report draft"}</p></section>;
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
  const [reportDraft, setReportDraft] = useState({ title: '', content: '', reportId: '', expectedContentHash: '' });
  const [reportError, setReportError] = useState('');
  const [restoreNotice,setRestoreNotice]=useState("");
  const location = useLocation();
  const requestedReportId = new URLSearchParams(location.search).get('report');
  const navigateReport = useNavigate();
  const latestRequestedReportId = useRef(requestedReportId); latestRequestedReportId.current = requestedReportId;
  const reportScope = useRef<string | null>(null);
  const reportGeneration = useRef(0);
  const [identityRefresh, setIdentityRefresh] = useState(0);
  const explicitReportRecovery = useRef(false);
  const [reportRecoveryConflict, setReportRecoveryConflict] = useState<ReportRecoveryConflict | null>(null);
  const [preservedReportDrafts, setPreservedReportDrafts] = useState<PreservedReportDraft[]>([]);
  // Last draft actually persisted by this page, retained across authority refresh.
  // A refresh must compare newer durable bytes BEFORE blessing live persistence.
  const reportDurableDraft = useRef<{scope: string; rawDraft: string} | null>(null);
  const recoveryPersistence = useRef<{scope: string; raw: string | null; rawDraft: string | null} | null>(null);
  const [choosingRecovery, setChoosingRecovery] = useState(false);
  const [copyingRecovery, setCopyingRecovery] = useState(false);
  type ReportMutation = { generation: number; taskId: string; principalId: string };
  const reportMutation = useRef<ReportMutation | null>(null);
  const [reportMutationBusy, setReportMutationBusy] = useState(false);
  // Synchronous reservation before any await or render, shared by all mutations.
  // An old finally can release only its own owner, never a newer scoped action.
  const reserveReportMutation = (principalId: string): ReportMutation | null => {
    if (reportMutation.current) return null;
    const owner = {generation: reportGeneration.current, taskId: task.id, principalId};
    reportMutation.current = owner; setReportMutationBusy(true); return owner;
  };
  const releaseReportMutation = (owner: ReportMutation) => {
    if (reportMutation.current !== owner) return;
    reportMutation.current = null; setReportMutationBusy(false);
  };
  const [reportRestore, setReportRestore] = useState<{raw: string; swap: ReportRestore; principalId: string} | null>(null);
  const [reportPrincipal, setReportPrincipal] = useState<{ taskId: string; id: string } | null>(null);
  // The server shares its current locked Report policy; Arm is not Report WRITE.
  const canMaintainReport = task.status === "in-progress"
    && reportPrincipal?.taskId === task.id
    && reportPrincipal.id === task.ownerPrincipalId
    && reportPrincipal.id !== task.verifierPrincipalId
    && task.reportMaintenanceAccess?.allowed === true;
  const [reportDirty, setReportDirty] = useState(false);
  const progressReports = useQuery({ queryKey: ['task-progress-reports', task.id, reportPrincipal?.id], enabled: reportPrincipal?.taskId===task.id, queryFn: async () =>
    fetchEditableTaskReports(task.id, reportPrincipal?.id ?? '') });
  const [reportSaving, setReportSaving] = useState(false);
  const [pendingReport, setPendingReport] = useState<PendingReport|null>(null);
  const [reportRecoveryBlocked, setReportRecoveryBlocked] = useState(false);
  const [reportStorageKey,setReportStorageKey]=useState<string|null>(null);
  const reportLiveWork=useRef({draft:reportDraft,dirty:reportDirty,pending:pendingReport});
  reportLiveWork.current={draft:reportDraft,dirty:reportDirty,pending:pendingReport};
  useEffect(() => {
    const refresh = () => setIdentityRefresh(value => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(()=>{
    const explicitRecovery = explicitReportRecovery.current; explicitReportRecovery.current = false;
    setReportRecoveryConflict(null); setPreservedReportDrafts([]); setReportRestore(null); setRestoreNotice(""); recoveryPersistence.current = null;
    let current=true; ++reportGeneration.current; reportMutation.current=null; setReportMutationBusy(false); setChoosingRecovery(false); setCopyingRecovery(false); setReportPrincipal(null); setReportStorageKey(null); setReportSaving(false);
    void (async()=>{try{
      const response=await authenticatedFetch(`${API_BASE_URL}/principals/me`);const data=await readEnvelope(response);
      if(!response.ok||typeof data.principal?.id!=="string")throw new Error("Sign in again to recover Task Report saves.");
      const storageKey=`relayhall-task-report:${window.location.origin}:${data.principal.id}:${task.id}`;
      const raw=sessionStorage.getItem(storageKey);
      const rawDraft=sessionStorage.getItem(`${storageKey}:draft`);
      const rawPreserved=sessionStorage.getItem(`${storageKey}:preserved`);
      const rawRestore=sessionStorage.getItem(`${storageKey}:restore`);
      const swap=rawRestore===null ? null : validateReportRestore(rawRestore,storageKey);
      const preserved=validatePreservedReportDrafts(rawPreserved);
      const stored=raw === null ? null : await validatePendingReport(JSON.parse(raw));
      const draft=rawDraft === null ? null : validateStoredReportDraft(JSON.parse(rawDraft));
      if(current){
        // Digest validation must not publish a snapshot whose evidence changed.
        if(sessionStorage.getItem(storageKey)!==raw || sessionStorage.getItem(`${storageKey}:draft`)!==rawDraft
          || sessionStorage.getItem(`${storageKey}:preserved`)!==rawPreserved
          || sessionStorage.getItem(`${storageKey}:restore`)!==rawRestore) {
          setReportRecoveryBlocked(true);setReportError("Saved evidence changed while it was being checked. Nothing was replaced. Recheck to compare the latest versions.");return;
        }
        if(swap && rawRestore!==null) {
          if(swap.pendingRaw!==raw || ![swap.beforeDraft,swap.afterDraft].includes(rawDraft)
            || ![swap.beforePreserved,swap.afterPreserved].includes(rawPreserved)
            || stored && !sameReportDraft(pendingReportDraft(stored),validateStoredReportDraft(JSON.parse(swap.afterDraft)).draft))
            throw new Error(REPORT_STORAGE_RECOVERY);
          setReportRestore({raw:rawRestore,swap,principalId:data.principal.id});
          setReportRecoveryBlocked(true);setReportError("Restoration was interrupted. All versions are kept in this tab. Finish restoring when storage is available.");
          return;
        }
        setPreservedReportDrafts(preserved);
        const sameScope = reportScope.current === storageKey;
        const durableDraftChanged = !explicitRecovery && !reportRecoveryBlocked
          && sameScope && reportDurableDraft.current?.scope === storageKey
          && reportDurableDraft.current.rawDraft !== rawDraft;
        if(!sameScope || explicitRecovery || reportRecoveryBlocked || durableDraftChanged){
          const recoveredDraft = stored ? pendingReportDraft(stored) : draft?.draft;
          // A pending body is immutable. A differing draft is separate evidence,
          // not permission to replace either record with the other.
          const storageConflict = stored && draft && hasReportEvidence(draft.draft)
            && !sameReportDraft(pendingReportDraft(stored), draft.draft);
          const memoryConflict = sameScope && (
            recoveredDraft && hasReportEvidence(reportDraft) && !sameReportDraft(reportDraft, recoveredDraft)
            || pendingReport && (!stored || pendingReport.key !== stored.key || pendingReport.requestHash !== stored.requestHash));
          if(storageConflict || memoryConflict || durableDraftChanged){
            setReportRecoveryConflict({taskId:task.id, scope:storageKey, principalId:data.principal.id,
              live:sameScope ? {draft:reportDraft,dirty:reportDirty,pending:pendingReport} : null,
              saved:{draft,pending:stored}, raw,rawDraft,rawPreserved,
              memory:JSON.stringify(sameScope ? {draft:reportDraft,dirty:reportDirty,pending:pendingReport} : null, null, 2),
              repaired:JSON.stringify({draft, pending:stored}, null, 2)});
            setReportRecoveryBlocked(true);setReportError(REPORT_STORAGE_RECOVERY);
            return;
          }
          reportScope.current=storageKey;
          setReportError("");setReportSaving(false);setPendingReport(stored);
          // Missing storage is not an instruction to erase live evidence.
          setReportDraft(recoveredDraft ?? (sameScope ? reportDraft : emptyReportDraft()));
          setReportDirty(Boolean(draft?.dirty) || sameScope && reportDirty);
        }
        recoveryPersistence.current={scope:storageKey,raw,rawDraft};
        setReportRecoveryBlocked(false);
        setReportPrincipal({taskId:task.id,id:data.principal.id});setReportStorageKey(storageKey);
      }
    }catch{if(current){setReportRecoveryBlocked(true);setReportError(REPORT_STORAGE_RECOVERY);}}})();
    return()=>{current=false;++reportGeneration.current;reportMutation.current=null;};
  },[task.id, task.ownerPrincipalId, task.verifierPrincipalId, task.status, task.reportMaintenanceAccess?.allowed, identityRefresh]);
  // Shared entry/pre-write comparison with the last verified observation. A
  // stable new value is not an accepted baseline until explicitly recovered.
  const checkCurrentReportDraft = (retainLive = false): boolean => {
    const scope=reportStorageKey;
    if(!scope || !reportPrincipal || reportScope.current!==scope) return false;
    const live=reportLiveWork.current;
    let raw: string|null=null,rawDraft: string|null=null,rawPreserved: string|null=null;
    let saved: PreservedReportDraft|null=null;
    let stored: PendingReport|null=null;
    let message="Saved work changed. Nothing was replaced. Compare the versions before continuing.";
    try {
      raw=sessionStorage.getItem(scope);rawDraft=sessionStorage.getItem(`${scope}:draft`);
      const snapshot=recoveryPersistence.current;
      const observed=snapshot?.scope===scope ? snapshot : reportDurableDraft.current?.scope===scope ? reportDurableDraft.current : null;
      if(observed && observed.rawDraft===rawDraft) return true;
      rawPreserved=sessionStorage.getItem(`${scope}:preserved`);
      saved=rawDraft===null?null:validateStoredReportDraft(JSON.parse(rawDraft));
      const preserved=validatePreservedReportDrafts(rawPreserved);
      if(raw!==null && pendingReport && raw===JSON.stringify(pendingReport)) stored=pendingReport;
      // On an ordinary edit, keep the characters just typed without replacing C.
      // Only append within the existing bounded archive; never evict or expand it.
      if(retainLive || live.dirty && !sameReportDraft(live.draft,reportDraft)) {
        if(sessionStorage.getItem(`${scope}:restore`)!==null || raw!==null || pendingReport)
          throw new Error(REPORT_STORAGE_RECOVERY);
        validateStoredReportDraft({draft:live.draft,dirty:live.dirty});
        if(hasReportEvidence(live.draft) && !preserved.some(item=>sameReportDraft(item.draft,live.draft))) {
          const archive=JSON.stringify({version:1,drafts:[...preserved,{draft:live.draft,dirty:live.dirty}]});
          validatePreservedReportDrafts(archive);
          sessionStorage.setItem(`${scope}:preserved`,archive);
          if(sessionStorage.getItem(`${scope}:preserved`)!==archive) throw new Error(REPORT_STORAGE_RECOVERY);
          rawPreserved=archive;
        }
        message="Saved work changed. Your latest page edit is also kept in this tab for reload. Compare the versions before continuing.";
      }
    } catch {
      message="Saved work cannot safely be replaced. Keep this page open: the latest page work may not be kept for reload. Copy the visible work before rechecking or reloading.";
    }
    recoveryPersistence.current=null;
    setReportRecoveryConflict({taskId:task.id,scope,principalId:reportPrincipal.id,live,
      saved:{draft:saved,pending:stored},raw,rawDraft,rawPreserved,
      memory:JSON.stringify(live,null,2),repaired:JSON.stringify({draft:saved,pending:stored},null,2)});
    setReportRecoveryBlocked(true);setReportError(message);
    return false;
  };
  useEffect(() => {
    if(!reportRecoveryBlocked && reportStorageKey && reportScope.current===reportStorageKey) {
      try {
      const snapshot=recoveryPersistence.current;
      if(snapshot && (snapshot.scope!==reportStorageKey || sessionStorage.getItem(reportStorageKey)!==snapshot.raw
        || sessionStorage.getItem(`${reportStorageKey}:draft`)!==snapshot.rawDraft)) {
        recoveryPersistence.current=null;setReportStorageKey(null);setReportPrincipal(null);
        setReportRecoveryBlocked(true);setReportError("Saved evidence changed before recovery finished. Nothing was replaced. Recheck the latest versions.");return;
      }
      if(!checkCurrentReportDraft(true)) return;
      recoveryPersistence.current=null;
      if(sessionStorage.getItem(`${reportStorageKey}:restore`)!==null) throw new Error(REPORT_STORAGE_RECOVERY);
      const persistedDraft=JSON.stringify({draft:reportDraft,dirty:reportDirty});
      sessionStorage.setItem(`${reportStorageKey}:draft`,persistedDraft);
      if(sessionStorage.getItem(`${reportStorageKey}:draft`)!==persistedDraft) throw new Error(REPORT_STORAGE_RECOVERY);
      reportDurableDraft.current={scope:reportStorageKey,rawDraft:persistedDraft}; }
      catch {setReportRecoveryBlocked(true);setReportError(REPORT_STORAGE_RECOVERY);}
    }
  },[reportStorageKey,reportDraft,reportDirty,reportRecoveryBlocked]);
  const recoveryAuthorId=reportRestore?.principalId ?? reportRecoveryConflict?.principalId ?? reportPrincipal?.id;
  const canChooseRecovery=task.status==="in-progress" && recoveryAuthorId===task.ownerPrincipalId
    && recoveryAuthorId!==task.verifierPrincipalId && task.reportMaintenanceAccess?.allowed===true;
  const currentRecoveryAuthority=useRef({taskId:task.id,authorId:recoveryAuthorId,allowed:canChooseRecovery});
  currentRecoveryAuthority.current={taskId:task.id,authorId:recoveryAuthorId,allowed:canChooseRecovery};
  const assertReportMutation = (owner: ReportMutation) => {
    const authority=currentRecoveryAuthority.current;
    if(reportMutation.current!==owner || owner.generation!==reportGeneration.current
      || authority.taskId!==owner.taskId || authority.authorId!==owner.principalId || !authority.allowed)
      throw new Error("Authenticated actor or Task access changed; all versions remain recoverable.");
  };
  const chooseRecoveryVersion = async (choice: "memory" | "saved" | "pending" | number) => {
    setRestoreNotice("");
    const conflict=reportRecoveryConflict;
    const scope=conflict?.scope ?? reportStorageKey;
    const principalId=conflict?.principalId ?? reportPrincipal?.id;
    if(reportMutation.current || choosingRecovery || !scope || !principalId || task.status!=="in-progress"
      || task.ownerPrincipalId!==principalId || task.verifierPrincipalId===principalId
      || task.reportMaintenanceAccess?.allowed!==true) return;
    // Ordinary Restore shares the last verified outgoing-draft boundary.
    if(!conflict && !checkCurrentReportDraft()) return;
    const owner=reserveReportMutation(principalId);if(!owner)return;
    const generation=owner.generation;
    setChoosingRecovery(true);
    try {
      const raw=conflict ? conflict.raw : sessionStorage.getItem(scope);
      const rawDraft=conflict ? conflict.rawDraft : sessionStorage.getItem(`${scope}:draft`);
      const rawPreserved=conflict ? conflict.rawPreserved : sessionStorage.getItem(`${scope}:preserved`);
      const preserved=validatePreservedReportDrafts(rawPreserved);
      // The displayed choice, not a freshly read index, is the entry baseline.
      // A stable pre-entry reorder/replacement must not authorize another target.
      if(!conflict && JSON.stringify(preserved)!==JSON.stringify(preservedReportDrafts)) {
        const live=reportLiveWork.current;
        const saved=rawDraft===null ? null : validateStoredReportDraft(JSON.parse(rawDraft));
        setReportRecoveryConflict({taskId:task.id,scope,principalId,live,
          saved:{draft:saved,pending:null},raw,rawDraft,rawPreserved,
          memory:JSON.stringify(live,null,2),repaired:JSON.stringify({draft:saved,pending:null},null,2)});
        throw new Error("The preserved versions changed. Nothing was restored. Recheck the versions before choosing again.");
      }
      if(sessionStorage.getItem(`${scope}:restore`)!==null)
        throw new Error("An interrupted restoration is still preserved. Finish it before choosing another version.");
      const stored=raw===null ? null : await validatePendingReport(JSON.parse(raw));
      assertReportMutation(owner);
      const saved=rawDraft===null ? null : validateStoredReportDraft(JSON.parse(rawDraft));
      const live=conflict ? conflict.live ?? {draft:emptyReportDraft(),dirty:false,pending:null} : reportLiveWork.current;
      // A missing or divergent live operation cannot be discarded or re-keyed.
      if(live.pending && (!stored || JSON.stringify(live.pending)!==JSON.stringify(stored)))
        throw new Error("Two different uncertain saves need help from support. Neither save was changed. Keep this page open; do not start another save.");
      if(stored && choice!=="pending" || typeof choice==="number" && pendingReport)
        throw new Error("Check the uncertain save first. Other versions remain preserved.");
      const chosen=typeof choice==="number" ? preserved[choice]
        : choice==="memory" ? {draft:live.draft,dirty:live.dirty}
        : choice==="pending" && stored ? {draft:pendingReportDraft(stored),dirty:true} : saved;
      if(!chosen) throw new Error("This version is no longer available. Recheck the saved evidence.");
      if(!chosen.dirty && latestRequestedReportId.current && latestRequestedReportId.current!==chosen.draft.reportId)
        throw new Error(RESTORE_CANONICAL_REFUSAL);
      const alternates: PreservedReportDraft[]=[];
      for(const version of [...preserved,{draft:live.draft,dirty:live.dirty},...(saved?[saved]:[])]) {
        if(hasReportEvidence(version.draft) && !sameReportDraft(version.draft,chosen.draft)
          && !alternates.some(item=>sameReportDraft(item.draft,version.draft))) alternates.push(version);
      }
      const archive=JSON.stringify({version:1,drafts:alternates});
      if(alternates.length>2) throw new Error("There are already two preserved versions. Keep this page open and ask support to retain all versions before continuing.");
      validatePreservedReportDrafts(archive); // bounded, strict and never silently evicts evidence
      const response=await authenticatedFetch(`${API_BASE_URL}/principals/me`);const data=await readEnvelope(response);
      if(generation!==reportGeneration.current) return;
      assertReportMutation(owner);
      if(!response.ok || data.principal?.id!==principalId) {
        setIdentityRefresh(value=>value+1);throw new Error("Your sign-in changed. Recheck before choosing a version.");
      }
      if(sessionStorage.getItem(scope)!==raw || sessionStorage.getItem(`${scope}:draft`)!==rawDraft
        || sessionStorage.getItem(`${scope}:preserved`)!==rawPreserved)
        throw new Error("Saved evidence changed while choosing. Nothing was replaced. Recheck the latest versions.");
      if(!chosen.dirty && latestRequestedReportId.current && latestRequestedReportId.current!==chosen.draft.reportId)
        throw new Error(RESTORE_CANONICAL_REFUSAL);
      if(sessionStorage.getItem(`${scope}:restore`)!==null)
        throw new Error("An interrupted restoration is still preserved. Finish it before choosing another version.");
      const swap:ReportRestore={version:1,scope,pendingRaw:raw,beforeDraft:rawDraft,beforePreserved:rawPreserved,
        afterDraft:JSON.stringify(chosen),afterPreserved:archive};
      const swapRaw=JSON.stringify(swap);validateReportRestore(swapRaw,scope);
      sessionStorage.setItem(`${scope}:restore`,swapRaw);
      if(sessionStorage.getItem(`${scope}:restore`)!==swapRaw) throw new Error(REPORT_STORAGE_RECOVERY);
      // Keep the safety record through either partial write, including reload.
      // Preserve alternate drafts durably BEFORE replacing the active draft.
      // The pending record is never written, removed or given a new identity here.
      sessionStorage.setItem(`${scope}:preserved`,archive);
      if(sessionStorage.getItem(`${scope}:preserved`)!==archive) throw new Error(REPORT_STORAGE_RECOVERY);
      sessionStorage.setItem(`${scope}:draft`,JSON.stringify(chosen));
      if(sessionStorage.getItem(`${scope}:draft`)!==swap.afterDraft || sessionStorage.getItem(`${scope}:preserved`)!==archive
        || sessionStorage.getItem(scope)!==raw || sessionStorage.getItem(`${scope}:restore`)!==swapRaw) throw new Error(REPORT_STORAGE_RECOVERY);
      sessionStorage.removeItem(`${scope}:restore`);
      if(sessionStorage.getItem(`${scope}:restore`)!==null) throw new Error(REPORT_STORAGE_RECOVERY);
      reportScope.current=scope;recoveryPersistence.current={scope,raw,rawDraft:JSON.stringify(chosen)};
      setPreservedReportDrafts(alternates);setReportDraft(chosen.draft);setReportDirty(chosen.dirty);
      setPendingReport(stored);setReportRecoveryConflict(null);setReportRecoveryBlocked(false);setReportError("");
      setReportPrincipal({taskId:task.id,id:principalId});setReportStorageKey(scope);
    } catch(error) {
      if(generation===reportGeneration.current) {
        const message=error instanceof Error?error.message:REPORT_STORAGE_RECOVERY;setReportError(message);
        if(message!==RESTORE_CANONICAL_REFUSAL) setReportRecoveryBlocked(true);else setRestoreNotice(message);
        try {const preservedSwap=sessionStorage.getItem(`${scope}:restore`);
          if(preservedSwap!==null)setReportRestore({raw:preservedSwap,swap:validateReportRestore(preservedSwap,scope),principalId});
        } catch { /* Unreadable storage stays blocked; no record is overwritten. */ }
      }
    } finally {if(reportMutation.current===owner)setChoosingRecovery(false);releaseReportMutation(owner);}
  };
  const finishReportRestore = async () => {
    const recovery=reportRestore;
    if(reportMutation.current || !recovery || choosingRecovery || !canChooseRecovery) return;
    const owner=reserveReportMutation(recovery.principalId);if(!owner)return;
    const generation=owner.generation;setChoosingRecovery(true);
    try {
      const {swap,raw,principalId}=recovery;const scope=swap.scope;
      const beforeDraft=sessionStorage.getItem(`${scope}:draft`);
      const beforePreserved=sessionStorage.getItem(`${scope}:preserved`);
      const pendingRaw=sessionStorage.getItem(scope);
      if(sessionStorage.getItem(`${scope}:restore`)!==raw || pendingRaw!==swap.pendingRaw
        || ![swap.beforeDraft,swap.afterDraft].includes(beforeDraft)
        || ![swap.beforePreserved,swap.afterPreserved].includes(beforePreserved)) throw new Error(REPORT_STORAGE_RECOVERY);
      validateReportRestore(raw,scope);
      const stored=pendingRaw===null ? null : await validatePendingReport(JSON.parse(pendingRaw));
      assertReportMutation(owner);
      const chosen=validateStoredReportDraft(JSON.parse(swap.afterDraft));
      if(stored && !sameReportDraft(pendingReportDraft(stored),chosen.draft)) throw new Error(REPORT_STORAGE_RECOVERY);
      const response=await authenticatedFetch(`${API_BASE_URL}/principals/me`);const data=await readEnvelope(response);
      if(generation!==reportGeneration.current) return;
      assertReportMutation(owner);
      if(!response.ok || data.principal?.id!==principalId) {setReportRestore(null);setIdentityRefresh(value=>value+1);throw new Error("Your sign-in changed. Recheck before restoring.");}
      if(currentRecoveryAuthority.current.taskId!==task.id || currentRecoveryAuthority.current.authorId!==principalId || !currentRecoveryAuthority.current.allowed) throw new Error("Your Task access changed. All versions remain preserved; recheck before restoring.");
      if(!chosen.dirty && latestRequestedReportId.current && latestRequestedReportId.current!==chosen.draft.reportId) throw new Error(RESTORE_CANONICAL_REFUSAL);
      if(sessionStorage.getItem(`${scope}:restore`)!==raw || sessionStorage.getItem(scope)!==pendingRaw
        || sessionStorage.getItem(`${scope}:draft`)!==beforeDraft || sessionStorage.getItem(`${scope}:preserved`)!==beforePreserved)
        throw new Error("Saved evidence changed while restoring. Nothing was replaced. Recheck the latest versions.");
      sessionStorage.setItem(`${scope}:preserved`,swap.afterPreserved);
      if(sessionStorage.getItem(`${scope}:preserved`)!==swap.afterPreserved) throw new Error(REPORT_STORAGE_RECOVERY);
      sessionStorage.setItem(`${scope}:draft`,swap.afterDraft);
      if(sessionStorage.getItem(`${scope}:draft`)!==swap.afterDraft || sessionStorage.getItem(`${scope}:preserved`)!==swap.afterPreserved
        || sessionStorage.getItem(scope)!==pendingRaw || sessionStorage.getItem(`${scope}:restore`)!==raw) throw new Error(REPORT_STORAGE_RECOVERY);
      sessionStorage.removeItem(`${scope}:restore`);
      if(sessionStorage.getItem(`${scope}:restore`)!==null) throw new Error(REPORT_STORAGE_RECOVERY);
      reportScope.current=scope;recoveryPersistence.current={scope,raw:pendingRaw,rawDraft:swap.afterDraft};
      setPreservedReportDrafts(validatePreservedReportDrafts(swap.afterPreserved));setReportDraft(chosen.draft);setReportDirty(chosen.dirty);
      setPendingReport(stored);setReportRestore(null);setReportRecoveryConflict(null);setReportRecoveryBlocked(false);setReportError("");
      setReportPrincipal({taskId:task.id,id:principalId});setReportStorageKey(scope);
    } catch(error) {if(generation===reportGeneration.current){setReportRecoveryBlocked(true);setReportError(error instanceof Error?error.message:REPORT_STORAGE_RECOVERY);}}
    finally {if(reportMutation.current===owner)setChoosingRecovery(false);releaseReportMutation(owner);}
  };
  const copyRecoveryEvidence = async () => {
    const conflict=reportRecoveryConflict;if(!conflict || copyingRecovery) return;
    const generation=reportGeneration.current;setCopyingRecovery(true);
    try {
      const response=await authenticatedFetch(`${API_BASE_URL}/principals/me`);const data=await readEnvelope(response);
      if(generation!==reportGeneration.current) return;
      if(!response.ok || data.principal?.id!==conflict.principalId) {setIdentityRefresh(value=>value+1);return;}
      if(!navigator.clipboard?.writeText) throw new Error("Copy is unavailable. Keep this page open and use the technical evidence below with support.");
      await navigator.clipboard.writeText(JSON.stringify({page:conflict.live,saved:conflict.saved},null,2));
      if(generation===reportGeneration.current)setReportError("Both versions copied for support. This has not resolved the uncertain saves; keep this page open.");
    } catch {if(generation===reportGeneration.current)setReportError("Copy is unavailable. Keep this page open and use the technical evidence below with support.");}
    finally {if(generation===reportGeneration.current)setCopyingRecovery(false);}
  };
  const editableReports = progressReports.data?.filter(report =>
    report.author_principal_id === reportPrincipal?.id && report.status === 'active');
  const canonicalMismatch = Boolean(requestedReportId && requestedReportId !== reportDraft.reportId);
  useEffect(() => {
    if (!requestedReportId || !canMaintainReport || !progressReports.isSuccess || requestedReportId === reportDraft.reportId) return;
    if (reportDirty || pendingReport || reportSaving) {
      setReportError("Report switch refused: keep your draft and reconcile any pending save before switching.");
      const search=new URLSearchParams(location.search);
      if(reportDraft.reportId) search.set("report",reportDraft.reportId); else search.delete("report");
      navigateReport({pathname:location.pathname,search:search.toString(),hash:location.hash},{replace:true});
      return;
    }
    const report = editableReports?.find(row => row.id === requestedReportId);
    if (!report) {
      setReportError("This Report is not available for you to edit on this Task.");
      return;
    }
    setReportError("");
    setReportDraft({title:report.title,content:report.content,reportId:report.id,expectedContentHash:report.content_hash});
  }, [requestedReportId, canMaintainReport, progressReports.isSuccess, editableReports, pendingReport, reportDirty, reportSaving, reportDraft.reportId, location, navigateReport]);
  const checkReportIdentity = async (owner: ReportMutation) => {
    assertReportMutation(owner);
    const response=await authenticatedFetch(`${API_BASE_URL}/principals/me`);const data=await readEnvelope(response);
    assertReportMutation(owner);
    if(!response.ok || data.principal?.id!==owner.principalId){
      setIdentityRefresh(value=>value+1);
      throw new Error("Authenticated actor or Task changed; the original draft and operation remain recoverable.");
    }
  };
  const saveProgressReport = async () => {
    if(reportMutation.current) return;
    if(reportRecoveryBlocked || !canMaintainReport || canonicalMismatch){setReportError("Only the current claimant with Task write access may maintain this Report.");return;}
    if(!reportStorageKey || !reportPrincipal){setReportError("Wait for your authenticated identity before saving.");return;}
    if(!checkCurrentReportDraft()) return;
    const owner=reserveReportMutation(reportPrincipal.id);if(!owner)return;
    setReportSaving(true); setReportError("");
    const generation=owner.generation;
    let operation=pendingReport;
    let evidenceChanged=false;
    try {
      const scope=reportStorageKey;
      let pendingRaw=sessionStorage.getItem(scope);
      const draftRaw=sessionStorage.getItem(`${scope}:draft`);
      const preservedRaw=sessionStorage.getItem(`${scope}:preserved`);
      const restoreRaw=sessionStorage.getItem(`${scope}:restore`);
      const assertEvidence = () => {
        assertReportMutation(owner);
        if(sessionStorage.getItem(scope)!==pendingRaw || sessionStorage.getItem(`${scope}:draft`)!==draftRaw
          || sessionStorage.getItem(`${scope}:preserved`)!==preservedRaw || sessionStorage.getItem(`${scope}:restore`)!==restoreRaw
          || restoreRaw!==null || latestRequestedReportId.current && latestRequestedReportId.current!==reportDraft.reportId) {
          evidenceChanged=true;
          throw new Error("Saved evidence changed during this save. Nothing newer was replaced. Recheck the latest versions before continuing.");
        }
      };
      if((operation ? pendingRaw===null || JSON.stringify(JSON.parse(pendingRaw))!==JSON.stringify(operation) : pendingRaw!==null)) {
        evidenceChanged=true;throw new Error("The uncertain save changed. Recheck the preserved evidence before continuing.");
      }
      const storedDraft=draftRaw===null?null:validateStoredReportDraft(JSON.parse(draftRaw));
      const storedPreserved=validatePreservedReportDrafts(preservedRaw);
      if(storedDraft && (!sameReportDraft(storedDraft.draft,reportDraft) || storedDraft.dirty!==reportDirty)
        || JSON.stringify(storedPreserved)!==JSON.stringify(preservedReportDrafts)) {
        evidenceChanged=true;throw new Error("Saved drafts changed before this save. Nothing was replaced. Recheck the latest versions.");
      }
      assertEvidence();await checkReportIdentity(owner);assertEvidence();
      if (!operation) {
        const body:Record<string,string>={title:reportDraft.title,content:reportDraft.content,
          ...(reportDraft.reportId?{reportId:reportDraft.reportId,expectedContentHash:reportDraft.expectedContentHash}:{})};
        const requestHash=await canonicalReportBodyHash(body);assertEvidence();
        operation={key:crypto.randomUUID(),body,requestHash};pendingRaw=JSON.stringify(operation);
        sessionStorage.setItem(scope,pendingRaw);
        if(sessionStorage.getItem(scope)!==pendingRaw) {evidenceChanged=true;throw new Error(REPORT_STORAGE_RECOVERY);}
        setPendingReport(operation);
      }
      operation=await validatePendingReport(operation);assertEvidence();
      await checkReportIdentity(owner);assertEvidence();
      let response = pendingReport
        ? await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/report-operations/${encodeURIComponent(operation.key)}?requestHash=${operation.requestHash}`)
        : await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/reports`, {method:"POST",
            headers:{"Content-Type":"application/json","Idempotency-Key":operation.key},body:JSON.stringify(operation.body)});
      let data=await readEnvelope(response);assertEvidence();
      if(pendingReport && response.status===404 && data.code==="TASK_REPORT_OPERATION_UNKNOWN"){
        await checkReportIdentity(owner);assertEvidence();
        response=await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/reports`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":operation.key},body:JSON.stringify(operation.body)});data=await readEnvelope(response);assertEvidence();
      }
      if (!response.ok) {
        throw new Error(data.error||"The save outcome is uncertain. Reconcile this operation before creating another Report.");
      }
      if (data.operation?.key!==operation.key || data.operation?.requestHash!==operation.requestHash
        || data.operation?.contentHash!==data.report?.content_hash) throw new Error("The committed operation does not match this save.");
      await checkReportIdentity(owner);assertEvidence();
      const saved=data.report;
      sessionStorage.removeItem(scope);
      if(sessionStorage.getItem(scope)!==null){evidenceChanged=true;throw new Error(REPORT_STORAGE_RECOVERY);}
      setPendingReport(null);setReportDirty(false);
      setReportDraft({title:saved.title,content:saved.content,reportId:saved.id,expectedContentHash:saved.content_hash});
      await Promise.all([reportsQuery.refetch(),progressReports.refetch()]);
    } catch(error) {if(generation===reportGeneration.current){
      if(evidenceChanged){recoveryPersistence.current=null;setReportRecoveryBlocked(true);}
      setReportError(error instanceof Error?error.message:"Reconcile the uncertain Task Report save.");
    }} finally {if(reportMutation.current===owner)setReportSaving(false);releaseReportMutation(owner);}
  };
  const editReportWork = (field: "title" | "content", value: string) => {
    if(reportMutation.current || reportRecoveryBlocked || !canMaintainReport) return;
    const draft={...reportLiveWork.current.draft,[field]:value};
    reportLiveWork.current={draft,dirty:true,pending:pendingReport};
    setReportDirty(true);setReportDraft(draft);
  };
  const handOverProgressReport = async () => {
    if(reportMutation.current) return;
    if(reportRecoveryBlocked || !canMaintainReport || canonicalMismatch || reportDirty || pendingReport || !reportDraft.reportId){setReportError("Only the current claimant with Task write access may hand over this Report.");return;}
    if(!checkCurrentReportDraft()) return;
    if(reportLiveWork.current.dirty || !sameReportDraft(reportLiveWork.current.draft,reportDraft)) return;
    const owner=reserveReportMutation(reportPrincipal!.id);if(!owner)return;
    setReportSaving(true); setReportError("");
    const generation=owner.generation;
    try {
      const scope=reportStorageKey!;
      const evidence=[scope,`${scope}:draft`,`${scope}:preserved`,`${scope}:restore`].map(key=>sessionStorage.getItem(key));
      const assertEvidence=()=>{
        assertReportMutation(owner);
        if([scope,`${scope}:draft`,`${scope}:preserved`,`${scope}:restore`].some((key,index)=>sessionStorage.getItem(key)!==evidence[index])
          || evidence[0]!==null || evidence[3]!==null || latestRequestedReportId.current && latestRequestedReportId.current!==reportDraft.reportId)
          throw new Error("Saved evidence changed before handover. All versions remain preserved; recheck before continuing.");
      };
      const currentDraft=evidence[1]===null ? null : validateStoredReportDraft(JSON.parse(evidence[1]));
      const currentPreserved=validatePreservedReportDrafts(evidence[2]);
      if(!currentDraft || currentDraft.dirty || !sameReportDraft(currentDraft.draft,reportDraft)
        || JSON.stringify(currentPreserved)!==JSON.stringify(preservedReportDrafts))
        throw new Error("Saved evidence changed before handover. Recheck before continuing.");
      assertEvidence();await checkReportIdentity(owner);assertEvidence();
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: reportDraft.reportId, handover: `Report filed: ${reportDraft.reportId}` }),
      });
      const data = await readEnvelope(response);assertEvidence();
      if (!response.ok) throw new Error(data.error || "The Task could not be handed over.");
      await checkReportIdentity(owner);assertEvidence();
      await refreshTask();
    } catch (error) { if(generation===reportGeneration.current)setReportError(error instanceof Error ? error.message : "The Task could not be handed over."); }
    finally { if(reportMutation.current===owner)setReportSaving(false);releaseReportMutation(owner); }
  };

  const reportsQuery = useQuery({
    queryKey: ['task-reports', task.id, reportPrincipal?.id],
    queryFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/reports?taskId=${encodeURIComponent(task.id)}`);
      const data = await readEnvelope(response);
      if (!response.ok) throw new TaskDetailRequestError(response.status, data.error || data.message || 'Reports could not be loaded.');
      return (data.reports || []) as TaskReport[];
    },
  });
  const setEditor = (id: string | null) => { setActiveEditor(id); onEditingChange(Boolean(id)); };
  const parsed = parseTaskDetailSections(task.description || '');
  const nativeReviewsQuery = useNativeReviews(task.id);
  const latestDecision = latestTaskReviewDecision(task.reviewHistory, nativeReviewsQuery.data);

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
    if (!task.ownerControl && nextStatus === 'completed') { path = `${positionalRoot}/approve`; method = 'POST'; body = {}; }
    else if (!task.ownerControl && currentStatus === 'review' && nextStatus === 'empty') { path = `${positionalRoot}/reject`; method = 'POST'; body = { note: details?.reviewNote }; }
    else if (!task.ownerControl && nextStatus === 'skipped') { path = `${positionalRoot}/skip`; method = 'POST'; body = {}; }
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
    notes: <EditableSection id="notes" heading="Notes" value={task.notes || ''} activeEditor={activeEditor} updatedElsewhere={updatedElsewhere} onBegin={setEditor} onEnd={() => setEditor(null)} onSave={notes => saveTask({ notes })}><p className="task-detail-advisory" role="note">Use Notes for task-specific operational guidance. Put hard limits in Constraints. Advisory only — accountability comes from History.</p>{task.notes ? <div className="task-detail-markdown" dangerouslySetInnerHTML={{ __html: renderTaskMarkdown(task.notes) }} /> : <EmptySection heading="No Notes" description="No advisory Notes are stored." />}</EditableSection>,
    'verifier-settings': <section className="task-detail-content-section" aria-labelledby="task-detail-verifier-heading"><h2 id="task-detail-verifier-heading">Verifier settings</h2><TaskSuccessCriteria task={task} onSaved={refreshTask} /><p>Latest decision: {nativeReviewsQuery.isPending ? 'Checking native verification…' : nativeReviewsQuery.isError ? 'Unavailable; native verification could not be read' : latestDecision} · Attempts: {task.attemptCount ?? 0} / {task.maxRetries ?? 3}</p><Link replace className="task-detail-inline-link" to={{ search: '?filter=handover', hash: '#task-detail-timeline' }} onClick={onViewReviewEvents}>View review events in Timeline</Link></section>,
    subtasks: <section className="task-detail-content-section" aria-labelledby="task-detail-subtasks-heading"><h2 id="task-detail-subtasks-heading">Subtasks</h2>{task.subtasks?.length ? <SubtaskList subtasks={task.subtasks} ownerControl={task.ownerControl} onStatusChange={transitionSubtask} onEditText={renameSubtask} /> : <EmptySection description="This Task has no Subtasks." />}
      <form className="task-detail-inline-add" aria-busy={savingSubtasks} onSubmit={event => { event.preventDefault(); void addSubtask(); }}><label className="sr-only" htmlFor="task-detail-subtask-add">Add a subtask</label><input className="form-input" id="task-detail-subtask-add" placeholder="Add a subtask" value={subtaskDraft} disabled={savingSubtasks} onChange={event => setSubtaskDraft(event.target.value)} /><Button type="submit" variant="secondary" size="compact" disabled={savingSubtasks || !subtaskDraft.trim()}>{savingSubtasks ? 'Adding subtask…' : 'Add subtask'}</Button></form>
      <span className="sr-only" role="status">{savingSubtasks ? 'Saving subtask changes' : ''}</span>
      {subtaskEditError ? <p className="task-detail-inline-error" role="alert">{subtaskEditError}</p> : null}</section>,
    'reports-handovers': <section className="task-detail-content-section" aria-labelledby="task-detail-reports-heading"><h2 id="task-detail-reports-heading">Reports &amp; handovers</h2>{canMaintainReport && !reportRecoveryBlocked ? <form onSubmit={event => { event.preventDefault(); void saveProgressReport(); }}><p>Save your progress Report while assigned to this Task. Handing the Task over freezes editing.</p><label>Continue a progress Report<Select disabled={Boolean(pendingReport) || reportSaving || reportMutationBusy || canonicalMismatch} value={reportDraft.reportId} onChange={event => { if(reportMutation.current)return; if(reportDirty){setReportError('Report switch refused: keep your draft before switching.');return;} const search=new URLSearchParams(location.search); if(event.target.value)search.set('report',event.target.value);else search.delete('report');navigateReport({search:search.toString()},{replace:true}); const row = editableReports?.find(report => report.id === event.target.value); setReportDirty(false); setReportDraft(row ? { title: row.title, content: row.content, reportId: row.id, expectedContentHash: row.content_hash } : { title: '', content: '', reportId: '', expectedContentHash: '' }); }}><option value="">New Report</option>{editableReports?.map(report => <option key={report.id} value={report.id}>{report.title}</option>)}</Select></label><label>Report title<input disabled={Boolean(pendingReport) || reportSaving || reportMutationBusy || canonicalMismatch} value={reportDraft.title} onChange={event => editReportWork("title",event.target.value)} required /></label><label>Progress<textarea disabled={Boolean(pendingReport) || reportSaving || reportMutationBusy || canonicalMismatch} value={reportDraft.content} onChange={event => editReportWork("content",event.target.value)} required /></label><Button type="submit" disabled={reportSaving || reportMutationBusy || !reportStorageKey || canonicalMismatch}>{pendingReport?'Reconcile Task Report save':'Save Task Report'}</Button>{reportDraft.reportId ? <><Link to={`/reports/${reportDraft.reportId}`}>Open saved Report</Link><Button type="button" disabled={reportSaving || reportMutationBusy || reportDirty || Boolean(pendingReport) || canonicalMismatch} onClick={() => void handOverProgressReport()}>Hand over saved Report for review</Button></> : null}</form> : task.status === 'in-progress' ? <p>Only the current claimant with Task write access can maintain progress Reports.</p> : reportPathGuidance(task) ? <p role="status">{reportPathGuidance(task)}</p> : null}{reportRestore && reportRestore.swap.scope===`relayhall-task-report:${window.location.origin}:${reportRestore.principalId}:${task.id}` ? <section aria-label="Interrupted Report restoration">
      <ReadableReportVersion name="Version being restored" draft={validateStoredReportDraft(JSON.parse(reportRestore.swap.afterDraft)).draft} />
      {[...validatePreservedReportDrafts(reportRestore.swap.beforePreserved), ...(reportRestore.swap.beforeDraft ? [validateStoredReportDraft(JSON.parse(reportRestore.swap.beforeDraft))] : [])].map((item,index)=><ReadableReportVersion key={index} name={`Version kept before restoration ${index+1}`} draft={item.draft} />)}
      <p>All versions stay preserved until restoration finishes. No Report is sent automatically.</p>
      <Button variant="secondary" disabled={reportMutationBusy || choosingRecovery || !canChooseRecovery} onClick={()=>void finishReportRestore()}>Finish interrupted restoration</Button>
    </section> : null}
    {requestedReportId && (preservedReportDrafts.length>0 || reportRestore) ? <Button variant="secondary" disabled={reportMutationBusy || choosingRecovery} onClick={()=>{if(reportMutation.current)return;const search=new URLSearchParams(location.search);search.delete("report");setRestoreNotice("");navigateReport({pathname:location.pathname,search:search.toString(),hash:location.hash},{replace:true});}}>Open Task without Report selection</Button> : null}
    {task.status === "in-progress" && reportRecoveryBlocked ? <div role="alert"><p>{restoreNotice || reportError || REPORT_STORAGE_RECOVERY}</p>{reportRecoveryConflict?.taskId === task.id ? <div><p>Report recovery conflict: there are different versions of your work. When a choice is available, choose which to continue; other drafts are kept in this browser tab and can be restored after reload. Choosing does not send a save.</p>
          <ReadableReportVersion name="Work from this page" draft={reportRecoveryConflict.live?.draft} />
          <ReadableReportVersion name="Saved draft from this tab" draft={reportRecoveryConflict.saved.draft?.draft} />
          {reportRecoveryConflict.saved.pending ? <ReadableReportVersion name="Uncertain save awaiting a check" draft={pendingReportDraft(reportRecoveryConflict.saved.pending)} /> : null}
          {reportRecoveryConflict.live?.pending && (!reportRecoveryConflict.saved.pending || JSON.stringify(reportRecoveryConflict.live.pending)!==JSON.stringify(reportRecoveryConflict.saved.pending))
            ? <p>Two different uncertain saves need help from support. Neither save can safely be replaced here. Keep this page open; do not start another save.</p>
            : reportRecoveryConflict.saved.pending
              ? <Button type="button" disabled={reportMutationBusy || choosingRecovery || !canChooseRecovery} onClick={()=>void chooseRecoveryVersion("pending")}>Continue uncertain save; keep other drafts</Button>
              : <><Button type="button" disabled={reportMutationBusy || choosingRecovery || !canChooseRecovery} onClick={()=>void chooseRecoveryVersion("memory")}>Continue work from this page; keep saved draft</Button><Button type="button" disabled={reportMutationBusy || choosingRecovery || !canChooseRecovery || !reportRecoveryConflict.saved.draft} onClick={()=>void chooseRecoveryVersion("saved")}>Continue saved draft; keep page work</Button></>}
          <Button type="button" disabled={copyingRecovery} onClick={()=>void copyRecoveryEvidence()}>Copy both versions for support</Button>
          <details><summary>Technical evidence for support</summary><label>In-memory Report recovery evidence<textarea readOnly value={reportRecoveryConflict.memory} /></label><label>Repaired Report storage evidence<textarea readOnly value={reportRecoveryConflict.repaired} /></label></details></div> : null}<Button type="button" disabled={reportMutationBusy} onClick={() => { if(reportMutation.current)return; explicitReportRecovery.current = true; setIdentityRefresh(value => value + 1); }}>Recheck preserved Report storage</Button></div> : task.status === 'in-progress' && (restoreNotice || reportError) ? <p role="alert">{restoreNotice || reportError}</p> : null}{canMaintainReport && !reportRecoveryBlocked && preservedReportDrafts.length ? <section aria-label="Preserved Report drafts"><p>Other versions are kept only in this browser tab, for this sign-in and Task. Closing the tab ends this recovery copy. Restore a version to continue it; the current draft will be preserved in its place.</p>{preservedReportDrafts.map((version,index)=><div key={index}><ReadableReportVersion name={`Preserved version ${index+1}`} draft={version.draft}/><Button type="button" disabled={reportMutationBusy || choosingRecovery || reportSaving || Boolean(pendingReport)} onClick={()=>void chooseRecoveryVersion(index)}>Restore preserved version {index+1}</Button></div>)}</section> : null}{reportsQuery.isLoading ? <p role="status">Loading Reports…</p> : reportsQuery.error ? <div role="alert">{reportsQuery.error instanceof Error ? reportsQuery.error.message : 'Reports could not be loaded.'} <Button variant="secondary" size="compact" onClick={() => void reportsQuery.refetch()}>Retry</Button></div> : reportsQuery.data?.length ? <ul className="task-detail-report-list">{reportsQuery.data.map(report => <li key={report.id}><h3><Link to={`/reports/${report.id}`}>{report.title}</Link></h3><p>{report.author_actor_name || 'Unattributed'} · <DateValue value={report.updated_at || report.updated} /></p>{report.summary ? <BoardTextQuote>{report.summary}</BoardTextQuote> : null}{report.handover ? <dl>{Object.entries(report.handover).map(([label, value]) => <div key={label}><dt>{label.replace(/_/g, ' ')}</dt><dd><HandoverBoardText value={value} /></dd></div>)}</dl> : null}</li>)}</ul> : <EmptySection heading="No Reports or handovers" description="No Reports or handovers are linked to this Task." />}</section>,
  };
  return <>{taskDetailSectionsFor('content').map(descriptor => <div key={descriptor.id}>{descriptor.render(task, { sections })}</div>)}</>;
}

function TimelineRegion({ task }: { task: Task }) {
  const { directory } = usePrincipalDirectory();
  // E387(1): the implementation-session and native-verification panels share
  // one disclosure under the Timeline title. It is closed by default in every
  // status, Review included, so the events lead the panel; "Request native
  // verification" stays one click away inside it and every query still runs.
  const sections: Record<string, ReactNode> = { 'timeline-rail': <><details className="task-timeline-runs"><summary>Sessions and verification</summary><NativeExecutionPanel taskId={task.id}/><NativeReviewPanel taskId={task.id} verifierPrincipalId={task.verifierPrincipalId} status={task.status} /></details><TaskTimeline taskId={task.id} directory={directory} /></> };
  return <>{taskDetailSectionsFor('timeline').map(descriptor => <div key={descriptor.id}>{descriptor.render(task, { sections })}</div>)}</>;
}

// E387(3): the Timeline column can be dragged wider or narrower, or expanded
// to the full layout width. The width is a per-viewer convenience kept only in
// this browser; it is never sent to the server.
const TIMELINE_WIDTH_KEY = 'relayhall.taskDetail.timelineWidth';
const TIMELINE_MIN_WIDTH = 280;
const TIMELINE_DEFAULT_WIDTH = 384; // 24rem, the stylesheet default
const TIMELINE_READING_RESERVE = 320; // dragging never narrows Work below this
const TIMELINE_RAIL_FALLBACK = 280;
const TIMELINE_KEY_STEP = 16;

function readStoredTimelineWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(TIMELINE_WIDTH_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value >= TIMELINE_MIN_WIDTH && value <= 10000 ? Math.round(value) : null;
  } catch { return null; }
}

function storeTimelineWidth(width: number) {
  try { window.localStorage.setItem(TIMELINE_WIDTH_KEY, String(width)); } catch { /* browser storage is optional */ }
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
  const toast = useOptionalToast();
  const { subscribe } = useWebSocket();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const timelinePanelRef = useRef<HTMLElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const timelineDragRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  const [timelineWidth, setTimelineWidth] = useState<number | null>(() => readStoredTimelineWidth());
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [, setLayoutMeasure] = useState(0);
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
  const taskQuery = useQuery({
    queryKey: ['task-detail', taskId],
    queryFn: () => fetchTaskDetail(taskId),
    enabled: validTaskId,
    retry: (failureCount, error) => !isTaskReadRefusal(error) && failureCount < 3,
  });
  // A background refetch keeps its previous data in React Query. Current read
  // authority must take precedence over that cached content and activity.
  const taskReadRefused = isTaskReadRefusal(taskQuery.error);

  const claimMutation = useMutation({
    mutationFn: async () => {
      const epoch = taskQuery.data?.lifecycleAccess?.claim.expectedAssignmentEpoch;
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/claim`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(epoch ? {expectedAssignmentEpoch: epoch} : {}),
      });
      const data = await readEnvelope(response);
      if (!response.ok || !data.success) throw new TaskDetailRequestError(response.status, data.error || 'Claim was refused. Read the current assignment and try again.');
      return data as { task: Task; claim?: { outcome?: string } };
    },
    // Card 3fc32dd1: a claim is announced either way. A 200 says which way the
    // caller is the Assignee; a refusal says why, beside the inline alert.
    onSuccess: ({ task: claimed, claim }) => {
      queryClient.setQueryData<Task>(['task-detail', taskId], current => ({ ...current, ...claimed } as Task));
      if (claim?.outcome === 'already_assignee') toast?.showInfo(ALREADY_ASSIGNEE_NOTICE);
      else toast?.showSuccess(claimed?.status === 'in-progress' ? CLAIMED_NOTICE : CLAIMED_NOTICE + CLAIMED_NEXT_STEP);
    },
    onError: error => toast?.showError(`Claim refused: ${error instanceof Error ? error.message : 'read the current assignment and try again.'}`),
    onSettled: () => {void queryClient.invalidateQueries({queryKey: ['task-detail', taskId]});},
  });
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
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['task-detail', taskId] }); },
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
    if (taskReadRefused) {
      document.title = `Task details · ${config.displayName}`;
      return;
    }
    if (!taskQuery.data) return;
    document.title = `${taskQuery.data.title} · Task details · ${config.displayName}`;
    titleRef.current?.focus();
  }, [taskQuery.data?.id, taskReadRefused, config.displayName]);



  useEffect(() => {
    if (!editorOpen) setUpdatedElsewhere(false);
  }, [editorOpen]);

  // The resize clamp reads the rendered layout: re-measure once the Task has
  // rendered and whenever the window changes size.
  useEffect(() => {
    const measure = () => {
      setLayoutMeasure(value => value + 1);
      // Expand exists only from 1280px; below it the expanded state ends, so a
      // window widened again starts from the three columns.
      if (window.matchMedia?.('(max-width: 1279px)').matches) setTimelineExpanded(false);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [taskQuery.data?.id]);

  useEffect(() => subscribe('task.updated', (message: { task?: Task }) => {
    if (message.task?.id !== taskId) return;
    if (editorOpen) setUpdatedElsewhere(true);
    void queryClient.invalidateQueries({ queryKey: ['task-detail', taskId] });
  }), [subscribe, taskId, editorOpen, queryClient]);

  useEffect(() => {
    if (!editorOpen || taskReadRefused) return;
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
  }, [editorOpen, taskReadRefused]);

  if (!validTaskId) return <Navigate to={`/tasks?focus=${encodeURIComponent(taskId)}`} replace />;
  if (taskQuery.isLoading) return <div className="task-detail-skeleton" role="status" aria-label="Loading Task details"><span className="sr-only">Loading Task details…</span><div aria-hidden="true" /><div aria-hidden="true" /><div aria-hidden="true" /></div>;
  if (taskReadRefused || !taskQuery.data) return <TaskDetailState error={taskQuery.error} onRetry={() => void taskQuery.refetch()} />;

  const task = taskQuery.data;
  const armDecision = task.autoStart ? task.lifecycleAccess?.park : task.lifecycleAccess?.arm;
  const claimDecision = task.lifecycleAccess?.claim;
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
  const saveTask = async (updates: Partial<Task>) => { await updateMutation.mutateAsync(updates); };
  const layoutWidth = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
  const railWidth = railRef.current?.getBoundingClientRect().width || TIMELINE_RAIL_FALLBACK;
  // The default width is always reachable, even where the reserve would cap
  // the drag below it (a 1280px window beside the app sidebar).
  const timelineMaxWidth = Math.max(TIMELINE_DEFAULT_WIDTH, Math.round(layoutWidth - railWidth - TIMELINE_READING_RESERVE));
  const clampTimelineWidth = (value: number) => Math.min(timelineMaxWidth, Math.max(TIMELINE_MIN_WIDTH, Math.round(value)));
  const currentTimelineWidth = clampTimelineWidth(timelineWidth ?? TIMELINE_DEFAULT_WIDTH);
  const resizeTimeline = (value: number, remember: boolean) => {
    const next = clampTimelineWidth(value);
    setTimelineWidth(next);
    if (remember) storeTimelineWidth(next);
  };
  const pageStyle = timelineWidth === null ? undefined : { '--task-detail-timeline-width': `${currentTimelineWidth}px` } as CSSProperties;

  return (
    <ContextPreview kind="task" elementId={task.id} elementName={task.title}>
    <div className={`task-detail-page task-detail-page--view${timelineExpanded ? ' task-detail-page--timeline-expanded' : ''}`} style={pageStyle}>
      <a className="task-detail-skip" href={`${route}#task-detail-work`}>Skip to Task work</a>
      <header className="task-detail-page-header" aria-label="Task identity and actions">
        <Link className="task-detail-back" to={boardReturnPath}><ChevronLeft size={16} aria-hidden="true" /> Tasks</Link>
        <div className="task-detail-heading">{titleEditing ? <><h1 className="sr-only">{task.title}</h1><div className="task-detail-title-editor">
          <label htmlFor="task-detail-title-input" className="sr-only">Title</label>
          <input id="task-detail-title-input" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} />
          <Button variant="secondary" disabled={!titleDraft.trim() || updateMutation.isPending} onClick={() => void updateMutation.mutateAsync({ title: titleDraft.trim() }).then(() => setTitleEditing(false))}>Save title</Button>
          <Button variant="secondary" disabled={updateMutation.isPending} onClick={() => setTitleEditing(false)}>Cancel title edit</Button>
        </div></> : <EditableFrame label="title" onEdit={() => { setTitleDraft(task.title); setTitleEditing(true); }}><h1 ref={titleRef} tabIndex={-1} title={task.title}>{task.title}</h1></EditableFrame>}
          <Button variant="secondary" size="compact" className="task-detail-id" onClick={() => void navigator.clipboard?.writeText(task.id)}>{task.id.slice(0, 8)} <Copy size={16} aria-hidden="true" /><span className="sr-only">Copy Task ID</span></Button>
        </div>
        {/* E388: three clusters - State | Lifecycle | Utilities - with the
            Arm/Claim reason on its own caption line under the row. */}
        <div className="task-detail-page-header-controls">
          <div className="task-detail-header-cluster">
            <label>Status<StatusSelect value={task.status as TaskStatus} disabled={updateMutation.isPending} onChange={status => updateMutation.mutate({ status })} /></label>
            <label>Priority<PrioritySelect value={task.priority as TaskPriority} disabled={updateMutation.isPending} onChange={priority => updateMutation.mutate({ priority })} /></label>
            <TaskDetailActivity task={task} />
          </div>
          <div className="task-detail-header-cluster">
            <Button variant="secondary" disabled={updateMutation.isPending || !armDecision?.allowed} ariaDescribedBy={armDecision?.allowed ? undefined : 'task-arm-authority'} onClick={() => updateMutation.mutate({ autoStart: !task.autoStart })}>{task.autoStart ? 'Park' : 'Arm'}</Button>
            <Button variant="secondary" disabled={claimMutation.isPending || !claimDecision?.allowed} ariaDescribedBy={claimDecision?.allowed ? undefined : 'task-claim-authority'} onClick={() => claimMutation.mutate()}>Claim Task</Button>
          </div>
          <div className="task-detail-header-cluster task-detail-header-cluster--utilities">
            <button type="button" className="task-detail-timeline-toggle" aria-label="Go to Timeline" aria-controls="task-detail-timeline" onClick={() => { timelinePanelRef.current?.focus(); timelinePanelRef.current?.scrollIntoView({ block: 'nearest' }); }}><PanelRight size={20} aria-hidden="true" /> Timeline</button>
            <Button variant="secondary" icon={<Copy size={16} aria-hidden="true" />} onClick={() => void navigator.clipboard?.writeText(window.location.href)}>Copy link</Button>
            <ContextPreviewTrigger size="standard" />
            <div className="task-detail-actions"><IconButton size="standard" ariaLabel="More Task actions" ariaExpanded={actionsOpen} icon={<MoreHorizontal size={20} aria-hidden="true" />} onClick={() => setActionsOpen(value => !value)} />
              {actionsOpen ? <div className="task-detail-actions-menu" role="menu">
                {task.status === 'archived'
                  ? <button type="button" role="menuitem" disabled={unarchiveMutation.isPending} onClick={() => { unarchiveMutation.mutate(); setActionsOpen(false); }}>Unarchive</button>
                  : <button type="button" role="menuitem" onClick={() => { if (window.confirm(`Archive “${task.title}”? The Task leaves the active board but remains in Archived.`)) { updateMutation.mutate({ status: 'archived' }); setActionsOpen(false); } }}>Archive</button>}
                <button type="button" role="menuitem" className="task-detail-danger" onClick={() => { if (window.confirm(`Delete “${task.title}” permanently? This removes the Task and cannot be undone.`)) { deleteMutation.mutate(); setActionsOpen(false); } }}>Delete</button>
              </div> : null}
            </div>
          </div>
          {!armDecision?.allowed && <span id="task-arm-authority" role="status" className="task-detail-header-caption">{ARM_ACCESS_REASONS[armDecision?.reason ?? ''] ?? UNKNOWN_ARM_ACCESS}</span>}
          {!claimDecision?.allowed && <span id="task-claim-authority" role="status" className="task-detail-header-caption">{CLAIM_ACCESS_REASONS[claimDecision?.reason ?? ''] ?? UNKNOWN_CLAIM_ACCESS}</span>}
          {claimMutation.error instanceof Error && <span role="alert" className="task-detail-header-caption">{claimMutation.error.message}</span>}
        </div>
        {mutationError ? <p className="task-detail-inline-error" role="alert">{mutationError}</p> : null}
        {operationFeedback ? <p className="task-detail-inline-warning" role="status">{operationFeedback}</p> : null}
      </header>
      <ContextPreviewPanel />
      <TaskRegionNavigation route={route} />
      <div ref={layoutRef} className="task-detail-layout">
        <aside ref={railRef} id="task-detail-panel-details" tabIndex={0} role="complementary" className="task-detail-left-rail" aria-labelledby="task-detail-details-heading"><h2 id="task-detail-details-heading">Details</h2><LeftRail task={task} update={(updates, onSuccess) => updateMutation.mutate(updates, { onSuccess })} onEditingChange={setRailEditorOpen} dueRefusal={dueRefusal} onDueEdited={() => { if (updateMutation.error) updateMutation.reset(); }} /></aside>
        <div id="task-detail-work" tabIndex={0} role="region" className="task-detail-work" aria-labelledby="task-detail-work-heading"><div id="task-detail-panel-work"><h2 id="task-detail-work-heading" className="sr-only">Work</h2><ContentRegion task={task} updatedElsewhere={updatedElsewhere} onEditingChange={setContentEditorOpen} saveTask={saveTask} refreshTask={async () => { await queryClient.invalidateQueries({ queryKey: ['task-detail', taskId] }); }} onViewReviewEvents={() => { timelinePanelRef.current?.focus(); timelinePanelRef.current?.scrollIntoView({ block: 'nearest' }); }} /></div></div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Timeline"
          aria-controls="task-detail-timeline"
          aria-valuenow={currentTimelineWidth}
          aria-valuemin={TIMELINE_MIN_WIDTH}
          aria-valuemax={timelineMaxWidth}
          tabIndex={0}
          className="task-detail-timeline-resizer"
          onKeyDown={event => {
            const next = event.key === 'ArrowLeft' ? currentTimelineWidth + TIMELINE_KEY_STEP
              : event.key === 'ArrowRight' ? currentTimelineWidth - TIMELINE_KEY_STEP
                : event.key === 'Home' ? TIMELINE_MIN_WIDTH
                  : event.key === 'End' ? timelineMaxWidth : null;
            if (next === null) return;
            event.preventDefault();
            resizeTimeline(next, true);
          }}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            timelineDragRef.current = { startX: event.clientX, startWidth: currentTimelineWidth, pointerId: event.pointerId };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={event => {
            const drag = timelineDragRef.current;
            if (drag) resizeTimeline(drag.startWidth + (drag.startX - event.clientX), false);
          }}
          onPointerUp={event => {
            const drag = timelineDragRef.current;
            if (!drag) return;
            timelineDragRef.current = null;
            event.currentTarget.releasePointerCapture?.(drag.pointerId);
            resizeTimeline(drag.startWidth + (drag.startX - event.clientX), true);
          }}
          onPointerCancel={() => {
            if (!timelineDragRef.current) return;
            timelineDragRef.current = null;
            storeTimelineWidth(currentTimelineWidth);
          }}
        />
        <aside ref={timelinePanelRef} id="task-detail-timeline" tabIndex={0} className="task-detail-timeline" aria-labelledby="task-detail-timeline-heading" onKeyDown={event => { if (event.key === 'Escape' && timelineExpanded) setTimelineExpanded(false); }}><div id="task-detail-panel-timeline"><div className="task-detail-timeline-title"><h2 id="task-detail-timeline-heading">Timeline</h2><IconButton
          className="task-detail-timeline-expand"
          variant="ghost"
          ariaLabel={timelineExpanded ? 'Restore Timeline width' : 'Expand Timeline to full width'}
          ariaPressed={timelineExpanded}
          icon={timelineExpanded ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
          onClick={() => setTimelineExpanded(value => !value)}
        /></div><TimelineRegion task={task} /></div></aside>
      </div>
    </div>
    </ContextPreview>
  );
}
