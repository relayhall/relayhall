import React from 'react';
import { useNavigate } from 'react-router-dom';
import { TaskLink } from '../../types/task';
import { Brain, FileText, Folder, GitBranch, Link2, MessageSquare, Wrench } from 'lucide-react';
import './TaskLinks.css';

interface TaskLinksProps {
  links: TaskLink[];
  compact?: boolean;
}

const LINK_ICONS: Record<string, React.ReactNode> = {
  project: <Folder size={16} />,
  tool: <Wrench size={16} />,
  git: <GitBranch size={16} />,
  doc: <FileText size={16} />,
  memory: <Brain size={16} />,
  session: <MessageSquare size={16} />,
  report: <FileText size={16} />,
};

const LINK_LABELS: Record<string, string> = {
  project: 'Project',
  tool: 'Tool',
  git: 'Git',
  doc: 'Doc',
  memory: 'Memory',
  session: 'Session',
  report: 'Report',
};

function isExternalUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export const TaskLinks: React.FC<TaskLinksProps> = ({ links, compact = false }) => {
  const navigate = useNavigate();

  if (!links || links.length === 0) return null;

  const displayLinks = compact ? links.slice(0, 3) : links;

  const handleLinkClick = (e: React.MouseEvent, link: TaskLink) => {
    e.stopPropagation();
    e.preventDefault();

    if (isExternalUrl(link.url)) {
      window.open(link.url, '_blank', 'noopener,noreferrer');
      return;
    }

    const reportMatch = link.url.match(/(?:^|\/)(?:dashboard\/)?reports\/([0-9a-f-]+)$/i);
    if (link.type === 'report' || reportMatch) {
      const reportId = reportMatch?.[1] || link.url.replace(/^.*\//, '');
      navigate(`/reports/${reportId}`);
      return;
    }

    // P1.3 (F11): workspace file paths are no longer viewable from the board
    // (the /workspace read routes were board-side observation of harness-local
    // files). Non-URL link values render as plain labels.
  };

  return (
    <div className={`task-links ${compact ? 'task-links-compact' : ''}`}>
      <div className="task-links-header">
        <Link2 size={16} aria-hidden="true" /> Links
      </div>
      <div className="task-links-list">
        {displayLinks.map((link, i) => (
          <a
            key={i}
            href={isExternalUrl(link.url) ? link.url : '#'}
            className="task-link-item"
            title={link.title}
            onClick={(e) => handleLinkClick(e, link)}
          >
            <span className="task-link-icon">
              {link.icon || LINK_ICONS[link.type] || <FileText size={16} />}
            </span>
            <span className="task-link-title">{link.title}</span>
            <span className="task-link-type">{LINK_LABELS[link.type] || link.type}</span>
          </a>
        ))}
        {compact && links.length > 3 && (
          <span className="task-links-more">+{links.length - 3} more</span>
        )}
      </div>
    </div>
  );
};
