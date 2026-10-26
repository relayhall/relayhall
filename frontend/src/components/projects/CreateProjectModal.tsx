import React, { useState } from 'react';
import { X } from 'lucide-react';
import { CreateProjectInput, OwnerGroupChoice, ProjectStatus } from '../../types/project';
import './CreateProjectModal.css';

interface CreateProjectModalProps {
  onClose: () => void;
  onCreate: (project: CreateProjectInput) => void;
  /**
   * AZ-A12 clauses 10(b) and 12: the Groups this session may make the owner.
   * Offered only to root and administrator sessions (the page decides); empty
   * or absent hides the selector, and the Project is created as before.
   */
  ownerGroups?: OwnerGroupChoice[];
  /** A refusal of the last submission, shown in the form. */
  submitError?: string | null;
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ onClose, onCreate, ownerGroups = [], submitError = null }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('active');
  const [ownerGroupId, setOwnerGroupId] = useState('');
  const [error, setError] = useState('');
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    
    onCreate({
      name: name.trim(),
      description: description.trim() || undefined,
      status,
      ...(ownerGroupId ? { ownerGroupId } : {}),
    });
  };
  
  return (
    <div className="modal-overlay create-project-modal-modal-overlay" onClick={onClose}>
      <div className="modal-content create-project-modal-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Create New Project</h2>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group create-project-modal-form-group">
            <label htmlFor="project-name">Project Name *</label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="e.g., RelayHall"
              autoFocus
              className={error ? 'input-error' : ''}
            />
            {error && <span className="create-project-modal-error-message">{error}</span>}
          </div>
          
          <div className="form-group create-project-modal-form-group">
            <label htmlFor="project-description">Description</label>
            <textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              rows={4}
            />
          </div>
          
          <div className="form-group create-project-modal-form-group">
            <label htmlFor="project-status">Status</label>
            <select
              id="project-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          
          {ownerGroups.length > 0 && (
            <div className="form-group create-project-modal-form-group">
              <label htmlFor="project-owner-group">Owner</label>
              <select
                id="project-owner-group"
                value={ownerGroupId}
                onChange={(e) => setOwnerGroupId(e.target.value)}
              >
                <option value="">You (the creator)</option>
                <optgroup label="Groups">
                  {ownerGroups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}{group.featured ? ' (featured)' : ''}</option>
                  ))}
                </optgroup>
              </select>
              {ownerGroupId && (
                <span className="create-project-modal-hint">
                  The Group will own this Project. You will be asked to confirm it is you.
                </span>
              )}
            </div>
          )}

          {submitError && <p role="alert" className="create-project-modal-error-message">{submitError}</p>}

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose} type="button">
              Cancel
            </button>
            <button className="btn btn-primary" type="submit">
              Create Project
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
