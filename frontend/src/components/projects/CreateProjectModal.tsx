import React, { useState } from 'react';
import { X } from 'lucide-react';
import { CreateProjectInput, ProjectStatus } from '../../types/project';
import './CreateProjectModal.css';

interface CreateProjectModalProps {
  onClose: () => void;
  onCreate: (project: CreateProjectInput) => void;
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ onClose, onCreate }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('active');
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
      status
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
