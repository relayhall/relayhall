import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ClipboardList, Folder, Inbox, Pin, Search, X } from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import './ReportsPage.css';
import { isIntentionalAbort } from '../utils/fetchAbort';
import { formatDate } from '../utils/dateFormat';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface Report {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  project_id: string | null;
  project_name?: string | null;
  task_ids: string[];
  /** Free-form label the CALLER supplied. Unverified and spoofable - never the
   * attribution (card 91599cd2). */
  author: string | null;
  /** The verified attribution: the identity the server resolved when the
   * Report was filed. Null means the Report has none. */
  author_actor_name: string | null;
  handover: ReportHandover | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

interface ReportHandover {
  schema_version: 1;
  decisions: string[];
  assumptions: string[];
  alternatives_rejected: string[];
  unresolved_questions: string[];
}

interface Project {
  id: string;
  name: string;
}

const timeAgo = (dateStr: string): string => {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
};

export const ReportsPage: React.FC = () => {
  const [reports, setReports] = useState<Report[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);

  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');
  const [activeTag, setActiveTag] = useState(searchParams.get('tag') || '');
  const [activeProject, setActiveProject] = useState(searchParams.get('project') || '');

  const navigate = useNavigate();

  // Fetch projects for the filter dropdown. Reports outlive project
  // archival, so archived projects must stay filterable here — the API's
  // default listing excludes them.
  useEffect(() => {
    authenticatedFetch(`${API_BASE_URL}/projects?includeArchived=true`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.success && data.projects) {
          setProjects(data.projects);
        }
      })
      .catch(() => {});
  }, []);

  const fetchReports = useCallback(async (offset = 0, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);

    try {
      const params = new URLSearchParams();
      params.set('limit', '10');
      params.set('offset', String(offset));
      if (searchQuery) params.set('q', searchQuery);
      if (activeTag) params.set('tags', activeTag);
      if (activeProject) params.set('project_id', activeProject);

      const response = await authenticatedFetch(`${API_BASE_URL}/reports?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data.reports) {
        // Collect all unique tags from loaded reports
        const newReports = append ? [...reports, ...data.reports] : data.reports;
        setReports(newReports);
        setTotal(data.total || 0);
        setHasMore(data.hasMore || false);

        // Build tag list from all loaded reports
        const tags = new Set<string>();
        newReports.forEach((r: Report) => r.tags?.forEach((t: string) => tags.add(t)));
        setAllTags(Array.from(tags).sort());
      }
    } catch (err) {
      if (!isIntentionalAbort(err)) console.error('Failed to fetch reports:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [searchQuery, activeTag, activeProject, reports]);

  // Initial load and when filters change
  useEffect(() => {
    fetchReports(0, false);
    // Update URL params
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (activeTag) params.set('tag', activeTag);
    if (activeProject) params.set('project', activeProject);
    setSearchParams(params, { replace: true });
  }, [searchQuery, activeTag, activeProject]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // searchQuery state change triggers useEffect above
  };

  const handleTagClick = (tag: string) => {
    setActiveTag(activeTag === tag ? '' : tag);
  };

  const clearFilters = () => {
    setSearchQuery('');
    setActiveTag('');
    setActiveProject('');
  };

  const hasActiveFilters = searchQuery || activeTag || activeProject;

  return (
    <div className="reports-page fade-in">
      <div className="reports-page-header">
        <h1><ClipboardList size={16} aria-hidden="true" /> Reports</h1>
        <span className="reports-page-count">{total} report{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Search & Filters */}
      <div className="reports-filters">
        <form className="reports-search-form" onSubmit={handleSearch}>
          <div className="reports-search-wrapper">
            <Search size={16} className="reports-search-icon" />
            <input
              type="text"
              className="reports-search-input"
              placeholder="Search reports..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="reports-search-clear"
                onClick={() => setSearchQuery('')}
              >
                <X size={16} />
              </button>
            )}
          </div>
        </form>

        <div className="reports-filter-row">
          {/* Project filter */}
          <select
            className="reports-project-filter"
            value={activeProject}
            onChange={(e) => setActiveProject(e.target.value)}
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          {/* Tag pills */}
          {allTags.length > 0 && (
            <div className="reports-tag-filters">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  className={`reports-tag-pill ${activeTag === tag ? 'reports-tag-pill--active' : ''}`}
                  onClick={() => handleTagClick(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {hasActiveFilters && (
            <button className="reports-clear-filters" onClick={clearFilters}>
              <X size={16} />
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Reports List */}
      {loading ? (
        <div className="reports-loading">
          <div className="reports-spinner" />
          <p>Loading reports...</p>
        </div>
      ) : reports.length === 0 ? (
        <div className="reports-empty">
          <span className="reports-empty-icon"><Inbox size={16} aria-hidden="true" /></span>
          <p>{hasActiveFilters ? 'No reports match your filters' : 'No reports yet'}</p>
          {hasActiveFilters && (
            <button className="reports-clear-btn" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      ) : (
        <div className="reports-list">
          {reports.map((report) => (
            <article
              key={report.id}
              className={`report-card ${report.pinned ? 'report-card-pinned' : ''}`}
              onClick={() => navigate(`/reports/${report.id}`)}
            >
              <div className="report-card-header">
                <div className="report-card-title-row">
                  {report.pinned && <span className="report-pin-icon"><Pin size={16} aria-hidden="true" /></span>}
                  <h2 className="report-card-title">{report.title}</h2>
                </div>
              </div>

              {report.summary && (
                <p className="report-card-summary">{report.summary}</p>
              )}

              {report.handover && (
                <div className="report-handover-badge">Structured handover</div>
              )}

              <div className="report-card-footer">
                <div className="report-card-tags">
                  {report.tags?.map((tag) => (
                    <span key={tag} className="report-card-tag">{tag}</span>
                  ))}
                </div>
                <div className="report-card-meta">
                  {report.project_name && (
                    <Link
                      to={`/projects?open=${encodeURIComponent(report.project_name)}`}
                      className="report-card-project report-card-project-link"
                      onClick={(e) => e.stopPropagation()}
                      title={`View project: ${report.project_name}`}
                    >
                      <Folder size={16} aria-hidden="true" /> {report.project_name}
                    </Link>
                  )}
                  <span className="report-card-author">
                    {report.author_actor_name ?? 'Unattributed'}
                  </span>
                  <time
                    className="report-card-time"
                    dateTime={report.created_at}
                    title={formatDate(report.created_at)}
                  >
                    {timeAgo(report.created_at)}
                    <span className="sr-only">, {formatDate(report.created_at)}</span>
                  </time>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Load More */}
      {hasMore && !loading && (
        <div className="reports-load-more">
          <button
            className="reports-load-more-btn"
            onClick={() => fetchReports(reports.length, true)}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <div className="reports-btn-spinner" />
                Loading...
              </>
            ) : (
              'Load More'
            )}
          </button>
        </div>
      )}
    </div>
  );
};
