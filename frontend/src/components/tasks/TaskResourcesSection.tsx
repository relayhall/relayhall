import React from 'react';
import { Link as LinkIcon, File, GitBranch, ExternalLink, FileText, Bookmark } from 'lucide-react';
import { TaskResources } from '../../types/task';
import { Button } from '../Button';
import './TaskResourcesSection.css';

interface TaskResourcesSectionProps {
  resources: TaskResources;
  onRelatedTaskClick?: (taskId: string) => void;
}

const RESOURCE_LINK_ICONS: Record<string, React.ReactNode> = {
  git: <GitBranch size={16} />,
  url: <ExternalLink size={16} />,
  file: <File size={16} />,
  reference: <Bookmark size={16} />,
};

export const TaskResourcesSection: React.FC<TaskResourcesSectionProps> = ({ 
  resources, 
  onRelatedTaskClick 
}) => {
  const hasLinks = resources.links && resources.links.length > 0;
  const hasFiles = resources.files && resources.files.length > 0;
  const hasRelatedTasks = resources.relatedTasks && resources.relatedTasks.length > 0;

  if (!hasLinks && !hasFiles && !hasRelatedTasks) {
    return null;
  }

  const isExternalUrl = (url: string): boolean => {
    return url.startsWith('http://') || url.startsWith('https://');
  };

  const handleLinkClick = (e: React.MouseEvent, url: string) => {
    if (isExternalUrl(url)) {
      e.preventDefault();
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="task-resources-section">
      <h4 className="task-resources-title">
        <FileText size={16} />
        Task Resources
      </h4>

      {/* Links */}
      {hasLinks && (
        <div className="task-resources-group">
          <span className="task-resources-group-label">
            <LinkIcon size={16} /> Links ({resources.links!.length})
          </span>
          <div className="task-resources-items">
            {resources.links!.map((link, index) => (
              <a
                key={index}
                href={isExternalUrl(link.url) ? link.url : '#'}
                className="task-resource-link"
                onClick={(e) => handleLinkClick(e, link.url)}
                title={link.url}
              >
                <span className="task-resource-icon">
                  {RESOURCE_LINK_ICONS[link.type] || <LinkIcon size={16} />}
                </span>
                <span className="task-resource-link-title">{link.title}</span>
                <span className="task-resource-link-type">{link.type}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Files */}
      {hasFiles && (
        <div className="task-resources-group">
          <span className="task-resources-group-label">
            <File size={16} /> Files ({resources.files!.length})
          </span>
          <div className="task-resources-items">
            {resources.files!.map((file, index) => (
              <div key={index} className="task-resource-file">
                <File size={16} />
                <code className="task-resource-file-path">{file}</code>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Related Tasks */}
      {hasRelatedTasks && (
        <div className="task-resources-group">
          <span className="task-resources-group-label">
            <Bookmark size={16} /> Related Tasks ({resources.relatedTasks!.length})
          </span>
          <div className="task-resources-items">
            {resources.relatedTasks!.map((taskId, index) => (
              <Button
                key={index}
                variant="secondary"
                size="compact"
                className="task-resource-related-task"
                onClick={() => onRelatedTaskClick?.(taskId)}
                title={`View task ${taskId}`}
              >
                <span className="task-resource-task-id">{taskId.substring(0, 8)}...</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
