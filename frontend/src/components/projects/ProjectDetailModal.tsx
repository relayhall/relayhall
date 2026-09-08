import { authenticatedFetch } from '../../utils/auth';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Clock, CheckCircle2, Circle, Cpu, Calendar, Globe, Plus, AlertTriangle, Lightbulb, Archive, Play, Clipboard, ScrollText, ArchiveRestore, GraduationCap, Search, BookOpen, Boxes, KeyRound, RefreshCw, Compass } from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMyPrincipal } from '../../hooks/usePrincipals';
import { EditableFrame, TASK_PRIORITY_OPTIONS } from '../tasks/taskFieldEditors';
import { Button } from '../Button';
import { IconButton } from '../ui/IconButton';
import { Select } from '../ui/Select';

import { ProjectResources } from './ProjectResources';
import { ConfirmationModal } from '../ConfirmationModal';
import { Project } from '../../types/project';
import { Skill, ProjectSkillLink } from '../../types/skill';
import { Task } from '../../types/task';
import './ProjectDetailModal.css';
import { isIntentionalAbort } from '../../utils/fetchAbort';
import { formatDate as formatShortDate, formatDateTime } from '../../utils/dateFormat';

interface AgentHistoryRecord {
  name: string;
  label: string;
  sessionKey: string;
  model?: string;
  startedAt: string;
  taskId: string;
  taskTitle?: string;
  completedAt?: string;
  outcome?: 'completed' | 'stuck' | 'error';
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

interface ProjectDetailModalProps {
  project: Project;
  onClose: () => void;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

type SectionKey = 'overview' | 'work' | 'resources' | 'records' | 'access';

export const ProjectDetailModal: React.FC<ProjectDetailModalProps> = ({ project, onClose }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<AgentHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<SectionKey>('overview');
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', description: '', priority: 'normal' as string });
  const navigate = useNavigate();
  const { scopes: blueprintScopes } = useMyPrincipal();
  const mayUseBlueprint = !!blueprintScopes && (blueprintScopes.includes('blueprints:use') || blueprintScopes.includes('*'));
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);
  const [toast, setToast] = useState<string | null>(null);
  const [briefModal, setBriefModal] = useState<{ brief: string; taskTitle: string } | null>(null);
  const [briefLoading, setBriefLoading] = useState<string | null>(null);
  const [resourceCount, setResourceCount] = useState<number | null>(null);

  // Archive/Status state. currentProject is the live snapshot this modal
  // mutates against — its revision is the If-Match token for every project
  // mutation, and it is replaced by the record each mutation returns.
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [currentProject, setCurrentProject] = useState<Project>(project);
  // 412 REVISION_MISMATCH notice: the project changed since it was loaded.
  const [projectConflict, setProjectConflict] = useState(false);
  const [reloadingProject, setReloadingProject] = useState(false);

  const currentProjectStatus = currentProject.status;
  const isHidden = !!currentProject.is_hidden;
  const isArchived = currentProjectStatus === 'archived';

  // Access & capabilities: read-only view of governed skill assignments
  const [projectSkills, setProjectSkills] = useState<ProjectSkillLink[]>([]);
  const [projectSkillsLoading, setProjectSkillsLoading] = useState(false);
  const [projectSkillsLoaded, setProjectSkillsLoaded] = useState(false);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [changingSkillPin, setChangingSkillPin] = useState<string | null>(null);

  // Description editing state
  const [editingDescription, setEditingDescription] = useState(false);
  // Project goal (RH-P2.4): the outcome statement an orchestrator reads to
  // understand what it is building. Edited exactly like the description —
  // same revision guard, same 412 conflict path.
  const [editingGoal, setEditingGoal] = useState(false);
  const [editedGoal, setEditedGoal] = useState(project.goal || '');
  const [savingGoal, setSavingGoal] = useState(false);
  const [editedDescription, setEditedDescription] = useState(project.description || '');
  const [savingDescription, setSavingDescription] = useState(false);

  // Records: reports state
  const [projectReports, setProjectReports] = useState<Array<{
    id: string; title: string; summary: string | null; tags: string[];
    pinned: boolean; created_at: string; updated_at: string;
  }>>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsLoaded, setReportsLoaded] = useState(false);

  const fetchProjectReports = useCallback(async () => {
    if (reportsLoaded) return;
    setReportsLoading(true);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/reports?project_id=${project.id}&limit=50`);
      if (res.ok) {
        const data = await res.json();
        setProjectReports(data.reports || []);
      }
    } catch (e) {
      if (!isIntentionalAbort(e)) console.error('Failed to fetch project reports:', e);
    } finally {
      setReportsLoading(false);
      setReportsLoaded(true);
    }
  }, [project.id, reportsLoaded]);

  // Compute stats from actual task data instead of SQL-based project.stats
  const computedStats = React.useMemo(() => {
    if (tasks.length === 0 && loading) return project.stats; // fallback while loading
    const total_tasks = tasks.length;
    const completed_tasks = tasks.filter(t => t.status === 'completed').length;
    const in_progress_tasks = tasks.filter(t => t.status === 'in-progress').length;
    const active_agents = new Set(tasks.filter(t => t.activeAgent).map(t => typeof t.activeAgent === 'string' ? t.activeAgent : t.activeAgent!.name)).size;
    // Find last activity
    let last_activity: string | null = null;
    for (const t of tasks) {
      const ts = t.completedAt || t.startedAt || t.created;
      if (ts && (!last_activity || ts > last_activity)) last_activity = ts;
    }
    return { total_tasks, completed_tasks, in_progress_tasks, active_agents, last_activity };
  }, [tasks, loading, project.stats]);
  const stats = computedStats;

  useEffect(() => {
    fetchProjectTasks();
    fetchProjectSessions();
    fetchResourceCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const fetchProjectTasks = async () => {
    try {
      setLoading(true);
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks?project=${encodeURIComponent(project.name)}`);
      const data = await response.json();
      if (data.success) {
        setTasks(data.tasks || []);
      }
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error('Failed to fetch project tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchProjectSessions = async () => {
    try {
      setSessionsLoading(true);
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/sessions`);
      const data = await response.json();
      if (data.success && Array.isArray(data.sessions)) {
        setSessions(data.sessions as AgentHistoryRecord[]);
      }
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error('Failed to fetch sessions:', error);
    } finally {
      setSessionsLoading(false);
    }
  };

  // Lightweight count for the Overview relationship summary; the Resources
  // section owns the full list and keeps this in sync via onActiveCountChange.
  const fetchResourceCount = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/resources`);
      const data = await response.json();
      if (response.ok && data.success) {
        setResourceCount((data.resources || []).length);
      }
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error('Failed to fetch resource count:', error);
    }
  };

  const fetchProjectSkills = useCallback(async () => {
    if (projectSkillsLoaded) return;
    try {
      setProjectSkillsLoading(true);
      const [linkedRes, allRes] = await Promise.all([
        authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/skills`),
        authenticatedFetch(`${API_BASE_URL}/skills`),
      ]);
      const linkedData = await linkedRes.json();
      const allData = await allRes.json();
      if (linkedData.success) setProjectSkills(linkedData.skills || []);
      if (allData.success) setAllSkills(allData.skills || []);
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error('Failed to fetch project skills:', error);
    } finally {
      setProjectSkillsLoading(false);
      setProjectSkillsLoaded(true);
    }
  }, [project.id, projectSkillsLoaded]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const refreshProjectSkills = useCallback(async () => {
    setProjectSkillsLoaded(false);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/skills`);
      const data = await response.json();
      if (response.ok && data.success) setProjectSkills(data.skills || []);
    } finally {
      setProjectSkillsLoaded(true);
    }
  }, [project.id]);

  const pinPublishedSkill = useCallback(async (skill: Skill) => {
    if (!skill.current_published_version_id || isArchived) return;
    setChangingSkillPin(skill.id);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/skills/${skill.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: skill.current_published_version_id }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to pin Skill Version');
      await refreshProjectSkills();
      showToast(`${skill.name} pinned to its current published Version`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unable to pin Skill Version');
    } finally { setChangingSkillPin(null); }
  }, [isArchived, project.id, refreshProjectSkills, showToast]);

  const removeSkillPin = useCallback(async (link: ProjectSkillLink) => {
    if (isArchived) return;
    setChangingSkillPin(link.skill_id);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/skills/${link.skill_id}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to remove Skill pin');
      await refreshProjectSkills();
      showToast(`${link.skill.name} pin removed`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unable to remove Skill pin');
    } finally { setChangingSkillPin(null); }
  }, [isArchived, project.id, refreshProjectSkills, showToast]);

  const handleCreateTask = async () => {
    if (!newTask.title.trim()) return;
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTask.title,
          description: newTask.description,
          priority: newTask.priority,
          project: project.name,
          status: 'todo'
        })
      });
      const data = await response.json();
      if (data.success) {
        setTasks([data.task, ...tasks]);
        setNewTask({ title: '', description: '', priority: 'normal' });
        setShowCreateTask(false);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied to clipboard!`);
    } catch {
      showToast('Failed to copy');
    }
  }, [showToast]);

  const handleGenerateBrief = useCallback(async (taskId: string, taskTitle: string) => {
    setBriefLoading(taskId);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
      const data = await res.json();
      if (data.success) {
        setBriefModal({ brief: data.brief, taskTitle });
      } else {
        showToast('Failed to generate brief');
      }
    } catch {
      showToast('Failed to generate brief');
    } finally {
      setBriefLoading(null);
    }
  }, [project.id, showToast]);

  // Reload the latest project record after a 412 conflict. Keeps an
  // in-progress description draft so the owner can re-apply and save again
  // against the fresh revision.
  const reloadProject = useCallback(async () => {
    setReloadingProject(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`);
      const data = await response.json();
      if (response.ok && data.success && data.project) {
        setCurrentProject(data.project);
        setEditedDescription(prev => (editingDescription ? prev : (data.project.description || '')));
        setProjectConflict(false);
      } else {
        showToast(data.message || data.error || 'Failed to reload the project');
      }
    } catch (error) {
      if (!isIntentionalAbort(error)) console.error('Failed to reload project:', error);
      showToast('Failed to reload the project. Check your connection and try again.');
    } finally {
      setReloadingProject(false);
    }
  }, [project.id, editingDescription, showToast]);

  const handleSecretToggle = useCallback(async () => {
    const newHidden = !isHidden;
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': currentProject.revision },
        body: JSON.stringify({ is_hidden: newHidden })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setCurrentProject(prev => data.project || { ...prev, is_hidden: newHidden });
        showToast(newHidden ? 'Project marked as secret' : 'Project is now visible');
      } else if (response.status === 412) {
        setProjectConflict(true);
      } else {
        showToast(data.message || data.error || 'Failed to toggle secret status');
      }
    } catch (error) {
      console.error('Failed to toggle secret status:', error);
      showToast('Failed to toggle secret status');
    }
  }, [project.id, currentProject.revision, isHidden, showToast]);

  // Archive and restore are dedicated endpoints, never PATCHes of status:
  // PATCH rejects status 'archived' and rejects any patch of an archived
  // project. Both endpoints are revision-bound via If-Match.
  const handleArchiveToggle = useCallback(async () => {
    const endpoint = isArchived ? 'unarchive' : 'archive';
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/${endpoint}`, {
        method: 'POST',
        headers: { 'If-Match': currentProject.revision }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setCurrentProject(prev => data.project || { ...prev, status: isArchived ? 'active' : 'archived' });
        showToast(`Project ${isArchived ? 'restored' : 'archived'} successfully`);
        setShowArchiveConfirm(false);
        setTimeout(() => onClose(), 1000);
      } else if (response.status === 412) {
        setShowArchiveConfirm(false);
        setProjectConflict(true);
      } else {
        // Includes 409 PROJECT_NAME_CONFLICT when restoring into a taken name.
        setShowArchiveConfirm(false);
        showToast(data.message || data.error || `Failed to ${isArchived ? 'restore' : 'archive'} project`);
      }
    } catch (error) {
      console.error('Failed to update project status:', error);
      setShowArchiveConfirm(false);
      showToast(`Failed to ${isArchived ? 'restore' : 'archive'} project`);
    }
  }, [project.id, currentProject.revision, isArchived, showToast, onClose]);

  const handleSaveDescription = useCallback(async () => {
    setSavingDescription(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': currentProject.revision },
        body: JSON.stringify({ description: editedDescription })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setCurrentProject(prev => data.project || { ...prev, description: editedDescription });
        setEditingDescription(false);
        showToast('Description updated');
      } else if (response.status === 412) {
        // Keep the editor open so the draft survives the reload.
        setProjectConflict(true);
      } else {
        showToast(data.message || data.error || 'Failed to update description');
      }
    } catch (error) {
      console.error('Failed to update description:', error);
      showToast('Failed to update description');
    } finally {
      setSavingDescription(false);
    }
  }, [project.id, currentProject.revision, editedDescription, showToast]);

  const handleSaveGoal = useCallback(async () => {
    setSavingGoal(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': currentProject.revision },
        body: JSON.stringify({ goal: editedGoal.trim() === '' ? null : editedGoal })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setCurrentProject(prev => data.project || { ...prev, goal: editedGoal });
        setEditingGoal(false);
        showToast('Project goal updated');
      } else if (response.status === 412) {
        setProjectConflict(true);
      } else {
        showToast(data.message || data.error || 'Failed to update the project goal');
      }
    } catch (error) {
      console.error('Failed to update the project goal:', error);
      showToast('Failed to update the project goal');
    } finally {
      setSavingGoal(false);
    }
  }, [project.id, currentProject.revision, editedGoal, showToast]);

  const handleCancelGoal = useCallback(() => {
    setEditedGoal(currentProject.goal || '');
    setEditingGoal(false);
  }, [currentProject.goal]);

  const handleCancelDescription = useCallback(() => {
    setEditedDescription(currentProject.description || '');
    setEditingDescription(false);
  }, [currentProject.description]);

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'active': return 'status-active';
      case 'archived': return 'status-archived';
      default: return 'status-active';
    }
  };

  const getTaskStatusColor = (status: string): string => {
    switch (status) {
      case 'completed': return 'var(--status-success-strong)';
      case 'in-progress': return 'var(--status-warning)';
      case 'review': return 'var(--accent-hover)';
      case 'stuck': return 'var(--status-danger-strong)';
      case 'todo': return 'var(--status-info)';
      case 'ideas': return 'var(--accent-color)';
      case 'archived': return 'var(--text-quaternary)';
      default: return 'var(--text-quaternary)';
    }
  };

  const getTaskStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 size={16} />;
      case 'in-progress': return <Play size={16} />;
      case 'review': return <Search size={16} />;
      case 'stuck': return <AlertTriangle size={16} />;
      case 'todo': return <Circle size={16} />;
      case 'ideas': return <Lightbulb size={16} />;
      case 'archived': return <Archive size={16} />;
      default: return <Circle size={16} />;
    }
  };

  // Was hardcoded 'en-US' while line ~1058 of this same file hardcoded
   // 'en-GB' -- two spellings of one instant inside one component.
  const formatDate = (dateString: string): string => formatDateTime(dateString);

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return '<1s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSec = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainSec}s`;
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return `${hours}h ${remainMin}m`;
  };

  const formatTokens = (tokens: number): string => {
    if (tokens === 0) return '—';
    if (tokens < 1000) return String(tokens);
    return `${(tokens / 1000).toFixed(1)}k`;
  };

  const getOutcomeClass = (outcome?: string): string => {
    switch (outcome) {
      case 'completed': return 'outcome-completed';
      case 'stuck': return 'outcome-stuck';
      case 'error': return 'outcome-error';
      default: return 'outcome-running';
    }
  };

  const progressPercent = stats && stats.total_tasks > 0
    ? Math.round((stats.completed_tasks / stats.total_tasks) * 100)
    : 0;

  // Compute task breakdown by status
  const taskBreakdown = tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const statusOrder = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived'];

  const sectionButton = (key: SectionKey, label: React.ReactNode, onOpen?: () => void) => (
    <Button
      variant="secondary"
      size="compact"
      className={`tab ${activeSection === key ? 'tab--active' : ''}`}
      ariaPressed={activeSection === key}
      onClick={() => { setActiveSection(key); if (onOpen) onOpen(); }}
    >
      {label}
    </Button>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="project-detail-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-detail-modal-title"
      >
        {/* Header */}
        <div className="project-detail-header project-detail-modal-project-detail-header">
          <div className="project-detail-title">
            <h2 id="project-detail-modal-title">{project.name}</h2>
            <div className="project-detail-status-controls">
              {isArchived ? (
                <span className="project-archived-badge">
                  <Archive size={16} aria-hidden="true" /> Archived
                </span>
              ) : (
                <>
                  {/* active·archived is the whole subset (A11.1); archiving is
                      the dedicated Archive action, so the status is a badge. */}
                  <span
                    className={`project-status-select ${getStatusColor(currentProjectStatus)}`}
                    aria-label="Project status"
                  >
                    Active
                  </span>
                  <Button
                    variant="secondary"
                    size="compact"
                    className={`btn-secret-toggle ${isHidden ? 'is-secret' : ''}`}
                    onClick={handleSecretToggle}
                    ariaPressed={isHidden}
                    title={isHidden ? 'Remove secret status' : 'Mark as secret project'}
                  >
                    {isHidden ? 'Secret' : 'Visible'}
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="project-detail-actions">
            <Button
              variant="secondary"
              size="compact"
              className={`btn-archive ${isArchived ? 'btn-restore' : ''}`}
              onClick={() => setShowArchiveConfirm(true)}
              title={isArchived ? 'Restore project' : 'Archive project'}
              icon={isArchived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            >
              {isArchived ? 'Restore' : 'Archive'}
            </Button>
            <IconButton
              icon={<X size={24} />}
              ariaLabel="Close"
              variant="ghost"
              size="compact"
              className="modal-close"
              onClick={onClose}
            />
          </div>
        </div>

        {isArchived && (
          <div className="project-archived-banner" role="note">
            <Archive size={16} aria-hidden="true" />
            This project is archived. Everything below is a read-only historical view — restore the project to make changes.
          </div>
        )}

        {projectConflict && (
          <div className="project-conflict-notice" role="alert" data-testid="project-conflict">
            <AlertTriangle size={16} aria-hidden="true" />
            <div className="project-conflict-body">
              <p>This project changed since it was loaded. Your change was not applied.</p>
              <Button
                variant="secondary"
                size="compact"
                className="btn-project-reload"
                onClick={reloadProject}
                disabled={reloadingProject}
                icon={<RefreshCw size={16} aria-hidden="true" />}
              >
                {reloadingProject ? 'Reloading...' : 'Reload latest version'}
              </Button>
            </div>
          </div>
        )}

        {/* Description */}
        <div className="project-detail-description-wrapper">
          {editingDescription && !isArchived ? (
            <div className="project-description-edit">
              <textarea
                value={editedDescription}
                onChange={(e) => setEditedDescription(e.target.value)}
                className="project-description-textarea"
                placeholder="Add a description for this project..."
                rows={3}
                autoFocus
              />
              <div className="project-description-actions">
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={handleCancelDescription}
                  className="btn-description-cancel"
                  disabled={savingDescription}
                >
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={handleSaveDescription}
                  className="btn-description-save"
                  disabled={savingDescription}
                >
                  {savingDescription ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="project-description-display">
              {currentProject.description ? (
                !isArchived ? (
                  <EditableFrame label="description" onEdit={() => setEditingDescription(true)}>
                    <div className="project-detail-description">{currentProject.description}</div>
                  </EditableFrame>
                ) : (
                  <div className="project-detail-description">{currentProject.description}</div>
                )
              ) : !isArchived ? (
                <EditableFrame label="description" onEdit={() => setEditingDescription(true)}>
                  <span className="project-detail-description-empty-line">Add description...</span>
                </EditableFrame>
              ) : (
                <div className="project-detail-description">No description</div>
              )}
            </div>
          )}
        </div>

        {/* Project goal (RH-P2.4). A property, never an object: it sits on the
            project you are already looking at, beside the description. */}
        <div className="project-detail-goal-wrapper">
          {editingGoal && !isArchived ? (
            <div className="project-goal-edit">
              <label htmlFor="project-goal-input" className="project-goal-label">Project goal</label>
              <textarea
                id="project-goal-input"
                value={editedGoal}
                onChange={(e) => setEditedGoal(e.target.value)}
                className="project-description-textarea"
                placeholder="The outcome this project exists to reach..."
                rows={2}
                autoFocus
              />
              <div className="project-description-actions">
                <Button variant="secondary" size="compact" onClick={handleCancelGoal} className="btn-description-cancel" disabled={savingGoal}>
                  Cancel
                </Button>
                <Button variant="secondary" size="compact" onClick={handleSaveGoal} className="btn-description-save" disabled={savingGoal}>
                  {savingGoal ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          ) : currentProject.goal ? (
            !isArchived ? (
              <EditableFrame label="Project goal" onEdit={() => setEditingGoal(true)}>
                <div className="project-detail-goal">
                  <span className="project-goal-label">Project goal</span>
                  <span className="project-goal-text">{currentProject.goal}</span>
                </div>
              </EditableFrame>
            ) : (
              <div className="project-detail-goal">
                <span className="project-goal-label">Project goal</span>
                <span className="project-goal-text">{currentProject.goal}</span>
              </div>
            )
          ) : !isArchived ? (
            <EditableFrame label="Project goal" onEdit={() => setEditingGoal(true)}>
              <span className="project-detail-description-empty-line">Add project goal...</span>
            </EditableFrame>
          ) : null}
        </div>

        <div>
          {mayUseBlueprint && <Button variant="secondary" size="compact" disabled={isArchived}
            onClick={() => { onClose(); navigate(`/blueprints?project=${encodeURIComponent(currentProject.id)}`); }}>
            Use a Blueprint in this Project
          </Button>}
          {mayUseBlueprint && isArchived && <p>Unarchive this Project before adding work from a Blueprint.</p>}
          {currentProject.blueprintKey && <p>
            Instantiated from <Link to={`/blueprints?blueprint=${encodeURIComponent(currentProject.blueprintKey)}`} onClick={onClose}>
              {currentProject.blueprintKey} v{currentProject.blueprintVersion}
            </Link>.
            {currentProject.instantiationId && <> <Link to={`/blueprints?blueprint=${encodeURIComponent(currentProject.blueprintKey)}&instantiation=${encodeURIComponent(currentProject.instantiationId)}`} onClick={onClose}>View instantiation ledger</Link>.</>}
            {' '}This is a provenance stamp; publishing a newer version does not update this Project.
          </p>}
        </div>

        {/* Section navigation */}
        <div className="project-detail-tabs">
          {sectionButton('overview', <>Overview</>)}
          {sectionButton('work', <>Work ({tasks.length})</>)}
          {sectionButton('resources', <><Boxes size={16} /> Resources</>)}
          {sectionButton('records', <><ScrollText size={16} /> Records</>, fetchProjectReports)}
          {sectionButton('access', <><KeyRound size={16} /> Access &amp; capabilities</>, fetchProjectSkills)}
        </div>

        {/* Content */}
        <div className="project-detail-content">
          {/* Overview */}
          {activeSection === 'overview' && (
            <div className="overview-tab">
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon stat-total"><Circle size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.total_tasks || 0}</div>
                    <div className="stat-label">Total tasks</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon stat-progress"><Clock size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.in_progress_tasks || 0}</div>
                    <div className="stat-label">In progress</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon stat-completed"><CheckCircle2 size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.completed_tasks || 0}</div>
                    <div className="stat-label">Completed</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon stat-agents"><Cpu size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.active_agents || 0}</div>
                    <div className="stat-label">Active agents</div>
                  </div>
                </div>
              </div>

              {/* Read-first: the Charter is the project's authority index and
                  has its own page (task f2735f1b). */}
              <Link to={`/projects/${project.id}/charter`} className="overview-charter-link" onClick={onClose}>
                <ScrollText size={16} aria-hidden="true" />
                <span>Charter — the project's authority index</span>
              </Link>

              {/* Phases: the grouping layer between Project and Task (RH-P2.4),
                  with its own page like the Charter. */}
              <Link to={`/projects/${project.id}/phases`} className="overview-charter-link" onClick={onClose}>
                <Compass size={16} aria-hidden="true" />
                <span>Phases — group tasks under one outcome</span>
              </Link>

              {/* State, visibility and relationships */}
              <div className="overview-facts">
                <div className="overview-fact">
                  <span className="overview-fact-label">State</span>
                  <span className="overview-fact-value">
                    {isArchived && <Archive size={16} aria-hidden="true" />} {currentProjectStatus}
                  </span>
                </div>
                <div className="overview-fact">
                  <span className="overview-fact-label">Visibility</span>
                  <span className="overview-fact-value">{isHidden ? 'Secret' : 'Visible'}</span>
                </div>
                <div className="overview-fact">
                  <span className="overview-fact-label">Tasks</span>
                  <span className="overview-fact-value">{tasks.length}</span>
                </div>
                <div className="overview-fact">
                  <span className="overview-fact-label">Agent sessions</span>
                  <span className="overview-fact-value">{sessions.length}</span>
                </div>
                <div className="overview-fact">
                  <span className="overview-fact-label">Resources</span>
                  <span className="overview-fact-value">{resourceCount === null ? '—' : resourceCount}</span>
                </div>
                <div className="overview-fact">
                  <span className="overview-fact-label">Reports</span>
                  <span className="overview-fact-value">{reportsLoaded ? projectReports.length : '—'}</span>
                </div>
              </div>

              {/* Progress bar */}
              {stats && stats.total_tasks > 0 && (
                <div className="overview-progress">
                  <div className="overview-progress-header">
                    <span className="overview-progress-label">Overall progress</span>
                    <span className="overview-progress-percent">{progressPercent}%</span>
                  </div>
                  <div className="overview-progress-bar">
                    <div className="overview-progress-fill" style={{ width: `${progressPercent}%` }} />
                  </div>
                  <div className="overview-progress-details">
                    <span>{stats.completed_tasks} of {stats.total_tasks} tasks completed</span>
                  </div>
                </div>
              )}

              {/* Task status breakdown */}
              {tasks.length > 0 && (
                <div className="task-breakdown">
                  <h3 className="breakdown-title">Task breakdown</h3>
                  <div className="breakdown-bars">
                    {statusOrder.filter(s => taskBreakdown[s]).map(status => (
                      <div key={status} className="breakdown-row">
                        <div className="breakdown-label">
                          <span className="breakdown-status-icon" style={{ color: getTaskStatusColor(status) }}>
                            {getTaskStatusIcon(status)}
                          </span>
                          <span className="breakdown-status-name">{status}</span>
                          <span className="breakdown-count">{taskBreakdown[status]}</span>
                        </div>
                        <div className="breakdown-bar-track">
                          <div
                            className="breakdown-bar-fill"
                            style={{
                              width: `${(taskBreakdown[status] / tasks.length) * 100}%`,
                              backgroundColor: getTaskStatusColor(status)
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="breakdown-stacked">
                    {statusOrder.filter(s => taskBreakdown[s]).map(status => (
                      <div
                        key={status}
                        className="breakdown-stacked-segment"
                        style={{
                          width: `${(taskBreakdown[status] / tasks.length) * 100}%`,
                          backgroundColor: getTaskStatusColor(status)
                        }}
                        title={`${status}: ${taskBreakdown[status]}`}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="project-metadata">
                <div className="metadata-item">
                  <Calendar size={16} />
                  <span>Created: {formatDate(project.created_at)}</span>
                </div>
                <div className="metadata-item">
                  <Clock size={16} />
                  <span>Updated: {formatDate(project.updated_at)}</span>
                </div>
                {stats?.last_activity && (
                  <div className="metadata-item">
                    <Cpu size={16} />
                    <span>Last activity: {formatDate(stats.last_activity)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Work: the project's Tasks */}
          {activeSection === 'work' && (
            <div className="tasks-tab">
              <div className="tasks-tab-header">
                <h3 className="tasks-tab-title">Tasks</h3>
                {!isArchived && (
                  <Button
                    variant="secondary"
                    size="compact"
                    className="btn-create-task"
                    onClick={() => setShowCreateTask(!showCreateTask)}
                    icon={<Plus size={16} />}
                  >
                    Create task
                  </Button>
                )}
              </div>

              {showCreateTask && !isArchived && (
                <div className="create-task-form">
                  <input
                    type="text"
                    placeholder="Task title"
                    value={newTask.title}
                    onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                    className="create-task-input"
                    autoFocus
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={newTask.description}
                    onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                    className="create-task-textarea"
                    rows={2}
                  />
                  <div className="create-task-actions">
                    <Select
                      value={newTask.priority}
                      onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
                      aria-label="Task priority"
                    >
                      {/* The canonical list, not a hand-written one: 'medium'
                          and 'critical' are not TaskPriority values and the
                          database rejects them, so two of the four options
                          here used to make Create fail with a 500 (found by
                          the A8 scale fixture). */}
                      {TASK_PRIORITY_OPTIONS.map(option => (
                        <option key={option} value={option}>
                          {option[0].toUpperCase() + option.slice(1)}
                        </option>
                      ))}
                    </Select>
                    <Button variant="secondary" size="compact" className="btn-save-link" onClick={handleCreateTask}>Create</Button>
                    <Button variant="secondary" size="compact" className="btn-cancel-link" onClick={() => setShowCreateTask(false)}>Cancel</Button>
                  </div>
                </div>
              )}

              {loading ? (
                <div className="tab-loading">Loading tasks...</div>
              ) : tasks.length === 0 ? (
                <div className="tab-empty">
                  <p>No tasks found for this project</p>
                  {!isArchived && <p className="tab-empty-hint">Create a task and assign it to "{project.name}"</p>}
                </div>
              ) : (
                <div className="tasks-list">
                  {tasks.map(task => (
                    <div key={task.id} className="task-item task-item-clickable" onClick={() => { onClose(); navigate(`/tasks/${task.id}`); }}>
                      <div className="task-item-header">
                        <div className="task-status-dot" style={{ backgroundColor: getTaskStatusColor(task.status) }} />
                        <h4 className="task-item-title">{task.title}</h4>
                        {!isArchived && (
                          <Button
                            variant="secondary"
                            size="compact"
                            className="btn-generate-brief"
                            title="Generate agent brief"
                            onClick={(e) => { e.stopPropagation(); handleGenerateBrief(task.id, task.title); }}
                            disabled={briefLoading === task.id}
                          >
                            {briefLoading === task.id ? 'Generating...' : 'Brief'}
                          </Button>
                        )}
                        <span className={`task-item-priority priority-${task.priority}`}>
                          {task.priority}
                        </span>
                      </div>
                      {task.description && (
                        <p className="task-item-description">{task.description}</p>
                      )}
                      <div className="task-item-meta">
                        <span className="task-item-status">{task.status}</span>
                        {task.subtasks && task.subtasks.length > 0 && (
                          <span className="task-item-subtasks">
                            {task.subtasks.filter(s => s.completed).length}/{task.subtasks.length} subtasks
                          </span>
                        )}
                        {task.tags && task.tags.length > 0 && (
                          <div className="task-item-tags">
                            {task.tags.map(tag => (
                              <span key={tag} className="task-tag">{tag}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Resources: the four typed kinds */}
          {activeSection === 'resources' && (
            <div className="resources-tab">
              <ProjectResources
                projectId={project.id}
                projectName={project.name}
                projectArchived={isArchived}
                onActiveCountChange={setResourceCount}
              />
            </div>
          )}

          {/* Records: Reports and Agent sessions */}
          {activeSection === 'records' && (
            <div className="records-tab">
              <section className="records-group records-group-reports" aria-label="Reports">
                <div className="records-group-header">
                  <h3 className="records-group-title"><BookOpen size={16} aria-hidden="true" /> Reports</h3>
                  <Link
                    to={`/reports?project=${encodeURIComponent(project.id)}`}
                    className="reports-tab-view-all"
                    onClick={onClose}
                  >
                    View all in Reports →
                  </Link>
                </div>
                {reportsLoading ? (
                  <div className="tab-loading">Loading reports...</div>
                ) : projectReports.length === 0 ? (
                  <div className="tab-empty">
                    <p>No reports linked to this project</p>
                  </div>
                ) : (
                  <div className="reports-tab-list">
                    {projectReports.map((r) => (
                      <Link
                        key={r.id}
                        to={`/reports/${r.id}`}
                        className="reports-tab-item"
                        onClick={onClose}
                      >
                        <div className="reports-tab-item-header">
                          {r.pinned && <span aria-label="Pinned"></span>}
                          <span className="reports-tab-item-title">{r.title}</span>
                          <span className="reports-tab-item-date">
                            {formatShortDate(r.created_at)}
                          </span>
                        </div>
                        {r.summary && (
                          <p className="reports-tab-item-summary">{r.summary}</p>
                        )}
                        {r.tags.length > 0 && (
                          <div className="reports-tab-item-tags">
                            {r.tags.map(t => <span key={t} className="reports-tab-item-tag">{t}</span>)}
                          </div>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </section>

              <section className="records-group records-group-agent-sessions" aria-label="Agent sessions">
                <div className="records-group-header">
                  <h3 className="records-group-title"><Cpu size={16} aria-hidden="true" /> Agent sessions</h3>
                  <span className="sessions-count">{sessions.length} agent session{sessions.length !== 1 ? 's' : ''}</span>
                </div>
                {sessionsLoading ? (
                  <div className="tab-loading">Loading agent sessions...</div>
                ) : sessions.length === 0 ? (
                  <div className="tab-empty">
                    <p>No agent sessions found for this project</p>
                    <p className="tab-empty-hint">Agent sessions appear here when tasks are worked on</p>
                  </div>
                ) : (
                  <div className="sessions-list">
                    {sessions.map((session, idx) => (
                      <div key={`${session.sessionKey}-${idx}`} className="session-item">
                        <div className="session-item-header">
                          <div className="session-name-row">
                            <span className={`session-outcome ${getOutcomeClass(session.outcome)}`}>
                              {session.outcome || 'running'}
                            </span>
                            <h4 className="session-item-name">{session.label || session.name}</h4>
                          </div>
                          {session.model && (
                            <span className="session-model">{session.model}</span>
                          )}
                        </div>

                        {session.taskTitle && (
                          <p className="session-task-title">Task: {session.taskTitle}</p>
                        )}

                        <div className="session-item-meta">
                          <span className="session-meta-item">
                            <Calendar size={16} />
                            {formatDate(session.startedAt)}
                          </span>
                          {session.durationMs && (
                            <span className="session-meta-item">
                              <Clock size={16} />
                              {formatDuration(session.durationMs)}
                            </span>
                          )}
                          {session.tokenUsage && session.tokenUsage.total > 0 && (
                            <span className="session-meta-item session-tokens">
                              <Cpu size={16} />
                              {formatTokens(session.tokenUsage.input)} in / {formatTokens(session.tokenUsage.output)} out
                            </span>
                          )}
                        </div>

                        {session.sessionKey && (
                          <div className="session-transcript-link">
                            <Button
                              variant="secondary"
                              size="compact"
                              className="transcript-link session-audit-btn"
                              icon={<ScrollText size={16} />}
                              onClick={() => navigate(`/audit?session=${encodeURIComponent(session.sessionKey)}`)}
                            >
                              View audit log
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* Access & capabilities: exact governed Version assignments */}
          {activeSection === 'access' && (
            <div className="access-tab">
              <div className="skills-tab-header">
                <div>
                  <h3 className="skills-tab-title">Access &amp; capabilities</h3>
                  <p className="skills-tab-subtitle">
                    Pin this project to exact published Skill Versions. Later edits or retirement never silently change an existing pin.
                  </p>
                </div>
              </div>

              {projectSkillsLoading ? (
                <div className="tab-loading">Loading assignments...</div>
              ) : (() => {
                const globalSkills = allSkills.filter(t => t.is_global);
                const linkedSkillIds = new Set(projectSkills.map(pt => pt.skill_id));
                const globalOnlySkills = globalSkills.filter(t => !linkedSkillIds.has(t.id));
                const availableSkills = allSkills.filter(t => t.current_published_version_id && !linkedSkillIds.has(t.id) && !t.is_global);

                if (globalOnlySkills.length === 0 && projectSkills.length === 0 && availableSkills.length === 0) {
                  return (
                    <div className="tab-empty">
                      <GraduationCap size={32} className="tab-empty-icon" />
                      <h3>No governed assignments</h3>
                      <p>Nothing is currently assigned to this project.</p>
                    </div>
                  );
                }

                return (
                  <>
                    {globalOnlySkills.length > 0 && (
                      <div className="project-skills-section">
                        <h4 className="project-skills-section-title">
                          <Globe size={16} /> Global skills <span className="skills-count">(auto-included)</span>
                        </h4>
                        <div className="project-skills-list">
                          {globalOnlySkills.map(skill => (
                            <div key={skill.id} className="project-skill-item project-skill-global">
                              <div className="project-skill-info">
                                <div className="project-skill-name">
                                  <GraduationCap size={16} />
                                  <span>{skill.name}</span>
                                  <span className="skill-badge skill-badge-global"><Globe size={16} /> Global</span>
                                  {skill.published_version && (
                                    <span className="skill-badge">Published v{skill.published_version.version}</span>
                                  )}
                                </div>
                                {skill.published_version?.category && <span className="project-skill-category">{skill.published_version.category}</span>}
                                {skill.published_version?.description && <p className="project-skill-description">{skill.published_version.description}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {projectSkills.length > 0 && (
                      <div className="project-skills-section">
                        <h4 className="project-skills-section-title">
                          <GraduationCap size={16} /> Linked skills <span className="skills-count">({projectSkills.length})</span>
                        </h4>
                        <div className="project-skills-list">
                          {projectSkills.map(pt => (
                            <div key={pt.id} className={`project-skill-item ${pt.skill.is_global ? 'project-skill-global-linked' : ''}`}>
                              <div className="project-skill-info">
                                <div className="project-skill-name">
                                  <GraduationCap size={16} />
                                  <span>{pt.skill.name}</span>
                                  {pt.skill.is_global && (
                                    <span className="skill-badge skill-badge-global"><Globe size={16} /> Global</span>
                                  )}
                                  <span className="skill-badge skill-badge-override">Exact v{pt.version.version} pin</span>
                                  {pt.version.status === 'retired' && <span className="skill-badge">Retired · pin preserved</span>}
                                </div>
                                {pt.skill.category && <span className="project-skill-category">{pt.skill.category}</span>}
                                {pt.skill.description && <p className="project-skill-description">{pt.skill.description}</p>}
                              </div>
                              {!isArchived && <Button variant="secondary" size="compact" disabled={changingSkillPin === pt.skill_id}
                                onClick={() => void removeSkillPin(pt)}>Remove pin</Button>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {availableSkills.length > 0 && (
                      <div className="project-skills-section">
                        <h4 className="project-skills-section-title"><Plus size={16} /> Available published skills</h4>
                        <div className="project-skills-list">
                          {availableSkills.map(skill => (
                            <div key={skill.id} className="project-skill-item">
                              <div className="project-skill-info">
                                <div className="project-skill-name">
                                  <GraduationCap size={16} /><span>{skill.name}</span>
                                  {skill.published_version && <span className="skill-badge">Published v{skill.published_version.version}</span>}
                                </div>
                                {skill.published_version?.description && <p className="project-skill-description">{skill.published_version.description}</p>}
                              </div>
                              {!isArchived && <Button variant="primary" size="compact" disabled={changingSkillPin === skill.id}
                                onClick={() => void pinPublishedSkill(skill)}>Pin published Version</Button>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="toast-notification">{toast}</div>
      )}

      {/* Brief modal */}
      {briefModal && (
        <div className="brief-modal-overlay project-detail-modal-brief-modal-overlay" onClick={() => setBriefModal(null)}>
          <div className="brief-modal project-detail-modal-brief-modal" onClick={(e) => e.stopPropagation()}>
            <div className="brief-modal-header">
              <h3>Agent brief: {briefModal.taskTitle}</h3>
              <div className="brief-modal-actions">
                <Button
                  variant="secondary"
                  size="compact"
                  className="btn-copy-context-inline"
                  onClick={() => copyToClipboard(briefModal.brief, 'Brief')}
                  icon={<Clipboard size={16} />}
                >
                  Copy
                </Button>
                <IconButton
                  icon={<X size={20} />}
                  ariaLabel="Close"
                  variant="ghost"
                  size="compact"
                  className="modal-close"
                  onClick={() => setBriefModal(null)}
                />
              </div>
            </div>
            <pre className="brief-content">{briefModal.brief}</pre>
          </div>
        </div>
      )}

      {/* Archive confirmation modal */}
      {showArchiveConfirm && (
        <ConfirmationModal
          title={isArchived ? 'Restore project' : 'Archive project'}
          message={
            isArchived
              ? `Are you sure you want to restore "${project.name}"? It will be moved back to active projects.`
              : `Are you sure you want to archive "${project.name}"? Archived projects are hidden from the main view but can be restored later.`
          }
          confirmLabel={isArchived ? 'Restore' : 'Archive'}
          cancelLabel="Cancel"
          onConfirm={handleArchiveToggle}
          onCancel={() => setShowArchiveConfirm(false)}
        />
      )}

    </div>
  );
};
