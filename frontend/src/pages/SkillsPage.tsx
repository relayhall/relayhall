import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Search, SlidersHorizontal, GraduationCap, Globe, Tag, X } from 'lucide-react';
import { Skill } from '../types/skill';
import { SkillDetailModal } from '../components/skills/SkillDetailModal';
import { Button } from '../components/Button';
import { RequestStatus } from '../components/RequestStatus';
import './SkillsPage.css';

type ViewFilter = 'all' | 'global';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const SkillsPage: React.FC = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchSkills = useCallback(async () => {
    const request = ++requestSequence.current;
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (searchQuery) params.set('search', searchQuery);
      if (categoryFilter) params.set('category', categoryFilter);
      if (tagFilter) params.set('tag', tagFilter);
      const query = params.toString();
      const response = await authenticatedFetch(`${API_BASE_URL}/skills${query ? `?${query}` : ''}`);
      const data = await response.json();
      if (request !== requestSequence.current) return;
      if (response.ok && data.success) {
        setSkills(data.skills || []);
      } else {
        setError(data.error || 'Failed to fetch skills');
      }
    } catch (err) {
      if (request === requestSequence.current) setError('Failed to connect to API');
    } finally {
      if (request === requestSequence.current) setLoading(false);
    }
  }, [searchQuery, categoryFilter, tagFilter]);

  useEffect(() => {
    void fetchSkills();
    return () => { requestSequence.current += 1; };
  }, [fetchSkills]);

  // Derive unique categories and tags from skills
  const categories = Array.from(new Set(skills.map(t => t.category).filter(Boolean))) as string[];
  const allTags = Array.from(new Set(skills.flatMap(t => t.tags || [])));

  // Client-side filter for view toggle (global vs all)
  const displayedSkills = viewFilter === 'global' ? skills.filter(t => t.is_global) : skills;

  const handleSkillSaved = useCallback(() => {
    fetchSkills();
    setSelectedSkill(null);
    setShowCreateModal(false);
  }, [fetchSkills]);

  const handleSkillDeleted = useCallback(() => {
    fetchSkills();
    setSelectedSkill(null);
  }, [fetchSkills]);

  return (
    <div className="skills-page">
      {/* Header */}
      <div className="skills-page-header">
        <div className="skills-page-header-title">
          <h1><GraduationCap size={24} aria-hidden="true" /> Skills registry</h1>
          <p>Manage skills available to agents and projects</p>
        </div>
        <div className="skills-page-header-actions">
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            New Skill
          </Button>
        </div>
      </div>

      {/* View Toggle */}
      <div className="skills-view-toggle">
        <button
          className={`view-toggle-btn ${viewFilter === 'all' ? 'view-toggle-btn--active' : ''}`}
          onClick={() => setViewFilter('all')}
        >
          All Skills ({skills.length})
        </button>
        <button
          className={`view-toggle-btn ${viewFilter === 'global' ? 'view-toggle-btn--active' : ''}`}
          onClick={() => setViewFilter('global')}
        >
          <Globe size={16} />
          Global Skills ({skills.filter(t => t.is_global).length})
        </button>
      </div>

      {/* Controls */}
      <div className="skills-page-controls">
        <div className="skills-search">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery('')}>
              <X size={16} />
            </button>
          )}
        </div>

        <div className="skills-category-filter">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="sort-select"
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        <button
          className={`filter-toggle ${showFilters ? 'filter-toggle--active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          <SlidersHorizontal size={16} />
          Filters
        </button>
      </div>

      {/* Tag Filters */}
      {showFilters && (
        <div className="skills-filters">
          <div className="filter-group">
            <label><Tag size={16} /> Tags</label>
            <div className="filter-options">
              <button
                className={`filter-option ${tagFilter === '' ? 'filter-option--active' : ''}`}
                onClick={() => setTagFilter('')}
              >
                All
              </button>
              {allTags.map(tag => (
                <button
                  key={tag}
                  className={`filter-option ${tagFilter === tag ? 'filter-option--active' : ''}`}
                  onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <RequestStatus loading={loading} label={skills.length ? 'Updating skills…' : 'Loading skills…'} error={error} onRetry={() => void fetchSkills()} />
      {!loading && !error && displayedSkills.length === 0 ? (
        <div className="skills-empty">
          <GraduationCap size={40} />
          <p>No skills found</p>
          <p className="empty-hint">
            {searchQuery || categoryFilter || tagFilter
              ? 'Try adjusting your search or filters'
              : 'Create your first skill to get started'}
          </p>
        </div>
      ) : (
        <div className="skills-grid" role="region" aria-label="Skills" aria-busy={loading} tabIndex={0}>
          {/* The grid is the page's scroll container, so it is a focus stop
              with a name rather than content only a mouse can reach
              (axe scrollable-region-focusable, walkthrough item R14). */}
          {displayedSkills.map(skill => (
            <div
              key={skill.id}
              className="skill-card"
              role="button"
              tabIndex={0}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedSkill(skill); } }}
              onClick={() => setSelectedSkill(skill)}
            >
              <div className="skill-card-header">
                <div className="skill-card-name">
                  <GraduationCap size={16} />
                  <h2>{skill.name}</h2>
                </div>
                <div className="skill-card-badges">
                  {skill.is_global && (
                    <span className="skill-badge skill-badge-global">
                      <Globe size={16} /> Global
                    </span>
                  )}
                  {skill.version !== null && (
                    <span className="skill-badge skill-badge-version">v{skill.version} · {skill.status}</span>
                  )}
                </div>
              </div>

              {skill.category && (
                <div className="skill-card-category">{skill.category}</div>
              )}

              {skill.description && (
                <p className="skill-card-description">{skill.description}</p>
              )}

              {skill.provenance && (
                <div className="skill-card-category">{skill.provenance}</div>
              )}

              {skill.tags && skill.tags.length > 0 && (
                <div className="skill-card-tags">
                  {skill.tags.map(tag => (
                    <span key={tag} className="skill-tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Skill Detail/Edit Modal */}
      {selectedSkill && (
        <SkillDetailModal
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onSaved={handleSkillSaved}
          onDeleted={handleSkillDeleted}
        />
      )}

      {/* Create Skill Modal */}
      {showCreateModal && (
        <SkillDetailModal
          skill={null}
          onClose={() => setShowCreateModal(false)}
          onSaved={handleSkillSaved}
          onDeleted={() => {}}
        />
      )}
    </div>
  );
};
