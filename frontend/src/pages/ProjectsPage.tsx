import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Folder, Lock, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Project, CreateProjectInput } from '../types/project';
import { ProjectCard } from '../components/projects/ProjectCard';
import { CreateProjectModal } from '../components/projects/CreateProjectModal';
import { ProjectDetailModal } from '../components/projects/ProjectDetailModal';
import { Button } from '../components/Button';
import { useWebSocket } from '../hooks/useWebSocket';
import './ProjectsPage.css';
import { isIntentionalAbort } from '../utils/fetchAbort';

type SortOption = 'name' | 'progress' | 'activity';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const ProjectsPage: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [filteredProjects, setFilteredProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('activity');
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string[]>(['active']);
  const [showSecretProjects, setShowSecretProjects] = useState(false);
  const { subscribe } = useWebSocket();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Real-time project updates via WebSocket
  const handleProjectCreated = useCallback((msg: { project: Project }) => {
    setProjects(prev => {
      if (prev.some(p => p.id === msg.project.id)) return prev;
      return [...prev, msg.project];
    });
  }, []);
  
  const handleProjectUpdated = useCallback((msg: { project: Project }) => {
    setProjects(prev => prev.map(p => p.id === msg.project.id ? msg.project : p));
  }, []);
  
  const handleProjectRemoved = useCallback((msg: { id: string }) => {
    setProjects(prev => prev.filter(p => p.id !== msg.id));
  }, []);
  
  useEffect(() => {
    const unsubs = [
      subscribe('project.created', handleProjectCreated),
      subscribe('project.updated', handleProjectUpdated),
      subscribe('project.archived', handleProjectRemoved),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [subscribe, handleProjectCreated, handleProjectUpdated, handleProjectRemoved]);
  
  // Load projects from API
  useEffect(() => {
    fetchProjects();
  }, []);
  
  // Auto-open project from URL query param
  useEffect(() => {
    const openProject = searchParams.get('open');
    if (openProject && projects.length > 0 && !selectedProject) {
      const match = projects.find(p => p.name === openProject || p.id === openProject);
      if (match) {
        setSelectedProject(match);
        searchParams.delete('open');
        setSearchParams(searchParams, { replace: true });
      }
    }
  }, [projects, searchParams]);
  
  const fetchProjects = async () => {
    try {
      // includeArchived: the API's default listing excludes archived projects,
      // but this page has an "archived" status filter that must show them.
      const response = await authenticatedFetch(`${API_BASE_URL}/projects?includeStats=true&includeHidden=true&includeArchived=true`);
      const data = await response.json();
      if (data.success) {
        setProjects(data.projects);
        setError(null);
      } else {
        setError(data.error || 'Failed to load projects');
      }
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to fetch projects:', err);
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };
  
  // Filter and sort projects
  useEffect(() => {
    // Include hidden projects only when Show Secret toggle is on
    let filtered = projects.filter(p => showSecretProjects ? true : !p.is_hidden);
    
    // Status filter
    if (statusFilter.length > 0) {
      filtered = filtered.filter(p => statusFilter.includes(p.status));
    }
    
    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p => 
        p.name.toLowerCase().includes(query) ||
        p.description?.toLowerCase().includes(query)
      );
    }
    
    // Sort
    filtered = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        
        case 'progress': {
          const progressA = a.stats && a.stats.total_tasks > 0
            ? a.stats.completed_tasks / a.stats.total_tasks
            : 0;
          const progressB = b.stats && b.stats.total_tasks > 0
            ? b.stats.completed_tasks / b.stats.total_tasks
            : 0;
          return progressB - progressA;
        }
        
        case 'activity': {
          const dateA = a.stats?.last_activity || a.updated_at;
          const dateB = b.stats?.last_activity || b.updated_at;
          return new Date(dateB).getTime() - new Date(dateA).getTime();
        }
        
        default:
          return 0;
      }
    });
    
    setFilteredProjects(filtered);
  }, [projects, searchQuery, sortBy, statusFilter, showSecretProjects]);
  
  const handleCreateProject = async (projectData: CreateProjectInput) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectData)
      });
      const data = await response.json();
      if (data.success) {
        setProjects([...projects, data.project]);
        setShowCreateModal(false);
      }
    } catch (error) {
      console.error('Failed to create project:', error);
    }
  };
  
  const handleProjectClick = (projectId: string) => {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      setSelectedProject(project);
    }
  };
  
  const handleViewTasks = (projectName: string) => {
    // Navigate to tasks page with project filter
    navigate(`/tasks?project=${encodeURIComponent(projectName)}`);
  };
  
  const toggleStatusFilter = (status: string) => {
    setStatusFilter(prev => 
      prev.includes(status)
        ? prev.filter(s => s !== status)
        : [...prev, status]
    );
  };
  
  if (loading) {
    return (
      <div className="page-loading">
        <div className="loading-spinner projects-page-loading-spinner" />
        <span>Loading projects...</span>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="projects-page-loading">
        <div className="error-message"><AlertTriangle size={16} aria-hidden="true" /> {error}</div>
        <button className="retry-btn projects-page-retry-btn" onClick={() => { setLoading(true); setError(null); fetchProjects(); }}>
          Retry
        </button>
      </div>
    );
  }
  
  return (
    <div className="projects-page fade-in">
      {/* Header */}
      <div className="projects-page-header">
        <div className="projects-page-header-title">
          <h1><Folder size={16} aria-hidden="true" /> Projects</h1>
          <p>
            {filteredProjects.length} project{filteredProjects.length !== 1 ? 's' : ''}
            {searchQuery && ` matching "${searchQuery}"`}
          </p>
        </div>
        
        <div className="projects-page-header-actions">
          <Button
            onClick={() => setShowCreateModal(true)}
            variant="primary"
            icon={<Plus size={16} />}
          >
            New Project
          </Button>
        </div>
      </div>
      
      {/* Filters & Search */}
      <div className="projects-page-controls">
        <div className="projects-search projects-page-projects-search">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>
        
        <div className="projects-sort projects-page-projects-sort">
          <label htmlFor="sort-select">Sort by:</label>
          <select
            id="sort-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="sort-select"
          >
            <option value="activity">Last activity</option>
            <option value="name">Name</option>
            <option value="progress">Progress</option>
          </select>
        </div>
        
        <button
          className={`filter-toggle projects-page-filter-toggle ${showFilters ? 'filter-toggle--active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          <SlidersHorizontal size={16} />
          Filters
        </button>
      </div>
      
      {/* Filter Panel */}
      {showFilters && (
        <div className="projects-filters">
          <div className="filter-group">
            <label>Status:</label>
            <div className="filter-options">
              {['active', 'archived'].map(status => (
                <button
                  key={status}
                  className={`filter-option projects-page-filter-option ${statusFilter.includes(status) ? 'filter-option--active' : ''}`}
                  onClick={() => toggleStatusFilter(status)}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <label>Secret:</label>
            <div className="filter-options">
              <button
                className={`filter-option projects-page-filter-option filter-secret ${showSecretProjects ? 'filter-option--active' : ''}`}
                onClick={() => setShowSecretProjects(!showSecretProjects)}
              >
                <Lock size={16} aria-hidden="true" /> Show Secret
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Projects Grid */}
      {filteredProjects.length === 0 ? (
        <div className="projects-empty">
          <p>No projects found</p>
          {searchQuery && <p className="empty-hint">Try adjusting your search or filters</p>}
          {!searchQuery && projects.length === 0 && (
            <Button
              onClick={() => setShowCreateModal(true)}
              variant="primary"
              icon={<Plus size={16} />}
            >
              Create Your First Project
            </Button>
          )}
        </div>
      ) : (
        <div className="projects-grid projects-page-projects-grid">
          {filteredProjects.map(project => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => handleProjectClick(project.id)}
              onViewTasks={handleViewTasks}
            />
          ))}
        </div>
      )}
      
      {/* Create Modal */}
      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateProject}
        />
      )}
      
      {/* Detail Modal */}
      {selectedProject && (
        <ProjectDetailModal
          project={selectedProject}
          onClose={() => {
            setSelectedProject(null);
            fetchProjects(); // Refresh in case status/hidden changed
          }}
        />
      )}
    </div>
  );
};
