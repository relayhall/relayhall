import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Search, Star, Plus, X } from 'lucide-react';
import { PersonalitySummary, PERSONALITY_COLORS, formatPersonalitySource, getPersonalityColor } from '../types/personality';
import { authenticatedFetch } from '../utils/auth';
import { Button } from '../components/Button';
import './PersonalitiesPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const EMPTY_DRAFT = { slug: '', name: '', description: '', category: 'custom', color: 'blue', content: '' };

export const PersonalitiesPage: React.FC = () => {
  const navigate = useNavigate();
  const [personalities, setPersonalities] = useState<PersonalitySummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const fetchPersonalities = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (categoryFilter) params.set('category', categoryFilter);
      const query = params.toString();
      const response = await authenticatedFetch(`${API_BASE_URL}/personalities${query ? `?${query}` : ''}`);
      const data = await response.json();
      if (data.success) {
        setPersonalities(data.personalities || []);
        setCategories(data.categories || []);
      } else {
        setError(data.error || 'Failed to fetch personalities');
      }
    } catch (err) {
      setError('Failed to connect to API');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter]);

  useEffect(() => {
    fetchPersonalities();
  }, [fetchPersonalities]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/personalities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setCreateError(data.error || 'Failed to create personality');
        return;
      }
      setDraft(EMPTY_DRAFT);
      setShowCreate(false);
      await fetchPersonalities();
    } catch {
      setCreateError('Failed to connect to the RelayHall API');
    } finally {
      setCreating(false);
    }
  };

  const closeCreate = () => {
    setShowCreate(false);
    setCreateError(null);
  };

  const filtered = personalities.filter(at => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return at.name.toLowerCase().includes(q) ||
      (at.description || '').toLowerCase().includes(q) ||
      (at.category || '').toLowerCase().includes(q);
  });

  const filtersActive = Boolean(searchQuery || categoryFilter);

  const grouped = filtered.reduce<Record<string, PersonalitySummary[]>>((acc, at) => {
    const cat = at.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(at);
    return acc;
  }, {});

  return (
    <div className="personalities-page">
      <div className="personalities-header">
        <div className="personalities-title">
          <Bot size={24} />
          <h1>Personalities</h1>
          <span className="personalities-count">{personalities.length} personalities</span>
        </div>
        <div className="personalities-actions">
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => setShowCreate(value => !value)}
          >
            New personality
          </Button>
        </div>
      </div>

      {showCreate && (
        <form className="personalities-editor" onSubmit={handleCreate} aria-busy={creating}>
          <div className="personalities-editor-grid">
            <div className="form-group">
              <label htmlFor="personality-create-name">Name</label>
              <input
                id="personality-create-name"
                className="form-input"
                type="text"
                required
                placeholder="Backend Architect"
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="personality-create-slug">Slug</label>
              <input
                id="personality-create-slug"
                className="form-input"
                type="text"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="backend-architect"
                title="Kebab-case: lowercase letters, digits and single hyphens"
                value={draft.slug}
                onChange={e => setDraft({ ...draft, slug: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="personality-create-category">Category</label>
              <input
                id="personality-create-category"
                className="form-input"
                type="text"
                list="personality-category-options"
                placeholder="custom"
                value={draft.category}
                onChange={e => setDraft({ ...draft, category: e.target.value })}
              />
              <datalist id="personality-category-options">
                {categories.map(cat => (
                  <option key={cat} value={cat} />
                ))}
              </datalist>
            </div>
            <div className="form-group">
              <label htmlFor="personality-create-color">Color</label>
              <select
                id="personality-create-color"
                className="form-select"
                value={draft.color}
                onChange={e => setDraft({ ...draft, color: e.target.value })}
              >
                {Object.keys(PERSONALITY_COLORS).map(color => (
                  <option key={color} value={color}>{color}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="personality-create-description">Description</label>
            <textarea
              id="personality-create-description"
              className="form-textarea"
              rows={2}
              placeholder="One line on when to assign this personality"
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="personality-create-content">Instructions (Markdown)</label>
            <textarea
              id="personality-create-content"
              className="form-textarea form-textarea-lg form-textarea-mono"
              placeholder="# Mission&#10;Review the task, constraints, and evidence before proposing changes."
              value={draft.content}
              onChange={e => setDraft({ ...draft, content: e.target.value })}
            />
          </div>
          {createError && <div className="personalities-error" role="alert">{createError}</div>}
          <div className="form-actions">
            <button type="button" className="btn-cancel" onClick={closeCreate}>Cancel</button>
            <button type="submit" className="btn-save" disabled={creating}>
              {creating ? 'Creating…' : 'Create personality'}
            </button>
          </div>
        </form>
      )}

      <div className="personalities-filters">
        <div className="personalities-search-box">
          <Search size={16} />
          <input
            type="text"
            placeholder="Search personalities..."
            aria-label="Search personalities"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="personalities-search-clear"
              aria-label="Clear search"
              onClick={() => setSearchQuery('')}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="form-select personalities-category-filter"
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {error && <div className="personalities-error" role="alert">{error}</div>}

      {loading ? (
        <div className="personalities-loading">
          <div className="loading-spinner" />
          Loading personalities...
        </div>
      ) : filtered.length === 0 ? (
        filtersActive && personalities.length > 0 ? (
          <div className="personalities-empty">
            <Bot size={40} />
            <p>No personalities match the current filters</p>
            <button
              type="button"
              className="btn-cancel"
              onClick={() => { setSearchQuery(''); setCategoryFilter(''); }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="personalities-empty">
            <Bot size={40} />
            <p>No personalities found</p>
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setShowCreate(true)}>
              Create personality
            </Button>
          </div>
        )
      ) : (
        <div className="personalities-groups">
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([category, types]) => (
            <div key={category} className="personality-category">
              <h2 className="category-heading">
                {category}
                <span className="category-count">{types.length}</span>
              </h2>
              <div className="personality-grid">
                {types.map(at => (
                  <button
                    key={at.id}
                    type="button"
                    className="personality-card"
                    onClick={() => navigate(`/personalities/${at.id}`)}
                    style={{ '--personality-color': getPersonalityColor(at.color) } as React.CSSProperties}
                  >
                    <div className="personality-card-accent" />
                    <div className="personality-card-body">
                      <div className="personality-card-header">
                        <span className="personality-card-name">{at.name}</span>
                        <span className="personality-card-source">{formatPersonalitySource(at.source)}</span>
                        {at.is_custom && (
                          <span className="personality-card-custom" title="Custom personality">
                            <Star size={16} />
                          </span>
                        )}
                      </div>
                      {at.description && (
                        <p className="personality-card-desc">{at.description}</p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
