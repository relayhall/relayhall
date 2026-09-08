/**
 * ToolsPage — always-on core surface, documented empty.
 *
 * A Tool is one callable operation a Service exposes — what MCP calls a
 * tool. Services and their capability descriptors are registered today, and
 * a descriptor DECLARES the Tools its Service exposes, but the surface that
 * binds to those declarations is not built yet: this page is empty because
 * there is nothing of this kind to list, not because nothing has connected.
 * The page ships anyway so the concept has a stable home.
 * Instruction text for agents lives in Skills, not here.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { CoreSurfacePlaceholder } from '../components/CoreSurfacePlaceholder';
import './ToolsPage.css';

export const ToolsPage: React.FC = () => {
  return (
    <div className="tools-page">
      <div className="tools-header">
        <h1>
          <Wrench size={24} aria-hidden="true" /> Tools
        </h1>
      </div>

      <CoreSurfacePlaceholder
        icon={<Wrench size={56} aria-hidden="true" />}
        heading="No Tools to list yet"
        description={
          <>
            A <strong>Tool</strong> is one callable operation a Service
            exposes — what MCP calls a tool. Registered Services already
            declare their Tools in a capability descriptor, but the surface
            that binds to those declarations is not built yet, so there are
            no Tools to list here. This page is deliberately empty rather
            than hidden so the concept has a stable home.
          </>
        }
        sections={[
          {
            title: 'What arrives with the Tool surface',
            items: [
              <>
                Each registered Service&apos;s declared Tools, listed here —
                one entry per callable operation.
              </>,
              <>
                The invoke authority that turns a declared Tool into a
                callable one.
              </>,
            ],
          },
          {
            title: 'Looking for agent instructions?',
            items: [
              <>
                Instruction text for agents lives in{' '}
                <Link to="/skills">Skills</Link> — a Skill is an instruction,
                not a callable operation.
              </>,
            ],
          },
        ]}
        footer={
          <>
            <strong>Docs:</strong> see <code>docs/services.md</code> in the
            repository for the Service registry and capability descriptors,
            and <code>docs/skills.md</code> for the Skill/Tool split.
          </>
        }
      />
    </div>
  );
};
