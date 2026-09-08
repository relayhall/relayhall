import React from 'react';
import './CoreSurfacePlaceholder.css';

export interface CoreSurfaceSection {
  title: string;
  /** Render items as a numbered list instead of bullets */
  ordered?: boolean;
  items: React.ReactNode[];
}

export interface CoreSurfacePlaceholderProps {
  icon: React.ReactNode;
  heading: string;
  description: React.ReactNode;
  sections: CoreSurfaceSection[];
  footer?: React.ReactNode;
}

/**
 * Shared empty-state shell for always-on core surfaces (Sessions, Stats,
 * Tools).
 *
 * These pages have no board-side data source by design. For Sessions and
 * Stats, the board never scrapes harness state, transcripts, or local files
 * — data appears only when reporter plugins self-report it. For Tools, the
 * object type itself does not exist until the Phase 2 Service registry. In
 * every case the empty state is the documented default — not an error.
 */
export const CoreSurfacePlaceholder: React.FC<CoreSurfacePlaceholderProps> = ({
  icon,
  heading,
  description,
  sections,
  footer,
}) => {
  return (
    <div className="core-placeholder-container">
      <div className="core-placeholder-card">
        <div className="core-placeholder-icon">{icon}</div>
        <h2>{heading}</h2>
        <p className="core-placeholder-description">{description}</p>

        {sections.map((section) => (
          <div className="core-placeholder-section" key={section.title}>
            <h3>{section.title}</h3>
            {section.ordered ? (
              <ol>
                {section.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ol>
            ) : (
              <ul>
                {section.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {footer && (
          <div className="core-placeholder-footer">
            <p>{footer}</p>
          </div>
        )}
      </div>
    </div>
  );
};
