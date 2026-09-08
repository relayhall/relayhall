import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Task, TaskDueAtWrite, TaskExecutionProfile, TaskPriority, TaskStatus, TaskWritePayload } from '../types/task';
import { Button } from '../components/Button';
import ExecutionProfileEditor from '../components/tasks/ExecutionProfileEditor';
import AccessVehiclePicker from '../components/tasks/AccessVehiclePicker';
import { authenticatedFetch } from '../utils/auth';
import { taskDetailSectionsFor } from '../components/tasks/taskDetailSectionRegistry';
import { PhaseSelect } from '../components/tasks/PhaseSelect';
import { PersonalitySummary } from '../types/personality';
import { DueAtInput, ModelInput, PersonalitySelect, PrioritySelect, ProjectSelect, StatusSelect, TASK_STATUS_OPTIONS, TagsInput, TaskSectionShell, ThinkingSelect, parseTagsInput } from '../components/tasks/taskFieldEditors';
import './TaskDetailPage.css';
import './TaskCreatePage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * Routed Task creation (design 986be411 §7, owner ruling E6 — the declared
 * amendment to spec 3cdf6e65 §3.7): `/tasks/new` mounts the Task-details
 * design language in CREATE mode. The SAME section registry orders the
 * content and rail; absent sections (Timeline, Reports, People, Relations,
 * Dates, Advanced, Verifier settings) simply do not render — the registry
 * returns null for section ids the mode does not provide. The structured
 * Definition-of-done and Constraints fields are CANONICAL: create posts them
 * as fields; the markdown-parsing path is never the write path.
 *
 * Tasks are created PARKED: arming is an explicit act on the details page
 * the creator lands on (strategy §2.6 direction; the modal-era autoStart
 * checkbox retires with the modal).
 */
// The option vocabularies and every field control are the SHARED editors —
// one source of truth with edit mode (taskFieldEditors).

const parseMultilineList = (value: string): string[] =>
  value.split('\n').map(line => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean);

interface DraftSubtask { id: string; text: string; completed: boolean; status: 'empty'; }
interface DraftLink { title: string; url: string; type: string; }

/* Census A11 (RH-UI.20): no decorative pencils. On the create page every
   field is directly editable, so the corner pencil - which estate-wide
   means "activate to edit" (amendment 2d5e2caa Ruling 1) - would be a
   false affordance here. Sections render plain. */
function CreateSection({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <TaskSectionShell id={id} heading={heading}>
      {children}
    </TaskSectionShell>
  );
}

export function TaskCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Board context pre-fill (§7): the filtered board hands its project/phase/
  // status context through the query string.
  const validStatus = (value: string | null): TaskStatus =>
    TASK_STATUS_OPTIONS.some(status => status.value === value && status.value !== 'archived') ? (value as TaskStatus) : 'todo';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [definitionOfDone, setDefinitionOfDone] = useState('');
  const [constraints, setConstraints] = useState('');
  const [status, setStatus] = useState<TaskStatus>(() => validStatus(searchParams.get('status')));
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [projectName, setProjectName] = useState(() => searchParams.get('project') ?? '');
  const [phaseId, setPhaseId] = useState(() => searchParams.get('phaseId') ?? '');
  const [tags, setTags] = useState('');
  // Card 7d38a6e0. null is the ordinary state: most Tasks have no deadline.
  // The value is what will be SENT — a wall clock with its zone once the
  // person picks one — not an instant this page derived; see taskFieldEditors.
  const [dueAt, setDueAt] = useState<TaskDueAtWrite>(null);
  // The SERVER's refusal for the field, verbatim. A local wall clock inside a
  // spring-forward hour names no instant, and only a real timezone database
  // can say so; the interface shows what it was told, on the field, and will
  // not re-post the same value until the person changes it.
  const [dueRefusal, setDueRefusal] = useState<string | null>(null);
  const [personalityId, setPersonalityId] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [executionProfile, setExecutionProfile] = useState<TaskExecutionProfile | null>(null);
  // RH-P3.AZ-S7 (ruling 7440b579 R2/R5): the chosen access vehicle. null is
  // a real choice — it takes the auto-grant fallback, never zero access.
  const [executionWarrantId, setExecutionWarrantId] = useState<string | null>(null);
  const [subtasks, setSubtasks] = useState<DraftSubtask[]>([]);
  const [newSubtask, setNewSubtask] = useState('');
  const [links, setLinks] = useState<DraftLink[]>([]);
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Dirty derives from a snapshot of the INITIAL form state (query prefills
  // included) across EVERY editable value AND the in-progress inline drafts
  // (review 26176eb3 B1): a priority-only change or an untyped-but-unsaved
  // subtask draft is user-entered state and must never be discarded silently.
  const initialSnapshotRef = useRef<string | null>(null);
  const formSnapshot = JSON.stringify({
    title, description, definitionOfDone, constraints, status, priority,
    projectName, phaseId, tags, personalityId, model, thinking,
    executionProfile, subtasks, links, blockedReason,
    // Round-1 review F6: `dueAt` is an editable value like any other, and
    // leaving it out of the snapshot meant a form whose ONLY change was a
    // deadline read as clean and was discarded by the navigation guards
    // without a word. The comment above says EVERY editable value; this is it.
    dueAt,
    newSubtask, newLinkTitle, newLinkUrl,
  });
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = formSnapshot;
  const dirty = formSnapshot !== initialSnapshotRef.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => { titleRef.current?.focus(); }, []);

  // The same three-way guard edit mode uses (TaskDetailPage): beforeunload,
  // capture-phase link clicks, and browser-history traversal.
  const guardedHistoryIndexRef = useRef<number | null>(null);
  const restoringHistoryRef = useRef(false);
  useEffect(() => {
    guardedHistoryIndexRef.current = typeof window.history.state?.idx === 'number' ? window.history.state.idx : null;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const guardLinks = (event: MouseEvent) => {
      if (!dirtyRef.current) return;
      const link = (event.target as Element | null)?.closest('a[href]');
      if (!link || !window.confirm('Discard this unsaved Task?')) { if (link) event.preventDefault(); }
    };
    const guardHistoryTraversal = (event: PopStateEvent) => {
      if (restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        event.stopImmediatePropagation();
        return;
      }
      if (!dirtyRef.current) return;
      if (window.confirm('Discard this unsaved Task?')) return;
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
  }, []);
  useEffect(() => { document.title = 'New Task · RelayHall'; }, []);

  const projectsQuery = useQuery({
    queryKey: ['task-create-projects'],
    queryFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || 'Projects could not be loaded.');
      return (data.projects || []) as Array<{ id: string; name: string }>;
    },
  });
  const personalitiesQuery = useQuery({
    queryKey: ['task-create-personalities'],
    queryFn: async () => {
      const response = await authenticatedFetch(`${API_BASE_URL}/personalities`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || 'Personalities could not be loaded.');
      return (data.personalities || []) as PersonalitySummary[];
    },
  });
  const projects = projectsQuery.data || [];
  const personalities = personalitiesQuery.data || [];
  const currentProject = useMemo(() => projects.find(project => project.name === projectName) || null, [projects, projectName]);

  const create = async () => {
    if (!title.trim()) {
      setError('Title is required');
      titleRef.current?.focus();
      return;
    }
    if (dueRefusal) {
      setError(dueRefusal);
      return;
    }
    setSaving(true);
    setError('');
    const payload: TaskWritePayload = {
      title: title.trim(),
      description: description.trim(),
      project: projectName.trim() || undefined,
      phaseId: phaseId || undefined,
      priority,
      status,
      tags: parseTagsInput(tags),
      // F4: connector tasks carry no board-native model — descriptor options
      // are the sole execution source.
      model: executionProfile?.serviceId ? undefined : (model || undefined),
      thinking: executionProfile?.serviceId ? undefined : ((thinking || undefined) as Task['thinking']),
      ...(executionProfile ? { executionProfile } : {}),
      ...(executionProfile?.serviceId && executionWarrantId ? { executionWarrantId } : {}),
      definitionOfDone: parseMultilineList(definitionOfDone),
      constraints: parseMultilineList(constraints),
      personalityId: personalityId || undefined,
      subtasks: subtasks as unknown as Task['subtasks'],
      links: links as unknown as Task['links'],
      blockedReason: status === 'stuck' ? blockedReason.trim() : undefined,
      // Sent only when the person picked one: no deadline is the ordinary
      // state of a Task, not a value the form should supply.
      ...(dueAt ? { dueAt } : {}),
    };
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.task?.id) {
        const message = data.error || data.message || 'The Task could not be created.';
        // A refusal that names a field belongs ON that field, where a screen
        // reader announces it as an alert the input points at — not only in a
        // banner at the top of a long form. Card 7d38a6e0: this is how the
        // "that local time does not exist in Europe/Warsaw" answer arrives now
        // that the browser no longer decides the question for itself.
        // sendTaskFieldRefusal puts the field name under `details`; the
        // profile and assignment refusals beside it put it at the top level.
        // Both are read, because both are shapes this API answers with.
        if ((data.details?.field ?? data.field) === 'dueAt') {
          setDueRefusal(message);
          return;
        }
        setError(message);
        return;
      }
      navigate(`/tasks/${data.task.id}`, { state: { dueAtResolution: data.dueAtResolution } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The Task could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty && !window.confirm('Discard this unsaved Task?')) return;
    navigate('/tasks');
  };

  const contentSections: Record<string, ReactNode> = {
    description: (
      <CreateSection id="description" heading="Description">
        <label className="sr-only" htmlFor="task-create-description">Description</label>
        <textarea id="task-create-description" rows={8} value={description} placeholder="What is this Task about?" onChange={event => setDescription(event.target.value)} />
      </CreateSection>
    ),
    dod: (
      <CreateSection id="dod" heading="Definition of done">
        <label className="sr-only" htmlFor="task-create-dod">Definition of done</label>
        <textarea id="task-create-dod" rows={4} value={definitionOfDone} placeholder={'One criterion per line'} onChange={event => setDefinitionOfDone(event.target.value)} />
      </CreateSection>
    ),
    constraints: (
      <CreateSection id="constraints" heading="Constraints">
        <label className="sr-only" htmlFor="task-create-constraints">Constraints</label>
        <textarea id="task-create-constraints" rows={4} value={constraints} placeholder={'One constraint per line'} onChange={event => setConstraints(event.target.value)} />
      </CreateSection>
    ),
    subtasks: (
      <CreateSection id="subtasks" heading="Subtasks">
        {subtasks.length ? (
          <ul className="task-create-draft-list">
            {subtasks.map(subtask => (
              <li key={subtask.id}>
                <span>{subtask.text}</span>
                <Button variant="secondary" size="compact" onClick={() => setSubtasks(previous => previous.filter(item => item.id !== subtask.id))}>Remove</Button>
              </li>
            ))}
          </ul>
        ) : <p className="task-create-empty-line">No Subtasks yet.</p>}
        <div className="task-create-inline-add">
          <label className="sr-only" htmlFor="task-create-subtask">Add subtask</label>
          <input id="task-create-subtask" value={newSubtask} placeholder="Add a subtask" onChange={event => setNewSubtask(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (newSubtask.trim()) { setSubtasks(previous => [...previous, { id: `draft-${Date.now()}-${previous.length}`, text: newSubtask.trim(), completed: false, status: 'empty' as const }]); setNewSubtask(''); } } }} />
          <Button variant="secondary" size="compact" onClick={() => { if (newSubtask.trim()) { setSubtasks(previous => [...previous, { id: `draft-${Date.now()}-${previous.length}`, text: newSubtask.trim(), completed: false, status: 'empty' as const }]); setNewSubtask(''); } }}>Add subtask</Button>
        </div>
      </CreateSection>
    ),
    links: (
      <CreateSection id="links" heading="Links">
        {links.length ? (
          <ul className="task-create-draft-list">
            {links.map(link => (
              <li key={`${link.title}-${link.url}`}>
                <span>{link.title} · <code>{link.url}</code></span>
                <Button variant="secondary" size="compact" onClick={() => setLinks(previous => previous.filter(item => item !== link))}>Remove</Button>
              </li>
            ))}
          </ul>
        ) : <p className="task-create-empty-line">No Links yet.</p>}
        <div className="task-create-inline-add">
          <label className="sr-only" htmlFor="task-create-link-title">Link title</label>
          <input id="task-create-link-title" value={newLinkTitle} placeholder="Link title" onChange={event => setNewLinkTitle(event.target.value)} />
          <label className="sr-only" htmlFor="task-create-link-url">Link URL</label>
          <input id="task-create-link-url" value={newLinkUrl} placeholder="https://…" onChange={event => setNewLinkUrl(event.target.value)} />
          <Button variant="secondary" size="compact" onClick={() => { if (newLinkTitle.trim() && newLinkUrl.trim()) { setLinks(previous => [...previous, { title: newLinkTitle.trim(), url: newLinkUrl.trim(), type: 'reference' }]); setNewLinkTitle(''); setNewLinkUrl(''); } }}>Add link</Button>
        </div>
      </CreateSection>
    ),
  };

  const railSections: Record<string, ReactNode> = {
    placement: (
      <section className="task-detail-rail-group"><h3>Placement</h3>
        <div className="task-create-rail-fields">
          <label>Project
            <ProjectSelect projects={projects} value={currentProject?.id ?? ''} onChange={projectId => {
              const selected = projects.find(project => project.id === projectId);
              setProjectName(selected?.name ?? '');
              setPhaseId('');
            }} />
          </label>
          <label>Phase
            <PhaseSelect projectId={currentProject?.id || null} value={phaseId} currentPhase={null} onChange={setPhaseId} />
          </label>
          <label>Tags
            <TagsInput value={tags} onChange={setTags} />
          </label>
          {/* Card 7d38a6e0: the same control the Task page edits with, so a
              deadline set at creation and a deadline set later are one act
              with one meaning. */}
          <label>Due
            <DueAtInput
              value={typeof dueAt === 'string' ? dueAt : null}
              refusal={dueRefusal}
              onChange={next => { setDueAt(next); setDueRefusal(null); }}
            />
          </label>
        </div>
      </section>
    ),
    execution: (
      <section className="task-detail-rail-group"><h3>Execution</h3>
        <div className="task-create-rail-fields">
          <ExecutionProfileEditor value={executionProfile} onChange={setExecutionProfile} />
          <AccessVehiclePicker
            phaseId={phaseId || null}
            assigned={Boolean(executionProfile?.serviceId)}
            value={executionWarrantId}
            onChange={setExecutionWarrantId}
          />
          {!executionProfile?.serviceId && (
            <>
              <label>Personality (optional)
                <PersonalitySelect personalities={personalities} value={personalityId} onChange={setPersonalityId} />
              </label>
              <label>Model
                <ModelInput value={model} onChange={setModel} />
              </label>
              <label>Thinking
                <ThinkingSelect value={thinking} onChange={setThinking} />
              </label>
            </>
          )}
        </div>
      </section>
    ),
  };

  return (
    <div className="task-detail-page task-create-page">
      <header className="task-detail-page-header" aria-label="New Task">
        <Link className="task-detail-back" to="/tasks"><ChevronLeft size={16} aria-hidden="true" /> Tasks</Link>
        <div className="task-detail-heading">
          <h1 className="sr-only">New Task</h1>
          <div className="task-detail-title-editor">
            <label htmlFor="task-create-title" className="sr-only">Title</label>
            <input id="task-create-title" ref={titleRef} value={title} placeholder="Task title" onChange={event => setTitle(event.target.value)} />
          </div>
        </div>
        <div className="task-detail-page-header-controls">
          <label>Status<StatusSelect value={status} includeArchived={false} onChange={setStatus} /></label>
          <label>Priority<PrioritySelect value={priority} onChange={setPriority} /></label>
          <Button variant="primary" className="task-create-primary" disabled={saving || dueRefusal !== null} onClick={() => void create()}>{saving ? 'Creating…' : 'Create Task'}</Button>
          <Button variant="secondary" disabled={saving} onClick={cancel}>Cancel</Button>
        </div>
        {status === 'stuck' ? (
          <label className="task-create-blocked">Stuck reason
            <input aria-label="Stuck reason" value={blockedReason} onChange={event => setBlockedReason(event.target.value)} />
          </label>
        ) : null}
        {error ? <p className="task-detail-inline-error" role="alert">{error}</p> : null}
      </header>
      <div className="task-detail-layout" data-create-mode="true">
        <aside className="task-detail-left-rail" aria-labelledby="task-create-details-heading">
          <h2 id="task-create-details-heading" className="task-create-details-heading">Details</h2>
          {taskDetailSectionsFor('left-rail').map(descriptor => <div key={descriptor.id}>{descriptor.render({} as Task, { sections: railSections })}</div>)}
        </aside>
        <div className="task-detail-work" role="region" id="task-detail-work" aria-label="New Task content">
          {taskDetailSectionsFor('content').map(descriptor => <div key={descriptor.id}>{descriptor.render({} as Task, { sections: contentSections })}</div>)}
        </div>
      </div>
    </div>
  );
}
